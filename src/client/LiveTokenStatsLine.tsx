/**
 * Browser half of dsh-live-token-stats: the live stream readout in the
 * composer dock.
 *
 * Three states, all in Chinese labels per product convention:
 *   - streaming, first token already out:
 *       实时速度 ~53.0 tok/s | 已停顿 2.5s | 实时输出 ~2,123 token | 首字延迟 1.2s
 *     the live rate is the host's windowed rate, TTFT folded into the span
 *     which slides from step start up to the window size, then stays fixed;
 *     long stalls expire the window's samples, the host stops emitting a rate
 *     and the speed readout disappears, leaving 已停顿 ticking.
 *   - waiting for the first token:
 *       准确速度 28.7 tok/s | 估算 2,123 / 实际 1,966 (+8%) | 等待首字 3.2s
 *     no token has arrived yet, so there is no live speed/output to show;
 *     the last settled readout is shown instead, with the wait timer ticking
 *     locally.
 *   - idle, last step settled:
 *       准确速度 189 tok/s | 估算 1,234 / 实际 1,100 (+12%) | 首字延迟 1.2s
 *     the settled actual rate, the estimate-vs-actual deviation, and the
 *     settled TTFT. No cumulative / global averages are shown any more.
 *
 * @module dsh-live-token-stats/client
 */

import { memo, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { LiveTokenStatsLineInjected } from './index.ts'
import type { LiveTokenStatsProjection } from '../projection.ts'

/** Props the dock owner share delivers for a composition/session slot. */
export interface LiveTokenStatsLineProps extends LiveTokenStatsLineInjected {
  useProjection: UseProjection
  /** Framework-resolved session id (owners never pass it). */
  sessionId: string
}

/** The live-rate snapshot the host serves for this session. */
interface LiveRateSnapshot {
  tokensPerSecond?: number
  updatedAt: number
  stallMs?: number
  sinceLastMs?: number
}

// --- Formatting -------------------------------------------------------------

/** Thousand-separated integer token count: 517 / 1,234 / 12,300. */
export function formatInt(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '0'
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** TPS with one decimal under 100 tok/s. */
export function formatTps(v: number): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return ''
  return v < 100 ? String(Math.round(v * 10) / 10) : String(Math.round(v))
}

/** Compact duration: 45.2s / 2m42s. */
export function formatDuration(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const s = ms / 1000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Signed integer percent of (estimate - actual) / actual, e.g. "+12%". */
export function formatGapPct(estimated: number, actual: number): string {
  if (typeof estimated !== 'number' || typeof actual !== 'number' || !Number.isFinite(estimated) || !Number.isFinite(actual) || actual <= 0) return ''
  const pct = ((estimated - actual) / actual) * 100
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${Math.round(pct)}%`
}

/** Re-render tick: 10x/s while waiting for the first token of the active step. */
function useWaitingTick(activeStartTime: number | null): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (activeStartTime === null) return
    const id = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(id)
  }, [activeStartTime])
}

/**
 * Live-rate + stall pull: ~10 Hz RPC poll of the host `/dsh-live-token-stats`
 * channel for this session. The host computes the rate as of each poll, so
 * the values keep moving while the stream stalls without any local ticking.
 */
function useLiveSnapshot(
  rpc: LiveTokenStatsLineInjected['rpc'],
  sessionId: string,
): { rate: number | undefined; stallMs: number } {
  const [live, setLive] = useState<{ rate: number | undefined; stallMs: number }>({ rate: undefined, stallMs: 0 })
  useEffect(() => {
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
          })
        } else {
          setLive({ rate: undefined, stallMs: 0 })
        }
      } catch {
        if (!disposed) setLive({ rate: undefined, stallMs: 0 })
      }
    }
    void poll()
    timer = setInterval(() => void poll(), 100)
    return () => {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
    }
  }, [rpc, sessionId])
  return live
}

/** The three-state live readout row; renders nothing when there is nothing live to show. */
export const LiveTokenStatsLine = memo(function LiveTokenStatsLine({
  useProjection,
  sessionId,
  rpc,
}: LiveTokenStatsLineProps) {
  const live = useProjection('liveTokenStats') as LiveTokenStatsProjection | undefined
  const active = live?.active ?? null
  const lastSettled = live?.lastSettled ?? null
  const liveSnap = useLiveSnapshot(rpc, sessionId)
  const liveRate = liveSnap.rate
  const stallMs = liveSnap.stallMs

  const waiting = active !== null && active.firstTokenTime === null
  useWaitingTick(waiting ? active.startTime : null)

  // —— 临时诊断：每次结算打一行「估算/实际/偏差」对照（devtools console），定位后移除 ——
  useEffect(() => {
    if (lastSettled === null) return
    const { turn, step, estimatedTokens, actualTokens, startTime, endTime } = lastSettled
    console.info(
      '[dsh-live-token-stats] settled',
      JSON.stringify({
        turn,
        step,
        est: estimatedTokens,
        actual: actualTokens ?? null,
        gapPct:
          typeof actualTokens === 'number' && actualTokens > 0
            ? Math.round(((estimatedTokens - actualTokens) / actualTokens) * 100)
            : null,
        durMs: endTime - startTime,
      }),
    )
  }, [lastSettled])

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

  if (active !== null && active.firstTokenTime !== null) {
    // 状态一：生成中，已出首字。停顿超窗无样本后速率格消失，只剩已停顿计时。
    if (liveRate !== undefined) groups.push(`实时速度 ~${formatTps(liveRate)} tok/s`)
    if (stallMs > 0) groups.push(`已停顿 ${formatDuration(stallMs)}`)
    const out = active.exact && active.actualTokens !== undefined ? active.actualTokens : active.estimatedTokens
    groups.push(`实时输出 ~${formatInt(out)} token`)
    groups.push(`首字延迟 ${formatDuration(active.firstTokenTime - active.startTime)}`)
  } else if (active !== null && active.firstTokenTime === null) {
    // 状态二：等待首字，尚无 token，无实时速度与实时输出，展示与空闲态同款的结算读数。
    groups.push(...settledGroups())
    groups.push(`等待首字 ${formatDuration(Date.now() - active.startTime)}`)
  } else if (lastSettled !== null) {
    // 状态三:空闲(上次已结算)
    groups.push(...settledGroups())
    if (lastSettled.firstTokenTime !== null) {
      groups.push(`首字延迟 ${formatDuration(lastSettled.firstTokenTime - lastSettled.startTime)}`)
    }
  }

  if (groups.length === 0) {
    // 空态占位:没有任何 step 数据时也渲染一行,让用户能确认插件还活着。
    // (会话刚打开、从未产生过任何 step 时,投影里 active 与 lastSettled
    // 均为空——旧的累计数显示才会在这种时候有东西看。)
    return <LiveStatsRow content="空闲 · 发起对话后显示实时速度 / 输出 / 首字延迟" />
  }

  // 与早期版本一致:各指标块之间用 ` | ` 分隔,整行输出。
  return <LiveStatsRow content={groups.join(' | ')} />
})

/** 单行统一样式容器:既承载实时数据也承载空态占位。 */
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