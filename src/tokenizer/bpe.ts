/**
 * DeepSeek-V3/V4 字节级 BPE 的纯函数实现（与 HF transformers 的
 * `encode(add_special_tokens=false)` 逐 token id 对齐）。
 *
 * 流程：added tokens 的最长前缀匹配（trie；命中且 special=true 时直接输出
 * 该 token id，其余命中视为普通文本）→ pre_tokenizer（三条 Isolated Split +
 * ByteLevel）→ 每段内按 merges rank 迭代合并 → 返回 token id 序列。
 * 数据来自 src/tokenizer/data.ts（由 scripts/export-tokenizer-data.mjs 从
 * HF tokenizer.json 生成）。
 *
 * 注：与 transformers 的差异仅在 non-special added token——它们命中后依然按
 * 普通文本走完整 BPE（tokenizers 的 split 默认 true 即递归 tokenize 该区间），
 * 不产生独占 token id（已实测：` response` 输出 BPE 的 4256 而非 128822）。
 *
 * @module dsh-live-token-stats/tokenizer/bpe
 */

import { ADDED_TOKENS, MERGE_PAIRS, VOCAB_B64, VOCAB_SIZE } from './data.ts'
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

// --- added tokens：trie 最长前缀匹配（按码点），命中且 special=true 直接出 id ---
interface AddedNode {
  next: Map<string, AddedNode>
  id?: number
  special: boolean
}

let addedTrie: AddedNode | undefined

function getAddedTrie(): AddedNode {
  if (addedTrie !== undefined) return addedTrie
  const root: AddedNode = { next: new Map(), special: false }
  for (const t of ADDED_TOKENS) {
    if (t.content.length === 0) continue // 空内容永不匹配文本
    let node = root
    for (const ch of t.content) {
      let nxt = node.next.get(ch)
      if (nxt === undefined) {
        nxt = { next: new Map(), special: false }
        node.next.set(ch, nxt)
      }
      node = nxt
    }
    node.id = t.id
    node.special = t.special
  }
  addedTrie = root
  return root
}

/** 所有 added token 的首码点集合（潜在窗口起点判定用）。 */
const addedFirstChars: Set<string> = (() => {
  const s = new Set<string>()
  for (const t of ADDED_TOKENS) {
    const a = Array.from(t.content)
    if (a.length > 0) s.add(a[0])
  }
  return s
})()

/**
 * 找潜在窗口起点：从 combined 末尾开始，能构成某个 added token 最长前缀的最靠左起点。
 * 该位置之后的文本可能被后续帧补全成完整 added 匹配，增量切分必须将其整体保留在不结算窗口中。
 * 该位置之前的文本不可能是任何完整匹配的起点，可安全按普通文本结算。
 *
 * 与旧实现的差异：旧实现只要在文本里遇到任意一个 added 首码点就把整段锁死，导致尖括号与全角竖线一出现就永久卡住，复杂度退化为平方。
 * 这里仅在文本末尾确实处于某 added 前缀匹配中时才锁窗，前缀一旦因后续字符不匹配而中断，窗口立即关闭，后续文本照常结算。
 *
 * 无匹配时返回 combined 长度，表示整个文本没有未闭合前缀，可按普通文本结算。
 */
export function potentialWindowStart(cps: string[]): number {
  const trie = getAddedTrie()
  // 从末尾向前找，检查每个 added 首码点为起点的最长前缀是否延伸到文本末尾。
  // 只需看末尾最长 added token 长度内的区间，更早的位置要么已完整匹配要么已确认中断，不可能是未闭合前缀。
  const maxLen = 36 // ADDED_TOKENS 最长 36 码点，见 data.ts 生成注释
  const lo = Math.max(0, cps.length - maxLen)
  for (let i = lo; i < cps.length; i += 1) {
    // 起点必须落在某 added 首码点上，否则不可能是前缀起点
    if (!addedFirstChars.has(cps[i])) continue
    let node = trie
    let j = i
    let reachedEnd = true
    // 沿 trie 走最长前缀，中途字符不匹配说明前缀已断开
    for (; j < cps.length; j += 1) {
      const nxt = node.next.get(cps[j])
      if (nxt === undefined) { reachedEnd = false; break }
      node = nxt
    }
    // 某前缀延伸或将要延伸到文本末尾时，认定为潜在窗口
    if (reachedEnd) return i
  }
  return cps.length
}

/** 在 cps 的 pos 处找最长 added token 前缀，命中返回长度与 token 信息，否则返回 null。 */
function matchAddedAt(
  cps: string[],
  pos: number,
  trie: AddedNode,
): { len: number; id: number; special: boolean } | null {
  let node = trie
  let best: { len: number; id: number; special: boolean } | null = null
  let len = 0
  for (let i = pos; i < cps.length; i += 1) {
    const nxt = node.next.get(cps[i])
    if (nxt === undefined) break
    node = nxt
    len += 1
    if (node.id !== undefined) best = { len, id: node.id, special: node.special }
  }
  return best
}

/** 分段结果：bpe 段（普通文本，需按 merges 合并）或 added 段（special token 单 id）。 */
export type TokenSegment =
  | { kind: 'bpe'; text: string; codes: number[] }
  | { kind: 'added'; text: string; id: number }

/**
 * 先做 added token 最长前缀匹配再分段：命中且 special=true 的 token 作为独立
 * added 段（直接输出其 id）；其余文本正常走 pre-tokenize 成 bpe 段。
 * non-special 命中与普通文本等价（transformers 对它递归 tokenize，已实测逐 id 一致）。
 * 返回的段序列按原文顺序交替，空输入返回空数组。
 */
export function splitWithAdded(text: string): TokenSegment[] {
  const out: TokenSegment[] = []
  if (text.length === 0) return out
  const cps = Array.from(text)
  const trie = getAddedTrie()
  let i = 0
  let segStart = 0
  const flushBpe = (from: number, to: number): void => {
    for (const pt of preTokenize(cps.slice(from, to).join(''))) {
      out.push({ kind: 'bpe', text: pt.text, codes: pt.codes })
    }
  }
  while (i < cps.length) {
    const m = matchAddedAt(cps, i, trie)
    if (m !== null && m.special) {
      flushBpe(segStart, i)
      out.push({ kind: 'added', text: cps.slice(i, i + m.len).join(''), id: m.id })
      i += m.len
      segStart = i
    } else {
      i += 1
    }
  }
  flushBpe(segStart, cps.length)
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
 * 完整切分一段文本，返回 token id 序列（与 transformers encode 对齐：
 * special added token 直接输出其 id，其余文本正常 BPE）。
 */
export function encodeText(text: string): number[] {
  const ids: number[] = []
  for (const seg of splitWithAdded(text)) {
    if (seg.kind === 'added') {
      ids.push(seg.id)
    } else {
      ids.push(...bpeMerge(seg.codes))
    }
  }
  return ids
}

/** 文本对应 token 数。 */
export function tokenCount(text: string): number {
  return encodeText(text).length
}