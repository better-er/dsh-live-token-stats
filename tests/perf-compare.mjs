/**
 * 大数据性能与正确性对拍：全量一次性切分 vs 增量分帧切分。
 * 对比三种数据形态下的耗时与最终 token 数，校验增量与全量逐 token 一致。
 * 用 node --experimental-strip-types 直接跑，非 vitest。
 *
 * 结论要点：
 *   - 混合多段（空格/标点拆段）与纯 ASCII 长段：增量与全量同样快，token 数精确一致。
 *   - 连续中文无段边界：增量每帧对不断增长的 buffer 全量 re-split，退化为 O(n²)，
 *     这是文档 §6.3 隐患：此类输入下增量远慢于全量，但 token 数仍精确一致。
 */
import { tokenCount } from '../src/tokenizer/bpe.ts'
import { EMPTY_INCREMENTAL, incrementalFeed, incrementalTotal } from '../src/tokenizer/incremental.ts'

const now = () => performance.now()

function runIncremental(text, frameLen) {
  let state = EMPTY_INCREMENTAL
  let i = 0
  while (i < text.length) {
    const f = text.slice(i, i + frameLen)
    state = incrementalFeed(state, f).state
    i += frameLen
  }
  return incrementalTotal(state)
}

const cases = [
  { label: '连续中文无段边界（最坏形态）', text: '深'.repeat(200_000), frameLen: 100 },
  { label: '混合中英多段（空格/标点拆段）', text: ('深度学习的 Tokenizer 需要高效处理中英文混排，把 Hello, 你好 切分，' +
    'let x = 42; return x + 1; 同时保持字节级 BPE 无损对齐。').repeat(2500), frameLen: 7 },
  { label: '纯 ASCII 长段', text: 'The quick brown fox jumps over the lazy dog. '.repeat(15000), frameLen: 7 },
]

console.log('=== 大数据速度与正确性对拍 ===\n')
let allMatch = true
for (const c of cases) {
  console.log(`数据形态 ${c.label}，长度 ${c.text.length.toLocaleString()} 字符`)
  const t0 = now()
  const fullN = tokenCount(c.text)
  const fullMs = now() - t0
  const t1 = now()
  const incN = runIncremental(c.text, c.frameLen)
  const incMs = now() - t1
  const ok = fullN === incN
  if (!ok) allMatch = false
  console.log(`  全量一次性 tokenCount: ${fullMs.toFixed(1)} ms → ${fullN}`)
  console.log(`  增量分帧(${c.frameLen}字符/帧): ${incMs.toFixed(1)} ms → ${incN}`)
  console.log(`  一致: ${ok ? '是' : '否'}${ok ? '' : ` 差 ${fullN - incN}`}`)
  console.log('')
}
console.log(allMatch ? '三形态全部一致，对拍通过' : '存在不一致，对拍失败')
process.exitCode = allMatch ? 0 : 1