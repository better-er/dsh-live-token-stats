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

import { Fragment, memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'
import {
  IconClockOutlineRegular,
  IconCompareSplitOutlineRegular,
  IconDatabaseOutlineRegular,
  IconGaugeOutlineRegular,
  IconPauseOutlineRegular,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { LiveTokenStatsProjection } from '../projection.ts'

/** 一个统计指标：详情面板里的一行，也是外显胶囊的候选。 */
interface StatItem {
  /** 指标名，如「实时速度」。 */
  readonly label: string
  /** 指标读数，如「~53.0 tok/s」。 */
  readonly value: string
}

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
  /** 最近一条 assistant/message 的所属 step 与本地整段估算、官方 usage，由主机计算。 */
  settledEstimate?: { turn: number; step: number; estimated: number; actual?: number; exact: boolean }
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
 * 模型生成中约 10 Hz，step 仍在但生成已停的工具阶段降到约 2 Hz，空闲只留 5 秒一次的兜底探测，基本不产生空转流量。
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
        if (data?.generating === true) {
          delayMs = 100
        } else if (active) {
          // step 仍在但生成已停，例如工具执行阶段，降到 500ms 减少空转。
          delayMs = 500
        }
      } catch (error) {
        if (disposed) return
        console.warn('[dsh-live-token-stats] 实时快照轮询失败，本帧按空数据渲染：', error)
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

  const items: StatItem[] = []

  // 结算读数：结算速度 + 估算/实际偏差，等待首字与空闲态共用；速度标签按有无官方 usage 分准确与估算。
  const settledItems = (): StatItem[] => {
    const out: StatItem[] = []
    if (lastSettled === null) return out
    // 输出估算由主机对最后一条 assistant/message 算一次，经实时快照返回；首次轮询返回前不显示估算。
    // 估算是 assistant/message 落地即更新，投影却要等 step/end 才结算 lastSettled，工具执行阶段两者属于不同的 step。
    // 只有 turn 与 step 都对上时才把估算和 lastSettled 的实际值配成一对，否则宁可不显示，避免出现跨 step 的假偏差。
    const est = liveSnap?.settledEstimate
    const estimated = est !== undefined && est.turn === lastSettled.turn && est.step === lastSettled.step
      ? est.estimated
      : undefined
    const durMs = lastSettled.endTime - lastSettled.startTime
    if (durMs > 0) {
      const actualTokens = lastSettled.actualTokens
      const tokens = actualTokens !== undefined ? actualTokens : estimated
      // 标签跟着来源走：官方 usage 已到才叫准确速度，只有整段估算时叫估算速度，避免「准确速度」配一个 `~`。
      const exact = actualTokens !== undefined
      if (tokens !== undefined) {
        out.push({ label: exact ? '准确速度' : '估算速度', value: `${exact ? '' : '~'}${formatTps(tokens / (durMs / 1000))} tok/s` })
      }
    }
    if (lastSettled.actualTokens !== undefined && estimated !== undefined) {
      out.push({ label: '估算', value: `${formatInt(estimated)} / 实际 ${formatInt(lastSettled.actualTokens)} (${formatGapPct(estimated, lastSettled.actualTokens)})` })
    } else if (estimated !== undefined) {
      out.push({ label: '估算', value: `~${formatInt(estimated)} token` })
    }
    return out
  }

  if (generating && firstTokenDelay !== undefined) {
    // 状态一：生成中，已出首字。停顿超窗无样本后速率格消失，只剩已停顿计时。
    if (liveRate !== undefined) items.push({ label: '实时速度', value: `~${formatTps(liveRate)} tok/s` })
    if (stallMs > 0) items.push({ label: '已停顿', value: formatDuration(stallMs) })
    const out = liveSnap?.outputTokens ?? 0
    items.push({ label: '实时输出', value: `${liveSnap?.exact === true ? '' : '~'}${formatInt(out)} token` })
    // 平均速度：本 step 自请求发出起的全程平均，分母含首字延迟与一切停顿，与窗口化的实时速度并列对照，可看出推流在加速还是减速。
    if (liveSnap?.avgTokensPerSecond !== undefined) items.push({ label: '平均速度', value: `${liveSnap.exact === true ? '' : '~'}${formatTps(liveSnap.avgTokensPerSecond)} tok/s` })
    items.push({ label: '首字延迟', value: formatDuration(firstTokenDelay) })
  } else if (waiting) {
    // 状态二：等待首字，尚无 token，无实时速度与实时输出。结算读数保持为对照基线。
    // 等待耗时优先用投影的 step 开始时刻，由 10 Hz 轮询驱动重渲染逐帧上涨，首字落地瞬间定格为精确 TTFT。
    items.push(...settledItems())
    const elapsedMs = startTime !== undefined ? Date.now() - startTime : liveSnap?.elapsedMs
    if (elapsedMs !== undefined) items.push({ label: '首字延迟', value: formatDuration(elapsedMs) })
  } else if (lastSettled !== null) {
    // 状态三：空闲态，上次已结算。生成已停止但 step 未结束，例如工具执行中，也落回此态。
    items.push(...settledItems())
    if (lastSettled.firstTokenTime !== null) {
      items.push({ label: '首字延迟', value: formatDuration(lastSettled.firstTokenTime - lastSettled.startTime) })
    }
  } else if (liveSnap !== null && (liveSnap.outputTokens ?? 0) > 0) {
    // 状态三的兜底：流已停止但投影尚未结算，用主机快照里本 step 的累计作对照基线。
    const out = liveSnap.outputTokens ?? 0
    items.push({ label: '输出', value: `${liveSnap.exact === true ? '' : '~'}${formatInt(out)} token` })
    if (liveSnap.firstTokenDelayMs !== undefined) items.push({ label: '首字延迟', value: formatDuration(liveSnap.firstTokenDelayMs) })
  }

  if (items.length === 0) {
    // 空态占位：没有任何 step 数据时也渲染一行，让用户能确认插件还活着。
    // 会话刚打开且从未产生过任何 step 时，投影里 active 与 lastSettled 均为空。
    return <LiveStatsPill items={[{ label: '空闲', value: '发起对话后显示实时速度 / 输出 / 首字延迟' }]} detailed={false} />
  }

  // 外显固定两个槽位：上格在生成中是实时速度或首字延迟，空闲时给上次结算的平均速度；下格是输出。
  // 不跟着 items 的顺序走，否则同一个位置会一会儿是速度一会儿是停顿，宽度来回换人。
  const summary: StatItem[] = []
  if (liveRate !== undefined) {
    summary.push({ label: '实时速度', value: `~${formatTps(liveRate)} tok/s` })
  } else if (generating || waiting) {
    let ttft: string | undefined
    if (firstTokenDelay !== undefined) {
      ttft = formatDuration(firstTokenDelay)
    } else if (waiting) {
      const elapsed = startTime !== undefined ? Date.now() - startTime : liveSnap?.elapsedMs
      if (elapsed !== undefined) ttft = formatDuration(elapsed)
    }
    if (ttft !== undefined && ttft !== '') summary.push({ label: '首字延迟', value: ttft })
  } else {
    // 空闲态上格换成上次结算的平均速度，直接从 items 里取已经算好的那一项。
    const settledSpeed = items.find((item) => item.label === '准确速度' || item.label === '估算速度')
    if (settledSpeed !== undefined) {
      summary.push({ label: '平均速度', value: settledSpeed.value })
    } else if (lastSettled !== null && lastSettled.firstTokenTime !== null) {
      summary.push({ label: '首字延迟', value: formatDuration(lastSettled.firstTokenTime - lastSettled.startTime) })
    }
  }
  if (generating) {
    summary.push({ label: '实时输出', value: `${liveSnap?.exact === true ? '' : '~'}${formatInt(liveSnap?.outputTokens ?? 0)} token` })
  } else if (lastSettled?.actualTokens !== undefined) {
    summary.push({ label: '输出', value: `${formatInt(lastSettled.actualTokens)} token` })
  } else if ((liveSnap?.outputTokens ?? 0) > 0) {
    summary.push({ label: '输出', value: `${liveSnap?.exact === true ? '' : '~'}${formatInt(liveSnap?.outputTokens ?? 0)} token` })
  }

  return <LiveStatsPill items={items} headline={summary} detailed={true} />
})

