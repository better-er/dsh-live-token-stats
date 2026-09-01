/**
 * dsh-live-token-stats 的实时主机→客户端流。
 *
 * 官方会话事件投影管线被刻意设计为「结算式」：数值是对已提交 `SessionEvent` 的纯折叠，从日志重放而来，没有开放的缝隙能把外部计算且墙钟实时的数据推进去，浏览器投影位置只接受折叠驱动的 key。
 * 实时 token 吞吐本质是在途、墙钟量，不是可重放的折叠。
 *
 * 于是本模块打开自己的纯插件通道，不改 DSH 源码，因此可在任何环境安装分发：
 *
 *   host：  `ctx.on('llm/stream', ...)` 拦截原始逐块 adapter 流，正是官方不变量包装的同一条瀑布流。对每个 text / reasoning / tool-call 参数片段，按会话 `options.sessionId` 累计一个滑动窗口 token 速率。
 *   host：  `ctx.connection.rpc.handle('/dsh-live-token-stats', ...)` 提供每个会话最新的实时快照。
 *   client：每秒轮询该 RPC 端点数次并渲染。
 *
 * 这是可分发插件能达到的「基线式近实时」：RPC 拉取限速在约 4/s。
 * 无需注册帧类型，无需运行时补丁。
 *
 * @module dsh-live-token-stats/live-stream
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// 副作用类型导入：从 connection 包的主机入口引入主机 `ctx.connection` 即 HostConnectionHandle 的声明合并。
import '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { estimateTextTokens, type EstimatorSpec } from './estimator.ts'
import { tokenCount } from './tokenizer/bpe.ts'
import {
  EMPTY_INCREMENTAL,
  incrementalFeed,
  incrementalTotal,
  type IncrementalState,
} from './tokenizer/incremental.ts'
import { EMPTY_UNESCAPE, unescapeFeed, type UnescapeState } from './tokenizer/unescape.ts'

/**
 * 单个工具调用名的 token 数，BPE 或 density 按 spec 计价。
 * 官方将模型生成的 tool-call JSON 完整计入 output，name 字段同为模型生成，此处补上 argumentsDelta 之外的缺口。
 * 注意：DSH 的 llm/stream 对同一工具调用的每个 delta 帧都携带 name 字段，官方只按一次计费，
 * 调用方必须按工具调用 id 去重，仅在首次出现时计入，否则 name 会被重复累加。
 * 消息外壳与模板结构费不补偿，见 DESIGN §10.x。
 */
function toolNameTokenCount(name: string, spec: Readonly<EstimatorSpec>): number {
  return spec.tokenizerMode === 'bpe' ? tokenCount(name) : estimateTextTokens(name, spec)
}

/** 一个增量 chunk 携带 token 的内容，无 token 时为空串。 */
function deltaTextOf(chunk: StreamChunk): string {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text
  if (chunk.type === 'tool-call-delta') return (chunk as { argumentsDelta?: string }).argumentsDelta ?? ''
  return ''
}

/** 判定一个 chunk 是否贡献流式输出 token。 */
function isTokenDelta(chunk: StreamChunk): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta'
}

/**
 * 停顿判定阈值毫秒。
 * 相邻 delta 样本间隔达到该值才算「停顿/卡住」并计入累计停顿 stallMs，低于阈值的毫秒级批处理间隙视为正常推流节奏。
 */
const STALL_GRACE_MS = 300

// --- 诊断日志，临时插桩：定位「估算 vs 官方 usage 偏差不为 0」，验证后移除 ---

/**
 * 诊断日志落盘位置：~/.dsh/dsh-live-token-stats-debug.jsonl。
 * 每行一个 JSON 记录，即一次 llm/stream 流一行，字段见 {@link StreamDebugLog}。
 * 仅落盘，不向控制台输出以避开每流一行刷屏，写入失败仍上报控制台。
 */
const DEBUG_LOG_PATH = join(homedir(), '.dsh', 'dsh-live-token-stats-debug.jsonl')

/** 写一行诊断日志。日志 IO 绝不能影响主流程；异常必须留痕以便定位。 */
function debugLog(record: Record<string, unknown>): void {
  let line: string
  try {
    line = JSON.stringify(record)
  } catch (err) {
    console.error('[dsh-live-token-stats] 诊断日志序列化失败，已忽略:', err)
    return
  }
  try {
    appendFileSync(DEBUG_LOG_PATH, `${line}\n`)
  } catch (err) {
    console.error('[dsh-live-token-stats] 诊断日志写入失败，已忽略:', err)
  }
}

