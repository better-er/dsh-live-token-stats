/**
 * `liveTokenStats` 会话投影：可重放的实时与时间性 token 数据，覆盖官方投影未涉及的部分，即流式 TPS、实时输出估算与在途 TTFT 计时。
 *
 * 纯 `init/apply/view` 单元拆分成独立的指标单元 METRIC UNITS。
 * 每个单元只负责一件关注点并导出极小的 reducer 接口，之后新增 token 指标只需加一个单元加一个视图切片，而不用碰庞大的折叠。
 * 状态保持纯 JSON，这是持久化缓存的前提。
 *
 * @module dsh-live-token-stats/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { estimateTextTokens, type EstimatorSpec } from './estimator.ts'
import { tokenCount } from './tokenizer/bpe.ts'
import {
  EMPTY_INCREMENTAL,
  incrementalFeed,
  incrementalTotal,
  type IncrementalState,
} from './tokenizer/incremental.ts'
import { EMPTY_UNESCAPE, unescapeFeed, type UnescapeState } from './tokenizer/unescape.ts'

/** 在会话投影映射表里声明我们的 key，可合并扩展。 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 当前正在流式输出或刚结算步骤的实时与时间性 token 数据。 */
    liveTokenStats: LiveTokenStatsProjection
  }
  interface SessionProjectionStateMap {
    /** 支撑 liveTokenStats 客户端视图的持久化折叠状态。 */
    liveTokenStats: LiveTokenStatsState
  }
}

/** 一步的 token 数据，含实时启发式估算以及官方 usage 落地后的实际值。
 * 两者都保留，以便步骤结束后展示估算值与实际值的结算偏差。 */
export interface LiveStepFacts {
  turn: number
  step: number
  /** step 开始的墙钟时间，单位为 epoch 毫秒。 */
  startTime: number
  /** 首 token 墙钟时间，单位为 epoch 毫秒，首字到来前为 null。 */
  firstTokenTime: number | null
  /** 实时输出 token 启发式估算，逐 delta 累加。 */
  estimatedTokens: number
  /** 官方上报的输出 token 数，usage 落地后才有值。 */
  actualTokens?: number
  /** 官方 usage 是否已上报。 */
  exact: boolean
}

/** 为 liveTokenStats key 提供的线上值。 */
export interface LiveTokenStatsProjection {
  /** 当前正在流式输出的步骤，空闲时为 null。 */
  active: LiveStepFacts | null
  /** 最近已结算的步骤，保留以避免闪烁。 */
  lastSettled: (LiveStepFacts & { endTime: number }) | null
  /** 滑动窗口内的秒级 token 数；窗口为空时缺省。 */
  tokensPerSecond?: number
}

/** 整个投影的不可变纯 JSON 状态。 */
export interface LiveTokenStatsState {
  activeStep: ActiveStepState
  throughput: ThroughputState
}

// --- ActiveStep metric ------------------------------------------------------

export interface ActiveStepState {
  active: LiveTokenStatsProjection['active']
  lastSettled: LiveTokenStatsProjection['lastSettled']
  /** BPE 增量切分状态，纯 JSON，density 模式保持初始态不增长。 */
  inc: IncrementalState
  /** tool-call 参数反转义状态，即跨 delta 帧的悬空尾部，纯 JSON 可重放。 */
  esc: UnescapeState
}

/** delta 文本计数：bpe 走增量 BPE 切分，与官方口径一致，density 走双密度盲估。 */
function countDeltaTokens(
  text: string,
  spec: Readonly<EstimatorSpec>,
  inc: IncrementalState,
): { added: number; inc: IncrementalState } {
  if (spec.tokenizerMode === 'bpe') {
    // 阈值口径：取 total 的增量（含尾段中尚未定界的 token）——
    // 连续中文无段边界时会全部滞留在尾段，added(已结算) 恒 0，不适用。
    const r = incrementalFeed(inc, text)
    const delta = incrementalTotal(r.state) - incrementalTotal(inc)
    return { added: delta, inc: r.state }
  }
  return { added: estimateTextTokens(text, spec), inc }
}