/**
 * 实时读数胶囊与其详情面板。
 *
 * 外显只有一个胶囊，结构与交互对齐原生的统计胶囊：anchor span 包一个 button，
 * 胶囊内是图标加标签，标签里用 aria-hidden 的 `·` 分隔两个固定槽位——速度或首字延迟，以及输出；
 * 其余读数收进点击后弹出的详情面板，槽位固定后宽度只在数值本身浮动。
 * 这样流式读数再怎么变，外显宽度只在两个数字上浮动，不会再整行左右平移。
 * 面板的定位与关闭复用 primitives 的 useAnchoredPosition 与 useDismissOnOutsidePointer，
 * 外观逐条照抄原生的 stat-dialog 样式，与原生统计胶囊是同一套观感。
 */

/** 分隔符 span 的样式：照抄原生 bOPqQW_sep。 */
const SEP_STYLE: CSSProperties = {
  color: 'var(--dsw-alias-separator-primary)',
  margin: '0 6px',
  whiteSpace: 'nowrap',
}

/** 胶囊外层 anchor 的样式：照抄原生 bOPqQW_anchor。 */
const ANCHOR_STYLE: CSSProperties = {
  display: 'inline-flex',
  minWidth: 0,
}

/** 胶囊样式：照抄原生 bOPqQW_pill，并补上 button 元素自身的复位。 */
const PILL_STYLE: CSSProperties = {
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  maxWidth: '100%',
  padding: '1px 8px',
  border: 'none',
  background: 'transparent',
  font: 'inherit',
  borderRadius: '999px',
  color: 'var(--dsw-alias-label-tertiary)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

/** 悬停与展开态：照抄原生 button.bOPqQW_pill 的 hover 与 aria-expanded。 */
const PILL_ACTIVE_STYLE: CSSProperties = {
  background: 'var(--dsw-alias-interactive-bg-hover)',
  color: 'var(--dsw-alias-label-secondary)',
}

/** 胶囊内图标的包裹层：图标自身只收 size 与 className，定尺与不收缩由这层给。 */
const ICON_STYLE: CSSProperties = {
  flex: '0 0 auto',
  display: 'inline-flex',
}

/** 胶囊内文本标签：照抄原生 bOPqQW_label 的单行省略。 */
const LABEL_STYLE: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

/**
 * 根容器样式：对齐会话区原生统计行的文字规格。
 *
 * 字号与行高不写死，而是照抄原生统计行所在层的同一条 CSS 表达式，让它跟随设置里的内容字号。
 */
const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexWrap: 'wrap',
  padding: '1px 8px',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
  fontWeight: 'inherit',
  lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
  whiteSpace: 'nowrap',
}