/** 一次 llm/stream 流的诊断统计，拦截器内自维护，独立于 tracker 的速率口径。 */
interface StreamDebugStats {
  /** 该会话内第几次流，工具循环会触发多次。 */
  seq: number
  /** GenerateOptions.model，可能缺省。 */
  model: string | undefined
  /** 三类 delta 的字符数，同投影 deltaText 口径。 */
  chars: { text: number; reasoning: number; tool: number }
  /** 本流的 BPE 增量切分状态，连续中文时 total 差分才有意义。 */
  inc: IncrementalState
  /** 本流的 tool-call 反转义悬空尾部，与 tracker 和投影同口径。 */
  esc: UnescapeState
  /** 本流第一次出现 usage chunk 时的 BPE 累计，流内无 usage 时为 null。 */
  bpeAtUsage: number | null
  /** 流内最后一个 usage.outputTokens，流内无 usage 时为 null。 */
  usageOutput: number | null
  /** 官方 usage 拆分的推理 token 数，provider 未报告时为 null。 */
  usageReasoning: number | null
  /** 本流每个工具调用的 name/id/参数累计字符，用于回归消息外壳结构费用。 */
  tools: { name: string | null; id: string | null; argsChars: number }[]
  /** 块 index 到 tools 数组下标的映射，运行时态不落日志。 */
  toolByIdx: Map<number, number>
  /** 本流逐 delta 完整序列，含内容与每帧 ISO 时间，供离线对照官方计费口径。 */
  frames: { t: string; ty: string; i: number; n?: string; id?: string; c: string }[]
}

/** 一个会话的滑动窗口速率单元。 */
interface RateCell {
  /** 窗口内的 token 样本，按到达时刻排序，超窗样本由 snapshot 滑出。 */
  samples: { time: number; tokens: number }[]
  /** 最后一次折叠某个 delta 的墙钟毫秒，仅供客户端衰减提示。 */
  updatedAt: number
  /** 本 step 起点，即拦截器记录到 llm/stream 事件的时刻，约等于请求发出时刻。 */
  stepStartAt: number
  /** 累计停顿毫秒，相邻 delta 间隔达 STALL_GRACE_MS 的段落之和。 */
  stallMs: number
  /** 最近一次有 token 样本的时刻，0 表示本 step 尚无样本，用于算进行中的停顿。 */
  lastSampleAt: number
  /** 本 step 的 llm/stream 是否已结束，结束后不再累加进行中的停顿。 */
  ended: boolean
  /** 该会话的 BPE 增量切分状态，density 模式保持初始态。 */
  inc: IncrementalState
  /** tool-call 参数反转义的悬空尾部，跨帧维护于 cell.esc。 */
  esc: UnescapeState
  /** 已计入 name token 的工具调用 id，同一调用跨帧只计一次。 */
  nameCountedIds: Set<string>
}

/** 提供给客户端、针对某个会话的实时快照。 */
export interface LiveTokenSnapshot {
  /**
   * 实时速度 tok/s：窗口内累计 token 除以跨度。
   * 跨度取自 step 开始流逝时间与窗口定值的较小值，即刚开始时含首字延迟随窗口滑动爬升，首字延迟摊完且流逝超过窗口后固定为窗口定值。
   * 超窗无样本则无值。
   */
  tokensPerSecond?: number
  /** 最新折叠样本的墙钟 epoch 毫秒，客户端从这里开始衰减。 */
  updatedAt: number
  /** 累计停顿毫秒，含生成中正在进行的当前停顿，间隔达 STALL_GRACE_MS 才计；流结束后冻结，不再累加工具执行等非生成时间。 */
  stallMs: number
  /** 距上一次 delta 样本的毫秒数，0 表示刚有数据，用于观察当前卡了多久。 */
  sinceLastMs: number
}

const INITIAL_RATE_CELL = (): RateCell => ({
  samples: [],
  updatedAt: 0,
  stepStartAt: 0,
  stallMs: 0,
  lastSampleAt: 0,
  ended: false,
  inc: { ...EMPTY_INCREMENTAL },
  esc: { ...EMPTY_UNESCAPE },
  nameCountedIds: new Set<string>(),
})

