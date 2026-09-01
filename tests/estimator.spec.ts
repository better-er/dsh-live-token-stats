import { describe, expect, it } from 'vitest'
import { countAsciiCjk, ESTIMATOR_DEFAULTS, estimateTextTokens, resolveSpec, type EstimatorConfig } from '../src/estimator.ts'

describe('countAsciiCjk', () => {
  it('分离 ASCII 与 CJK 计数', () => {
    expect(countAsciiCjk('hello')).toEqual({ ascii: 5, cjk: 0 })
    expect(countAsciiCjk('中文')).toEqual({ ascii: 0, cjk: 2 })
    expect(countAsciiCjk('a上海b')).toEqual({ ascii: 2, cjk: 2 })
  })

  it('空字符串返回零', () => {
    expect(countAsciiCjk('')).toEqual({ ascii: 0, cjk: 0 })
  })

  it('全角标点与全角形式归为 CJK', () => {
    // 全角逗号 U+FF0C 与 CJK 标点 > 0x7F，进 cjk 桶
    expect(countAsciiCjk('，')).toEqual({ ascii: 0, cjk: 1 })
  })

  it('重音符号与表情符等非 ASCII 非 CJK 码点归入 CJK', () => {
    // 尖音 é 非 ascii 被告知按高密度处理
    expect(countAsciiCjk('é')).toEqual({ ascii: 0, cjk: 1 })
    // 表情符 U+1F600 是代理对，当作一个码点
    expect(countAsciiCjk('😀')).toEqual({ ascii: 0, cjk: 1 })
    expect(countAsciiCjk('a😀b')).toEqual({ ascii: 2, cjk: 1 })
  })
})

describe('estimateTextTokens', () => {
  it('按密度比例折算', () => {
    // 5 ASCII * 0.3 = 1.5 -> 2
    expect(estimateTextTokens('hello', ESTIMATOR_DEFAULTS)).toBe(2)
    // 2 CJK * 0.6 = 1.2 -> 1
    expect(estimateTextTokens('中文', ESTIMATOR_DEFAULTS)).toBe(1)
  })

  it('CJK 比 ASCII 密度更高，单调', () => {
    const ascii = estimateTextTokens('abcdefg', ESTIMATOR_DEFAULTS)
    const cjk = estimateTextTokens('一二三四五六七', ESTIMATOR_DEFAULTS)
    expect(cjk).toBeGreaterThan(ascii)
  })
})

describe('resolveSpec', () => {
  it('无配置时应用默认值', () => {
    const spec = resolveSpec({})
    expect(spec.asciiTokenPerChar).toBe(ESTIMATOR_DEFAULTS.asciiTokenPerChar)
    expect(spec.cjkTokenPerChar).toBe(ESTIMATOR_DEFAULTS.cjkTokenPerChar)
    expect(spec.rateWindowMs).toBe(ESTIMATOR_DEFAULTS.rateWindowMs)
    expect(spec.tokenizerMode).toBe('bpe')
  })

  it('接受显式 density 模式即旧行为', () => {
    const spec = resolveSpec({ tokenizerMode: 'density' })
    expect(spec.tokenizerMode).toBe('density')
  })

  it('拒绝非法 tokenizerMode', () => {
    expect(() => resolveSpec({ tokenizerMode: 'foo' } as unknown as EstimatorConfig)).toThrow(/tokenizerMode/)
  })

  it('忽略未知配置项', () => {
    // 运行时配置会带额外 key，例如 loader 注入的 `enabled` 总开关，故意忽略它们，为单个外来 key 终止整个插件树比丢弃它更糟。
    const spec = resolveSpec({ nope: 1 } as unknown as EstimatorConfig)
    expect(spec.asciiTokenPerChar).toBe(ESTIMATOR_DEFAULTS.asciiTokenPerChar)
    expect(spec.cjkTokenPerChar).toBe(ESTIMATOR_DEFAULTS.cjkTokenPerChar)
    expect(spec.rateWindowMs).toBe(ESTIMATOR_DEFAULTS.rateWindowMs)
  })

  it('拒绝非正密度', () => {
    expect(() => resolveSpec({ asciiTokenPerChar: 0 })).toThrow(/positive finite/)
    expect(() => resolveSpec({ cjkTokenPerChar: -1 })).toThrow(/positive finite/)
    expect(() => resolveSpec({ asciiTokenPerChar: Number.POSITIVE_INFINITY })).toThrow(/positive finite/)
  })

  it('拒绝负窗口', () => {
    expect(() => resolveSpec({ rateWindowMs: -5 })).toThrow(/rateWindowMs/)
  })
})
