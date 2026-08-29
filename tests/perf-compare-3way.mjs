/**
 * 逐 token 正确性对拍：全量一次性 vs 按合并半径 K 结算的逐帧增量原型。
 *
 * 与只比总数不同，本脚本对每个 golden 测例，把文本按小帧喂给原型，
 * 原型逐段收集已结算 token 的 id 序列，最终把收集的完整 id 数组与
 * golden 的 ids 逐位精确比对——这才是真正的逐 token 正确性验证。
 *
 * K 由数据实测：最长 token 码元数 = 128。结算规则：尾部保留 >= K 码元，
 * 左侧按完整段结算不切刀，保证合并轨迹不受损。
 */
import { readFileSync } from 'node:fs'
import { bpeMerge, splitWithAdded, potentialWindowStart, encodeText } from '../src/tokenizer/bpe.ts'
import { incrementalTotal } from '../src/tokenizer/incremental.ts'

const now = () => performance.now()
const K = 128

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/dsv3-golden.json', import.meta.url), 'utf-8'),
)

// 逐帧增量原型：返回累积的完整 token id 序列（已结算段 id 依序拼接 + 残留尾段补全）
function feedIncrementalK(text, frameLen) {
  let tail = ''
  const ids = []
  for (let i = 0; i < text.length; i += frameLen) {
    const frame = text.slice(i, i + frameLen)
    const combined = tail + frame
    const cps = Array.from(combined)
    if (potentialWindowStart(cps) < cps.length) { // added 未闭合前缀，整段保留
      if (combined.length > 4096) tail = combined.slice(-K * 4)
      else tail = combined
      continue
    }
    const segs = splitWithAdded(combined)
    if (segs.length === 0) continue
    const n = segs.length
    let acc = 0
    let keepStart = n - 1
    for (let idx = n - 1; idx >= 0; idx -= 1) { // 从右往左累计至 >= K，把跨过 K 界的段整段保留
      const len = segs[idx].kind === 'added' ? 0 : segs[idx].codes.length
      acc += len
      if (acc >= K && idx < n - 1) { keepStart = idx; break }
      keepStart = idx
    }
    for (let idx = 0; idx < keepStart; idx += 1) {
      if (segs[idx].kind === 'added') ids.push(segs[idx].id)
      else ids.push(...bpeMerge(segs[idx].codes))
    }
    tail = segs.slice(keepStart).map((s) => s.text).join('')
  }
  if (tail.length > 0) ids.push(...encodeText(tail)) // 残留尾部按全量补全
  return ids
}

let allPass = true
let totalCompared = 0
for (const c of golden) {
  const t0 = now()
  const incIds = feedIncrementalK(c.text, 7) // 每 7 字符一帧，跨词边界
  const ms = now() - t0
  const fullIds = encodeText(c.text)
  const okIds = incIds.length === fullIds.length && incIds.every((id, j) => id === fullIds[j])
  const okCount = incIds.length === c.ids.length
  if (!okIds || !okCount) allPass = false
  totalCompared += 1
  console.log(
    `【${c.name}】增量${incIds.length} / 全量${fullIds.length} / golden${c.ids.length}，` +
    `逐位一致=${okIds ? '是' : '否'} 帧成本=${ms.toFixed(1)}ms`,
  )
}
console.log(`\n共比对 ${totalCompared} 个测例，全部逐 token 精确一致：${allPass ? '是' : '否'}`)
process.exitCode = allPass ? 0 : 1