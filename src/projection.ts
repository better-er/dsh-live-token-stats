/**
 * `liveTokenStats` 会话投影：只记录 step 的时间线与官方 usage，不做分词、不持有原文。
 *
 * 结算估算原本由投影在重放时逐帧算，冷读长会话要对每条历史 step 重扫 BPE。
 * 现在改由 host 在需要时对最后一条 `assistant/message` 算一次，见 settle.ts 与 live-stream.ts，
 * 投影只提供客户端判断 step 是否在跑，以及首字与结算时间戳。
 *
 * 状态保持纯 JSON，体积只有时间戳与几个数字，可安全持久化。
 *
 * @module dsh-live-token-stats/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expandCompactStream, isDeltaChunk } from './settle.ts'

/** 在会话投影映射表里声明我们的 key，可合并扩展。 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 当前正在流式输出或刚结算步骤的实时与时间性 token 数据。 */
    liveTokenStats: LiveTokenStatsProjection
  }
  interface SessionProjectionStateMap {
    /** 支撑 liveTokenStats 客户端视图的持久化折叠状态。 */
    liveTokenStats: LiveTokenStatsState
  }
}

/** 一步的 token 时间线，输出估算由 host 单独提供，投影不持有。 */
export interface LiveStepFacts {
  turn: number
  step: number
  /** step 开始的墙钟时间，单位为 epoch 毫秒。 */
  startTime: number
  /** 首 token 墙钟时间，单位为 epoch 毫秒，首字到来前为 null。 */
  firstTokenTime: number | null
  /** 官方上报的输出 token 数，usage 落地后才有值。 */
  actualTokens?: number
  /** 官方 usage 是否已上报。 */
  exact: boolean
}

/** 为 liveTokenStats key 提供的线上值。 */
export interface LiveTokenStatsProjection {
  /** 当前正在流式输出的步骤，空闲时为 null。 */
  active: LiveStepFacts | null
  /** 最近已结算的步骤，保留以避免闪烁。 */
  lastSettled: (LiveStepFacts & { endTime: number }) | null
}

/** 整个投影的不可变纯 JSON 状态。 */
export interface LiveTokenStatsState {
  activeStep: ActiveStepState
}

// --- ActiveStep metric ------------------------------------------------------

export interface ActiveStepState {
  active: LiveTokenStatsProjection['active']
  lastSettled: LiveTokenStatsProjection['lastSettled']
}

/** 设置首字时间，仅在尚未记录时生效。 */
function withFirstToken(active: LiveStepFacts, time: number): LiveStepFacts {
  return active.firstTokenTime === null ? { ...active, firstTokenTime: time } : active
}

const ACTIVE_INIT: ActiveStepState = { active: null, lastSettled: null }

/**
 * 活跃步骤指标单元的纯折叠。
 * 只维护时间戳与官方 usage，不解析文本、不持有原文；输出估算由 host 另行提供。
 */
export function activeStepApply(state: ActiveStepState, event: SessionEvent): ActiveStepState {
  const { type, data } = event

  if (type === 'step/start') {
    return {
      ...state,
      active: {
        turn: data.turn,
        step: data.step,
        startTime: event.time,
        firstTokenTime: null,
        exact: false,
      },
    }
  }

  if (state.active === null) return state

  if (type === 'assistant/message') {
    // v2 事件模型把本 step 的紧凑流随结算一次送到，这里只取首个增量时间与官方 usage。
    const message = data as { stream?: readonly unknown[]; usage?: { outputTokens?: number } }
    let next = state
    if (Array.isArray(message.stream)) {
      for (const item of expandCompactStream(message.stream)) {
        const chunk = item.chunk
        if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage.outputTokens === 'number') {
          if (next.active !== null && !next.active.exact) {
            next = { ...next, active: { ...next.active, actualTokens: chunk.usage.outputTokens, exact: true } }
          }
          continue
        }
        if (next.active === null || next.active.exact || next.active.firstTokenTime !== null) continue
        if (!isDeltaChunk(chunk)) continue
        next = { ...next, active: withFirstToken(next.active, item.time) }
      }
    }
    const usage = message.usage
    if (usage !== undefined && typeof usage.outputTokens === 'number' && next.active !== null && !next.active.exact) {
      next = { ...next, active: { ...next.active, actualTokens: usage.outputTokens, exact: true } }
    }
    return next
  }

  if (type === 'step/end') {
    if (state.active.turn === data.turn && state.active.step === data.step) {
      return { active: null, lastSettled: { ...state.active, endTime: event.time } }
    }
    return state
  }

  // 未完成的 turn/end 会废弃其未结算的时间线。
  if (type === 'turn/end' && data.reason && data.reason.kind !== 'completed') {
    return { ...state, active: null }
  }

  return state
}

