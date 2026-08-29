/**
 * 跨 delta 的增量 BPE 切分：维护「未完成尾段」的纯 fold 状态。
 *
 * 与一次性整段切分的一致性论证：
 *   BPE 合并只发生在 pre-token 段内部，追加文本只会扩展或改变最后一段。
 *   因此把除尾段外的段落立即结算进基线，只重切「尾段 + 新帧」即可。
 *   已结算段不再参与重切，数学上等价，避免每帧全量 O(buffer) 的正则扫描成本，尤其是无空白长段的 alternation 回溯。
 *   任何时刻的 total() 与整段一次性切分逐 token 一致，段边界随追加变化时旧尾段未入账，重切后按新段结算。
 *
 *   added token 的匹配会跨越多个段，若已结算段被后续帧补全成 added 匹配则计数将偏高。
 *   因此只把文本末尾确实处于某 added 前缀匹配中的部分保留在未结算窗口内。
 *   待后续帧补全或确认中断，前缀一旦断开窗口立即关闭。
 *   普通文本没有未闭合前缀时窗口只含尾段，行为与旧版完全一致。
 *
 * 状态是纯 JSON { buffer, counted }，可持久化、可重放，满足投影约束。
 *
 * @module dsh-live-token-stats/tokenizer/incremental
 */

import { bpeMerge, potentialWindowStart, splitWithAdded, tokenCount, type TokenSegment } from './bpe.ts'

/** 增量切分状态，纯 JSON 可序列化，随事件序列确定演化。 */
export interface IncrementalState {
  /** 未结算的尾段文本，追加文本后会被重切。 */
  buffer: string
  /** 已结算 token 数，即 buffer 之前的全部段落。 */
  counted: number
}

export const EMPTY_INCREMENTAL: IncrementalState = Object.freeze({ buffer: '', counted: 0 })

/** buffer 的硬上限；超过时把前部段落按整段结算，仅尾部若干段保留。 */
const MAX_TAIL_CHARS = 4096

/** 一段分段结果的 token 数，added 段恒为 1，bpe 段按 merges 合并后计数。 */
function segmentTokenCount(seg: TokenSegment): number {
  return seg.kind === 'added' ? 1 : bpeMerge(seg.codes).length
}

/**
 * 喂入一段新文本，返回新状态与本次新增已结算 token 数。
 * 新增量用于实时速率与投影逐 delta 累计，total 用于绝对计数。
 *
 * 核心不变量是已结算进基线的段落不会被后续帧重新判定。
 * 纯 BPE 下段边界由 pre-token 规则确定、与未来文本无关，故尾段保留即可。
 * added token 的匹配可跨越多个段，若已结算段被后续帧补全成完整匹配则增量计数将偏高。
 * 因此把可能被后续帧补全成 added 匹配的区域整体保留在未结算窗口中，窗口内一律不结算，待完整匹配或确认中断。
 * 窗口起点取末尾处未闭合的 added 前缀起点，无则整个 combined 均可按普通文本结算。
 */
export function incrementalFeed(
  state: IncrementalState,
  text: string,
): { state: IncrementalState; added: number } {
  if (text.length === 0) return { state, added: 0 }
  const combined = state.buffer + text
  const cps = Array.from(combined)
  const winStart = potentialWindowStart(cps)
  if (winStart < cps.length) {
    // 存在未闭合的 added 前缀，整个 combined 保留为 buffer 不切割，避免割裂段破坏增量等价性。
    // 窗口由改后的 potentialWindowStart 保证快速关闭，仅当末尾确有未闭合前缀时短暂开启。
    // 下帧补全或确认中断后立即回到普通分支。
    if (combined.length > MAX_TAIL_CHARS) {
      const r = truncateTail(combined)
      return {
        state: { buffer: r.buffer, counted: state.counted + r.dropped },
        added: r.dropped,
      }
    }
    return { state: { buffer: combined, counted: state.counted }, added: 0 }
  }
  // 无潜在 added 区域：普通文本，只重切尾段加新帧，已结算段不参与
  const segs = splitWithAdded(combined)
  if (segs.length === 0) return { state, added: 0 }
  const tail = segs.pop()!
  let added = 0
  for (const s of segs) added += segmentTokenCount(s)
  let buffer = tail.text
  let counted = state.counted + added
  if (buffer.length > MAX_TAIL_CHARS) {
    const r = truncateTail(buffer)
    buffer = r.buffer
    counted += r.dropped
  }
  return { state: { buffer, counted }, added }
}

/** 当前绝对 token 数，已结算加尾段重切。 */
export function incrementalTotal(state: IncrementalState): number {
  return state.counted + (state.buffer.length === 0 ? 0 : tokenCount(state.buffer))
}

/**
 * 超长 buffer 截断：从尾部保留若干整段，累计 ≤ MAX_TAIL_CHARS。
 * 丢弃的段按整段结算进基线。
 * 段截断处最多损失一个跨边界合并，误差有界，且结算后会被官方 usage 覆盖，文档已声明此取舍。
 */
function truncateTail(buffer: string): { buffer: string; dropped: number } {
  const segs = splitWithAdded(buffer)
  let keep = ''
  let keptStart = segs.length
  let acc = 0
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    const s = segs[i]
    if (keep !== '' && acc + s.text.length > MAX_TAIL_CHARS) break
    keep = s.text + keep
    keptStart = i
    acc += s.text.length
  }
  let dropped = 0
  for (let i = 0; i < keptStart; i += 1) dropped += segmentTokenCount(segs[i])
  return { buffer: keep, dropped }
}