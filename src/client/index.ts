/**
 * Browser plugin entry: mounts the live token-stats readout into the composer
 * dock (`conversation.composer.dock`). The real-time token/sec figure no longer
 * rides the session projection (settled, fold-driven); it is pulled through a
 * pure-plugin RPC channel the host half serves (`/dsh-live-token-stats`), which
 * in turn is fed by the `llm/stream` waterfall intercept — the raw per-chunk
 * adapter stream, tool-call argument fragments included.
 *
 * @module dsh-live-token-stats/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: merges the ui-conversation SlotMap declaration so the
// 'conversation.composer.dock' slot name type-checks on the slots registry.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LiveTokenStatsLine } from './LiveTokenStatsLine.tsx'

/** Plugin name (= the config entry id). */
export const name = 'dsh-live-token-stats'
/** Client services this plugin needs (slots + the connection RPC carrier). */
export const inject = ['slots', 'connection']

/** The business face injected into the readout component by the registration. */
export interface LiveTokenStatsLineInjected {
  /** Connection RPC caller (the host half serves `/dsh-live-token-stats`). */
  readonly rpc: ClientConnectionRpc
}

/**
 * Register the readout into the composer dock. The dock owner share supplies
 * the session-scoped `useProjection` seat and `sessionId`; we additionally
 * inject the connection RPC caller for the live rate pull.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // `ctx.connection` is provided by the connection service; on the browser the
  // face is `ConnectionHandle` (host and client bundles ship separate
  // declarations of `Context.connection`, so read it through a narrow cast).
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