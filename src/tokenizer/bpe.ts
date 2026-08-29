/**
 * DeepSeek-V3/V4 字节级 BPE 的纯函数实现，与 HF transformers 的 `encode(add_special_tokens=false)` 逐 token id 对齐。
 *
 * 流程：先做 added tokens 的最长前缀匹配，trie 命中且 special=true 时直接输出该 token id，其余命中视为普通文本。
 * 然后走 pre_tokenizer，即三条 Isolated Split 加 ByteLevel，再在每段内按 merges rank 迭代合并，最后返回 token id 序列。
 * 数据来自 src/tokenizer/data.ts，由 scripts/export-tokenizer-data.mjs 从 HF tokenizer.json 生成。
 *
 * 注：与 transformers 的差异仅在 non-special added token，它们命中后依然按普通文本走完整 BPE，tokenizers 的 split 默认 true 即递归 tokenize 该区间，不产生独占 token id。
 * 已实测 ` response` 输出 BPE 的 4256 而非 128822。
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
 * 按正则保持匹配内容切分，HF Split behavior=Isolated 语义。
 * 每个匹配独立成段，间隙也保留为独立段，不合并相邻段。
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
  /** 字节映射后的码位数组，作为 BPE 合并的输入。 */
  codes: number[]
}

/**
 * pre_tokenizer：依次应用三条 split 加 ByteLevel，返回段列表。
 * 段长不限——v0.3 起 bpeMerge 用 O(n log n) 堆实现，可安全处理任意长度段，
 * 不再需要 MAX_SEG_CODES 截断（截断反而会损失跨边界合并、引入误差）。
 */
export function preTokenize(text: string): PreToken[] {
  const segs = splitKeep(text, RE_DIGITS)
    .flatMap((s) => splitKeep(s, RE_CJK))
    .flatMap((s) => splitKeep(s, RE_WORDS))
  return segs.map((s) => ({ text: s, codes: bytesToChars(charToBytes(s)) }))
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

/** 所有 added token 的首码点集合，用于潜在窗口起点判定。 */
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

/** 分段结果：bpe 段即普通文本须按 merges 合并，或 added 段即 special token 单 id。 */
export type TokenSegment =
  | { kind: 'bpe'; text: string; codes: number[] }
  | { kind: 'added'; text: string; id: number }

/**
 * 先做 added token 最长前缀匹配再分段。
 * 命中且 special=true 的 token 作为独立 added 段并直接输出其 id，其余文本正常走 pre-tokenize 成 bpe 段。
 * non-special 命中与普通文本等价，transformers 对它递归 tokenize，已实测逐 id 一致。
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

// --- merges rank 表与 vocab 映射，解码一次并缓存 ---
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

/**
 * vocab 的字符串→id 映射，字节字符键与合并产物键都在其中。
 * 合并产物 id = 256 + rank，不是 VOCAB_SIZE + rank。
 */
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

/**
 * 对一段码位数组做 BPE 合并，返回 token id 列表。
 *
 * O(n log n) 堆实现（v0.3）：最小堆（按 rank）+ 邻接双链表 + 惰性删除。
 * 与朴素全扫版语义逐 id 一致：merges rank 全局唯一（=数组下标），每轮最小 pair 唯一，
 * 堆顶即朴素版全扫选中的同一个 pair，因此两个版本合并轨迹完全相同，可直接对拍。
 *
 * 正确性要点：
 *  - 惰性删除：合并后旧候选不主动删，弹出时校验（left 仍 live、right 存在且 live、
 *    实时 rank 与入堆时一致），不通过则丢弃重弹，避免 O(n) 的删除维护。
 *  - 每节点至多合并一次，每个 pair 进出堆 O(log n)，总 O(n log n)。
 *  - rank 平局时用显式次键 (rank, leftIdx) 保证确定性：与朴素版「取首个最小 index」一致。
 */
export function bpeMerge(codes: number[]): number[] {
  const rank = getRankMap()
  const vocab = getVocabMap()
  const n = codes.length
  if (n === 0) return []
  // 节点：str=当前符号、prev/next=链表邻居下标(-1 为端)、dead=已被并入别的符号
  const nodes: Array<{ str: string; prev: number; next: number; dead: boolean }> = []
  for (let i = 0; i < n; i += 1) {
    nodes.push({
      str: String.fromCodePoint(codes[i]),
      prev: i > 0 ? i - 1 : -1,
      next: i + 1 < n ? i + 1 : -1,
      dead: false,
    })
  }
  // pair 元素 {rank,left}；rank 为 (left 与其右邻) 的合并 rank，+∞ 表示无此合并
  const pairRank = (l: number): number => {
    const r = nodes[l].next
    if (r === -1) return Number.POSITIVE_INFINITY
    return rank.get(`${nodes[l].str},${nodes[r].str}`) ?? Number.POSITIVE_INFINITY
  }
  const heap: Array<{ rank: number; left: number }> = []
  const cmp = (a: { rank: number; left: number }, b: { rank: number; left: number }): number =>
    a.rank !== b.rank ? a.rank - b.rank : a.left - b.left
  const push = (r: number, l: number): void => {
    heap.push({ rank: r, left: l })
    let c = heap.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (cmp(heap[p], heap[c]) <= 0) break
      ;[heap[p], heap[c]] = [heap[c], heap[p]]
      c = p
    }
  }
  const pop = (): { rank: number; left: number } | undefined => {
    if (heap.length === 0) return undefined
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < heap.length && cmp(heap[l], heap[m]) < 0) m = l
        if (r < heap.length && cmp(heap[r], heap[m]) < 0) m = r
        if (m === i) break
        ;[heap[i], heap[m]] = [heap[m], heap[i]]
        i = m
      }
    }
    return top
  }
  for (let i = 0; i < n - 1; i += 1) {
    const r = pairRank(i)
    if (Number.isFinite(r)) push(r, i)
  }
  // 主循环：弹堆顶，惰性校验后合并 left+right 为新节点，接拢邻居并只入堆新形成的两个 pair
  while (heap.length > 0) {
    const e = pop()!
    const l = e.left
    const r = nodes[l].next
    if (r === -1 || nodes[l].dead || nodes[r].dead) continue // 候选已失效，丢弃重弹
    if (pairRank(l) !== e.rank) continue // 实时 rank 变更（邻域被重排），丢弃
    const prev = nodes[l].prev
    const next = nodes[r].next
    const newIdx = nodes.length
    nodes.push({ str: nodes[l].str + nodes[r].str, prev, next, dead: false })
    nodes[l].dead = true
    nodes[r].dead = true
    if (prev !== -1) {
      nodes[prev].next = newIdx
      const pr = pairRank(prev)
      if (Number.isFinite(pr)) push(pr, prev)
    }
    if (next !== -1) {
      nodes[next].prev = newIdx
      const nr = pairRank(newIdx)
      if (Number.isFinite(nr)) push(nr, newIdx)
    }
  }
  // 结果 = 沿链表遍历活节点查 vocab id（链头是唯一 prev===-1 的活节点）
  const ids: number[] = []
  let head = nodes.findIndex((nd) => !nd.dead && nd.prev === -1)
  while (head !== -1) {
    const id = vocab.get(nodes[head].str)
    if (id === undefined) throw new Error(`tokenizer: 符号 不在 vocab 中`)
    ids.push(id)
    head = nodes[head].next
  }
  return ids
}

/**
 * 完整切分一段文本，返回 token id 序列，与 transformers encode 对齐。
 * special added token 直接输出其 id，其余文本正常 BPE。
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