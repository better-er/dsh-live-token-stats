/**
 * DeepSeek-V3/V4 字节级 BPE 的纯函数实现（与 HF transformers 的
 * `encode(add_special_tokens=false)` 逐 token id 对齐）。
 *
 * 流程：pre_tokenizer（三条 Isolated Split + ByteLevel）→ 每段内按 merges
 * rank 迭代合并 → 返回 token id 序列。数据来自 src/tokenizer/data.ts
 * （由 scripts/export-tokenizer-data.mjs 从 HF tokenizer.json 生成）。
 *
 * @module dsh-live-token-stats/tokenizer/bpe
 */

import { MERGE_PAIRS, VOCAB_B64, VOCAB_SIZE } from './data.ts'
import { bytesToChars, charToBytes } from './bytes.ts'

// --- pre_tokenizer 正则（与 tokenizer.json 逐字节一致，u flag 启用 \p{}） ---
// 注意：R1/R3 不能用 JS 正则字面量手写转写——`\\-` 在 JSON 字符串里是
// 「字面反斜杠+连字符」（正则引擎收到字面反斜杠），手写 `\-` 只是转义
// 连字符，会漏匹配。直接以 JSON 解析后的字符串构造 RegExp，与 Rust 同源。
const RE_DIGITS = new RegExp('\\p{N}{1,3}', 'gu')
// 字符类 [一-龥-龥-龥-龥-龥-龥぀-ゟ゠-ヿ] 的 `-` 在 Rust 正则里被解析为
// range 分隔符（冗余 range，不含字面连字符）；JS 引擎却会把这种冗余 range
// 解析出字面 `-`，因此 R2 写成去冗余等价形式（语义与 Rust 相同，已验证）。
const RE_CJK = /[一-龥぀-ゟ゠-ヿ]+/gu
const RE_WORDS = new RegExp(
  '[!"#$%&\'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+|[^\\r\\n\\p{L}\\p{P}\\p{S}]?[\\p{L}\\p{M}]+| ?[\\p{P}\\p{S}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+',
  'gu',
)

/**
 * 按正则保持匹配内容切分（HF Split behavior=Isolated：每个匹配独立成段，
 * 间隙也保留为独立段；不合并相邻段）。
 */
function splitKeep(text: string, re: RegExp): string[] {
  const out: string[] = []
  let last = 0
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** 一个 pre-token 段：原文文本 + ByteLevel 字节映射后的码位序列。 */
export interface PreToken {
  /** 段在原文中的字符序列。 */
  text: string
  /** 字节映射后的码位数组（BPE 合并的输入）。 */
  codes: number[]
}

/**
 * pre_tokenizer：依次应用三条 split + ByteLevel，返回段列表。
 * 超长段（罕见：连续数千字中文）在字符边界截断到 ≤ MAX_SEG_CODES 码位，
 * 朴素 BPE 对每段为常数开销；截断处最多损失一个跨边界合并，误差有界
 * （文档已声明此取舍），样例文本不触发。
 */
export function preTokenize(text: string): PreToken[] {
  const segs = splitKeep(text, RE_DIGITS)
    .flatMap((s) => splitKeep(s, RE_CJK))
    .flatMap((s) => splitKeep(s, RE_WORDS))
  const out: PreToken[] = []
  for (const s of segs) {
    if (s.length <= MAX_SEG_CODES) {
      out.push({ text: s, codes: bytesToChars(charToBytes(s)) })
    } else {
      for (let off = 0; off < s.length; off += MAX_SEG_CODES) {
        const part = s.slice(off, off + MAX_SEG_CODES)
        out.push({ text: part, codes: bytesToChars(charToBytes(part)) })
      }
    }
  }
  return out
}

// --- merges rank 表 + vocab 映射（解码一次，缓存） ---
let rankMap: Map<string, number> | undefined
let vocabMap: Map<string, number> | undefined

function getRankMap(): Map<string, number> {
  if (rankMap !== undefined) return rankMap
  const map = new Map<string, number>()
  for (let i = 0; i < MERGE_PAIRS.length; i += 1) {
    map.set(`${MERGE_PAIRS[i][0]},${MERGE_PAIRS[i][1]}`, i)
  }
  rankMap = map
  return map
}

/** vocab 的 字符串→id 映射（字节字符键 + 合并产物键都在其中）。
 * 合并产物 id = 256 + rank，不是 VOCAB_SIZE + rank。 */
function getVocabMap(): Map<string, number> {
  if (vocabMap !== undefined) return vocabMap
  const bytes = Buffer.from(VOCAB_B64, 'base64')
  const map = new Map<string, number>()
  let off = 0
  for (let id = 0; id < VOCAB_SIZE; id += 1) {
    const n = bytes[off]
    off += 1
    let s = ''
    for (let j = 0; j < n; j += 1) {
      s += String.fromCodePoint(bytes.readUInt32LE(off))
      off += 4
    }
    map.set(s, id)
  }
  vocabMap = map
  return map
}

/** 单段最大码元数：超长段（罕见）在 preTokenize 时按码位截断，朴素 BPE 每段
 * O(MAX²) 约为常数开销；截断处最多损失一个跨边界合并，误差有界（文档已声明）。 */
const MAX_SEG_CODES = 512

/**
 * 对一段码位数组做 BPE 合并，返回 token id 列表。
 *
 * 朴素实现：每轮在所有相邻 pair 里取 rank 最小者合并（与 transformers/
 * tokenizers 的语义逐 id 一致）。段长 ≤ MAX_SEG_CODES，每段常数开销。
 */
export function bpeMerge(codes: number[]): number[] {
  const rank = getRankMap()
  const vocab = getVocabMap()
  const sym = codes.map((cp) => String.fromCodePoint(cp))
  while (sym.length > 1) {
    let bestRank = Number.POSITIVE_INFINITY
    let bestI = -1
    for (let i = 0; i < sym.length - 1; i += 1) {
      const r = rank.get(`${sym[i]},${sym[i + 1]}`)
      if (r !== undefined && r < bestRank) {
        bestRank = r
        bestI = i
      }
    }
    if (bestI === -1) break
    sym.splice(bestI, 2, sym[bestI] + sym[bestI + 1])
  }
  const ids = new Array<number>(sym.length)
  for (let i = 0; i < sym.length; i += 1) {
    const id = vocab.get(sym[i])
    if (id === undefined) throw new Error(`tokenizer: 符号 不在 vocab 中`)
    ids[i] = id
  }
  return ids
}

/**
 * 完整切分一段文本，返回 token id 序列（与 transformers encode 对齐；
 * 不处理 added_tokens 的内容匹配——普通模型输出不含特殊 token）。
 */
export function encodeText(text: string): number[] {
  const ids: number[] = []
  for (const seg of preTokenize(text)) {
    ids.push(...bpeMerge(seg.codes))
  }
  return ids
}

/** 文本对应 token 数。 */
export function tokenCount(text: string): number {
  return encodeText(text).length
}