/**
 * 实时的每会话 token 速率追踪器。
 * 单线程即单一主机进程，`llm/stream` 按请求串行，因此映射无需加锁。
 */
export class LiveTokenRateTracker {
  private readonly cells = new Map<string, RateCell>()

  constructor(private readonly spec: Readonly<EstimatorSpec>) {}

  /** 把一个 adapter chunk 折叠进其会话的速率单元。相对流本身为纯函数。 */
  fold(sessionId: string | undefined, chunk: StreamChunk, timeMs: number): void {
    if (sessionId === undefined) return
    if (!isTokenDelta(chunk)) return
    const text = deltaTextOf(chunk)
    // 工具名 token 每个调用只计一次：DSH 的 llm/stream 对同一工具调用的每个 delta 帧都携带 name，
    // 逐帧累加会把 name 重复计数，按工具调用 id 去重，仅首次出现计入。
    let nameTokens = 0
    let cell = this.cells.get(sessionId)
    if (chunk.type === 'tool-call-delta') {
      const id = chunk.id
      const name = chunk.name
      if (typeof name === 'string' && name.length > 0 && (cell === undefined || !cell.nameCountedIds.has(id))) {
        nameTokens = toolNameTokenCount(name, this.spec)
      }
      if (nameTokens > 0 && cell !== undefined) cell.nameCountedIds.add(id)
    }
    if (text.length === 0 && nameTokens === 0) return
    if (cell === undefined) {
      cell = INITIAL_RATE_CELL()
      this.cells.set(sessionId, cell)
      if (nameTokens > 0 && chunk.type === 'tool-call-delta') cell.nameCountedIds.add(chunk.id)
    }
    // 停顿累计：相邻 delta 间隔达到阈值才算「卡住」，整个间隔计入累计停顿。
    if (cell.lastSampleAt > 0 && timeMs - cell.lastSampleAt >= STALL_GRACE_MS) {
      cell.stallMs += timeMs - cell.lastSampleAt
    }
    let tokensAdded = nameTokens
    // 工具参数先反转义再计数：官方按解码后的实际内容计费，delta 是 JSON 转义原文，DESIGN §10.6，跨帧悬空尾部在 cell.esc 上。
    let esc = cell.esc
    let countText = text
    if (chunk.type === 'tool-call-delta' && text.length > 0) {
      const r = unescapeFeed(esc, text)
      countText = r.text
      esc = r.state
    }
    let inc = cell.inc
    if (countText.length > 0) {
      if (this.spec.tokenizerMode === 'bpe') {
        const r = incrementalFeed(inc, countText)
        // 实时口径：取 total 增量，含尾段未定界 token，连续中文停在尾段时 added 恒 0
        tokensAdded += incrementalTotal(r.state) - incrementalTotal(inc)
        inc = r.state
      } else {
        tokensAdded += estimateTextTokens(countText, this.spec)
      }
    }
    cell.inc = inc
    cell.esc = esc
    cell.samples.push({ time: timeMs, tokens: tokensAdded })
    cell.lastSampleAt = timeMs
  }

  /**
   * 新 step 开始，每次 llm/stream 拦截到就调用。
   * startAt 为拦截器收到事件的时刻，约等于请求发出时刻，TTFT 由此起算。
   * 停顿与样本状态全部重置，避免跨 step 混算。
   */
  beginStep(sessionId: string, startAt: number): void {
    let cell = this.cells.get(sessionId)
    if (cell === undefined) {
      cell = INITIAL_RATE_CELL()
      this.cells.set(sessionId, cell)
    }
    cell.samples = []
    cell.stepStartAt = startAt
    cell.stallMs = 0
    cell.lastSampleAt = 0
    cell.ended = false
    cell.inc = { ...EMPTY_INCREMENTAL }
    cell.esc = { ...EMPTY_UNESCAPE }
    cell.nameCountedIds = new Set<string>()
  }

  /**
   * 标记本 step 的 llm/stream 已结束。
   * 生成结束后浏览器仍在轮询，若保持「生成中」状态会把工具执行等非生成时间误计入进行中的停顿，
   * 因此流结束后 `snapshot` 冻结累计停顿，不再累加 idle 时间。
   */
  endStep(sessionId: string): void {
    const cell = this.cells.get(sessionId)
    if (cell !== undefined) cell.ended = true
  }

