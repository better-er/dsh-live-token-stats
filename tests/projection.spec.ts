import { describe, expect, it } from 'vitest'
import { ESTIMATOR_DEFAULTS, type EstimatorSpec } from '../src/estimator.ts'
import {
  activeStepApply,
  createLiveTokenStatsDefinition,
  throughputApply,
  type ActiveStepState,
  type ThroughputState,
} from '../src/projection.ts'
import { tokenCount } from '../src/tokenizer/bpe.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

// 旧行为测试显式用 density 模式，数值断言不变，bpe 模式在下方专项用例验证。
const SPEC: Readonly<EstimatorSpec> = { ...ESTIMATOR_DEFAULTS, tokenizerMode: 'density' }
const BPE_SPEC: Readonly<EstimatorSpec> = { ...ESTIMATOR_DEFAULTS, tokenizerMode: 'bpe' }

/** 构建一个最小会话事件。被测的折叠不关心 seq。 */
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

const ACTIVE_INIT: ActiveStepState = { active: null, lastSettled: null, inc: { buffer: '', counted: 0 }, esc: { tail: '' }, nameCountedIds: [] }
const THROUGHPUT_INIT: ThroughputState = { samples: [], totalTokens: 0, currentRate: undefined, inc: { buffer: '', counted: 0 }, esc: { tail: '' }, nameCountedIds: [] }

describe('activeStepApply', () => {
  it('step/start 打开一个 step', () => {
    const next = activeStepApply(ACTIVE_INIT, stepStart(0, 1, 2, 5000), SPEC)
    expect(next.active).toEqual({
      turn: 1, step: 2, startTime: 5000, firstTokenTime: null, estimatedTokens: 0, exact: false,
    })
  })

  it('跨文本 delta 累计输出估算并记录首字', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    s = activeStepApply(s, textDelta(1, 'hello', 1010), SPEC)
    s = activeStepApply(s, textDelta(2, ' world', 1020), SPEC)
    expect(s.active!.firstTokenTime).toBe(1010)
    // hello 为 5 个 ascii 计 2，world 为 6 个 ascii 计 2，合计 4
    expect(s.active!.estimatedTokens).toBe(4)
    expect(s.active!.exact).toBe(false)
  })

  it('估算与官方 usage 分开记录', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    s = activeStepApply(s, textDelta(1, 'hello', 1020), SPEC)
    expect(s.active!.estimatedTokens).toBe(2)
    s = activeStepApply(s, usageChunk(2, 88, 1030), SPEC)
    expect(s.active!.estimatedTokens).toBe(2)
    expect(s.active!.actualTokens).toBe(88)
    expect(s.active!.exact).toBe(true)
  })

  it('usage 精确后停止累计', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    s = activeStepApply(s, usageChunk(1, 88, 1020), SPEC)
    s = activeStepApply(s, textDelta(2, 'more', 1030), SPEC)
    expect(s.active!.estimatedTokens).toBe(0)
    expect(s.active!.actualTokens).toBe(88)
    expect(s.active!.firstTokenTime).toBeNull()
  })

  it('step/end 结算进 lastSettled 并同时记录估算与实际', () => {
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

  it('turn/end 取消时丢弃未结算估算', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    s = activeStepApply(s, textDelta(1, 'abandon this', 1010), SPEC)
    s = activeStepApply(s, event(2, 'turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 1020), SPEC)
    expect(s.active).toBeNull()
  })

  it('无关事件返回同一引用', () => {
    const before = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), SPEC)
    const after = activeStepApply(before, event(1, 'request/header', { header: {}, reason: 'initial' }), SPEC)
    expect(after).toBe(before)
  })
})

describe('throughputApply', () => {
  it('窗口内计算实时速率', () => {
    let t: ThroughputState = THROUGHPUT_INIT
    t = throughputApply(t, textDelta(1, 'aaaa', 1000), SPEC)
    t = throughputApply(t, textDelta(2, 'aaaa', 2000), SPEC)
    // 4 个 ascii 乘 0.3 等于 1.2 每段计 1 token，2 token 除以 1s 得 2 tok/s
    expect(t.currentRate).toBeCloseTo(2, 5)
  })

  it('忽略非 delta 块', () => {
    const t = throughputApply(THROUGHPUT_INIT, event(1, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } }), SPEC)
    expect(t).toBe(THROUGHPUT_INIT)
  })
})

