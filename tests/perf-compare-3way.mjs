/**
 * 三方对拍：全量一次性 vs 现有增量（保整段） vs 按 k 合并半径结算的增量原型。
 * 目的：验证「保右端 k 码元、左端按完整段结算」的增量方案在连续中文下
 * 既保持与全量逐 token 精确一致，又避免 O(n²) 退化。
 *
 * k 由数据实测：本词表最长 token 码元数 = 128。
 *
 * 结算规则（兼顺段边界）：
 *   combined 分段后，从左往右扫描，凡是「整体落在右 k 半径左侧」的完整段立即结算；
 *   任何「跨越右 k 半径左界」的段，整段保留，不切开。尾段总是保留。
 * 这样左端全部可结算、且从不在段中间切刀，BPE 合并轨迹不被破坏。
 */
import { bpeMerge, preTokenize, splitWithAdded, tokenCount, type TokenSegment } from '../src/tokenizer/bpe.ts'
import { EMPTY_INCREMENTAL, incrementalFeed, incrementalTotal } from '../src/tokenizer/incremental.ts'

const now = () => performance.now()
const K = 128 // 实测最长 token 码元数

function segTokenCount(seg: TokenSegment): number {
  return seg.kind === 'added' ? 1 : bpeMerge(seg.codes).length
}

// 按 k 半径结算的增量原型：保留「尾段 + 跨过 k 左界的段」，其余全结算。
function incrementalFeedK(segs: TokenSegment[]): number {
  const n = segs.length
  if (n === 0) return 0
  // 从头累计码元长度，停在「尾段之前、且累计剩余刚好能覆盖右 k 半径」的位置
  let rest = 0                       // 从当前段往右还剩的码元
  let cut = n - 1                    // 默认只留尾段
  // 从右往左累加码元，记录需要保留到最左边的段下标（保证保留区 >= k 码元）
  let keptCodepoints = 0
  for (let i = n - 1; i >= 0; i -= 1) {
    const len = segs[i].kind === 'added' ? 0 : segs[i].codes.length
    if (keptCodepoints >= K && i < n - 1) { cut = i + 1; break }
    keptCodepoints += len
    cut = i
  }
  // 结算 cut 之前的全部段
  let acc = 0
  for (let i = 0; i < cut; i += 1) acc += segTokenCount(segs[i])
  return acc
}

const cases = [
  { label: '连续中文无段边界（最坏形态）', text: '深'.repeat(200_000), frameLen: 100 },
  { label: '混合中英多段（空格/标点拆段）', text: ('深度学习的 Tokenizer 需要高效处理中英文混排，把 Hello, 你好 切分，' +
    'let x = 42; return x + 1; 同时保持字节级 BPE 无损对齐。').repeat(2500), frameLen: 7 },
  { label: '纯 ASCII 长段', text: 'The quick brown fox jumps over the lazy dog. '.repeat(15000), frameLen: 7 },
]

console.log(`=== 三方对拍，合并半径 K=${K} ===\n`)
let allOk = true
for (const c of cases) {
  console.log(`${c.label}，长度 ${c.text.length.toLocaleString()} 字符`)
  // 全量
  const t0 = now(); const fullN = tokenCount(c.text); const fullMs = now() - t0
  // 现有增量（保整段）
  let st = EMPTY_INCREMENTAL
  const t1 = now()
  for (let i = 0; i < c.text.length; i += c.frameLen) st = incrementalFeed(st, c.text.slice(i, i + c.frameLen)).state
  const incMs = now() - t1
  const incN = incrementalTotal(st)
  // 按 k 结算的增量原型：直接对全量分段结果应用结算规则（等价于把喂帧合并为一次整段分段）
  const t2 = now()
  const segs = splitWithAdded(c.text)
  const kAcc = incrementalFeedK(segs)
  // 计算保留区（未结算）码元长度，印证 buffer 有界
  const tailIdx = segs.length - 1
  let kept = 0
  for (let i = tailIdx; i >= 0; i -= 1) {
    if (i >= tailIdx - (segs.length - 1 - tailIdx) && false) break
    kept += segs[i].kind === 'added' ? 0 : segs[i].codes.length
    if (kept >= K && i < tailIdx) break
    if (i <= tailIdx - 1 && kept >= K) break
  }
  const kMs = now() - t2
  const ok = fullN === incN && incN === kAcc
  if (!ok) allOk = false
  const keptLen = segs.slice(tailIdx - 2 < 0 ? 0 : tailIdx - 2).reduce((a, s) => a + (s.kind === 'added' ? 0 : s.codes.length), 0)
  console.log(`  全量: ${fullMs.toFixed(1)} ms → ${fullN}`)
  console.log(`  现有增量(保整段): ${incMs.toFixed(1)} ms → ${incN}`)
  console.log(`  按K结算原型(整段不分段时测结算器): ${kMs.toFixed(1)} ms → ${kAcc}（保守保留区 ${segs[0].codes.length.toLocaleString()} 码元 — 这里仅是整段，见下）`)
  console.log(`  三者一致: ${ok ? '是' : '否'}${ok ? '' : ` 差 全量-现有=${fullN - incN} 现有-k=${incN - kAcc}`}`)
  console.log('')
}
console.log(allOk ? '三形态全部一致，对拍通过' : '存在不一致，对拍失败')
process.exitCode = allOk ? 0 : 1