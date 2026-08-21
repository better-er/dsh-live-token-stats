/**
 * Real-time host→client live stream for dsh-live-token-stats.
 *
 * The official session-event projection pipeline is deliberately "settled":
 * values are pure folds over committed `SessionEvent`s, replayed from the log,
 * and there is no open seam for pushing externally-computed, wall-clock-live
 * figures through it (the browser projection seat only accepts fold driven
 * keys). Live token throughput is by nature an in-flight, wall-clock quantity,
 * not a replayable fold.
 *
 * So this module opens its OWN pure-plugin channel — no DSH source edits, so it
 * ships and installs anywhere:
 *
 *   host:  `ctx.on('llm/stream', ...)` intercepts the raw per-chunk adapter
 *          stream (the same waterfall the official invariant wraps). For every
 *          text / reasoning / tool-call argument fragment it accumulates a
 *          sliding-window token rate per session (keyed by `options.sessionId`).
 *   host:  `ctx.connection.rpc.handle('/dsh-live-token-stats', ...)` serves the
 *          latest per-session live snapshot.
 *   client: polls that RPC endpoint a few times a second and renders it.
 *
 * This is "baseline push-like realtime" achievable by a distributable plugin:
 * RPC pull throttled at ~4/s. No frame-type registration, no runtime patch.
 *
 * @module dsh-live-token-stats/live-stream
 */

import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: pulls the host `ctx.connection` (HostConnectionHandle)
// declaration merge from the connection package's host entry.
import '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { estimateTextTokens, type EstimatorSpec } from './estimator.ts'

/** The token-bearing content of a delta chunk (empty when none). */
function deltaTextOf(chunk: StreamChunk): string {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text
  if (chunk.type === 'tool-call-delta') return (chunk as { argumentsDelta?: string }).argumentsDelta ?? ''
  return ''
}

/** Whether a chunk contributes streamed output tokens. */
function isTokenDelta(chunk: StreamChunk): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta'
}

/** One sliding-window rate cell for a session. */
interface RateCell {
  /** Monotonic tick counter; bumped on every windowed recompute for decay. */
  samples: { time: number; tokens: number }[]
  /** Latest computed token/sec, or undefined when the window is empty. */
  rate: number | undefined
  /** Last wall-clock ms a delta was folded (used only for client decay hints). */
  updatedAt: number
}

/** The live snapshot served to the client for one session. */
export interface LiveTokenSnapshot {
  /** Streaming tokens/sec over the sliding window (undefined when idle). */
  tokensPerSecond?: number
  /** Wall-clock epoch ms of the newest folded sample (client decays from here). */
  updatedAt: number
}

const INITIAL_RATE_CELL = (): RateCell => ({ samples: [], rate: undefined, updatedAt: 0 })

/**
 * Real-time per-session token-rate tracker. Single-threaded (one host process);
 * `llm/stream` is serialized per request, so the map needs no locking.
 */
export class LiveTokenRateTracker {
  private readonly cells = new Map<string, RateCell>()

  constructor(private readonly spec: Readonly<EstimatorSpec>) {}

  /** Fold one adapter chunk into its session's rate cell. Pure w.r.t. the stream. */
  fold(sessionId: string | undefined, chunk: StreamChunk, timeMs: number): void {
    if (sessionId === undefined) return
    if (!isTokenDelta(chunk)) return
    const text = deltaTextOf(chunk)
    if (text.length === 0) return
    let cell = this.cells.get(sessionId)
    if (cell === undefined) {
      cell = INITIAL_RATE_CELL()
      this.cells.set(sessionId, cell)
    }
    const tokens = estimateTextTokens(text, this.spec)
    cell.samples.push({ time: timeMs, tokens })
    this.recompute(cell, timeMs)
  }

  /** Snapshot cell for one session. */
  snapshot(sessionId: string): LiveTokenSnapshot {
    const cell = this.cells.get(sessionId)
    if (cell === undefined) return { updatedAt: 0 }
    const out: LiveTokenSnapshot = { updatedAt: cell.updatedAt }
    if (cell.rate !== undefined) out.tokensPerSecond = cell.rate
    return out
  }

  /** Drop a session's cell (e.g. on turn/end or when no longer needed). */
  reset(sessionId: string): void {
    this.cells.delete(sessionId)
  }

  private recompute(cell: RateCell, asOf: number): void {
    const window = this.spec.rateWindowMs
    const cutoff = asOf - window
    // Pop samples older than the sliding window.
    let samples = cell.samples
    while (samples.length > 0 && samples[0].time < cutoff) samples = samples.slice(1)
    cell.samples = samples
    cell.updatedAt = asOf
    if (samples.length === 0) {
      cell.rate = undefined
      return
    }
    // Span from the window's oldest surviving sample to now, floored at 50ms
    // so a burst of same-timestamp samples (a large tool-call argument delta
    // arriving in one frame) cannot divide by ~0 and explode the rate.
    const spanMs = Math.max(50, asOf - samples[0].time)
    const total = samples.reduce((acc, s) => acc + s.tokens, 0)
    cell.rate = total / (spanMs / 1000)
  }
}

/**
 * Build the RPC channel handler backed by the tracker.
 * `endpoint` `snapshot` + `{ sessionId }` returns that session's live rate.
 */
export function createLiveStreamRpcHandler(
  tracker: LiveTokenRateTracker,
): ConnectionRpcHandler {
  return async (endpoint, payload) => {
    if (endpoint !== 'snapshot') {
      return transportError(new Error(`unknown endpoint ${endpoint}`))
    }
    const sessionId = (payload as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return transportError(new Error('missing sessionId'))
    }
    return { ok: true, value: tracker.snapshot(sessionId) }
  }
}

/**
 * Install the host half: intercept `llm/stream` and mount the RPC channel.
 * @param ctx - host plugin context (the same context used by `apply`).
 * @param spec - resolved estimator spec.
 * @returns the tracker (for tests / teardown) and a disposer.
 */
export function installHostLiveStream(
  ctx: Context,
  spec: Readonly<EstimatorSpec>,
): { tracker: LiveTokenRateTracker; dispose: () => void } {
  const tracker = new LiveTokenRateTracker(spec)

  // Prepend so we see chunks before the invariant validator (harmless either way).
  const offStream = ctx.on(
    'llm/stream',
    (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      const sessionId = options.sessionId
      return (async function* () {
        for await (const chunk of next()) {
          // timeMs: the adapter chunks carry no timestamp; use wall-clock so the
          // client-rendered rate decays naturally with real time.
          tracker.fold(String(sessionId), chunk, Date.now())
          yield chunk
        }
      })()
    },
    { global: true, prepend: true },
  )

  // Mount the client-pull RPC channel on the shared connection transport.
  let offRpc: (() => Promise<void>) | undefined
  const connection = ctx.connection
  if (connection !== undefined) {
    offRpc = connection.rpc.handle(
      '/dsh-live-token-stats',
      createLiveStreamRpcHandler(tracker),
      { authority: 'loopback' },
    )
  }

  return {
    tracker,
    dispose: () => {
      offStream()
      offRpc?.()
    },
  }
}

/** Re-export the estimator spec type for use in tests. */
export type { EstimatorSpec as LiveStreamEstimatorSpec } from './estimator.ts'
