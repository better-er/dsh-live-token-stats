/**
 * dsh-live-token-stats 的浏览器端：composer 停靠区里的实时流读数。
 *
 * 三种状态，标签按产品惯例使用中文：
 *   - 生成中、首字已出：
 *       实时速度 ~53.0 tok/s | 平均速度 ~40.3 tok/s | 已停顿 2.5s | 实时输出 ~2,123 token | 首字延迟 1.2s
 *     实时速度是主机的窗口速率，TTFT 被折进跨度，跨度从 step 开始滑到窗口大小之后固定。
 *     平均速度是从请求发出的 step 级全程平均，含首字延迟与一切停顿，因此这一对能看出推流相对其自身平均值在提速还是减速。
 *     长停顿会让窗口样本过期，主机停止发速率，实时速度读数消失，只剩已停顿在走。
 *   - 等待首字：
 *       准确速度 28.7 tok/s | 估算 2,123 / 实际 1,966 (+8%) | 首字延迟 2.3s
 *     还没有 token 到达，所以没有实时速度与输出可显示，保留上一次结算的读数作为对照基线。
 *     首字延迟从 step 开始以 10 Hz 实时跳动，首字落地瞬间冻结为该 step 的精确 TTFT，同时状态切到生成中。
 *   - 空闲、上一步已结算，同样的结算读数，但首字延迟是上一步的结算 TTFT，作为静态对照基线。生成已停止但 step 未结束时也显示此态。
 *
 * @module dsh-live-token-stats/client
 */

