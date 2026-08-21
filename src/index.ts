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
  /**
   * 诊断日志开关（默认关，发布零污染）。
   * 开启后在 ~/.dsh/dsh-live-token-stats-debug.jsonl 记录每流完整 delta 序列
   * 与官方 usage 对照（定位估算偏差用）；关闭时拦截器零开销。也可用环境变量
   * DSH_LIVE_TOKEN_STATS_DEBUG=1 开启，免改配置。
   */
  debug?: boolean
}

/** Runtime schema for {@link Config} (default applied by the loader). */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  asciiTokenPerChar: z.number().min(0.01).default(ESTIMATOR_DEFAULTS.asciiTokenPerChar),
  cjkTokenPerChar: z.number().min(0.01).default(ESTIMATOR_DEFAULTS.cjkTokenPerChar),
  rateWindowMs: z.number().min(0).default(ESTIMATOR_DEFAULTS.rateWindowMs),
  // 真实 BPE 分词（默认，用户拍板）；'density' 回退到双密度盲估
  // schemastery 无 z.enum，用 union 实现二选一
  tokenizerMode: z.union([z.const('bpe'), z.const('density')]).default(ESTIMATOR_DEFAULTS.tokenizerMode),
  debug: z.boolean().default(false),
})

/**
 * Register the liveTokenStats projection and the live host→client channel.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  // `enabled` 是插件开关(由 loader 注入默认值),并非 estimator 配置,剥离后再解析
  const { enabled: _enabled, debug: debugConfig, ...estimatorConfig } = config
  const spec = resolveSpec(estimatorConfig)
  // 调试日志：配置开关优先，环境变量兜底（免改配置的开发快捷方式）。
  const debug = debugConfig === true || process.env.DSH_LIVE_TOKEN_STATS_DEBUG === '1'

  // 1) Replayable settled projection (session events).
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(createLiveTokenStatsDefinition(spec))
  })

  // 2) Live real-time channel (llm/stream intercept + RPC serve).
  const live = installHostLiveStream(ctx, spec, debug)
  ctx.effect(() => live.dispose, 'dsh-live-token-stats: live stream teardown')
}

export { resolveSpec, ESTIMATOR_DEFAULTS } from './estimator.ts'
export { createLiveTokenStatsDefinition } from './projection.ts'
export type { LiveTokenStatsProjection, LiveTokenStatsState } from './projection.ts'
export { LiveTokenRateTracker, installHostLiveStream } from './live-stream.ts'
export type { LiveTokenSnapshot } from './live-stream.ts'