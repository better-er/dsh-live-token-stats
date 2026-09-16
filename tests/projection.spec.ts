import { describe, expect, it } from 'vitest'
import {
  activeStepApply,
  createLiveTokenStatsDefinition,
  type ActiveStepState,
} from '../src/projection.ts'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'

/** 空日志初始化参数：header 与继承前缀对被测折叠没有影响。 */
const HEADER = {} as SessionHeader
const NO_INHERIT = 0 as unknown as SessionLogOffset

/** 构建一个最小会话事件。被测的折叠不关心 seq。 */
function event(seq: number, type: string, data: unknown, time = 1000 + seq * 10): SessionEvent {
  return { type, data, time, seq } as unknown as SessionEvent
}

function stepStart(seq: number, turn = 0, step = 0, time = 1000): SessionEvent {
  return event(seq, 'step/start', { turn, step }, time)
}

/** 一条带单个文本增量的 assistant/message，紧凑记录的首个成员时间即 time0。 */
function textDelta(seq: number, text: string, time = 1000 + seq * 10): SessionEvent {
  return event(seq, 'assistant/message', {
    turn: 0,
    step: 0,
    stream: [{ type: 'text-chunks', time0: time, index: 0, dt: [], texts: [text] }],
  }, time)
}

/** 一条只带官方 usage 的 assistant/message。 */
function usageChunk(seq: number, outputTokens: number, time = 1000 + seq * 10): SessionEvent {
  return event(seq, 'assistant/message', {
    turn: 0,
    step: 0,
    stream: [],
    usage: { inputTokens: 0, outputTokens },
  }, time)
}

function stepEnd(seq: number, turn = 0, step = 0, time = 1000 + seq * 10): SessionEvent {
  return event(seq, 'step/end', { turn, step }, time)
}

const ACTIVE_INIT: ActiveStepState = { active: null, lastSettled: null }

describe('activeStepApply', () => {
  it('step/start 打开一个 step', () => {
    const next = activeStepApply(ACTIVE_INIT, stepStart(0, 1, 2, 5000))
    expect(next.active).toEqual({
      turn: 1, step: 2, startTime: 5000, firstTokenTime: null, exact: false,
    })
  })

  it('首个文本 delta 记录首字时间，后续 delta 不覆盖', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000))
    s = activeStepApply(s, textDelta(1, 'hello', 1010))
    expect(s.active!.firstTokenTime).toBe(1010)
    s = activeStepApply(s, textDelta(2, ' world', 1020))
    expect(s.active!.firstTokenTime).toBe(1010)
  })

  it('usage 记录实际值并置 exact', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000))
    s = activeStepApply(s, usageChunk(1, 88, 1020))
    expect(s.active!.actualTokens).toBe(88)
    expect(s.active!.exact).toBe(true)
  })

  it('v2：从 assistant/message.stream 取首字与 usage', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000))
    s = activeStepApply(s, event(1, 'assistant/message', {
      turn: 0,
      step: 0,
      // 紧凑记录：第 i 个成员的原始时间 = time0 + 前 i 个 dt 之和
      stream: [{ type: 'text-chunks', time0: 1010, index: 0, dt: [10], texts: ['hello', ' world'] }],
      usage: { inputTokens: 0, outputTokens: 20 },
    }, 1030))
    expect(s.active!.firstTokenTime).toBe(1010)
    expect(s.active!.actualTokens).toBe(20)
    expect(s.active!.exact).toBe(true)
  })

  it('step/end 结算进 lastSettled 并带 endTime', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 3, 4, 1000))
    s = activeStepApply(s, textDelta(1, 'hi', 1010))
    s = activeStepApply(s, usageChunk(2, 20, 1020))
    s = activeStepApply(s, stepEnd(3, 3, 4, 2000))
    expect(s.active).toBeNull()
    expect(s.lastSettled).toMatchObject({
      turn: 3, step: 4, firstTokenTime: 1010, endTime: 2000, actualTokens: 20, exact: true,
    })
  })

  it('turn/end 取消时丢弃未结算时间线', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000))
    s = activeStepApply(s, textDelta(1, 'abandon this', 1010))
    s = activeStepApply(s, event(2, 'turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 1020))
    expect(s.active).toBeNull()
  })

  it('无关事件返回同一引用', () => {
    const before = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000))
    const after = activeStepApply(before, event(1, 'request/header', { header: {}, reason: 'initial' }))
    expect(after).toBe(before)
  })
})

describe('createLiveTokenStatsDefinition', () => {
  it('是可重放投影，stateVersion 为 8，状态只含时间线', () => {
    const def = createLiveTokenStatsDefinition()
    expect(def.key).toBe('liveTokenStats')
    expect(def.stateVersion).toBe(8)
    const init = def.init(HEADER, NO_INHERIT)
    expect(def.wire!.view(init)).toEqual({ active: null, lastSettled: null })
    // 持久化状态必须能过 stateSchema，这是缓存恢复的前提
    expect(def.stateSchema.parse(init)).toEqual(init)
  })

  it('view 输出时间线与 usage 并通过边界 schema', () => {
    const def = createLiveTokenStatsDefinition()
    let state = def.init(HEADER, NO_INHERIT)
    state = def.apply(state, stepStart(0, 0, 0, 1000))
    state = def.apply(state, textDelta(1, 'hello', 1010))
    // 状态里没有原文，只有时间戳与数字
    expect(JSON.stringify(state)).not.toContain('hello')
    state = def.apply(state, usageChunk(2, 9, 1020))
    const value = def.wire!.view(state)
    const parsed = def.wire!.viewSchema.parse(value)
    expect(parsed.active!.firstTokenTime).toBe(1010)
    expect(parsed.active!.actualTokens).toBe(9)
  })
})

