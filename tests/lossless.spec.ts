/**
 * 投影状态的无损 JSON 边界回归。
 *
 * 这一组用例守的是一条曾经在生产上炸过的边界：`liveTokenStats` 在 step 被 kill、
 * 从未收到 usage 时，把 `active.actualTokens` 的 `undefined` 原样复制进了 `lastSettled`。
 * 后果不在插件内可见——投影缓存整条写入失败、宿主转发 `api-session/added` 抛错，
 * 界面表现是会话行消失/闪跳、fork 点了没反应。用例按「按值判定」而不是「按形状判定」，
 * 因为 `undefined` 值在 `toEqual` 与 `Object.keys` 下都容易被漏掉。
 */
import { describe, expect, it } from 'vitest'
import { ESTIMATOR_DEFAULTS, type EstimatorSpec } from '../src/estimator.ts'
import {
  activeStepApply,
  activeStepView,
  createLiveTokenStatsDefinition,
  setLosslessAssertions,
  type ActiveStepState,
} from '../src/projection.ts'
import { assertLosslessJson, findNonJsonPath, omitUndefined } from '../src/compact.ts'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'

const SPEC: Readonly<EstimatorSpec> = { ...ESTIMATOR_DEFAULTS, tokenizerMode: 'density' }
const HEADER = {} as SessionHeader
const NO_INHERIT = 0 as unknown as SessionLogOffset

const ACTIVE_INIT: ActiveStepState = {
  active: null,
  lastSettled: null,
  inc: { buffer: '', counted: 0 },
  esc: { tail: '' },
  nameCountedIds: [],
}

function event(seq: number, type: string, data: unknown, time = 1000 + seq * 10): SessionEvent {
  return { type, data, time, seq } as unknown as SessionEvent
}

function stepStart(seq: number, turn = 0, step = 0, time = 1000): SessionEvent {
  return event(seq, 'step/start', { turn, step }, time)
}

function stepEnd(seq: number, turn = 0, step = 0, time = 1000 + seq * 10): SessionEvent {
  return event(seq, 'step/end', { turn, step }, time)
}

