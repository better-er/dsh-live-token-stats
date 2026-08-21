/**
 * Browser half of dsh-live-token-stats: the live stream readout in the
 * composer dock.
 *
 * Three states, all in Chinese labels per product convention:
 *   - streaming (first token already out):
 *       实时速度 ~189 tok/s | 实时输出 ~1,234 token | 首字延迟 1.2s
 *     the live rate comes from the pure-plugin RPC channel (fed by the
 *     `llm/stream` waterfall intercept); the live output is the heuristic
 *     estimate; 首字延迟 is the recorded TTFT.
 *   - waiting for the first token:
 *       上次偏差 +12% | 实时输出 0 token | 等待首字 3.2s
 *     the deviation of the previously settled step plus a live wait timer.
 *   - idle (last step settled):
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

/** Re-render tick: 4x/s while waiting for the first token of the active step. */
function useWaitingTick(activeStartTime: number | null): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (activeStartTime === null) return
    const id = setInterval(() => setTick((t) => t + 1), 250)
    return () => clearInterval(id)
  }, [activeStartTime])
}

/**
 * Live-rate pull: ~4 Hz RPC poll of the host `/dsh-live-token-stats` channel
 * for this session. Returns undefined until the first successful read.
 */
function useLiveRate(rpc: LiveTokenStatsLineInjected['rpc'], sessionId: string): number | undefined {
  const [rate, setRate] = useState<number | undefined>(undefined)
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
          setRate(typeof data?.tokensPerSecond === 'number' ? data.tokensPerSecond : undefined)
        } else {
          setRate(undefined)
        }
      } catch {
        if (!disposed) setRate(undefined)
      }
    }
    void poll()
    timer = setInterval(() => void poll(), 250)
    return () => {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
    }
  }, [rpc, sessionId])
  return rate
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
  const liveRate = useLiveRate(rpc, sessionId)

  const waiting = active !== null && active.firstTokenTime === null
  useWaitingTick(waiting ? active.startTime : null)

  const groups: string[] = []

  if (active !== null && active.firstTokenTime !== null) {
    // 状态一:生成中(已出首字)
    if (liveRate !== undefined) groups.push(`实时速度 ~${formatTps(liveRate)} tok/s`)
    const out = active.exact && active.actualTokens !== undefined ? active.actualTokens : active.estimatedTokens
    groups.push(`实时输出 ~${formatInt(out)} token`)
    groups.push(`首字延迟 ${formatDuration(active.firstTokenTime - active.startTime)}`)
  } else if (active !== null && active.firstTokenTime === null) {
    // 状态二:等待首字(含 TTFT)——参考上次结算,与状态三同款的全量偏差(估算/实际/百分比)
    if (lastSettled !== null) {
      if (lastSettled.actualTokens !== undefined) {
        groups.push(`估算 ${formatInt(lastSettled.estimatedTokens)} / 实际 ${formatInt(lastSettled.actualTokens)} (${formatGapPct(lastSettled.estimatedTokens, lastSettled.actualTokens)})`)
      } else {
        groups.push(`估算 ~${formatInt(lastSettled.estimatedTokens)} token`)
      }
    }
    groups.push(`实时输出 ${formatInt(active.estimatedTokens)} token`)
    groups.push(`等待首字 ${formatDuration(Date.now() - active.startTime)}`)
  } else if (lastSettled !== null) {
    // 状态三:空闲(上次已结算)
    const durMs = lastSettled.endTime - lastSettled.startTime
    if (durMs > 0) {
      const tokens = lastSettled.actualTokens !== undefined ? lastSettled.actualTokens : lastSettled.estimatedTokens
      const mark = lastSettled.actualTokens !== undefined ? '' : '~'
      groups.push(`准确速度 ${mark}${formatTps(tokens / (durMs / 1000))} tok/s`)
    }
    if (lastSettled.actualTokens !== undefined) {
      groups.push(`估算 ${formatInt(lastSettled.estimatedTokens)} / 实际 ${formatInt(lastSettled.actualTokens)} (${formatGapPct(lastSettled.estimatedTokens, lastSettled.actualTokens)})`)
    } else {
      groups.push(`估算 ~${formatInt(lastSettled.estimatedTokens)} token`)
    }
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