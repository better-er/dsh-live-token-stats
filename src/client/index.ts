/**
 * 浏览器插件入口：把实时 token 读数挂到 composer 停靠区 `conversation.composer.dock`。
 * 实时 token/秒数字不再走会话投影，即结算式且折叠驱动，而是经由纯插件 RPC 通道拉取，由主机端提供 `/dsh-live-token-stats`，再由 `llm/stream` 瀑布流拦截喂养，即原始逐块 adapter 流含 tool-call 参数片段。
 *
 * @module dsh-live-token-stats/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
// 仅类型：合并 ui-conversation 的 SlotMap 声明，让 'conversation.composer.dock' 槽位名在 slots 注册表里通过类型检查。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LiveTokenStatsLine } from './LiveTokenStatsLine.tsx'

/** 插件名即配置项 id。 */
export const name = 'dsh-live-token-stats'
/** 本插件需要的客户端服务，即槽位加 connection RPC 载体。 */
export const inject = ['slots', 'connection']

/** 注册时注入读数组件的业务面。 */
export interface LiveTokenStatsLineInjected {
  /** Connection RPC 调用器，主机端提供 `/dsh-live-token-stats`。 */
  readonly rpc: ClientConnectionRpc
}

/**
 * 把读数注册进 composer 停靠区。
 * 停靠区所属方提供会话作用域的 `useProjection` 座位和 `sessionId`，我们另外注入 connection RPC 调用器用于实时速率拉取。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  // `ctx.connection` 由 connection 服务提供，浏览器端的面是 `ConnectionHandle`。
  // 主机与客户端 bundle 各自独立声明 `Context.connection`，因此经一次收窄转换读取。
  const connection = (ctx as unknown as { connection: ConnectionHandle }).connection
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        id: 'dsh-live-token-stats',
        order: 10,
        inject: (): LiveTokenStatsLineInjected => ({
          rpc: connection.rpc,
        }),
      },
      LiveTokenStatsLine,
    ),
  )
}

export { LiveTokenStatsLine } from './LiveTokenStatsLine.tsx'
export type { LiveTokenStatsLineProps } from './LiveTokenStatsLine.tsx'