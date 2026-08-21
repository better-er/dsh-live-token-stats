import { describe, expect, it } from 'vitest'
import { ESTIMATOR_DEFAULTS, type EstimatorSpec } from '../src/estimator.ts'
import {
  activeStepApply,
  createLiveTokenStatsDefinition,
  throughputApply,
  type ActiveStepState,
  type ThroughputState,
} from '../src/projection.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const SPEC: Readonly<EstimatorSpec> = ESTIMATOR_DEFAULTS

/** Build a minimal session event. seq is not used by the folds under test. */
function event(seq: number, type: string, data: unknown, time = 1000 + seq * 10): SessionEvent {
  return { type, data, time, seq } as unknown as SessionEvent
}

function stepStart(seq: number, turn = 0, step = 0, time = 1000): SessionEvent {
  return event(seq, 'step/start', { turn, step }, time)
}

function textDelta(seq: number, text: string, time = 1000 + seq * 10, turn = 0, step = 0): SessionEvent {
  return event(seq, 'assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text } }, time)
}

function usageChunk(seq: number, outputTokens: number, time = 1000 + seq * 10, turn = 0, step = 0): SessionEvent {
  return event(seq, 'assistant/chunk', { turn, step, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens } } }, time)
}

function stepEnd(seq: number, turn = 0, step = 0, time = 1000 + seq * 10): SessionEvent {
  return event(seq, 'step/end', { turn, step }, time)
}

const ACTIVE_INIT: ActiveStepState = { active: null, lastSettled: null }
const THROUGHPUT_INIT: ThroughputState = { samples: [], totalTokens: 0, currentRate: undefined }

describe('activeStepApply', () => {
  it('opens a step on step/start', () => {
    const next = activeStepApply(ACTIVE_INIT, stepStart(0, 1, 2, 5000), SPEC)
    expect(next.active).toEqual({
      turn: 1, step: 2, startTime: 5000, firstTokenTime: null, estimatedTokens: 0, exact: false,
    })
  })

  it('accumulates the output estimate across text deltas and records first token', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    s = activeStepApply(s, textDelta(1, 'hello', 1010), SPEC)
    s = activeStepApply(s, textDelta(2, ' world', 1020), SPEC)
    expect(s.active!.firstTokenTime).toBe(1010)
    // hello(5 ascii)=2, " world"(6 ascii)=2 -> 4
    expect(s.active!.estimatedTokens).toBe(4)
    expect(s.active!.exact).toBe(false)
  })

  it('keeps the estimate and records provider usage separately', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    s = activeStepApply(s, textDelta(1, 'hello', 1020), SPEC)
    expect(s.active!.estimatedTokens).toBe(2)
    s = activeStepApply(s, usageChunk(2, 88, 1030), SPEC)
    expect(s.active!.estimatedTokens).toBe(2)
    expect(s.active!.actualTokens).toBe(88)
    expect(s.active!.exact).toBe(true)
  })

  it('stops accumulating once provider usage is exact', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    s = activeStepApply(s, usageChunk(1, 88, 1020), SPEC)
    s = activeStepApply(s, textDelta(2, 'more', 1030), SPEC)
    expect(s.active!.estimatedTokens).toBe(0)
    expect(s.active!.actualTokens).toBe(88)
    expect(s.active!.firstTokenTime).toBeNull()
  })

  it('settles on step/end into lastSettled with both estimates and actuals', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 3, 4, 1000), SPEC)
    s = activeStepApply(s, textDelta(1, 'hi', 1010), SPEC)
    s = activeStepApply(s, usageChunk(2, 20, 1020), SPEC)
    s = activeStepApply(s, stepEnd(3, 3, 4, 2000), SPEC)
    expect(s.active).toBeNull()
    expect(s.lastSettled).toMatchObject({
      turn: 3, step: 4, firstTokenTime: 1010, endTime: 2000,
      estimatedTokens: 1, actualTokens: 20, exact: true,
    })
  })

  it('abandons an unsettled estimate on a cancelled turn/end', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    s = activeStepApply(s, textDelta(1, 'abandon this', 1010), SPEC)
    s = activeStepApply(s, event(2, 'turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 1020), SPEC)
    expect(s.active).toBeNull()
  })

  it('returns the same reference for unrelated events', () => {
    const before = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    const after = activeStepApply(before, event(1, 'request/header', { header: {}, reason: 'initial' }), SPEC)
    expect(after).toBe(before)
  })
})

describe('throughputApply', () => {
  it('computes a live rate within the window', () => {
    let t: ThroughputState = THROUGHPUT_INIT
    t = throughputApply(t, textDelta(1, 'aaaa', 1000), SPEC)
    t = throughputApply(t, textDelta(2, 'aaaa', 2000), SPEC)
    // 4 ascii *0.3 = 1.2 -> 1 tok each; 2 tokens over (2000-1000)=1s -> 2 tok/s
    expect(t.currentRate).toBeCloseTo(2, 5)
  })

  it('ignores non-delta chunks', () => {
    const t = throughputApply(THROUGHPUT_INIT, event(1, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } }), SPEC)
    expect(t).toBe(THROUGHPUT_INIT)
  })
})

describe('createLiveTokenStatsDefinition', () => {
  it('is a replayable projection with init/apply/wire/stateSchema/stateVersion', () => {
    const def = createLiveTokenStatsDefinition(SPEC)
    expect(def.key).toBe('liveTokenStats')
    expect(def.stateVersion).toBe(2)
    const init = def.init()
    expect(def.wire!.view(init)).toEqual({ active: null, lastSettled: null })
    // 持久化状态必须能过 stateSchema(缓存恢复的前提)
    expect(def.stateSchema.parse(init)).toEqual(init)
  })

  it('view passes the boundary schema with estimated and actual tokens', () => {
    const def = createLiveTokenStatsDefinition(SPEC)
    let state = def.init()
    state = def.apply(state, stepStart(0, 0, 0, 1000))
    state = def.apply(state, textDelta(1, 'hello', 1010))
    state = def.apply(state, usageChunk(2, 9, 1020))
    const value = def.wire!.view(state)
    const parsed = def.wire!.viewSchema.parse(value)
    expect(parsed.active!.estimatedTokens).toBe(2)
    expect(parsed.active!.actualTokens).toBe(9)
  })
})