describe('createLiveTokenStatsDefinition', () => {
  it('是可重放投影，含 init/apply/wire/stateSchema/stateVersion', () => {
    const def = createLiveTokenStatsDefinition(SPEC)
    expect(def.key).toBe('liveTokenStats')
    expect(def.stateVersion).toBe(5)
    const init = def.init()
    expect(def.wire!.view(init)).toEqual({ active: null, lastSettled: null })
    // 持久化状态必须能过 stateSchema，这是缓存恢复的前提
    expect(def.stateSchema.parse(init)).toEqual(init)
  })

  it('view 输出含估算与实际 token 且过边界 schema', () => {
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

describe('BPE 模式，tokenizerMode: bpe', () => {
  it('activeStep 的估算累计与真实 BPE 切分一致，跨帧合并', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), BPE_SPEC)
    // '发展' 拆成两帧喂入：增量 buffer 合并后应与整句 tokenCount 一致
    s = activeStepApply(s, textDelta(1, '发展', 1010), BPE_SPEC)
    s = activeStepApply(s, textDelta(2, '中国特色社会主义', 1020), BPE_SPEC)
    expect(s.active!.estimatedTokens).toBe(tokenCount('发展中国特色社会主义'))
  })

  it('throughput 的样本 token 数与真实 BPE 切分一致', () => {
    let t = throughputApply(THROUGHPUT_INIT, textDelta(1, '苹果 banana 123', 1000), BPE_SPEC)
    // 单帧 total 增量 = 全文 token 数
    expect(t.samples[0].tokens).toBe(tokenCount('苹果 banana 123'))
  })

  it('持久化状态含增量字段且可过 stateSchema，可重放', () => {
    const def = createLiveTokenStatsDefinition(BPE_SPEC)
    let state = def.init()
    state = def.apply(state, stepStart(0, 0, 0, 1000))
    state = def.apply(state, textDelta(1, '你好 world', 1010))
    expect(def.stateSchema.parse(state)).toEqual(state)
    // 重放：相同事件序列得到相同状态
    const init2 = def.init()
    const replayed = def.apply(init2, stepStart(0, 0, 0, 1000))
    const replayed2 = def.apply(replayed, textDelta(1, '你好 world', 1010))
    expect(replayed2).toEqual(state)
  })
})

describe('BPE 模式：tool-call 参数反转义，官方按解码后内容计费', () => {
  /** 构造 tool-call-delta 会话事件。 */
  function toolCallDelta(seq: number, argumentsDelta: string, time = 1000 + seq * 10, turn = 0, step = 0): SessionEvent {
    return event(seq, 'assistant/chunk', {
      turn, step,
      chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'write', argumentsDelta },
    })
  }

  it('单帧：转义原文按解码后内容计数，而非原文 BPE', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), BPE_SPEC)
    // 参数原文含 JSON 转义：\n 是 2 字符，解码后是 1 换行符
    s = activeStepApply(s, toolCallDelta(1, '{"content": "a\\nb"}'), BPE_SPEC)
    const decoded = '{"content": "a\nb"}'
    // 不再等于原文 tokenCount 即旧行为，而等于解码后 tokenCount 加 name
    expect(s.active!.estimatedTokens).toBe(tokenCount(decoded) + tokenCount('write'))
  })

  it('跨帧：悬空尾部跨帧合并后与整段解码一致', () => {
    const whole = '{"content": "第\\n二\\t行\\u4f60"}'
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), BPE_SPEC)
    // 逐字符切帧喂入，即极端流式，转义序列被拆得最碎。
    // 旧 adapter 语义：name 只在首个 tool-call 片段携带，后续帧不带；按 id 去重后与只首帧带等价。
    for (let i = 0; i < whole.length; i += 1) {
      const name = i === 0 ? 'write' : undefined
      s = activeStepApply(s, event(1, 'assistant/chunk', {
        turn: 0, step: 0,
        chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', ...name !== undefined ? { name } : {}, argumentsDelta: whole[i] },
      }), BPE_SPEC)
    }
    expect(s.active!.estimatedTokens).toBe(tokenCount('{"content": "第\n二\t行你"}') + tokenCount('write'))
  })

  it('真实流：同一调用每帧都带 name，只计一次不重复累加', () => {
    const whole = '{"content": "第\\n二\\t行\\u4f60"}'
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), BPE_SPEC)
    // DSH 的 llm/stream 对同一工具调用的每个 delta 帧都携带 name 字段，官方只按一次计费。
    // 若逐帧累加 name，估算会高出 (帧数-1) × tokenCount(name)，必须按 id 去重。
    for (let i = 0; i < whole.length; i += 1) {
      s = activeStepApply(s, event(1, 'assistant/chunk', {
        turn: 0, step: 0,
        chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'write', argumentsDelta: whole[i] },
      }), BPE_SPEC)
    }
    expect(s.active!.estimatedTokens).toBe(tokenCount('{"content": "第\n二\t行你"}') + tokenCount('write'))
  })

  it('单轮多个同名工具调用：每个调用各计一次 name', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), BPE_SPEC)
    // 同轮两个 write 调用，id 不同，官方分别计费，name 各计一次不得合并。
    s = activeStepApply(s, event(1, 'assistant/chunk', {
      turn: 0, step: 0,
      chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'write', argumentsDelta: '{"a":1}' },
    }), BPE_SPEC)
    s = activeStepApply(s, event(2, 'assistant/chunk', {
      turn: 0, step: 0,
      chunk: { type: 'tool-call-delta', index: 1, id: 'call-2', name: 'write', argumentsDelta: '{"b":2}' },
    }), BPE_SPEC)
    expect(s.active!.estimatedTokens)
      .toBe(tokenCount('{"a":1}') + tokenCount('write') + tokenCount('{"b":2}') + tokenCount('write'))
  })

  it('跨 step：新 step 重置 name 去重，同名调用再次计数', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), BPE_SPEC)
    s = activeStepApply(s, event(1, 'assistant/chunk', {
      turn: 0, step: 0,
      chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'write', argumentsDelta: '{"a":1}' },
    }), BPE_SPEC)
    const first = s.active!.estimatedTokens
    expect(first).toBe(tokenCount('{"a":1}') + tokenCount('write'))
    // 新 step：active 重建估算归零，name 去重集合随 step/start 重置，同名调用再次计数。
    s = activeStepApply(s, stepStart(2, 0, 1, 2000), BPE_SPEC)
    expect(s.active!.estimatedTokens).toBe(0)
    s = activeStepApply(s, event(3, 'assistant/chunk', {
      turn: 0, step: 1,
      chunk: { type: 'tool-call-delta', index: 0, id: 'call-9', name: 'write', argumentsDelta: '{"c":3}' },
    }), BPE_SPEC)
    expect(s.active!.estimatedTokens)
      .toBe(tokenCount('{"c":3}') + tokenCount('write'))
  })

  it('纯文本 delta 不受反转义影响，text-delta 不是 JSON 转义原文', () => {
    let s = activeStepApply(ACTIVE_INIT, stepStart(0, 0, 0, 1000), BPE_SPEC)
    s = activeStepApply(s, textDelta(1, 'a\\nb', 1010), BPE_SPEC)
    // text-delta 的内容就是原样文本，反斜杠加 n 保持 2 字符，与旧行为一致
    expect(s.active!.estimatedTokens).toBe(tokenCount('a\\nb'))
  })

  it('throughput 同样按解码后内容计数', () => {
    let t = throughputApply(THROUGHPUT_INIT, toolCallDelta(1, '{"content": "a\\nb"}'), BPE_SPEC)
    expect(t.samples[0].tokens).toBe(tokenCount('{"content": "a\nb"}') + tokenCount('write'))
  })
})