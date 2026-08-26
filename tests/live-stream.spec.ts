/**
 * Unit tests for the live rate tracker — the real-time host half that folds
 * raw `llm/stream` adapter chunks (text / reasoning / tool-call argument
 * fragments) into a per-session windowed tokens/sec figure.
 *
 * Focuses on the contracts the session-event projection cannot cover: the
 * same-timestamp burst guard, window expiry, the TTFT-inclusive span that
 * slides from step start up to the window size then stays fixed, stall
 * accounting, and idle reset. All snapshots pass an explicit `asOf` so the
 * simulated timelines never collide with the real clock.
 */

import { describe, expect, it } from 'vitest'
import { LiveTokenRateTracker } from '../src/live-stream.ts'
import { ESTIMATOR_DEFAULTS, type EstimatorSpec } from '../src/estimator.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm/brand'

const SPEC: Readonly<EstimatorSpec> = { ...ESTIMATOR_DEFAULTS, tokenizerMode: 'density' }
const BPE_SPEC: Readonly<EstimatorSpec> = { ...ESTIMATOR_DEFAULTS, tokenizerMode: 'bpe' }

function textDelta(text: string): StreamChunk {
  return { type: 'text-delta', index: 0, text }
}

function toolCallDelta(argumentsDelta: string): StreamChunk {
  return { type: 'tool-call-delta', index: 0, id: CallId('call-1'), name: 'write', argumentsDelta }
}

/** density 模式：33 个 ASCII ≈ 10 token。 */
function tenTokenFrame(): StreamChunk {
  return textDelta('a'.repeat(33))
}

const SESSION = 'session-1'