/** 面板样式：照抄原生 bRhRbq_panel。 */
const PANEL_STYLE = {
  zIndex: 1100,
  boxSizing: 'border-box',
  borderRadius: 'var(--dsw-radius-lg)',
  background: 'var(--dsw-specific-menu)',
  width: 'max-content',
  minWidth: 'min(300px, 100vw - 24px)',
  maxWidth: 'min(440px, 100vw - 24px)',
  backdropFilter: 'var(--dsw-menu-backdrop-filter)',
  '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
  boxShadow: 'var(--dsw-elevation-prominent)',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'default',
  border: 0,
  padding: 16,
  fontSize: 12,
  lineHeight: '18px',
  position: 'fixed',
} as CSSProperties

/** 尚未测出坐标时的面板样式：隐藏但参与布局，供定位测量真实尺寸。照抄原生 MEASURE_STYLE。 */
const MEASURE_STYLE: CSSProperties = {
  visibility: 'hidden',
  left: 0,
  top: 0,
}

/** 面板标题样式：照抄原生 bRhRbq_title。 */
const TITLE_STYLE: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  justifyContent: 'space-between',
  gap: 16,
  marginBottom: 8,
  fontWeight: 500,
  display: 'flex',
}

/** 标题左侧图标加文字样式：照抄原生 bRhRbq_titleLabel。 */
const TITLE_LABEL_STYLE: CSSProperties = {
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  display: 'inline-flex',
}

/** 标题下的分隔线：照抄原生 bRhRbq_titleRule。 */
const TITLE_RULE_STYLE: CSSProperties = {
  borderTop: '.5px solid var(--dsw-alias-border-l2)',
  marginBottom: 10,
}

/** 详情网格样式：照抄原生 bRhRbq_details。 */
const DETAILS_STYLE: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  gridTemplateColumns: 'minmax(76px,auto) minmax(0,1fr)',
  gap: '6px 16px',
  margin: 0,
  display: 'grid',
}

