/**
 * 跨 delta 的增量 BPE 切分：维护「未完成尾段」的纯 fold 状态。
 *
 * 与一次性整段切分的一致性论证：
 *   BPE 合并只发生在 pre-token 段内部，追加文本只会扩展/改变**最后一段**；
 *   因此把除尾段外的段落立即结算进基线，只重切「尾段 + 新帧」即可——
 *   已结算段不再参与重切（数学等价，避免每帧全量 O(buffer) 的正则扫描成本，
 *   尤其是无空白长段的 alternation 回溯）。任何时刻的 total() 与整段一次性
 *   切分逐 token 一致（段边界随追加变化时，旧尾段未入账，重切后按新段结算）。
 *
 * 状态是纯 JSON（{ buffer, counted }），可持久化、可重放，满足投影约束。
 *
 * @module dsh-live-token-stats/tokenizer/incremental
 */

import { bpeMerge, preTokenize, tokenCount } from './bpe.ts'

/** 增量切分状态（纯 JSON，可序列化；随事件序列确定演化）。 */
export interface IncrementalState {
  /** 未结算的尾段文本（追加文本后会被重切）。 */
  buffer: string
  /** 已结算 token 数（buffer 之前的全部段落）。 */
  counted: number
}

export const EMPTY_INCREMENTAL: IncrementalState = Object.freeze({ buffer: '', counted: 0 })

/** buffer 的硬上限；超过时把前部段落按整段结算，仅尾部若干段保留。 */
const MAX_TAIL_CHARS = 4096

/**
 * 喂入一段新文本，返回 { 新状态, 本次新增已结算 token 数 }。
 * 新增量用于实时速率/投影逐 delta 累计；total() 用于绝对计数。
 */
export function incrementalFeed(
  state: IncrementalState,
  text: string,
): { state: IncrementalState; added: number } {
  if (text.length === 0) return { state, added: 0 }
  // 只重切尾段 + 新帧（已结算段不参与，数学等价且每次成本有界）
  const segs = preTokenize(state.buffer + text)
  if (segs.length === 0) return { state, added: 0 }
  const tail = segs.pop()!
  let added = 0
  for (const s of segs) added += bpeMerge(s.codes).length
  let buffer = tail.text
  let counted = state.counted + added
  if (buffer.length > MAX_TAIL_CHARS) {
    const r = truncateTail(buffer)
    buffer = r.buffer
    counted += r.dropped
  }
  return { state: { buffer, counted }, added }
}

/** 当前绝对 token 数（已结算 + 尾段重切）。 */
export function incrementalTotal(state: IncrementalState): number {
  return state.counted + (state.buffer.length === 0 ? 0 : tokenCount(state.buffer))
}

/**
 * 超长 buffer 截断：从尾部保留若干整段（累计 ≤ MAX_TAIL_CHARS），
 * 丢弃的段按整段结算进基线。段截断处最多损失一个跨边界合并，误差有界，
 * 且结算后会被官方 usage 覆盖（文档已声明此取舍）。
 */
function truncateTail(buffer: string): { buffer: string; dropped: number } {
  const segs = preTokenize(buffer)
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
  for (let i = 0; i < keptStart; i += 1) dropped += bpeMerge(segs[i].codes).length
  return { buffer: keep, dropped }
}