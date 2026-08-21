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

const ACTIVE_INIT: ActiveStepState = { active: null, lastSettled: null }

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
    if (text.length === 0) return state
    return {
      ...state,
      active: {
        ...state.active,
        firstTokenTime: state.active.firstTokenTime === null ? event.time : state.active.firstTokenTime,
        estimatedTokens: state.active.estimatedTokens + estimateTextTokens(text, spec),
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
    return { ...state, active: null }
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
}

const THROUGHPUT_INIT: ThroughputState = { samples: [], totalTokens: 0, currentRate: undefined }

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
  return { samples, totalTokens: total, currentRate }
}

/** Pure fold for the throughput metric unit. */
export function throughputApply(
  state: ThroughputState,
  event: SessionEvent,
  spec: Readonly<EstimatorSpec>,
): ThroughputState {
  if (event.type === 'assistant/chunk' && isDeltaChunk(event.data.chunk)) {
    const text = deltaText(event.data.chunk)
    if (text.length === 0) return state
    const tokens = estimateTextTokens(text, spec)
    return slideWindow(
      { samples: [...state.samples, { time: event.time, tokens }], totalTokens: state.totalTokens + tokens, currentRate: state.currentRate },
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

const throughputSampleSchema = z.object({
  time: z.number(),
  tokens: z.number().nonnegative(),
}).strict()

const throughputStateSchema = z.object({
  samples: z.array(throughputSampleSchema),
  totalTokens: z.number().nonnegative(),
  currentRate: z.number().nonnegative().optional(),
}).strict()

const activeStepStateSchema = z.object({
  active: activeSchema.nullable(),
  lastSettled: lastSettledSchema.nullable(),
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
    stateVersion: 2,
  }
}