  /**
   * 按 `asOf` 时刻给单元做实时速率快照，`asOf` 缺省为 `Date.now()`。
   * 跨度恒 ≤ 窗口大小：开始阶段取 step 开始后的流逝时间，首字延迟随窗口滑动爬升，流逝超过窗口后固定为窗口定值。
   * 停顿超窗后无样本，速率不外发，数学上未定义，客户端显示 0 兜底；stallMs 同步计入进行中的停顿。
   */
  snapshot(sessionId: string, asOf: number = Date.now()): LiveTokenSnapshot {
    const cell = this.cells.get(sessionId)
    if (cell === undefined) return { updatedAt: 0, stallMs: 0, sinceLastMs: 0 }
    const idleMs = cell.lastSampleAt > 0 ? Math.max(0, asOf - cell.lastSampleAt) : 0
    // 流结束后即工具执行等非生成时间，不再累加进行中的停顿，只保留生成期内已累计的部分。
    const stallMs = cell.stallMs + (!cell.ended && idleMs >= STALL_GRACE_MS ? idleMs : 0)
    // 超窗样本逐批滑出窗口，长停顿后窗口内不再有样本。
    const window = this.spec.rateWindowMs
    const cutoff = asOf - window
    let samples = cell.samples
    while (samples.length > 0 && samples[0].time < cutoff) samples = samples.slice(1)
    cell.samples = samples
    cell.updatedAt = asOf
    let rate: number | undefined
    if (samples.length > 0) {
      // 分母取流逝时间与窗口的较小值，下限 50ms 防同批突发除零；未 beginStep 时回退旧口径。
      const elapsedMs = cell.stepStartAt > 0 ? Math.max(0, asOf - cell.stepStartAt) : asOf - samples[0].time
      const spanMs = Math.max(50, Math.min(elapsedMs, window))
      const total = samples.reduce((acc, s) => acc + s.tokens, 0)
      rate = total / (spanMs / 1000)
    }
    const out: LiveTokenSnapshot = { updatedAt: asOf, stallMs, sinceLastMs: idleMs }
    if (rate !== undefined) out.tokensPerSecond = rate
    return out
  }

  /** 丢弃一个会话的单元，例如 turn/end 或不再需要时。 */
  reset(sessionId: string): void {
    this.cells.delete(sessionId)
  }
}

/**
 * 构建由追踪器支撑的 RPC 通道处理器。
 * `endpoint` 为 `snapshot`、载荷含 `{ sessionId }` 时返回该会话的实时速率。
 */
export function createLiveStreamRpcHandler(
  tracker: LiveTokenRateTracker,
): ConnectionRpcHandler {
  return async (endpoint, payload) => {
    if (endpoint !== 'snapshot') {
      return transportError(new Error(`unknown endpoint ${endpoint}`))
    }
    const sessionId = (payload as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return transportError(new Error('missing sessionId'))
    }
    return { ok: true, value: tracker.snapshot(sessionId) }
  }
}

/**
 * 安装主机端：拦截 `llm/stream` 并挂载 RPC 通道。
 * @param ctx - 主机插件上下文，与 `apply` 用的是同一个上下文。
 * @param spec - 已解析的估算器 spec。
 * @param debug - 诊断日志开关，默认关；开启时把每流完整 delta 序列与官方 usage 对照记录到 ~/.dsh/dsh-live-token-stats-debug.jsonl，关闭时拦截器零额外开销。
 * @returns 追踪器供测试与善后使用，以及一个销毁器。
 */
