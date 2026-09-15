/**
 * 会话投影状态的无损 JSON 边界工具。
 *
 * 投影状态不是内部私有数据：它会被序列化进投影缓存（`session_projcache`），
 * 也会经 `wire.view` 上送宿主、再由宿主转发给客户端。这条链路上有一道硬边界——
 * **无损 JSON**：`undefined`、函数、Symbol、BigInt、非有限数、循环引用都不是 JSON 值。
 *
 * 一旦状态里带进 `undefined`，后果是整条链路一起坏，而且报错位置离根因很远：
 * 1. 宿主转发 `api-session/added` 时在参数校验处抛错，客户端**永远收不到**该会话条目，
 *    界面上表现为会话行消失或闪跳；
 * 2. 同一道失败会吞掉 `session/fork`，分叉看起来「点了没反应」；
 * 3. 投影缓存整条写入失败（缓存按整记录写，不做字段级降级），缓存停在旧 seq 上。
 *
 * 因此折叠必须遵守一条纪律：
 * **schema 里的 `.optional()` 表示「该键可以缺席」，不表示「该键可以持有 undefined」。**
 * 需要表达「无值」时让键缺席；不要写 `undefined`，也不要改写成 `null`——
 * 消费者用 `!== undefined` 判定「有无实际值」，`null` 会被读成「有值且为空」。
 *
 * @module dsh-live-token-stats/compact
 */

/** 首个非 JSON 值的定位结果。 */
export interface NonJsonPath {
  /** 从根开始的访问路径，数组下标用 `[i]` 表示。 */
  path: string
  /** 违规原因，例如 `undefined` / `non-finite number` / `circular`。 */
  why: string
}

/**
 * 去掉对象里所有值为 `undefined` 的键，返回浅拷贝。
 * 没有任何键被去掉时返回原引用，保持 `apply` 的「无变化即同引用」语义。
 */
export function omitUndefined<T extends object>(value: T): T {
  const source = value as Record<string, unknown>
  let dirty = false
  for (const key of Object.keys(source)) {
    if (source[key] === undefined) {
      dirty = true
      break
    }
  }
  if (!dirty) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    const item = source[key]
    if (item !== undefined) out[key] = item
  }
  return out as T
}

/** 判定一个值是否为无损 JSON 标量。 */
function scalarReason(value: unknown): string | null {
  if (value === undefined) return 'undefined'
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null
    case 'number':
      return Number.isFinite(value) ? null : 'non-finite number'
    case 'bigint':
      return 'bigint'
    case 'function':
      return 'function'
    case 'symbol':
      return 'symbol'
    default:
      return null
  }
}

/**
 * 定位对象图里第一个非 JSON 值的位置，全部无损时返回 null。
 * 与宿主 `isJsonValue` 同样只看值本身，不看原型，适用于投影状态这类纯数据。
 * @param value - 待检查的值，通常是投影状态。
 * @param base - 起始路径，默认 `$`。
 * @returns 首个违规位置，或 null。
 */
export function findNonJsonPath(value: unknown, base = '$'): NonJsonPath | null {
  return walk(value, base, new Set<object>())
}

function walk(value: unknown, path: string, seen: Set<object>): NonJsonPath | null {
  const reason = scalarReason(value)
  if (reason !== null) return { path, why: reason }
  if (value === null || typeof value !== 'object') return null
  const asObject = value as object
  if (seen.has(asObject)) return { path, why: 'circular' }
  seen.add(asObject)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const hit = walk(value[index], `${path}[${index}]`, seen)
        if (hit !== null) return hit
      }
      return null
    }
    const prototype: unknown = Object.getPrototypeOf(asObject)
    if (prototype !== Object.prototype && prototype !== null) {
      return { path, why: `non-plain object (${(asObject.constructor as { name?: string } | undefined)?.name ?? 'unknown'})` }
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const hit = walk((value as Record<string, unknown>)[key], `${path}.${key}`, seen)
      if (hit !== null) return hit
    }
    return null
  } finally {
    seen.delete(asObject)
  }
}

/** 断言强度：off 零成本；warn 只告警并去重；throw 直接失败，供测试使用。 */
export type LosslessAssertionMode = 'off' | 'warn' | 'throw'

let assertionMode: LosslessAssertionMode = 'off'
const reported = new Set<string>()

/**
 * 设置无损 JSON 断言强度，由主机按插件 debug 配置调用。
 * 主机侧用 warn：投影折叠在事件回放路径上，这里抛错会让整个投影单元失效，
 * 告警加去重既能看到违规路径，又不放大故障。测试侧用 throw。
 */
export function setLosslessAssertions(mode: LosslessAssertionMode): void {
  assertionMode = mode
  if (mode === 'off') reported.clear()
}

/**
 * 投影状态自检：不是无损 JSON 就按当前强度报告，把违规路径直接指向产生它的字段。
 * 这是宿主转发校验之前的兜底——在产生处看见，比在转发处看见好得多。
 * @param value - 待检查的投影状态。
 * @param label - 出错信息里的投影名。
 */
export function assertLosslessJson(value: unknown, label: string): void {
  if (assertionMode === 'off') return
  const hit = findNonJsonPath(value)
  if (hit === null) return
  const message = `[dsh-live-token-stats] 投影 ${label} 的状态不是无损 JSON：${hit.path} 是 ${hit.why}`
  if (assertionMode === 'throw') throw new Error(message)
  const fingerprint = `${label}:${hit.path}:${hit.why}`
  if (reported.has(fingerprint)) return
  reported.add(fingerprint)
  console.warn(message)
}