/** 判定一个 chunk 是否为携带 token 的增量。 */
function isDeltaChunk(chunk: StreamChunk): chunk is Extract<StreamChunk, { type: 'text-delta' | 'reasoning-delta' | 'tool-call-delta' }> {
  return chunk.type === 'text-delta'
    || chunk.type === 'reasoning-delta'
    || chunk.type === 'tool-call-delta'
}

/** 一个增量 chunk 携带 token 的文本，无 token 时为空串。 */
function deltaText(chunk: StreamChunk): string {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta
  return ''
}

/**
 * 反转义工具参数。
 * 官方按「解码后的实际内容」给 tool-call 参数计费，本地 delta 是 JSON 转义原文，如 `\n` 两字符等，按原文 BPE 会系统性高估，见 DESIGN §10.6。
 * 返回 { 文本, esc }，解码后的文本供计数，esc 状态挂到 fold 状态里跨帧。
 */
function decodeToolArgument(
  text: string,
  esc: UnescapeState,
): { text: string; esc: UnescapeState } {
  if (text.length === 0) return { text, esc }
  const r = unescapeFeed(esc, text)
  return { text: r.text, esc: r.state }
}

/**
 * 工具调用名的 token 数，由 tool-call-delta 首个片段一次性携带。
 * 官方会把模型生成的 tool-call JSON 完整计入 output，其中 `name` 字段是模型生成内容，本地可拿到。
 * `argumentsDelta` 已由 deltaText 计入，这里补上 name 缺口，消息外壳与模板结构费不补偿，见 DESIGN §10.x。
 */
function toolCallNameTokens(chunk: StreamChunk, spec: Readonly<EstimatorSpec>): number {
  if (chunk.type !== 'tool-call-delta') return 0
  const name = chunk.name
  if (typeof name !== 'string' || name.length === 0) return 0
  return spec.tokenizerMode === 'bpe' ? tokenCount(name) : estimateTextTokens(name, spec)
}

const ACTIVE_INIT: ActiveStepState = {
  active: null,
  lastSettled: null,
  inc: { ...EMPTY_INCREMENTAL },
  esc: { ...EMPTY_UNESCAPE },
}

/** 活跃步骤指标单元的纯折叠。 */
export function activeStepApply(
  state: ActiveStepState,
  event: SessionEvent,
  spec: Readonly<EstimatorSpec>,
): ActiveStepState {
  const { type, data } = event

  if (type === 'step/start') {
    return {
      ...state,
      inc: { ...EMPTY_INCREMENTAL },
      esc: { ...EMPTY_UNESCAPE },
      active: {
        turn: data.turn,
        step: data.step,
        startTime: event.time,
        firstTokenTime: null,
        estimatedTokens: 0,
        exact: false,
      },
    }
  }

  if (state.active === null) return state

  if (type === 'assistant/chunk') {
    const chunk = data.chunk
    if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage.outputTokens === 'number') {
      // 官方 usage：记住实际值，估算保持不动，便于之后推导结算偏差。
      return {
        ...state,
        active: {
          ...state.active,
          actualTokens: chunk.usage.outputTokens,
          exact: true,
        },
      }
    }
    if (!isDeltaChunk(chunk) || state.active.exact) return state
    const text = deltaText(chunk)
    const nameTokens = toolCallNameTokens(chunk, spec)
    if (text.length === 0 && nameTokens === 0) return state
    // 工具参数先反转义再计数（跨帧悬空尾部挂在 esc 状态上）
    const esc = chunk.type === 'tool-call-delta' ? decodeToolArgument(text, state.esc) : undefined
    const countText = esc !== undefined ? esc.text : text
    const { added, inc } =
      countText.length > 0 ? countDeltaTokens(countText, spec, state.inc) : { added: 0, inc: state.inc }
    return {
      ...state,
      inc,
      ...esc !== undefined ? { esc: esc.esc } : {},
      active: {
        ...state.active,
        firstTokenTime: state.active.firstTokenTime === null ? event.time : state.active.firstTokenTime,
        estimatedTokens: state.active.estimatedTokens + added + nameTokens,
      },
    }
  }

  if (type === 'assistant/message') {
    const usage = data.usage
    if (usage !== undefined && typeof usage.outputTokens === 'number') {
      return {
        ...state,
        active: {
          ...state.active,
          actualTokens: usage.outputTokens,
          exact: true,
        },
      }
    }
    return state
  }

  if (type === 'step/end') {
    if (state.active.turn === data.turn && state.active.step === data.step) {
      return {
        inc: { ...EMPTY_INCREMENTAL },
        esc: { ...EMPTY_UNESCAPE },
        active: null,
        lastSettled: {
          turn: data.turn,
          step: data.step,
          startTime: state.active.startTime,
          firstTokenTime: state.active.firstTokenTime,
          estimatedTokens: state.active.estimatedTokens,
          actualTokens: state.active.actualTokens,
          exact: state.active.exact,
          endTime: event.time,
        },
      }
    }
    return state
  }

  // 未完成的 turn/end 会废弃其未结算的估算。
  if (type === 'turn/end' && data.reason && data.reason.kind !== 'completed') {
    return { ...state, inc: { ...EMPTY_INCREMENTAL }, esc: { ...EMPTY_UNESCAPE }, active: null }
  }

  return state
}

