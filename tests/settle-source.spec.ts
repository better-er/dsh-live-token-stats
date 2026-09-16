import { describe, expect, it, vi } from 'vitest'
import { ESTIMATOR_DEFAULTS, type EstimatorSpec } from '../src/estimator.ts'
import { createSettleSource } from '../src/live-stream.ts'
import { tokenCount } from '../src/tokenizer/bpe.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

const SPEC: Readonly<EstimatorSpec> = { ...ESTIMATOR_DEFAULTS, tokenizerMode: 'bpe' }

/** 构造一条带紧凑文本流的最小 assistant/message 事件。 */
function assistantMessage(seq: number, text: string, usageOutputTokens?: number): SessionEvent {
  return {
    type: 'assistant/message',
    data: {
      turn: 0,
      step: 0,
      stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [text] }],
      ...(usageOutputTokens === undefined ? {} : { usage: { outputTokens: usageOutputTokens } }),
    },
    time: 1,
    seq,
  } as unknown as SessionEvent
}

/** 只暴露 createSettleSource 会用到的服务查找，形状按真实服务类型收窄。 */
function makeCtx(services: { sessions?: SessionStore; sessionPersistence?: SessionPersistence }): Context {
  return { get: (name: string) => (services as Record<string, unknown>)[name] } as unknown as Context
}

/** 假活跃会话：真实 Session 的事件读取口只有 snapshotEvents()，没有 events 属性。 */
function liveSession(events: readonly SessionEvent[]): Session {
  return { snapshotEvents: () => events } as unknown as Session
}

/** 假会话存储：只实现 get。 */
function liveStore(session: Session | undefined): SessionStore {
  return { get: () => session } as unknown as SessionStore
}

/** 假持久化服务：只实现 open，SessionPersistence 的公开面里唯一能读日志的入口。 */
function fakePersistence(open: SessionPersistence['open']): SessionPersistence {
  return { open } as unknown as SessionPersistence
}

/** 一次只读句柄读取的桩，记录 read 与 close 的调用次数。 */
function readHandle(events: readonly SessionEvent[]): { handle: SessionHandle; read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async () => ({ events }))
  const close = vi.fn(async () => undefined)
  return { handle: { read, close } as unknown as SessionHandle, read, close }
}

describe('createSettleSource', () => {
  it('活跃会话走 sessions.snapshotEvents，取最后一条并缓存同一结果', async () => {
    const events = [assistantMessage(1, '发展'), assistantMessage(5, '中国特色社会主义')]
    const source = createSettleSource(makeCtx({ sessions: liveStore(liveSession(events)) }), SPEC)
    const first = await source.get('s1')
    expect(first?.estimated).toBe(tokenCount('中国特色社会主义'))
    const second = await source.get('s1')
    // 同一条消息命中缓存，返回同一对象而不是重算
    expect(second).toBe(first)
  })

  it('冷会话用 open 的只读句柄读一次并关闭句柄', async () => {
    const { handle, read, close } = readHandle([assistantMessage(3, 'hello', 42)])
    const open = vi.fn(async () => handle)
    const source = createSettleSource(makeCtx({ sessionPersistence: fakePersistence(open) }), SPEC)
    const first = await source.get('cold')
    expect(first).toEqual({ turn: 0, step: 0, estimated: tokenCount('hello'), actual: 42, exact: true })
    await source.get('cold')
    expect(open).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('读取失败进入退避，退避到期后重试并恢复', async () => {
    const { handle } = readHandle([assistantMessage(1, 'ok')])
    const open = vi.fn()
      .mockRejectedValueOnce(new Error('client disconnected'))
      .mockResolvedValueOnce(handle)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.useFakeTimers()
    try {
      const source = createSettleSource(makeCtx({ sessionPersistence: fakePersistence(open) }), SPEC)
      expect(await source.get('cold')).toBeUndefined()
      // 退避窗口内不再尝试，避免空闲轮询对读不到的会话刷告警
      expect(await source.get('cold')).toBeUndefined()
      expect(open).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 11_000)
      const retry = await source.get('cold')
      expect(retry?.estimated).toBe(tokenCount('ok'))
      expect(open).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  it('会话转活跃时作废冷读缓存，移出 store 后重新读', async () => {
    const { handle } = readHandle([assistantMessage(1, 'old')])
    const open = vi.fn(async () => handle)
    const services: { sessions?: SessionStore; sessionPersistence?: SessionPersistence } = {
      sessionPersistence: fakePersistence(open),
    }
    const source = createSettleSource(makeCtx(services), SPEC)
    expect((await source.get('s1'))?.estimated).toBe(tokenCount('old'))
    expect(open).toHaveBeenCalledTimes(1)
    services.sessions = liveStore(liveSession([assistantMessage(2, 'live')]))
    expect((await source.get('s1'))?.estimated).toBe(tokenCount('live'))
    delete services.sessions
    expect((await source.get('s1'))?.estimated).toBe(tokenCount('old'))
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('没有 assistant/message 时返回 undefined', async () => {
    const source = createSettleSource(makeCtx({ sessions: liveStore(liveSession([])) }), SPEC)
    expect(await source.get('s1')).toBeUndefined()
  })

  it('两个服务都缺席时返回 undefined 并留下日志', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const source = createSettleSource(makeCtx({}), SPEC)
    expect(await source.get('s1')).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