/** 详情项名：照抄原生 bRhRbq_details dt。 */
const DETAIL_TERM_STYLE: CSSProperties = {
  minWidth: 0,
  margin: 0,
}

/** 详情读数：照抄原生 bRhRbq_details dd。 */
const DETAIL_VALUE_STYLE: CSSProperties = {
  minWidth: 0,
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontVariantNumeric: 'tabular-nums',
  textAlign: 'right',
}

/**
 * 按指标名挑选图标。
 *
 * 图标全部取自 @deepseek-ai/dsh-client-ui-primitives 的官方图标集，与原生统计行图标同源：
 * 都是 16 网格、fill=none、stroke=currentColor 的描边风格。这里手动画图标会立刻显出笔触差异。
 * @param label 指标名。
 * @returns 对应图标，无法归类时给速率表。
 */
function iconFor(label: string): ReactNode {
  if (label.includes('估算')) return <IconCompareSplitOutlineRegular size={14} />
  if (label.includes('停顿')) return <IconPauseOutlineRegular size={14} />
  if (label.includes('延迟')) return <IconClockOutlineRegular size={14} />
  if (label.includes('速度')) return <IconGaugeOutlineRegular size={14} />
  if (label.includes('token')) return <IconDatabaseOutlineRegular size={14} />
  return <IconGaugeOutlineRegular size={14} />
}

/** 未显式传 summary 时外显的读数个数，其余收进详情面板。 */
const SUMMARY_COUNT = 2

/**
 * 外显胶囊加点击详情。
 * @param props 全部读数，以及是否可展开详情；空态占位行不可展开。
 */
const LiveStatsPill = memo(function LiveStatsPill({
  items,
  headline,
  detailed,
}: {
  items: StatItem[]
  /** 外显的两个槽位；缺省时退回 items 的前两个。 */
  headline?: StatItem[]
  detailed: boolean
}) {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const rootRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const expanded = detailed && open
  const anchor = useAnchoredPosition({ open: expanded, anchorRef: rootRef, panelRef, side: 'top', gap: 6, margin: 8 })
  useDismissOnOutsidePointer(rootRef, expanded, setOpen, panelRef)

  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [expanded])

  const shown = headline ?? items.slice(0, SUMMARY_COUNT)
  const head = shown[0]
  const summary = shown.map((item, i) => (
    <Fragment key={item.label + i}>
      {i > 0 && <span aria-hidden="true" style={SEP_STYLE}>·</span>}
      <span>{item.value}</span>
    </Fragment>
  ))

  return (
    <div data-dsh-live-token-stats="true" style={ROOT_STYLE}>
      <span style={ANCHOR_STYLE}>
        <button
          ref={rootRef}
          type="button"
          style={hovered || expanded ? { ...PILL_STYLE, ...PILL_ACTIVE_STYLE } : PILL_STYLE}
          aria-haspopup={detailed ? 'dialog' : undefined}
          aria-expanded={detailed ? expanded : undefined}
          aria-label={items.map((item) => item.label + ' ' + item.value).join('，')}
          onClick={detailed ? () => setOpen((value) => !value) : undefined}
          onMouseEnter={detailed ? () => setHovered(true) : undefined}
          onMouseLeave={detailed ? () => setHovered(false) : undefined}
        >
          <span style={ICON_STYLE} aria-hidden="true">{iconFor(head?.label ?? '')}</span>
          <span style={LABEL_STYLE}>{summary}</span>
        </button>
      </span>
      {expanded && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="实时 token 统计"
          style={anchor === null ? { ...PANEL_STYLE, ...MEASURE_STYLE } : { ...PANEL_STYLE, ...anchor }}
        >
          <div style={TITLE_STYLE}>
            <span style={TITLE_LABEL_STYLE}>
              <span style={ICON_STYLE} aria-hidden="true">{iconFor(head?.label ?? '')}</span>
              实时 token 统计
            </span>
          </div>
          <div style={TITLE_RULE_STYLE} aria-hidden="true" />
          <dl style={DETAILS_STYLE}>
            {items.map((item, i) => (
              <Fragment key={item.label + i}>
                <dt style={DETAIL_TERM_STYLE}>{item.label}</dt>
                <dd style={DETAIL_VALUE_STYLE}>{item.value}</dd>
              </Fragment>
            ))}
          </dl>
        </div>,
        document.body,
      )}
    </div>
  )
})