/** 活跃步骤指标的视图切片。 */
export function activeStepView(state: ActiveStepState): Pick<LiveTokenStatsProjection, 'active' | 'lastSettled'> {
  return { active: state.active, lastSettled: state.lastSettled }
}

// --- Projection container ---------------------------------------------------

const activeSchema = z.object({
  turn: z.number(),
  step: z.number(),
  startTime: z.number(),
  firstTokenTime: z.number().nullable(),
  actualTokens: z.number().nonnegative().optional(),
  exact: z.boolean(),
}).strict()

const lastSettledSchema = z.object({
  turn: z.number(),
  step: z.number(),
  startTime: z.number(),
  firstTokenTime: z.number().nullable(),
  actualTokens: z.number().nonnegative().optional(),
  exact: z.boolean(),
  endTime: z.number(),
}).strict()

const viewSchema = z.object({
  active: activeSchema.nullable(),
  lastSettled: lastSettledSchema.nullable(),
}).strict()

const activeStepStateSchema = z.object({
  active: activeSchema.nullable(),
  lastSettled: lastSettledSchema.nullable(),
}).strict()

/** 在用它播种一次缓存恢复前校验持久化的折叠状态。 */
const stateSchema = z.object({
  activeStep: activeStepStateSchema,
}).strict()

function init(): LiveTokenStatsState {
  return { activeStep: { ...ACTIVE_INIT } }
}

/**
 * 注册表客户端可见的 register 重载所要求的具体承载 wire 的定义形态。
 * SessionProjectionMap 里的 key 必须有 wire。
 */
export type LiveTokenStatsDefinition = Omit<
  ProjectionDefinition<'liveTokenStats', LiveTokenStatsState>,
  'wire'
> & {
  wire: NonNullable<ProjectionDefinition<'liveTokenStats', LiveTokenStatsState>['wire']>
}

/**
 * 创建可重放的 liveTokenStats 投影定义。
 * 输出估算已由 host 单独提供，这里不需要估算器配置。
 * @returns 供 sessionProjections.register() 使用的投影定义。
 */
export function createLiveTokenStatsDefinition(): LiveTokenStatsDefinition {
  return {
    key: 'liveTokenStats',
    stateSchema,
    init,
    apply: (state, event) => {
      const nextActive = activeStepApply(state.activeStep, event)
      if (nextActive === state.activeStep) return state
      return { activeStep: nextActive }
    },
    wire: {
      viewSchema,
      view: (state) => activeStepView(state.activeStep),
    },
    // 仅当序列化状态字段或折叠语义变化时才递增。
    // v4：tool-call 参数反转义，esc 状态——官方按解码后内容计费。
    // v5：tool-call name 按调用 id 去重只计一次——DSH 的 llm/stream 对同一调用的每个 delta 帧都携带 name。
    // v6：dsh 0.1.5-rc.2 的 v2 事件模型把流式增量打包进 assistant/message.stream，改从该字段折算。
    // v7：移除无消费者的 tokensPerSecond，实时速度由主机 llm/stream 快照提供。
    // v8：分词与原文整体移出投影，只留时间戳与官方 usage；结算估算由 host 对最后一条 assistant/message 算一次。
    stateVersion: 8,
  }
}