describe('LiveTokenRateTracker', () => {
  it('starts idle: no snapshot before any delta', () => {
    const t = new LiveTokenRateTracker(SPEC)
    const snap = t.snapshot(SESSION, 10000)
    expect(snap.tokensPerSecond).toBeUndefined()
    expect(snap.updatedAt).toBe(0)
    expect(snap.stallMs).toBe(0)
  })

  it('ignores non-delta chunks and empty deltas', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.fold(SESSION, { type: 'block-start', index: 0, blockType: 'text' }, 1000)
    t.fold(SESSION, { type: 'tool-call-delta', index: 0, id: CallId(''), argumentsDelta: '' }, 1000)
    expect(t.snapshot(SESSION, 10000).tokensPerSecond).toBeUndefined()
  })

  it('computes a sane rate for sparse text deltas', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // 100 tokens across 1 second → ~100 tok/s.
    for (let i = 0; i < 10; i += 1) {
      t.fold(SESSION, tenTokenFrame(), 1000 + i * 100)
    }
    const snap = t.snapshot(SESSION, 2000)
    expect(snap.tokensPerSecond).toBeGreaterThan(50)
    expect(snap.tokensPerSecond).toBeLessThan(200)
    expect(snap.updatedAt).toBeGreaterThan(0)
  })

  it('does NOT explode on a huge same-timestamp tool-call argument delta (burst guard)', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // 一条 13.5k 字符的参数 delta 单帧到达：13554 * 0.3 ≈ 4066 token，
    // 50ms 下限兜底，速率有界，不会除零爆表。
    t.fold(SESSION, toolCallDelta('x'.repeat(13554)), 5000)
    const snap = t.snapshot(SESSION, 5000)
    expect(snap.tokensPerSecond).toBeDefined()
    expect(snap.tokensPerSecond!).toBeLessThan(100000)
  })

  it('expires samples outside the window', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // 老 burst 在 ~1s，共 10*99 ≈ 990 token，远超 3s 窗口。
    for (let i = 0; i < 10; i += 1) t.fold(SESSION, textDelta('a'.repeat(330)), 1000 + i)
    // 新样本 10 token 于 10000ms。若老 burst 存活，速率 ≈ 1000/0.05 = 20000。
    t.fold(SESSION, tenTokenFrame(), 10000)
    const snap = t.snapshot(SESSION, 10000)
    expect(snap.tokensPerSecond!).toBeGreaterThan(50)
    expect(snap.tokensPerSecond!).toBeLessThan(1000)
  })

  it('TTFT 随窗口滑动：分母 = min(流逝时间, 窗口)，等待首字期不外发速率', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    // 等待首字期：尚无样本，数学上未定义，不发假 0。
    expect(t.snapshot(SESSION, 1700).tokensPerSecond).toBeUndefined()
    // 首字 2700ms 到达，TTFT 1.7s；10 帧共 100 token。
    for (let i = 0; i < 10; i += 1) t.fold(SESSION, tenTokenFrame(), 2700 + i * 10)
    const snap = t.snapshot(SESSION, 2790)
    // span = min(2790-1000, 3000) = 1790ms → 100/1.79 ≈ 55.9 tok/s。
    expect(snap.tokensPerSecond!).toBeGreaterThan(40)
    expect(snap.tokensPerSecond!).toBeLessThan(70)
  })

  it('流逝超过窗口后，分母固定为窗口定值，不再增长', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    // 4000..5200ms 每 100ms 一帧，共 13 帧 = 130 token。
    for (let i = 0; i < 13; i += 1) t.fold(SESSION, tenTokenFrame(), 4000 + i * 100)
    const snap = t.snapshot(SESSION, 6000)
    // 分母 = min(5000, 3000) = 3000，窗口 3s 内全样本存活 → 130/3 ≈ 43.3 tok/s。
    expect(snap.tokensPerSecond).toBeDefined()
    expect(snap.tokensPerSecond!).toBeCloseTo(130 / 3, 1)
    // 同一批样本，推进 1s 后分母仍封顶 3000，速率不变，验证定值语义。
    const later = t.snapshot(SESSION, 7000)
    expect(later.tokensPerSecond).toBeCloseTo(snap.tokensPerSecond!, 1)
  })

  it('停顿超窗无样本后，速率不外发，不进假 0', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    t.fold(SESSION, tenTokenFrame(), 1500)
    expect(t.snapshot(SESSION, 2000).tokensPerSecond).toBeDefined()
    // 停顿远超 3s 窗口，样本全部滑出。
    expect(t.snapshot(SESSION, 6000).tokensPerSecond).toBeUndefined()
  })

  it('累计停顿时长：长间隔计入，进行中实时增长，快照不结算', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    t.fold(SESSION, tenTokenFrame(), 1200)
    t.fold(SESSION, tenTokenFrame(), 3000) // gap 1800 ≥ 300 → stallMs = 1800
    let snap = t.snapshot(SESSION, 3000)
    expect(snap.stallMs).toBe(1800)
    // 进行中 idle 900ms ≥ 300 → 显示 2700，但字段未结算。
    snap = t.snapshot(SESSION, 3900)
    expect(snap.stallMs).toBe(2700)
    t.fold(SESSION, tenTokenFrame(), 5000) // gap 2000 → 字段 = 1800 + 2000 = 3800
    snap = t.snapshot(SESSION, 5000)
    expect(snap.stallMs).toBe(3800)
  })

  it('normal delta spacing does not count as stall', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    t.fold(SESSION, tenTokenFrame(), 1200)
    t.fold(SESSION, tenTokenFrame(), 1300) // gap 100 < 300，正常节奏
    t.fold(SESSION, tenTokenFrame(), 1400)
    expect(t.snapshot(SESSION, 1400).stallMs).toBe(0)
  })

  it('beginStep 重置停顿与样本，开启新 step 计时', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    t.fold(SESSION, tenTokenFrame(), 1200)
    const before = t.snapshot(SESSION, 1200)
    expect(before.stallMs).toBe(0)
    expect(before.tokensPerSecond).toBeDefined()
    t.beginStep(SESSION, 20000)
    const snap = t.snapshot(SESSION, 21000)
    expect(snap.stallMs).toBe(0)
    expect(snap.tokensPerSecond).toBeUndefined()
  })

  it('reset drops the session cell', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.fold(SESSION, textDelta('hello world'), 1000)
    expect(t.snapshot(SESSION, 1000).tokensPerSecond).toBeDefined()
    t.reset(SESSION)
    expect(t.snapshot(SESSION, 1000).tokensPerSecond).toBeUndefined()
  })

  it('is per-session isolated', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.fold('s-a', textDelta('a'.repeat(330)), 1000)
    expect(t.snapshot('s-b', 1000).tokensPerSecond).toBeUndefined()
    expect(t.snapshot('s-a', 1000).tokensPerSecond).toBeDefined()
  })

  it('folding a streamed arguments fragment count toward output like text', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.fold(SESSION, toolCallDelta('{"path": '), 1000)
    t.fold(SESSION, toolCallDelta('"C:\\\\tmp\\\\a.json", "content": "abc"'), 1100)
    const snap = t.snapshot(SESSION, 1200)
    expect(snap.tokensPerSecond).toBeDefined()
    expect(snap.tokensPerSecond!).toBeGreaterThan(0)
  })

  it('BPE 模式：分片参数的增量计数与真实分词一致', () => {
    const t = new LiveTokenRateTracker(BPE_SPEC)
    t.fold(SESSION, toolCallDelta('{"path": "C:/tmp/'), 1000)
    t.fold(SESSION, toolCallDelta('a.json", "content": "你好世界"}'), 1100)
    const snap = t.snapshot(SESSION, 1200)
    expect(snap.tokensPerSecond).toBeDefined()
    expect(snap.tokensPerSecond!).toBeGreaterThan(0)
  })

  it('BPE 模式：tool-call 首帧携带的 name 计入输出', () => {
    const t = new LiveTokenRateTracker(BPE_SPEC)
    t.fold(SESSION, { type: 'tool-call-delta', index: 0, id: CallId('call-1'), name: 'write_file', argumentsDelta: '' }, 1000)
    const snap = t.snapshot(SESSION, 1000)
    expect(snap.tokensPerSecond).toBeDefined()
    expect(snap.tokensPerSecond!).toBeGreaterThan(0)
  })

  it('BPE 模式：工具参数按解码后内容计数（转义原文不再直接 BPE）', () => {
    const t = new LiveTokenRateTracker(BPE_SPEC)
    const frames = [
      '{"content": "a\\',
      'nb"}',
    ]
    for (let i = 0; i < frames.length; i += 1) {
      t.fold(SESSION, toolCallDelta(frames[i] as string), 1000 + i)
    }
    const snap = t.snapshot(SESSION, 1100)
    expect(snap.tokensPerSecond).toBeDefined()
    expect(snap.tokensPerSecond!).toBeGreaterThan(0)
  })
})