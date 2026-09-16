import { describe, expect, it } from 'vitest'
import { ESTIMATOR_DEFAULTS, type EstimatorSpec } from '../src/estimator.ts'
import { estimateAssistantMessage, findLastAssistantMessage } from '../src/settle.ts'
import { tokenCount } from '../src/tokenizer/bpe.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const BPE: Readonly<EstimatorSpec> = { ...ESTIMATOR_DEFAULTS, tokenizerMode: 'bpe' }
const DENSITY: Readonly<EstimatorSpec> = { ...ESTIMATOR_DEFAULTS, tokenizerMode: 'density' }

describe('estimateAssistantMessage', () => {
  it('跨帧文本整段一次切分', () => {
    const r = estimateAssistantMessage({
      stream: [{ type: 'text-chunks', time0: 1010, index: 0, dt: [10], texts: ['发展', '中国特色社会主义'] }],
    }, BPE)
    expect(r.estimated).toBe(tokenCount('发展中国特色社会主义'))
    expect(r.exact).toBe(false)
    expect(r.actual).toBeUndefined()
  })

  it('工具参数按解码后内容计数，name 另计一次', () => {
    const stream = [{
      type: 'tool-call-chunks', time0: 1000, index: 0, dt: [1],
      id: 'call-1', name: 'write', args: ['{"content": "a\\nb"}'],
    }]
    const r = estimateAssistantMessage({ stream }, BPE)
    expect(r.estimated).toBe(tokenCount('{"content": "a\nb"}') + tokenCount('write'))
  })

  it('同一调用多帧只计一次 name', () => {
    const stream = [{
      type: 'tool-call-chunks', time0: 1000, index: 0, dt: [1, 1, 1],
      id: 'call-1', name: 'write', args: ['{"a"', ':1', '}'],
    }]
    const r = estimateAssistantMessage({ stream }, BPE)
    expect(r.estimated).toBe(tokenCount('{"a":1}') + tokenCount('write'))
  })

  it('多个同名调用各计一次 name', () => {
    const stream = [
      { type: 'tool-call-chunks', time0: 1000, index: 0, dt: [1], id: 'call-1', name: 'write', args: ['{"a":1}'] },
      { type: 'tool-call-chunks', time0: 2000, index: 1, dt: [1], id: 'call-2', name: 'write', args: ['{"b":2}'] },
    ]
    const r = estimateAssistantMessage({ stream }, BPE)
    expect(r.estimated).toBe(
      tokenCount('{"a":1}') + tokenCount('write') + tokenCount('{"b":2}') + tokenCount('write'),
    )
  })

  it('usage 取实际值并置 exact，流内 usage 同样识别', () => {
    const r = estimateAssistantMessage({
      stream: [
        { type: 'text-chunks', time0: 1010, index: 0, dt: [], texts: ['hi'] },
        { type: 'chunk', time: 1020, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 42 } } },
      ],
    }, BPE)
    expect(r.estimated).toBe(tokenCount('hi'))
    expect(r.actual).toBe(42)
    expect(r.exact).toBe(true)
  })

  it('density 模式整段取整', () => {
    const r = estimateAssistantMessage({
      stream: [{ type: 'text-chunks', time0: 1010, index: 0, dt: [10], texts: ['hello', ' world'] }],
    }, DENSITY)
    expect(r.estimated).toBe(3)
  })
})

describe('findLastAssistantMessage', () => {
  it('取最后一条并带 seq', () => {
    const events = [
      { type: 'assistant/message', data: { stream: [] }, time: 1, seq: 3 },
      { type: 'step/end', data: { turn: 0, step: 0 }, time: 2, seq: 4 },
      { type: 'assistant/message', data: { stream: [] }, time: 3, seq: 7 },
      { type: 'step/end', data: { turn: 1, step: 1 }, time: 4, seq: 8 },
    ] as unknown as SessionEvent[]
    expect(findLastAssistantMessage(events)?.seq).toBe(7)
  })

  it('没有 assistant/message 返回 undefined', () => {
    expect(findLastAssistantMessage([])).toBeUndefined()
  })
})
