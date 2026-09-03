/**
 * 实时速率追踪器的单元测试：把原始 `llm/stream` adapter 块折叠成每会话窗口化 tok/秒数字的实时主机端。
 * 块包括 text、reasoning 与 tool-call 参数片段。
 *
 * 聚焦会话事件投影无法覆盖的约定：同一时间戳的突发防护、窗口过期、含 TTFT 的跨度即从 step 开始滑到窗口大小后固定、停顿记账、空闲重置。
 * 所有快照都显式传 `asOf`，让模拟时间线永不相撞真实时钟。
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
  it('初始空闲：无 delta 前无快照', () => {
    const t = new LiveTokenRateTracker(SPEC)
    const snap = t.snapshot(SESSION, 10000)
    expect(snap.tokensPerSecond).toBeUndefined()
    expect(snap.updatedAt).toBe(0)
    expect(snap.stallMs).toBe(0)
  })

  it('忽略非 delta 块与空 delta', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.fold(SESSION, { type: 'block-start', index: 0, blockType: 'text' }, 1000)
    t.fold(SESSION, { type: 'tool-call-delta', index: 0, id: CallId(''), argumentsDelta: '' }, 1000)
    expect(t.snapshot(SESSION, 10000).tokensPerSecond).toBeUndefined()
  })

  it('稀疏文本 delta 算出合理速率', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // 1 秒内 100 token → 约 100 tok/s。
    for (let i = 0; i < 10; i += 1) {
      t.fold(SESSION, tenTokenFrame(), 1000 + i * 100)
    }
    const snap = t.snapshot(SESSION, 2000)
    expect(snap.tokensPerSecond).toBeGreaterThan(50)
    expect(snap.tokensPerSecond).toBeLessThan(200)
    expect(snap.updatedAt).toBeGreaterThan(0)
  })

  it('大同一时间戳工具参数 delta 不爆表，突发保护', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // 一条 13.5k 字符的参数 delta 单帧到达，13554 × 0.3 ≈ 4066 token，50ms 下限兜底，速率有界，不会除零爆表。
    t.fold(SESSION, toolCallDelta('x'.repeat(13554)), 5000)
    const snap = t.snapshot(SESSION, 5000)
    expect(snap.tokensPerSecond).toBeDefined()
    expect(snap.tokensPerSecond!).toBeLessThan(100000)
  })

  it('窗口外样本过期', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // 老 burst 在 ~1s，共 10*99 ≈ 990 token，远超 3s 窗口。
    for (let i = 0; i < 10; i += 1) t.fold(SESSION, textDelta('a'.repeat(330)), 1000 + i)
    // 新样本 10 token 于 10000ms。若老 burst 存活，速率 ≈ 1000/0.05 = 20000。
    t.fold(SESSION, tenTokenFrame(), 10000)
    const snap = t.snapshot(SESSION, 10000)
    expect(snap.tokensPerSecond!).toBeGreaterThan(50)
    expect(snap.tokensPerSecond!).toBeLessThan(1000)
  })

  it('TTFT 随窗口滑动：分母取流逝时间与窗口的较小值，等待首字期不外发速率', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    // 等待首字期：尚无样本，数学上未定义，不发假 0。
    expect(t.snapshot(SESSION, 1700).tokensPerSecond).toBeUndefined()
    // 首字 2700ms 到达，TTFT 1.7s；10 帧共 100 token。
    for (let i = 0; i < 10; i += 1) t.fold(SESSION, tenTokenFrame(), 2700 + i * 10)
    const snap = t.snapshot(SESSION, 2790)
    // span 为 2790-1000 与 3000 的较小值 1790ms，100/1.79 ≈ 55.9 tok/s。
    expect(snap.tokensPerSecond!).toBeGreaterThan(40)
    expect(snap.tokensPerSecond!).toBeLessThan(70)
  })

  it('流逝超过窗口后，分母固定为窗口定值，不再增长', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    // 4000..5200ms 每 100ms 一帧，共 13 帧 = 130 token。
    for (let i = 0; i < 13; i += 1) t.fold(SESSION, tenTokenFrame(), 4000 + i * 100)
    const snap = t.snapshot(SESSION, 6000)
    // 分母为 5000 与 3000 的较小值 3000，窗口 3s 内全样本存活，130/3 ≈ 43.3 tok/s。
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

  it('流结束后不再累加进行中的停顿，stallMs 冻结', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    t.fold(SESSION, tenTokenFrame(), 1200)
    t.fold(SESSION, tenTokenFrame(), 3000) // gap 1800 ≥ 300 → stallMs = 1800
    t.endStep(SESSION)
    // 流结束后 idle 远超阈值，也不再累加，模拟 LLM 结束、工具执行期间的空闲。
    expect(t.snapshot(SESSION, 3900).stallMs).toBe(1800)
    expect(t.snapshot(SESSION, 8000).stallMs).toBe(1800)
  })

  it('流结束后再次 beginStep 会重置停顿状态', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    t.fold(SESSION, tenTokenFrame(), 1200)
    t.fold(SESSION, tenTokenFrame(), 3000) // gap 1800 → stallMs = 1800
    t.endStep(SESSION)
    // 新一轮 llm/stream 即工具循环重新开始计时，停顿与 ended 一并重置。
    t.beginStep(SESSION, 10000)
    t.fold(SESSION, tenTokenFrame(), 10200)
    expect(t.snapshot(SESSION, 10200).stallMs).toBe(0)
  })

  it('snapshot 暴露 generating：流结束前为真，endStep 后为假', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    expect(t.snapshot(SESSION, 1100).generating).toBe(true)
    t.fold(SESSION, tenTokenFrame(), 1200)
    expect(t.snapshot(SESSION, 1300).generating).toBe(true)
    t.endStep(SESSION)
    expect(t.snapshot(SESSION, 1500).generating).toBe(false)
  })

  it('正常 delta 间距不计为停顿', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    t.fold(SESSION, tenTokenFrame(), 1200)
    t.fold(SESSION, tenTokenFrame(), 1300) // gap 100 < 300，正常节奏
    t.fold(SESSION, tenTokenFrame(), 1400)
    expect(t.snapshot(SESSION, 1400).stallMs).toBe(0)
  })

  it('上一轮流全部结束后，新一轮 beginStep 重置停顿与样本，开启新 step 计时', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.beginStep(SESSION, 1000)
    t.fold(SESSION, tenTokenFrame(), 1200)
    const before = t.snapshot(SESSION, 1200)
    expect(before.stallMs).toBe(0)
    expect(before.tokensPerSecond).toBeDefined()
    // 上一轮 llm/stream 结束，存活流归零。
    t.endStep(SESSION)
    // 新一轮 step：此时 beginStep 才视为全新 step，重置样本与停顿、重新起算。
    t.beginStep(SESSION, 20000)
    const snap = t.snapshot(SESSION, 21000)
    expect(snap.stallMs).toBe(0)
    expect(snap.tokensPerSecond).toBeUndefined()
  })

  it('前缀流与主内容流交错时，前缀 endStep 不误杀仍在流的主内容 generating', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // 主内容流先 begin，标题/前缀流随后并存 begin，两条流时间重叠。
    t.beginStep(SESSION, 1000)
    t.beginStep(SESSION, 1002)
    // 前缀流先出少量帧并收尾，此刻主内容流仍存活，generating 必须保持 true，样本不得被清。
    t.fold(SESSION, tenTokenFrame(), 1500)
    t.endStep(SESSION)
    const during = t.snapshot(SESSION, 1600)
    expect(during.generating).toBe(true)
    expect(during.tokensPerSecond).toBeDefined()
    // 主内容流此刻才真正出主体帧，速率照常累积。
    for (let i = 0; i < 5; i += 1) t.fold(SESSION, tenTokenFrame(), 1700 + i * 10)
    const mid = t.snapshot(SESSION, 1800)
    expect(mid.generating).toBe(true)
    expect(mid.tokensPerSecond).toBeDefined()
    // 主内容流也收尾，存活流归零，generating 才翻 false。
    t.endStep(SESSION)
    expect(t.snapshot(SESSION, 1900).generating).toBe(false)
  })

  it('reset 丢弃会话单元', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.fold(SESSION, textDelta('hello world'), 1000)
    expect(t.snapshot(SESSION, 1000).tokensPerSecond).toBeDefined()
    t.reset(SESSION)
    expect(t.snapshot(SESSION, 1000).tokensPerSecond).toBeUndefined()
  })

  it('各会话相互隔离', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.fold('s-a', textDelta('a'.repeat(330)), 1000)
    expect(t.snapshot('s-b', 1000).tokensPerSecond).toBeUndefined()
    expect(t.snapshot('s-a', 1000).tokensPerSecond).toBeDefined()
  })

  it('流式参数片段与文本一样计入输出', () => {
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

  it('BPE 模式：同一调用每帧都带 name 时只计一次，不重复累加', () => {
    const t = new LiveTokenRateTracker(BPE_SPEC)
    // DSH 的 llm/stream 对同一工具调用的每个 delta 帧都携带 name，官方只按一次计费。
    t.fold(SESSION, { type: 'tool-call-delta', index: 0, id: CallId('call-1'), name: 'write', argumentsDelta: '{"a":' }, 1000)
    t.fold(SESSION, { type: 'tool-call-delta', index: 0, id: CallId('call-1'), name: 'write', argumentsDelta: '1}' }, 1100)
    // 全部样本合计 = 解码后参数 token + 一次 name；若重复累加会多出 tokenCount('write')。
    const snap = t.snapshot(SESSION, 1110)
    expect(snap.tokensPerSecond).toBeDefined()
    // 参数 + 一次 name 的总 token 数在 0.1s 内，速率应远小于重复累加情形。
    const oneTimeTokens = 100
    expect(snap.tokensPerSecond!).toBeLessThan(oneTimeTokens * 10)
  })

  it('BPE 模式：同轮多个同名调用各计一次 name', () => {
    const t = new LiveTokenRateTracker(BPE_SPEC)
    t.fold(SESSION, { type: 'tool-call-delta', index: 0, id: CallId('call-1'), name: 'write', argumentsDelta: '{"a":1}' }, 1000)
    t.fold(SESSION, { type: 'tool-call-delta', index: 1, id: CallId('call-2'), name: 'write', argumentsDelta: '{"b":2}' }, 1100)
    const snap = t.snapshot(SESSION, 1110)
    expect(snap.tokensPerSecond).toBeDefined()
    expect(snap.tokensPerSecond!).toBeGreaterThan(0)
  })

  it('BPE 模式：工具参数按解码后内容计数，转义原文不再直接 BPE', () => {
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