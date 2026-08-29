/**
 * 用于实时输出 token 计数的双密度 Unicode 估算器。
 *
 * 官方 usage 到达时以官方为准，在此之前按字符密度给流式增量计价，区分 ASCII 与 CJK。
 * 当前经验值 1 token 约等于 3.33 个 ASCII 字符或 1.67 个 CJK 字符，即 ASCII 每字符 0.3 token、CJK 每字符 0.6 token。
 * 两种密度均可配置、绝不写死，这里的一切都是其参数的纯函数，便于单元测试与确定性地折叠。
 *
 * @module dsh-live-token-stats/estimator
 */

/** 计数模式：bpe 为真实 BPE 分词且默认采用，density 为旧的双密度盲估。 */
export type TokenizerMode = 'bpe' | 'density'

/** 默认密度的估算器配置，同时是 Config schema 的来源。 */
export interface EstimatorSpec {
  /** 每 token 对应的 ASCII 字符数。 */
  readonly asciiTokenPerChar: number
  /** 每 token 对应的 CJK 字符数。 */
  readonly cjkTokenPerChar: number
  /** 实时 TPS 速率的滑动窗口，单位为毫秒。 */
  readonly rateWindowMs: number
  /** 计数模式：bpe 为真实 BPE 切分，density 为双密度盲估。 */
  readonly tokenizerMode: TokenizerMode
}

/** 允许只提供部分部署配置；缺失项用默认值补齐。 */
export type EstimatorConfig = Partial<EstimatorSpec>

/** 默认值，导出供测试与 Config schema 默认值使用。 */
export const ESTIMATOR_DEFAULTS: Readonly<EstimatorSpec> = Object.freeze({
  asciiTokenPerChar: 0.3,
  cjkTokenPerChar: 0.6,
  rateWindowMs: 3000,
  tokenizerMode: 'bpe',
})

/**
 * 把部署配置解析并校验成完全带默认值的 spec。
 *
 * 未知 key 一律忽略而非拒绝。
 * 本函数在 cordis 插件的 `apply` 内运行，loader 会把 schema 带默认值的 key 如 `enabled` 注入我们收到的同一个 config 对象。
 * 把注入的 key 当作硬错误会让整个插件树加载中断，所以只消费已知的估算器 key，其余的一律丢弃。
 * 严格拒绝逻辑放在单元测试里，那里由调用方掌控输入。
 * 数值密度仍会做范围校验，避免脏数据污染实时估算。
 */
export function resolveSpec(config: EstimatorConfig = {}): Readonly<EstimatorSpec> {
  const spec: EstimatorSpec = { ...ESTIMATOR_DEFAULTS, ...config }
  for (const key of ['asciiTokenPerChar', 'cjkTokenPerChar'] as const) {
    const v = spec[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`dsh-live-token-stats: ${key} must be a positive finite number`)
    }
  }
  if (!Number.isFinite(spec.rateWindowMs) || spec.rateWindowMs < 0) {
    throw new Error('dsh-live-token-stats: rateWindowMs must be a non-negative number')
  }
  if (spec.tokenizerMode !== 'bpe' && spec.tokenizerMode !== 'density') {
    throw new Error('dsh-live-token-stats: tokenizerMode must be "bpe" or "density"')
  }
  return Object.freeze({ ...spec })
}

/**
 * 求字符串的 ASCII 与 CJK 码点计数。
 *
 * 归类刻意做成二值，码点在 0x00-0x7F 视为 ASCII，否则折叠进 CJK 桶并按 `cjkTokenPerChar` 计价。
 * Emoji、拉丁变音符、西里尔文、阿拉伯文、泰文及一切非 ASCII 码点都归入高密度桶。
 * 实时读数低估一连串它们，比按 token 密集处理更糟，而 ASCII 类是唯一每字符 token 成本真正低的类别。
 * 代理对按一个码点计数。
 */
export function countAsciiCjk(text: string): { ascii: number; cjk: number } {
  if (typeof text !== 'string' || text.length === 0) return { ascii: 0, cjk: 0 }
  let ascii = 0
  let cjk = 0
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.codePointAt(i)
    if (cp === undefined) continue
    if (cp <= 0x7f) ascii += 1
    else cjk += 1
    if (cp > 0xffff) i += 1
  }
  return { ascii, cjk }
}

/** 估算一段生成文本所代表的输出 token 数。 */
export function estimateTextTokens(text: string, spec: Readonly<EstimatorSpec>): number {
  const { ascii, cjk } = countAsciiCjk(text)
  return Math.round(ascii * spec.asciiTokenPerChar + cjk * spec.cjkTokenPerChar)
}
