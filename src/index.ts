/**
 * dsh-live-token-stats 的主机端。
 *
 * 两个相互独立的部分：
 *  1. 可重放的 `liveTokenStats` 会话投影，官方 sessionProjections 注册表，提供结算后的输出估算与 TTFT 计时。
 *  2. 实时 token 速率的主机→客户端通道：`llm/stream` 瀑布流拦截把原始逐块 adapter 增量含 text、reasoning 与 tool-call 参数片段折叠成每个会话的滑动窗口速率，再经插件自有的 RPC 通道 `/dsh-live-token-stats` 提供给浏览器。
 *
 * 纯插件实现，不改 DSH 源码，可随处安装分发。
 *
 * @module dsh-live-token-stats
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ESTIMATOR_DEFAULTS, resolveSpec, type EstimatorConfig } from './estimator.ts'
import { createLiveTokenStatsDefinition } from './projection.ts'
import { installHostLiveStream } from './live-stream.ts'

/** 插件名即 cordis 配置项 id。 */
export const name = 'dsh-live-token-stats'
/** 本插件需要的主机服务。 */
export const inject = ['sessionProjections', 'connection']

/** 插件配置：估算器密度参数外加一个总开关。 */
export interface Config extends EstimatorConfig {
  /** 整套能力的总开关。 */
  enabled?: boolean
  /**
   * 诊断日志开关，默认关，发布零污染。
   * 开启后在 ~/.dsh/dsh-live-token-stats-debug.jsonl 记录每流完整 delta 序列并与官方 usage 对照，用于定位估算偏差。
   * 关闭时拦截器零开销。
   * 也可用环境变量 DSH_LIVE_TOKEN_STATS_DEBUG=1 开启，免改配置。
   */
  debug?: boolean
}

/** {@link Config} 的运行时 schema，默认值由 loader 应用。 */
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
 * 注册 liveTokenStats 投影与实时主机→客户端通道。
 * @param ctx - 主机插件上下文。
 * @param config - 已解析的插件配置，schema 默认值由 loader 应用。
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  // `enabled` 是插件开关(由 loader 注入默认值),并非 estimator 配置,剥离后再解析
  const { enabled: _enabled, debug: debugConfig, ...estimatorConfig } = config
  const spec = resolveSpec(estimatorConfig)
  // 调试日志：配置开关优先，环境变量兜底（免改配置的开发快捷方式）。
  const debug = debugConfig === true || process.env.DSH_LIVE_TOKEN_STATS_DEBUG === '1'

  // 其一：可重放的结算投影，处理会话事件。
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(createLiveTokenStatsDefinition(spec))
  })

  // 其二：实时通道，拦截 llm/stream 并提供 RPC。
  const live = installHostLiveStream(ctx, spec, debug)
  ctx.effect(() => live.dispose, 'dsh-live-token-stats: live stream teardown')
}

export { resolveSpec, ESTIMATOR_DEFAULTS } from './estimator.ts'
export { createLiveTokenStatsDefinition } from './projection.ts'
export type { LiveTokenStatsProjection, LiveTokenStatsState } from './projection.ts'
export { LiveTokenRateTracker, installHostLiveStream } from './live-stream.ts'
export type { LiveTokenSnapshot } from './live-stream.ts'