/** 活跃步骤指标的视图切片。 */
export function activeStepView(state: ActiveStepState): Pick<LiveTokenStatsProjection, 'active' | 'lastSettled'> {
  return { active: state.active, lastSettled: state.lastSettled }
}

// --- Throughput metric ------------------------------------------------------

export interface ThroughputSample {
  time: number
  tokens: number
}

export interface ThroughputState {
  samples: ThroughputSample[]
  totalTokens: number
  /** 滑动窗口内的实时速率，窗口为空时无值，JSON 序列化时该字段缺省。 */
  currentRate?: number
  /** BPE 增量切分状态，纯 JSON，density 模式保持初始态。 */
  inc: IncrementalState
  /** tool-call 参数反转义状态，即跨 delta 帧的悬空尾部，纯 JSON 可重放。 */
  esc: UnescapeState
}

const THROUGHPUT_INIT: ThroughputState = {
  samples: [],
  totalTokens: 0,
  currentRate: undefined,
  inc: { ...EMPTY_INCREMENTAL },
  esc: { ...EMPTY_UNESCAPE },
}

/** 在 `asOf` 时刻滑动窗口并重算实时速率，纯函数。 */
function slideWindow(state: ThroughputState, asOf: number, spec: Readonly<EstimatorSpec>): ThroughputState {
  const cutoff = asOf - spec.rateWindowMs
  let samples = state.samples
  while (samples.length > 0 && samples[0].time < cutoff) samples = samples.slice(1)
  let total = 0
  for (const s of samples) total += s.tokens
  let currentRate: number | undefined
  if (samples.length === 0) {
    currentRate = undefined
  } else {
    const spanMs = Math.max(1, asOf - samples[0].time)
    currentRate = total / (spanMs / 1000)
  }
  return { samples, totalTokens: total, currentRate, inc: state.inc, esc: state.esc }
}

/** 吞吐指标单元的纯折叠。 */
export function throughputApply(
  state: ThroughputState,
  event: SessionEvent,
  spec: Readonly<EstimatorSpec>,
): ThroughputState {
  if (event.type === 'assistant/chunk' && isDeltaChunk(event.data.chunk)) {
    const chunk = event.data.chunk
    const text = deltaText(chunk)
    const nameTokens = toolCallNameTokens(chunk, spec)
    if (text.length === 0 && nameTokens === 0) return state
    // 工具参数先反转义再计数（跨帧悬空尾部挂在 esc 状态上）
    const esc = chunk.type === 'tool-call-delta' ? decodeToolArgument(text, state.esc) : undefined
    const countText = esc !== undefined ? esc.text : text
    const { added, inc } =
      countText.length > 0 ? countDeltaTokens(countText, spec, state.inc) : { added: 0, inc: state.inc }
    return slideWindow(
      {
        samples: [...state.samples, { time: event.time, tokens: added + nameTokens }],
        totalTokens: state.totalTokens + added + nameTokens,
        currentRate: state.currentRate,
        inc,
        esc: esc !== undefined ? esc.esc : state.esc,
      },
      event.time,
      spec,
    )
  }
  return state
}

