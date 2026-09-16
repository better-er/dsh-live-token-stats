/**
 * 从已提交会话事件里取最后一次 assistant 输出，并按整段口径算一次结算估算。
 *
 * 结算估算原本由投影在重放时逐帧算，冷读长会话要对每一条历史 step 重扫 BPE。
 * 现在改由 host 在需要时对最后一条 `assistant/message` 算一次，投影不再持有原文，
 * 因此这段逻辑与投影分家，放在这里供 host 使用。
 *
 * @module dsh-live-token-stats/settle
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { estimateTextTokens, type EstimatorSpec } from './estimator.ts'
import { tokenCount } from './tokenizer/bpe.ts'
import { EMPTY_UNESCAPE, unescapeFeed, type UnescapeState } from './tokenizer/unescape.ts'

let compactStreamDebugEnabled = false

/** 打开或关闭紧凑流未知记录的告警，由主机按插件 debug 配置调用。 */
export function setCompactStreamDebug(enabled: boolean): void {
  compactStreamDebugEnabled = enabled
}

/** 记录一条被跳过的紧凑流记录，仅在 debug 开启时告警。 */
function warnSkippedRecord(reason: string, record: unknown): void {
  if (!compactStreamDebugEnabled) return
  console.warn(`[dsh-live-token-stats] 跳过紧凑流记录：${reason}`, record)
}

/**
 * 展开 dsh 0.1.5-rc.2 的紧凑流记录为带原始时间的 delta 序列，对应官方 expandAssistantStream。
 * 有意保留两处差异：官方对未知或残缺记录直接抛错，这里跳过并在 debug 开启时告警，避免一条坏记录让整段估算失效；官方按 dt 的前一项直接累加，这里对缺失项按 0 兜底。
 */
export function expandCompactStream(stream: readonly unknown[]): { time: number; chunk: StreamChunk }[] {
  const out: { time: number; chunk: StreamChunk }[] = []
  for (const raw of stream) {
    if (typeof raw !== 'object' || raw === null) {
      warnSkippedRecord('记录不是对象', raw)
      continue
    }
    const record = raw as Record<string, unknown>
    const type = record.type
    if (type === 'chunk') {
      const chunk = record.chunk as StreamChunk | undefined
      if (chunk === undefined) {
        warnSkippedRecord('chunk 记录缺少 chunk 字段', raw)
        continue
      }
      out.push({ time: typeof record.time === 'number' ? record.time : 0, chunk })
      continue
    }
    const members = type === 'tool-call-chunks'
      ? record.args
      : type === 'text-chunks' || type === 'reasoning-chunks' ? record.texts : undefined
    if (!Array.isArray(members)) {
      warnSkippedRecord(`无法识别的记录类型 ${JSON.stringify(type)}`, raw)
      continue
    }
    const dt = Array.isArray(record.dt) ? record.dt as number[] : []
    const index = typeof record.index === 'number' ? record.index : 0
    let time = typeof record.time0 === 'number' ? record.time0 : 0
    for (let member = 0; member < members.length; member += 1) {
      if (member > 0) time += dt[member - 1] ?? 0
      const text = typeof members[member] === 'string' ? members[member] as string : ''
      let chunk: StreamChunk
      if (type === 'text-chunks') chunk = { type: 'text-delta', index, text }
      else if (type === 'reasoning-chunks') chunk = { type: 'reasoning-delta', index, text }
      else chunk = {
        type: 'tool-call-delta',
        index,
        id: String(record.id ?? ''),
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        argumentsDelta: text,
      } as unknown as StreamChunk
      out.push({ time, chunk })
    }
  }
  return out
}

/**
 * 判定一个 chunk 是否携带模型输出 token，语义对齐官方 isTokenDelta：
 * 文本与推理要求内容非空，工具调用要求参数片段非空或带 name。
 * 投影、实时追踪与整段结算共用这一份，三处口径必须一致，空增量不得计入首字时间。
 */
export function isDeltaChunk(chunk: StreamChunk): chunk is Extract<StreamChunk, { type: 'text-delta' | 'reasoning-delta' | 'tool-call-delta' }> {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== ''
  if (chunk.type === 'tool-call-delta') return (chunk.argumentsDelta ?? '') !== '' || chunk.name !== undefined
  return false
}

/** 一个增量 chunk 携带 token 的文本，无 token 时为空串；投影、实时追踪与整段结算共用。 */
export function deltaText(chunk: StreamChunk): string {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta ?? ''
  return ''
}

