/**
 * Host half of dsh-live-token-stats.
 *
 * Two independent halves:
 *  1. The replayable `liveTokenStats` session projection (official
 *     sessionProjections registry) — settled output estimate + TTFT timing.
 *  2. A live host→client channel for the REAL-TIME token rate: the
 *     `llm/stream` waterfall intercept folds raw per-chunk adapter deltas
 *     (text / reasoning / tool-call argument fragments — the genuinely
 *     streamed, unaggregated source) into a per-session sliding-window rate,
 *     served to the browser over a plugin-owned RPC channel
 *     (`/dsh-live-token-stats`). Pure plugin, no DSH source edits, ships
 *     anywhere.
 *
 * @module dsh-live-token-stats
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ESTIMATOR_DEFAULTS, resolveSpec, type EstimatorConfig } from './estimator.ts'
import { createLiveTokenStatsDefinition } from './projection.ts'
import { installHostLiveStream } from './live-stream.ts'

/** Plugin name (= the cordis config entry id). */
export const name = 'dsh-live-token-stats'
/** Host services this plugin needs. */
export const inject = ['sessionProjections', 'connection']

/** Plugin configuration: estimator densities plus a master switch. */
export interface Config extends EstimatorConfig {
  /** Master switch for the whole capability. */
  enabled?: boolean
}

/** Runtime schema for {@link Config} (default applied by the loader). */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  asciiTokenPerChar: z.number().min(0.01).default(ESTIMATOR_DEFAULTS.asciiTokenPerChar),
  cjkTokenPerChar: z.number().min(0.01).default(ESTIMATOR_DEFAULTS.cjkTokenPerChar),
  rateWindowMs: z.number().min(0).default(ESTIMATOR_DEFAULTS.rateWindowMs),
})

/**
 * Register the liveTokenStats projection and the live host→client channel.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  // `enabled` 是插件开关(由 loader 注入默认值),并非 estimator 配置,剥离后再解析
  const { enabled: _enabled, ...estimatorConfig } = config
  const spec = resolveSpec(estimatorConfig)

  // 1) Replayable settled projection (session events).
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(createLiveTokenStatsDefinition(spec))
  })

  // 2) Live real-time channel (llm/stream intercept + RPC serve).
  const live = installHostLiveStream(ctx, spec)
  ctx.effect(() => live.dispose, 'dsh-live-token-stats: live stream teardown')
}

export { resolveSpec, ESTIMATOR_DEFAULTS } from './estimator.ts'
export { createLiveTokenStatsDefinition } from './projection.ts'
export type { LiveTokenStatsProjection, LiveTokenStatsState } from './projection.ts'
export { LiveTokenRateTracker, installHostLiveStream } from './live-stream.ts'
export type { LiveTokenSnapshot } from './live-stream.ts'