function textDelta(seq: number, text: string, time = 1000 + seq * 10, turn = 0, step = 0): SessionEvent {
  return event(seq, 'assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text } }, time)
}

/**
 * 判定一个值是否无损 JSON，独立于 src 的实现，作为被测实现的对照。
 * 判定口径与宿主 `isJsonValue` 一致：无 undefined、无函数/Symbol/BigInt、数字有限、无循环。
 */
function isLossless(value: unknown): boolean {
  return findNonJsonPath(value) === null
}

describe('无损 JSON 判定（对照实现自检）', () => {
  it('接受纯 JSON 数据', () => {
    expect(isLossless({ a: 1, b: [true, null, 'x'], c: { d: 0.5 } })).toBe(true)
  })

  it('拒绝 undefined 值、非有限数、函数、BigInt、Symbol 与循环', () => {
    expect(isLossless({ a: undefined })).toBe(false)
    expect(isLossless({ a: Number.NaN })).toBe(false)
    expect(isLossless({ a: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isLossless({ a: () => 1 })).toBe(false)
    expect(isLossless({ a: 1n })).toBe(false)
    expect(isLossless({ a: Symbol('s') })).toBe(false)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(isLossless(cyclic)).toBe(false)
  })

  it('把违规位置定位到具体字段路径', () => {
    const hit = findNonJsonPath({ a: { b: [{ c: undefined }] } })
    expect(hit).toEqual({ path: '$.a.b[0].c', why: 'undefined' })
  })
})

describe('omitUndefined', () => {
  it('去掉 undefined 值的键且保持其余键原样', () => {
    expect(omitUndefined({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null })
  })

  it('干净对象返回原引用，维持「无变化即同引用」语义', () => {
    const clean = { a: 1, b: null }
    expect(omitUndefined(clean)).toBe(clean)
  })
})

describe('投影状态的与无损 JSON 边界', () => {
  it('step 被 kill、从未收到 usage 时，lastSettled 的 actualTokens 键缺席而非 undefined', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 7, 1, 1000), SPEC)
    s = activeStepApply(s, textDelta(1, 'partial output', 1010), SPEC)
    // 此刻还没有 usage，被直接结算，正是历史事故的现场
    s = activeStepApply(s, stepEnd(2, 7, 1, 2000), SPEC)

    const settled = s.lastSettled
    expect(settled).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(settled, 'actualTokens')).toBe(false)
    expect('actualTokens' in settled!).toBe(false)
    expect(settled!.exact).toBe(false)
    expect(settled!.estimatedTokens).toBeGreaterThan(0)
    // 关键断言：状态整体无损，宿主转发与投影缓存都不会抛
    expect(isLossless(s)).toBe(true)
  })

  it('lastSettled 不因修补而丢字段：有 usage 时仍然带 actualTokens', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    s = activeStepApply(s, event(1, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 42 } } }, 1020), SPEC)
    s = activeStepApply(s, stepEnd(2, 0, 0, 2000), SPEC)
    expect(s.lastSettled!.actualTokens).toBe(42)
    expect(isLossless(s)).toBe(true)
  })

  it('turn/end 中断清空 active 后状态仍然无损', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    s = activeStepApply(s, textDelta(1, 'abandoned', 1010), SPEC)
    s = activeStepApply(s, event(2, 'turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 1020), SPEC)
    expect(s.active).toBeNull()
    expect(isLossless(s)).toBe(true)
  })

  it('整个 replayed 状态在任意前缀都无损', () => {
    const def = createLiveTokenStatsDefinition(SPEC)
    const events = [
      stepStart(0, 0, 0, 1000),
      textDelta(1, 'hello', 1010),
      stepEnd(2, 0, 0, 1100),
      stepStart(3, 0, 1, 1200),
      event(4, 'assistant/chunk', { turn: 0, step: 1, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 7 } } }, 1250),
      stepEnd(5, 0, 1, 1300),
      stepStart(6, 1, 0, 1400),
      event(7, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 1500),
    ]
    let state = def.init(HEADER, NO_INHERIT)
    expect(isLossless(state)).toBe(true)
    for (const item of events) {
      state = def.apply(state, item)
      expect(isLossless(state), `seq ${item.seq} ${item.type}`).toBe(true)
    }
  })

  it('view 出口同样无损，且过 viewSchema 后不变形', () => {
    const def = createLiveTokenStatsDefinition(SPEC)
    let state = def.init(HEADER, NO_INHERIT)
    state = def.apply(state, stepStart(0, 0, 0, 1000))
    state = def.apply(state, textDelta(1, 'no usage here', 1010))
    state = def.apply(state, stepEnd(2, 0, 0, 2000))
    const view = def.wire!.view(state)
    expect(isLossless(view)).toBe(true)
    // 无实际值时键缺席，客户端 `!== undefined` 判定为「无值」
    expect(view.lastSettled!.actualTokens).toBeUndefined()
    const parsed = def.wire!.viewSchema.parse(view)
    expect(parsed).toEqual(view)
  })

  it('历史污染状态的 view 出口被就地清理，不再把 undefined 转发出去', () => {
    // 模拟修复前写进内存的历史状态：键存在但值为 undefined
    const polluted: ActiveStepState = {
      ...ACTIVE_INIT,
      lastSettled: {
        turn: 0, step: 0, startTime: 1000, firstTokenTime: null,
        estimatedTokens: 3, actualTokens: undefined, exact: false, endTime: 2000,
      },
    }
    const view = activeStepView(polluted)
    expect(isLossless(view)).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(view.lastSettled, 'actualTokens')).toBe(false)
  })

  it('开发期断言在 throw 档下把违规路径点名抛出，off 档零动作', () => {
    setLosslessAssertions('throw')
    try {
      expect(() => assertLosslessJson({ activeStep: { lastSettled: { actualTokens: undefined } } }, 'liveTokenStats'))
        .toThrow(/lastSettled\.actualTokens 是 undefined/)
      expect(() => assertLosslessJson({ ok: 1 }, 'liveTokenStats')).not.toThrow()
    } finally {
      setLosslessAssertions('off')
    }
    expect(() => assertLosslessJson({ bad: undefined }, 'liveTokenStats')).not.toThrow()
  })
})