/** 吞吐指标的视图切片。 */
export function throughputView(state: ThroughputState): Pick<LiveTokenStatsProjection, 'tokensPerSecond'> {
  return state.currentRate === undefined ? {} : { tokensPerSecond: state.currentRate }
}

// --- Projection container ---------------------------------------------------

const activeSchema = z.object({
  turn: z.number(),
  step: z.number(),
  startTime: z.number(),
  firstTokenTime: z.number().nullable(),
  estimatedTokens: z.number().nonnegative(),
  actualTokens: z.number().nonnegative().optional(),
  exact: z.boolean(),
}).strict()

const lastSettledSchema = z.object({
  turn: z.number(),
  step: z.number(),
  startTime: z.number(),
  firstTokenTime: z.number().nullable(),
  estimatedTokens: z.number().nonnegative(),
  actualTokens: z.number().nonnegative().optional(),
  exact: z.boolean(),
  endTime: z.number(),
}).strict()

const viewSchema = z.object({
  active: activeSchema.nullable(),
  lastSettled: lastSettledSchema.nullable(),
  tokensPerSecond: z.number().nonnegative().optional(),
}).strict()

const incSchema = z.object({
  buffer: z.string(),
  counted: z.number().nonnegative(),
}).strict()

/** tool-call 反转义的悬空尾部状态，纯 JSON，可重放。 */
const escSchema = z.object({
  tail: z.string(),
}).strict()

const throughputSampleSchema = z.object({
  time: z.number(),
  tokens: z.number().nonnegative(),
}).strict()

const throughputStateSchema = z.object({
  samples: z.array(throughputSampleSchema),
  totalTokens: z.number().nonnegative(),
  currentRate: z.number().nonnegative().optional(),
  inc: incSchema,
  esc: escSchema,
}).strict()

const activeStepStateSchema = z.object({
  active: activeSchema.nullable(),
  lastSettled: lastSettledSchema.nullable(),
  inc: incSchema,
  esc: escSchema,
}).strict()

/** 在用它播种一次缓存恢复前校验持久化的折叠状态。 */
const stateSchema = z.object({
  activeStep: activeStepStateSchema,
  throughput: throughputStateSchema,
}).strict()

function init(): LiveTokenStatsState {
  return { activeStep: { ...ACTIVE_INIT }, throughput: { ...THROUGHPUT_INIT } }
}

/**
 * 注册表客户端可见的 register 重载所要求的具体承载 wire 的定义形态。
 * SessionProjectionMap 里的 key 必须有 wire。
 */
export type LiveTokenStatsDefinition = Omit<
  ProjectionDefinition<'liveTokenStats', LiveTokenStatsState>,
  'wire'
> & {
  wire: NonNullable<ProjectionDefinition<'liveTokenStats', LiveTokenStatsState>['wire']>
}

/**
 * 创建可重放的 liveTokenStats 投影定义。
 * @param spec - 已解析的估算器 spec。
 * @returns 供 sessionProjections.register() 使用的投影定义。
 */
export function createLiveTokenStatsDefinition(
  spec: Readonly<EstimatorSpec>,
): LiveTokenStatsDefinition {
  return {
    key: 'liveTokenStats',
    stateSchema,
    init,
    apply: (state, event) => {
      const nextActive = activeStepApply(state.activeStep, event, spec)
      const nextThroughput = throughputApply(state.throughput, event, spec)
      if (nextActive === state.activeStep && nextThroughput === state.throughput) return state
      return { activeStep: nextActive, throughput: nextThroughput }
    },
    wire: {
      viewSchema,
      view: (state) => ({
        ...activeStepView(state.activeStep),
        ...throughputView(state.throughput),
      }),
    },
    // 仅当序列化状态字段或折叠语义变化时才递增。
    // v4：tool-call 参数反转义（esc 状态）——官方按解码后内容计费。
    stateVersion: 4,
  }
}
