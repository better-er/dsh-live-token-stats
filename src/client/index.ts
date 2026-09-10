/**
 * 浏览器插件入口：把实时 token 读数挂到 composer 停靠区 `conversation.composer.dock`。
 * 实时 token/秒数字不再走会话投影，即结算式且折叠驱动，而是直接向主机插件自注册的
 * `/dsh-live-token-stats` 通道 POST，复用官方 client-request/server-response 信封，
 * 由 `llm/stream` 瀑布流拦截喂养，即原始逐块 adapter 流含 tool-call 参数片段。
 *
 * 刻意不经 `ctx.connection.rpc`：本插件客户端曾取不到该调用器，失败原因未定位，为规避改用直连打通道，与 dsh-classic-coding 的做法一致。
 *
 * @module dsh-live-token-stats/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// 仅类型：合并 ui-conversation 的 SlotMap 声明，让 'conversation.composer.dock' 槽位名在 slots 注册表里通过类型检查。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LiveTokenStatsLine } from './LiveTokenStatsLine.tsx'

/** 插件名即配置项 id。 */
export const name = 'dsh-live-token-stats'
/** 本插件需要的客户端服务：只需槽位，实时数据直接打插件通道。 */
export const inject = ['slots']

/**
 * 把读数注册进 composer 停靠区。
 * 停靠区所属方提供会话作用域的 `useProjection` 座位和 `sessionId`。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        id: 'dsh-live-token-stats',
        order: 10,
      },
      LiveTokenStatsLine,
    ),
  )
}

export { LiveTokenStatsLine } from './LiveTokenStatsLine.tsx'
export type { LiveTokenStatsLineProps } from './LiveTokenStatsLine.tsx'