/**
 * 单个工具调用名的 token 数，BPE 或 density 按 spec 计价；整段结算与实时追踪共用。
 * 官方将模型生成的 tool-call JSON 完整计入 output，name 字段同为模型生成，此处补上 argumentsDelta 之外的缺口。
 * 同一调用每帧都携带 name，官方只按一次计费，调用方必须按 id 去重。
 * 消息外壳与模板结构费不补偿。
 */
export function toolNameTokenCount(name: string, spec: Readonly<EstimatorSpec>): number {
  return spec.tokenizerMode === 'bpe' ? tokenCount(name) : estimateTextTokens(name, spec)
}

/** assistant/message 事件 data 的最小面。 */
export interface AssistantMessageData {
  turn?: number
  step?: number
  stream?: readonly unknown[]
  usage?: { outputTokens?: number }
}

/**
 * 从日志尾部找最后一条 assistant/message 事件，返回其 seq、所属 turn/step 与 data。
 * turn/step 是客户端把结算估算与投影的 lastSettled 对齐的依据：估算在 assistant/message 落地时就换了，
 * 而投影要等 step/end 才结算，工具执行阶段两者会指向不同的 step。
 * 旧日志缺这两个字段时回落到 -1，永不与任何真实 step 匹配。
 */
export function findLastAssistantMessage(
  events: readonly SessionEvent[],
): { seq: number; turn: number; step: number; data: AssistantMessageData } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type === 'assistant/message') {
      const data = event.data as AssistantMessageData
      return {
        seq: event.seq,
        turn: typeof data.turn === 'number' ? data.turn : -1,
        step: typeof data.step === 'number' ? data.step : -1,
        data,
      }
    }
  }
  return undefined
}

/** 一次结算估算的结果。 */
export interface SettledEstimate {
  /** 这条 assistant/message 所属的 turn，旧日志缺字段时为 -1。 */
  turn: number
  /** 这条 assistant/message 所属的 step，旧日志缺字段时为 -1。 */
  step: number
  /** 本地整段估算的输出 token 数。 */
  estimated: number
  /** 官方上报的输出 token 数，未上报时缺省。 */
  actual?: number
  /** 官方 usage 是否已上报；供估算过程短路与测试断言，客户端不消费。 */
  exact: boolean
}

/**
 * 对一条 assistant/message 的紧凑流做一次估算，口径与实时通道一致：
 * bpe 模式把文本与反转义后的工具参数按到达顺序拼接后整段分词一次，与逐帧增量逐 token 相同；
 * density 模式按每个成员逐段取整累加，与实时通道的逐帧口径相同，避免结算瞬间出现系统性跳变。
 * 工具名按调用 id 去重各计一次。usage 到达后不再累加后续 delta。
 */
export function estimateAssistantMessage(
  data: AssistantMessageData,
  spec: Readonly<EstimatorSpec>,
): SettledEstimate {
  const turn = typeof data.turn === 'number' ? data.turn : -1
  const step = typeof data.step === 'number' ? data.step : -1
  let text = ''
  // density 与实时通道同口径：逐段取整累加，而不是整段一次取整。
  let densityTokens = 0
  const calls: { id: string; name: string }[] = []
  let esc: UnescapeState = { ...EMPTY_UNESCAPE }
  let actual: number | undefined
  let exact = false
  if (Array.isArray(data.stream)) {
    for (const item of expandCompactStream(data.stream)) {
      const chunk = item.chunk
      if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage.outputTokens === 'number') {
        actual = chunk.usage.outputTokens
        exact = true
        continue
      }
      if (exact || !isDeltaChunk(chunk)) continue
      const delta = deltaText(chunk)
      if (chunk.type === 'tool-call-delta') {
        const name = chunk.name
        if (typeof name === 'string' && name.length > 0 && !calls.some((call) => call.id === chunk.id)) {
          calls.push({ id: chunk.id, name })
        }
        if (delta.length > 0) {
          const decoded = unescapeFeed(esc, delta)
          esc = decoded.state
          if (spec.tokenizerMode === 'density') densityTokens += estimateTextTokens(decoded.text, spec)
          else text += decoded.text
        }
      } else if (delta.length > 0) {
        if (spec.tokenizerMode === 'density') densityTokens += estimateTextTokens(delta, spec)
        else text += delta
      }
    }
  }
  const usage = data.usage
  if (usage !== undefined && typeof usage.outputTokens === 'number') {
    actual = usage.outputTokens
    exact = true
  }
  let estimated = spec.tokenizerMode === 'bpe' ? (text.length > 0 ? tokenCount(text) : 0) : densityTokens
  for (const call of calls) estimated += toolNameTokenCount(call.name, spec)
  const value: SettledEstimate = { turn, step, estimated, exact }
  return actual === undefined ? value : { ...value, actual }
}
