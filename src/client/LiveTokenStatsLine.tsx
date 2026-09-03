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
import type { ReactNode } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { LiveTokenStatsLineInjected } from './index.ts'
import type { LiveTokenStatsProjection } from '../projection.ts'

/** 停靠区所属方为组合/会话槽位交付的 props。 */
export interface LiveTokenStatsLineProps extends LiveTokenStatsLineInjected {
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

/** 重渲染计时：活跃步骤等待首字期间每秒 10 次。 */
function useWaitingTick(activeStartTime: number | null): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (activeStartTime === null) return
    const id = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(id)
  }, [activeStartTime])
}

/**
 * 实时速率与停顿拉取：约 10 Hz RPC 轮询主机 `/dsh-live-token-stats` 通道以取本会话数据。
 * 主机会话在每次轮询时按当下时刻计算速率，因此流停顿期间数值也在移动，无需本地计时。
 * 仅在有活跃 step 时轮询，即 enabled 为真，空闲时不发任何请求，避免空转流量。
 */
function useLiveSnapshot(
  rpc: LiveTokenStatsLineInjected['rpc'],
  sessionId: string,
  enabled: boolean,
): { rate: number | undefined; stallMs: number; generating: boolean } {
  const [live, setLive] = useState<{ rate: number | undefined; stallMs: number; generating: boolean }>({ rate: undefined, stallMs: 0, generating: true })
  useEffect(() => {
    // 空闲态即无活跃 step 时停掉轮询；进入活跃态时 effect 重建并立即拉一次。
    if (!enabled) return
    let disposed = false
    let timer: ReturnType<typeof setInterval> | undefined
    const poll = async (): Promise<void> => {
      try {
        const result = await rpc.call(
          '/dsh-live-token-stats',
          'snapshot',
          { sessionId },
        )
        if (disposed) return
        if (result.ok) {
          const data = (result as { value?: LiveRateSnapshot }).value
          setLive({
            rate: typeof data?.tokensPerSecond === 'number' ? data.tokensPerSecond : undefined,
            stallMs: data?.stallMs ?? 0,
            generating: data?.generating ?? true,
          })
        } else {
          setLive({ rate: undefined, stallMs: 0, generating: true })
        }
      } catch {
        if (!disposed) setLive({ rate: undefined, stallMs: 0, generating: true })
      }
    }
    void poll()
    timer = setInterval(() => void poll(), 100)
    return () => {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
    }
  }, [rpc, sessionId, enabled])
  return live
}

/** 三态实时读数行；没有任何实时内容可显示时渲染为空。 */
export const LiveTokenStatsLine = memo(function LiveTokenStatsLine({
  useProjection,
  sessionId,
  rpc,
}: LiveTokenStatsLineProps) {
  const live = useProjection('liveTokenStats') as LiveTokenStatsProjection | undefined
  const active = live?.active ?? null
  const lastSettled = live?.lastSettled ?? null
  const liveSnap = useLiveSnapshot(rpc, sessionId, active !== null)
  const liveRate = liveSnap.rate
  const stallMs = liveSnap.stallMs
  const generating = liveSnap.generating

  const waiting = active !== null && active.firstTokenTime === null && generating
  useWaitingTick(waiting ? active.startTime : null)

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

  if (active !== null && active.firstTokenTime !== null && generating) {
    // 状态一：生成中，已出首字。停顿超窗无样本后速率格消失，只剩已停顿计时。
    if (liveRate !== undefined) groups.push(`实时速度 ~${formatTps(liveRate)} tok/s`)
    if (stallMs > 0) groups.push(`已停顿 ${formatDuration(stallMs)}`)
    const out = active.exact && active.actualTokens !== undefined ? active.actualTokens : active.estimatedTokens
    groups.push(`实时输出 ~${formatInt(out)} token`)
    // 平均速度：本 step 自请求发出起的全程平均，分母含首字延迟与一切停顿，与窗口化的实时速度并列对照，可看出推流在加速还是减速。
    const elapsedMs = Date.now() - active.startTime
    if (elapsedMs > 0) groups.push(`平均速度 ~${formatTps(out / (elapsedMs / 1000))} tok/s`)
    groups.push(`首字延迟 ${formatDuration(active.firstTokenTime - active.startTime)}`)
  } else if (active !== null && active.firstTokenTime === null && generating) {
    // 状态二：等待首字，尚无 token，无实时速度与实时输出。结算读数保持为对照基线。
    // 首字延迟显示本次等待的实时耗时，由 useWaitingTick 以 10 Hz 驱动重渲染逐帧上涨，首字落地的瞬间自然定格为该 step 的精确 TTFT。
    groups.push(...settledGroups())
    groups.push(`首字延迟 ${formatDuration(Date.now() - active.startTime)}`)
  } else if (lastSettled !== null) {
    // 状态三：空闲态，上次已结算。生成已停止但 step 未结束，例如工具执行中，也落回此态。
    groups.push(...settledGroups())
    if (lastSettled.firstTokenTime !== null) {
      groups.push(`首字延迟 ${formatDuration(lastSettled.firstTokenTime - lastSettled.startTime)}`)
    }
  } else if (active !== null && active.firstTokenTime !== null) {
    // 状态三的兜底：流已停止、step 未结束，但尚无任何历史结算——正是第一步常见情形，
    // 例如本 step 已推完文字、正在执行工具或等待结算。此时没有上一笔 lastSettled 可作对照基线，
    // 改显示本 step 已累计的输出 token 与首字延迟，而不是误渲染「还没发起对话」的空态占位符。
    // 第 2、3… 步因存在 lastSettled 会命中状态三，不会走到这里。
    const out = active.actualTokens !== undefined ? active.actualTokens : active.estimatedTokens
    groups.push(`输出 ${active.actualTokens !== undefined ? '' : '~'}${formatInt(out)} token`)
    groups.push(`首字延迟 ${formatDuration(active.firstTokenTime - active.startTime)}`)
  }

  if (groups.length === 0) {
    // 空态占位：没有任何 step 数据时也渲染一行，让用户能确认插件还活着。
    // 会话刚打开且从未产生过任何 step 时，投影里 active 与 lastSettled 均为空。
    // 旧的累计数显示才会在这种时候有东西看。
    return <LiveStatsRow content="空闲 · 发起对话后显示实时速度 / 输出 / 首字延迟" />
  }

  // 与早期版本一致：各指标块之间用 ` | ` 分隔，整行输出。
  return <LiveStatsRow content={groups.join(' | ')} />
})

/** 单行统一样式容器：既承载实时数据也承载空态占位。 */
function LiveStatsRow({ content }: { content: ReactNode }) {
  return (
    <div
      data-dsh-live-token-stats="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        padding: '2px 8px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '11.5px',
        fontVariantNumeric: 'tabular-nums',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      }}
    >
      {content}
    </div>
  )
}