import { memo, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { LiveTokenStatsProjection } from '../projection.ts'

/** 停靠区所属方为组合/会话槽位交付的 props。 */
export interface LiveTokenStatsLineProps {
  useProjection: UseProjection
  /** 框架解析出的会话 id，所属方从不传入。 */
  sessionId: string
}

/** 主机会话提供的实时速率快照。 */
interface LiveRateSnapshot {
  tokensPerSecond?: number
  updatedAt: number
  stallMs?: number
  sinceLastMs?: number
  /** 该 step 的模型生成是否仍在进行；false 表示流已结束，进入工具执行等停止态。 */
  generating?: boolean
  /** 本 step 累计输出 token，官方 usage 已到则为实际值。 */
  outputTokens?: number
  /** outputTokens 是否为官方 usage 实际值。 */
  exact?: boolean
  /** 首 token 相对 step 起点的延迟毫秒，尚未出首字时缺省。 */
  firstTokenDelayMs?: number
  /** 本 step 已流逝毫秒。 */
  elapsedMs?: number
  /** 本 step 全程平均速度 tok/s。 */
  avgTokensPerSecond?: number
}

// --- Formatting -------------------------------------------------------------

/** 千分位整数 token 计数：517 / 1,234 / 12,300。 */
export function formatInt(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '0'
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 100 tok/s 以下保留一位小数的 TPS。 */
export function formatTps(v: number): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return ''
  return v < 100 ? String(Math.round(v * 10) / 10) : String(Math.round(v))
}

/** 紧凑时长：45.2s / 2m42s。 */
export function formatDuration(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const s = ms / 1000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** 估算减实际的带符号整数百分比，如 "+12%"。精确相等显示 "±0%"，四舍五入为 0 但仍有方向时保留正负向的 "+0%" / "-0%"。 */
export function formatGapPct(estimated: number, actual: number): string {
  if (typeof estimated !== 'number' || typeof actual !== 'number' || !Number.isFinite(estimated) || !Number.isFinite(actual) || actual <= 0) return ''
  const pct = ((estimated - actual) / actual) * 100
  const rounded = Math.round(pct)
  if (rounded === 0) {
    if (estimated === actual) return '±0%'
    return pct >= 0 ? '+0%' : '-0%'
  }
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${rounded}%`
}

/** 请求序号，用于 client-request/server-response 的 rpcId 配对。 */
let rpcIdCounter = 0

/**
 * 直接向插件自注册通道发一次 snapshot 请求，复用官方信封，绕开取不到的 connection.rpc。
 * @param sessionId - 目标会话。
 * @returns 快照，任何非成功路径都返回 null。
 */
async function callSnapshot(sessionId: string): Promise<LiveRateSnapshot | null> {
  const rpcId = 'lts-' + String(++rpcIdCounter)
  const response = await fetch('/dsh-live-token-stats/snapshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'snapshot',
      payload: { sessionId },
    }),
  })
  if (!response.ok) return null
  const full = await response.json() as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: LiveRateSnapshot } }
  if (full.type !== 'server-response' || full.rpcId !== rpcId) return null
  return full.result?.ok === true ? full.result.value ?? null : null
}

/**
 * 实时快照拉取：向主机 `/dsh-live-token-stats` 通道轮询本会话数据。
 * 主机在每次轮询时按当下时刻计算速率，因此流停顿期间数值也在移动，无需本地计时。
 * 有活跃 step 时约 10 Hz，空闲只留 5 秒一次的兜底探测，基本不产生空转流量。
 * dsh 0.1.5-rc.2 起会话投影不再有实时增量，投影的 active 只用来判断 step 是否在跑，实时数值仍取自快照。
 */
function useLiveSnapshot(
  sessionId: string,
  active: boolean,
): LiveRateSnapshot | null {
  const [live, setLive] = useState<LiveRateSnapshot | null>(null)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      let delayMs = active ? 100 : 5000
      try {
        const data = await callSnapshot(sessionId)
        if (disposed) return
        setLive(data)
        if (data?.generating === true) delayMs = 100
      } catch {
        if (disposed) return
        setLive(null)
      }
      if (!disposed) timer = setTimeout(() => void poll(), delayMs)
    }
    void poll()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [sessionId, active])
  return live
}

/** 三态实时读数行；没有任何实时内容可显示时渲染为空。 */
export const LiveTokenStatsLine = memo(function LiveTokenStatsLine({
  useProjection,
  sessionId,
}: LiveTokenStatsLineProps) {
  const live = useProjection('liveTokenStats') as LiveTokenStatsProjection | undefined
  const active = live?.active ?? null
  const lastSettled = live?.lastSettled ?? null
  const liveSnap = useLiveSnapshot(sessionId, active !== null)
  const generating = liveSnap?.generating === true
  const firstTokenDelay = liveSnap?.firstTokenDelayMs
  const liveRate = liveSnap?.tokensPerSecond
  const stallMs = liveSnap?.stallMs ?? 0
  // step 的精确开始时刻来自投影 step/start 事件，快照的 elapsedMs 仅在没有它时兜底。
  const startTime = active?.startTime

  // dsh 0.1.5-rc.2 起流式增量不再逐块进会话事件，投影没有实时数据，
  // 生成中的首字、输出与速度以主机 llm/stream 快照为准，投影提供开始时刻与结算读数。
  const waiting = generating && firstTokenDelay === undefined

  const groups: string[] = []

  // 结算读数：准确速度 + 估算/实际偏差，等待首字与空闲态共用。
  const settledGroups = (): string[] => {
    const out: string[] = []
    if (lastSettled === null) return out
    const durMs = lastSettled.endTime - lastSettled.startTime
    if (durMs > 0) {
      const tokens = lastSettled.actualTokens !== undefined ? lastSettled.actualTokens : lastSettled.estimatedTokens
      const mark = lastSettled.actualTokens !== undefined ? '' : '~'
      out.push(`准确速度 ${mark}${formatTps(tokens / (durMs / 1000))} tok/s`)
    }
    if (lastSettled.actualTokens !== undefined) {
      out.push(`估算 ${formatInt(lastSettled.estimatedTokens)} / 实际 ${formatInt(lastSettled.actualTokens)} (${formatGapPct(lastSettled.estimatedTokens, lastSettled.actualTokens)})`)
    } else {
      out.push(`估算 ~${formatInt(lastSettled.estimatedTokens)} token`)
    }
    return out
  }

  if (generating && firstTokenDelay !== undefined) {
    // 状态一：生成中，已出首字。停顿超窗无样本后速率格消失，只剩已停顿计时。
    if (liveRate !== undefined) groups.push(`实时速度 ~${formatTps(liveRate)} tok/s`)
    if (stallMs > 0) groups.push(`已停顿 ${formatDuration(stallMs)}`)
    const out = liveSnap?.outputTokens ?? 0
    groups.push(`实时输出 ${liveSnap?.exact === true ? '' : '~'}${formatInt(out)} token`)
    // 平均速度：本 step 自请求发出起的全程平均，分母含首字延迟与一切停顿，与窗口化的实时速度并列对照，可看出推流在加速还是减速。
    if (liveSnap?.avgTokensPerSecond !== undefined) groups.push(`平均速度 ~${formatTps(liveSnap.avgTokensPerSecond)} tok/s`)
    groups.push(`首字延迟 ${formatDuration(firstTokenDelay)}`)
  } else if (waiting) {
    // 状态二：等待首字，尚无 token，无实时速度与实时输出。结算读数保持为对照基线。
    // 等待耗时优先用投影的 step 开始时刻，由 10 Hz 轮询驱动重渲染逐帧上涨，首字落地瞬间定格为精确 TTFT。
    groups.push(...settledGroups())
    const elapsedMs = startTime !== undefined ? Date.now() - startTime : liveSnap?.elapsedMs
    if (elapsedMs !== undefined) groups.push(`首字延迟 ${formatDuration(elapsedMs)}`)
  } else if (lastSettled !== null) {
    // 状态三：空闲态，上次已结算。生成已停止但 step 未结束，例如工具执行中，也落回此态。
    groups.push(...settledGroups())
    if (lastSettled.firstTokenTime !== null) {
      groups.push(`首字延迟 ${formatDuration(lastSettled.firstTokenTime - lastSettled.startTime)}`)
    }
  } else if (liveSnap !== null && (liveSnap.outputTokens ?? 0) > 0) {
    // 状态三的兜底：流已停止但投影尚未结算，用主机快照里本 step 的累计作对照基线。
    const out = liveSnap.outputTokens ?? 0
    groups.push(`输出 ${liveSnap.exact === true ? '' : '~'}${formatInt(out)} token`)
    if (liveSnap.firstTokenDelayMs !== undefined) groups.push(`首字延迟 ${formatDuration(liveSnap.firstTokenDelayMs)}`)
  }

  if (groups.length === 0) {
    // 空态占位：没有任何 step 数据时也渲染一行，让用户能确认插件还活着。
    // 会话刚打开且从未产生过任何 step 时，投影里 active 与 lastSettled 均为空。
    // 旧的累计数显示才会在这种时候有东西看。
    return <LiveStatsRow segments={['空闲 · 发起对话后显示实时速度 / 输出 / 首字延迟']} />
  }

  // 与原生结算统计行的结构一致：各指标块是独立 span，块间用 aria-hidden 的 `|` 分隔 span 隔开。
  return <LiveStatsRow segments={groups} />
})

/**
 * 单行统一样式容器，结构与 dsh 原生的结算统计行一致：
 * 根容器一个 div，每个指标块是独立 span，块与块之间用 aria-hidden 的 `|` 分隔 span 隔开，末尾不带分隔符。
 * 复刻时保留语义 token，不使用颜色字面量。
 */

/** 分隔符 span 的样式：比正文更淡的次级分隔点，避免喧宾夺主。 */
const SEP_STYLE: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  whiteSpace: 'nowrap',
}

/** 根容器样式：一行次级小字，数值等宽对齐，块间与块内留出呼吸感。 */
const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  flexWrap: 'wrap',
  padding: '0 12px',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: '13px',
  fontVariantNumeric: 'tabular-nums',
  lineHeight: '18px',
  whiteSpace: 'nowrap',
}

function LiveStatsRow({ segments }: { segments: ReactNode[] }) {
  const nodes: ReactNode[] = []
  for (const [i, seg] of segments.entries()) {
    // 分隔符只插在相邻块之间，末尾不带尾分隔符。
    if (i > 0) {
      nodes.push(
        <span key={'sep-' + i} aria-hidden="true" style={SEP_STYLE}>|</span>,
      )
    }
    nodes.push(<span key={'seg-' + i}>{seg}</span>)
  }
  return (
    <div data-dsh-live-token-stats="true" style={ROOT_STYLE}>
      {nodes}
    </div>
  )
}