export function installHostLiveStream(
  ctx: Context,
  spec: Readonly<EstimatorSpec>,
  debug = false,
): { tracker: LiveTokenRateTracker; dispose: () => void } {
  const tracker = new LiveTokenRateTracker(spec)

  // 前插：让我们先于不变量校验器看到 chunk，无论顺序都无害。
  const streamSeq = new Map<string, number>()
  const offStream = ctx.on(
    'llm/stream',
    (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      const sessionId = String(options.sessionId)
      // 拦截到 llm/stream 的时刻约等于请求发出时刻，作为本 step 起点与 TTFT 起算点。
      tracker.beginStep(sessionId, Date.now())
      return (async function* () {
        const seq = (streamSeq.get(sessionId) ?? 0) + 1
        streamSeq.set(sessionId, seq)
        const d: StreamDebugStats | null = debug
          ? {
            seq,
            model: (options as { model?: string }).model,
            chars: { text: 0, reasoning: 0, tool: 0 },
            inc: { ...EMPTY_INCREMENTAL },
            esc: { ...EMPTY_UNESCAPE },
            bpeAtUsage: null,
            usageOutput: null,
            usageReasoning: null,
            tools: [],
            toolByIdx: new Map<number, number>(),
            frames: [],
          }
          : null
        for await (const chunk of next()) {
          // timeMs：adapter 的 chunk 不带时间戳；用墙钟，让客户端渲染的速率随真实时间自然衰减。
          const now = Date.now()
          tracker.fold(String(sessionId), chunk, now)
          // —— 诊断统计，与 fold 同一数据源，独立切分一遍，仅 debug 开启时运行——
          if (d !== null) {
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
              const frame: { t: string; ty: string; i: number; n?: string; id?: string; c: string } = {
                t: new Date(now).toISOString(),
                ty: chunk.type,
                i: chunk.index,
                c: deltaTextOf(chunk),
              }
              if (chunk.type === 'tool-call-delta') {
                if (chunk.name !== undefined) frame.n = chunk.name
                frame.id = String(chunk.id)
                let pos = d.toolByIdx.get(chunk.index)
                if (pos === undefined) {
                  pos = d.tools.length
                  d.toolByIdx.set(chunk.index, pos)
                  d.tools.push({ name: chunk.name ?? null, id: chunk.id, argsChars: chunk.argumentsDelta.length })
                } else {
                  const t = d.tools[pos]
                  if (t.name === null && chunk.name !== undefined) t.name = chunk.name
                  t.argsChars += chunk.argumentsDelta.length
                }
                // 仅当确实带内容才入 frames，空参数的首帧 name 也保留
                if (chunk.argumentsDelta.length > 0 || chunk.name !== undefined) d.frames.push(frame)
              } else {
                d.frames.push(frame)
              }
              const text = deltaTextOf(chunk)
              if (text.length > 0) {
                if (chunk.type === 'text-delta') d.chars.text += text.length
                else if (chunk.type === 'reasoning-delta') d.chars.reasoning += text.length
                else d.chars.tool += text.length
                // 与 tracker/投影同口径：工具参数反转义后再计数，frames 保留原始 delta 供离线对照
                const unesc = chunk.type === 'tool-call-delta' ? unescapeFeed(d.esc, text) : null
                if (unesc !== null) {
                  d.esc = unesc.state
                  d.inc = incrementalFeed(d.inc, unesc.text).state
                } else {
                  d.inc = incrementalFeed(d.inc, text).state
                }
              }
            } else if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage.outputTokens === 'number') {
              d.usageOutput = chunk.usage.outputTokens
              d.usageReasoning = chunk.usage.reasoningTokens ?? null
              if (d.bpeAtUsage === null) d.bpeAtUsage = incrementalTotal(d.inc)
            }
          }
          yield chunk
        }
        // 流结束：本流 BPE 总计数 + 构成 + 官方 usage + 完整 delta 序列一行落盘。
        if (d !== null) {
          debugLog({
            ev: 'stream',
            ts: new Date().toISOString(),
            tsMs: Date.now(),
            session: sessionId.slice(0, 12),
            seq,
            model: d.model,
            chars: d.chars,
            bpe: incrementalTotal(d.inc),
            // usage 提前到达而流还有后续 delta 时 bpeAtUsage < bpe，投影 exact 后会忽略剩余 delta。
            bpeAtUsage: d.bpeAtUsage,
            usageOutput: d.usageOutput,
            usageReasoning: d.usageReasoning,
            tools: d.tools,
            frames: d.frames,
            mode: spec.tokenizerMode,
          })
        }
        // 流结束：标记本 step 生成完毕，之后浏览器轮询得到的空闲时间不再计入「已停顿」。
        tracker.endStep(String(sessionId))
      })()
    },
    { global: true, prepend: true },
  )

  // 在共享连接传输上挂载客户端拉取用的 RPC 通道。
  let offRpc: (() => Promise<void>) | undefined
  const connection = ctx.connection
  if (connection !== undefined) {
    offRpc = connection.rpc.handle(
      '/dsh-live-token-stats',
      createLiveStreamRpcHandler(tracker),
      { authority: 'loopback' },
    )
  }

  return {
    tracker,
    dispose: () => {
      offStream()
      offRpc?.()
    },
  }
}

/** 重新导出估算器 spec 类型供测试使用。 */
export type { EstimatorSpec as LiveStreamEstimatorSpec } from './estimator.ts'
