/**
 * 流式 JSON 反转义单元测试。
 *
 * 验证三件事：
 * 1. 常见转义（\n \r \t \" \\ \uXXXX）正确还原；
 * 2. 跨帧拆分（悬空尾部）与整段解码结果一致（逐字符一致）；
 * 3. 非法转义按原样保留、空帧与尾帧收敛。
 *
 * @module dsh-live-token-stats/tests/unescape
 */

import { describe, expect, it } from 'vitest'
import { EMPTY_UNESCAPE, unescapeAll, unescapeFeed } from '../src/tokenizer/unescape.ts'

describe('unescapeFeed', () => {
  it('还原常用转义序列', () => {
    const r = unescapeFeed(EMPTY_UNESCAPE, '{"a": "x\\ny\\t\\\\z\\\"q"}')
    expect(r.text).toBe('{"a": "x\ny\t\\z"q"}')
    expect(r.state.tail).toBe('')
  })

  it('还原 \\uXXXX 码点', () => {
    const r = unescapeFeed(EMPTY_UNESCAPE, '\\u4f60\\u597d')
    expect(r.text).toBe('你好')
    expect(r.state.tail).toBe('')
  })

  it('未识别转义原样保留', () => {
    const r = unescapeFeed(EMPTY_UNESCAPE, '\\x\\q')
    expect(r.text).toBe('\\x\\q')
    expect(r.state.tail).toBe('')
  })

  it('尾随悬空反斜杠挂起，等下一帧', () => {
    const r1 = unescapeFeed(EMPTY_UNESCAPE, '{"a": "x\\')
    expect(r1.text).toBe('{"a": "x')
    expect(r1.state.tail).toBe('\\')
    const r2 = unescapeFeed(r1.state, 'n"}')
    expect(r2.text).toBe('\n"}')
    expect(r2.state.tail).toBe('')
  })

  it('跨帧 \\u 补全（hex 分两帧到）', () => {
    const r1 = unescapeFeed(EMPTY_UNESCAPE, '\\u4f')
    expect(r1.text).toBe('')
    expect(r1.state.tail).toBe('\\u4f')
    const r2 = unescapeFeed(r1.state, '60')
    expect(r2.text).toBe('你')
    expect(r2.state.tail).toBe('')
  })

  it('\\u 后跟非法 hex 时按原样保留', () => {
    const r = unescapeFeed(EMPTY_UNESCAPE, '\\uZZZZ')
    expect(r.text).toBe('\\uZZZZ')
    expect(r.state.tail).toBe('')
  })

  it('跨帧拆分与整段解码逐字符一致（含反斜杠歧义）', () => {
    const whole = '{"path": "C:\\\\tmp\\\\a.json", "content": "第\\n二\\t行\\u4f60"}'
    const reference = unescapeAll(whole)
    // 逐帧逐个字符拆开喂（模拟流式细碎 fragment）
    let state = EMPTY_UNESCAPE
    let out = ''
    for (const ch of whole) {
      const r = unescapeFeed(state, ch)
      out += r.text
      state = r.state
    }
    // 尾帧可能残留悬空尾部——本串无悬空
    expect(out).toBe(reference)
    expect(state.tail).toBe('')
  })

  it('空字符串与纯文本不产生悬空', () => {
    const r1 = unescapeFeed(EMPTY_UNESCAPE, '')
    expect(r1.state).toEqual(EMPTY_UNESCAPE)
    const r2 = unescapeFeed(EMPTY_UNESCAPE, 'plain text')
    expect(r2.text).toBe('plain text')
    expect(r2.state.tail).toBe('')
  })
})

describe('unescapeAll', () => {
  it('与逐帧等价', () => {
    const sample = '{"c": "行1\\n行2\\t\\u4e2d"}'
    expect(unescapeAll(sample)).toBe(unescapeFeed(EMPTY_UNESCAPE, sample).text)
  })
})