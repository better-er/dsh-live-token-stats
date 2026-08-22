/**
 * 流式 JSON 反转义：把协议层加在 tool-call arguments 上的转义剥掉，还原模型真实生成文本。
 *
 * 背景（DESIGN §10.6）：官方 usage 数的是模型**原始生成的 token 序列**——模型生成工具
 * 调用时输出序列里的参数文本是解码形态，真实换行符、真实引号；但 OpenAI 兼容协议把参数
 * 作为 JSON 字符串序列化进 SSE 时加了一层转义（`\n` 两字符、`\"`、`\\`、`\uXXXX`），
 * 我们逐帧拿到的是序列化后的转义原文。按原文 BPE 会系统性高估（参数越长、转义越密，
 * 偏得越多——write 大 content 参数曾偏 −53）。计数前把转义剥掉还原模型真实生成文本，
 * 偏差即回到「结构费」簇（负值清零）。
 *
 * 流式约束：argumentsDelta 逐帧到达，转义序列可能跨帧（`\` 与 `n` 分帧、
 * `\u` 后不足 4 位 hex）。本模块维护一个**悬空尾部**状态（纯 JSON：
 * 只可能是 `'\'` 或 `'\u'` + 0~3 位 hex），下一帧拼上后继续解码。
 * 纯函数、可持久化、可重放，满足投影约束。
 *
 * @module dsh-live-token-stats/tokenizer/unescape
 */

/** 流式反转义状态：上一帧留下的未决尾部。 */
export interface UnescapeState {
  /** 悬空尾部：`'\'`（等待下一字符）或 `'\u'` + 0~3 位 hex（等待补全）。 */
  tail: string
}

export const EMPTY_UNESCAPE: UnescapeState = Object.freeze({ tail: '' })

const RE_HEX4 = /^[0-9a-fA-F]{4}$/

/**
 * 喂入一帧文本，返回 { 可立即计数的解码文本, 新状态 }。
 * 解码按 JSON 字符串值语义：`\n \r \t \b \f \\ \" \/ \uXXXX`。
 * 尾部若是不完整转义（单个 `\`、`\u`+不足 4 hex）则挂起，等待下一帧。
 * 非法转义（`\x` 不认得的）按原样保留两个字符。
 */
export function unescapeFeed(
  state: UnescapeState,
  fragment: string,
): { text: string; state: UnescapeState } {
  const s = state.tail + fragment
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c !== '\\') {
      out += c
      i += 1
      continue
    }
    // 当前字符是反斜杠：需要看下一个字符。
    if (i === s.length - 1) {
      // 悬空反斜杠：可能是 \\ 或 \n 等的前半，挂起。
      return { text: out, state: { tail: '\\' } }
    }
    const n = s[i + 1]
    if (n === 'u') {
      // \uXXXX：需要 4 位 hex；不足视为未决尾部。
      const hex = s.slice(i + 2, i + 6)
      if (hex.length < 4) {
        return { text: out, state: { tail: s.slice(i) } }
      }
      if (!RE_HEX4.test(hex)) {
        // 非法 \u 序列（后随非 hex）：按原样保留 `\u`，后续字符照常。
        out += '\\u'
        i += 2
        continue
      }
      out += String.fromCodePoint(parseInt(hex, 16))
      i += 6
      continue
    }
    switch (n) {
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case '\\': out += '\\'; break
      case '"': out += '"'; break
      case '/': out += '/'; break
      default:
        // 未识别转义：原样保留 `\` + 字符。
        out += s.slice(i, i + 2)
    }
    i += 2
  }
  return { text: out, state: EMPTY_UNESCAPE }
}

/** 一次性反转义整段文本（测试/离线分析用；等价于逐帧 feed 但无悬念）。 */
export function unescapeAll(text: string): string {
  const r = unescapeFeed(EMPTY_UNESCAPE, text)
  return r.state.tail.length === 0 ? r.text : r.text + r.state.tail
}