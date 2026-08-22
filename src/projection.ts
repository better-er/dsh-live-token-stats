/**
 * The `liveTokenStats` session projection: replayable live/temporal token
 * figures the official projections do not cover (streaming TPS, live output
 * estimate, in-flight TTFT timing).
 *
 * Pure `init/apply/view` unit split into independent METRIC UNITS. Each unit
 * owns one concern and exports a tiny reducer interface, so adding a token
 * metric later means adding one unit plus one view slice — not touching a
 * god-fold. State stays plain JSON (persisted-cache precondition).
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

/** Declare our key in the session-projection map tables (merge-extensible). */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Live/temporal token figures for the currently streaming (or just-settled) step. */
    liveTokenStats: LiveTokenStatsProjection
  }
  interface SessionProjectionStateMap {
    /** Persisted fold state backing the liveTokenStats client view. */
    liveTokenStats: LiveTokenStatsState
  }
}

/** One step's token figures: the live heuristic estimate plus the official
 * provider usage once it lands. Both are kept so the settled deviation
 * (estimate vs actual) can be shown after the step closes. */
export interface LiveStepFacts {
  turn: number
  step: number
  /** step/start wall-clock epoch ms. */
  startTime: number
  /** first-token wall-clock epoch ms, or null before the first delta. */
  firstTokenTime: number | null
  /** live output-token heuristic estimate, accumulated per delta. */
  estimatedTokens: number
  /** provider-reported output tokens, present once usage lands. */
  actualTokens?: number
  /** true once provider usage was reported. */
  exact: boolean
}

/** The wire value served for the liveTokenStats key. */
export interface LiveTokenStatsProjection {
  /** The currently streaming step, or null when idle. */
  active: LiveStepFacts | null
  /** The most recently settled step, retained to avoid flicker. */
  lastSettled: (LiveStepFacts & { endTime: number }) | null
  /** Live tokens/second over the sliding window; absent when no window. */
  tokensPerSecond?: number
}

/** Immutable plain-JSON state for the whole projection. */
export interface LiveTokenStatsState {
  activeStep: ActiveStepState
  throughput: ThroughputState
}

// --- ActiveStep metric ------------------------------------------------------

export interface ActiveStepState {
  active: LiveTokenStatsProjection['active']
  lastSettled: LiveTokenStatsProjection['lastSettled']
  /** BPE 增量切分状态（纯 JSON；density 模式保持初始态不增长）。 */
  inc: IncrementalState
  /** tool-call 参数反转义状态（跨 delta 帧的悬空尾部；纯 JSON，可重放）。 */
  esc: UnescapeState
}

/** delta 文本计数：bpe 走增量 BPE 切分（与官方口径一致），density 走双密度盲估。 */
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

/** Whether a chunk is a token-bearing delta. */
function isDeltaChunk(chunk: StreamChunk): chunk is Extract<StreamChunk, { type: 'text-delta' | 'reasoning-delta' | 'tool-call-delta' }> {
  return chunk.type === 'text-delta'
    || chunk.type === 'reasoning-delta'
    || chunk.type === 'tool-call-delta'
}

/** The token-bearing text of a delta chunk (empty when none). */
function deltaText(chunk: StreamChunk): string {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta
  return ''
}

/**
 * 反转义工具参数：官方对 tool-call 参数按「解码后的实际内容」计费，本地 delta
 * 是 JSON 转义原文（`\n` 两字符等），按原文 BPE 会系统性高估（见 DESIGN §10.6）。
 * 返回 { 文本, esc }：解码后的文本供计数，esc 状态挂到 fold 状态里跨帧。
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
 * 工具调用名（tool-call-delta 首个片段一次性携带）的 token 数。
 * 官方会把模型生成的 tool-call JSON 完整计入 output，其中 `name` 字段
 * 是模型生成内容，本地可拿到；`argumentsDelta` 已由 deltaText 计入，
 * 这里补上 name 缺口（消息外壳/模板结构费不补偿——见 DESIGN §10.x）。
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

/** Pure fold for the active-step metric unit. */
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
      // Provider usage: remember the actual, keep the estimate untouched so the
      // settled deviation can be derived later.
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

  // A non-completed turn/end abandons its unsettled estimate.
  if (type === 'turn/end' && data.reason && data.reason.kind !== 'completed') {
    return { ...state, inc: { ...EMPTY_INCREMENTAL }, esc: { ...EMPTY_UNESCAPE }, active: null }
  }

  return state
}

/** View slice for the active-step metric. */
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
  /** 滑动窗口内的实时速率;窗口为空时无值(JSON 序列化时字段缺省)。 */
  currentRate?: number
  /** BPE 增量切分状态（纯 JSON；density 模式保持初始态）。 */
  inc: IncrementalState
  /** tool-call 参数反转义状态（跨 delta 帧的悬空尾部；纯 JSON，可重放）。 */
  esc: UnescapeState
}

const THROUGHPUT_INIT: ThroughputState = {
  samples: [],
  totalTokens: 0,
  currentRate: undefined,
  inc: { ...EMPTY_INCREMENTAL },
  esc: { ...EMPTY_UNESCAPE },
}

/** Slide the window at `asOf` and recompute the live rate. Pure. */
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

/** Pure fold for the throughput metric unit. */
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

/** View slice for the throughput metric. */
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

/** tool-call 反转义的悬空尾部状态（纯 JSON，可重放）。 */
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

/** Validates persisted fold state before it seeds a cache restore. */
const stateSchema = z.object({
  activeStep: activeStepStateSchema,
  throughput: throughputStateSchema,
}).strict()

function init(): LiveTokenStatsState {
  return { activeStep: { ...ACTIVE_INIT }, throughput: { ...THROUGHPUT_INIT } }
}

/**
 * The concrete wire-carrying definition shape the registry's client-visible
 * register overload requires (wire mandatory for keys in SessionProjectionMap).
 */
export type LiveTokenStatsDefinition = Omit<
  ProjectionDefinition<'liveTokenStats', LiveTokenStatsState>,
  'wire'
> & {
  wire: NonNullable<ProjectionDefinition<'liveTokenStats', LiveTokenStatsState>['wire']>
}

/**
 * Create the replayable liveTokenStats projection definition.
 * @param spec - resolved estimator spec.
 * @returns the projection definition for sessionProjections.register().
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
    // Bump only when serialized state fields or fold semantics change.
    // v4: tool-call 参数反转义（esc 状态）——官方按解码后内容计费。
    stateVersion: 4,
  }
}
