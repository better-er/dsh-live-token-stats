import { describe, expect, it } from 'vitest'
import { countAsciiCjk, ESTIMATOR_DEFAULTS, estimateTextTokens, resolveSpec, type EstimatorConfig } from '../src/estimator.ts'

describe('countAsciiCjk', () => {
  it('splits ASCII and CJK counts', () => {
    expect(countAsciiCjk('hello')).toEqual({ ascii: 5, cjk: 0 })
    expect(countAsciiCjk('中文')).toEqual({ ascii: 0, cjk: 2 })
    expect(countAsciiCjk('a上海b')).toEqual({ ascii: 2, cjk: 2 })
  })

  it('treats empty as zero', () => {
    expect(countAsciiCjk('')).toEqual({ ascii: 0, cjk: 0 })
  })

  it('counts CJK punctuation and fullwidth forms as CJK', () => {
    // 全角逗号 U+FF0C 与 CJK 标点 > 0x7F，进 cjk 桶
    expect(countAsciiCjk('，')).toEqual({ ascii: 0, cjk: 1 })
  })

  it('counts non-ASCII non-CJK codepoints (accents, emoji) as CJK bucket', () => {
    // 尖音 é (U+00E9) 非 ascii → 被告知按高密度处理
    expect(countAsciiCjk('é')).toEqual({ ascii: 0, cjk: 1 })
    // 表情符 U+1F600 是代理对，当作一个码点
    expect(countAsciiCjk('😀')).toEqual({ ascii: 0, cjk: 1 })
    expect(countAsciiCjk('a😀b')).toEqual({ ascii: 2, cjk: 1 })
  })
})

describe('estimateTextTokens', () => {
  it('applies per-density fractions', () => {
    // 5 ASCII * 0.3 = 1.5 -> 2
    expect(estimateTextTokens('hello', ESTIMATOR_DEFAULTS)).toBe(2)
    // 2 CJK * 0.6 = 1.2 -> 1
    expect(estimateTextTokens('中文', ESTIMATOR_DEFAULTS)).toBe(1)
  })

  it('is monotone (cjk denser than ascii)', () => {
    const ascii = estimateTextTokens('abcdefg', ESTIMATOR_DEFAULTS)
    const cjk = estimateTextTokens('一二三四五六七', ESTIMATOR_DEFAULTS)
    expect(cjk).toBeGreaterThan(ascii)
  })
})

describe('resolveSpec', () => {
  it('applies defaults when nothing supplied', () => {
    const spec = resolveSpec({})
    expect(spec.asciiTokenPerChar).toBe(ESTIMATOR_DEFAULTS.asciiTokenPerChar)
    expect(spec.cjkTokenPerChar).toBe(ESTIMATOR_DEFAULTS.cjkTokenPerChar)
    expect(spec.rateWindowMs).toBe(ESTIMATOR_DEFAULTS.rateWindowMs)
    expect(spec.tokenizerMode).toBe('bpe')
  })

  it('accepts an explicit density mode (legacy behavior)', () => {
    const spec = resolveSpec({ tokenizerMode: 'density' })
    expect(spec.tokenizerMode).toBe('density')
  })

  it('rejects invalid tokenizerMode', () => {
    expect(() => resolveSpec({ tokenizerMode: 'foo' } as unknown as EstimatorConfig)).toThrow(/tokenizerMode/)
  })

  it('ignores unknown keys', () => {
    // 运行时配置会带额外 key，例如 loader 注入的 `enabled` 总开关，故意忽略它们，为单个外来 key 终止整个插件树比丢弃它更糟。
    const spec = resolveSpec({ nope: 1 } as unknown as EstimatorConfig)
    expect(spec.asciiTokenPerChar).toBe(ESTIMATOR_DEFAULTS.asciiTokenPerChar)
    expect(spec.cjkTokenPerChar).toBe(ESTIMATOR_DEFAULTS.cjkTokenPerChar)
    expect(spec.rateWindowMs).toBe(ESTIMATOR_DEFAULTS.rateWindowMs)
  })

  it('rejects non-positive densities', () => {
    expect(() => resolveSpec({ asciiTokenPerChar: 0 })).toThrow(/positive finite/)
    expect(() => resolveSpec({ cjkTokenPerChar: -1 })).toThrow(/positive finite/)
    expect(() => resolveSpec({ asciiTokenPerChar: Number.POSITIVE_INFINITY })).toThrow(/positive finite/)
  })

  it('rejects negative window', () => {
    expect(() => resolveSpec({ rateWindowMs: -5 })).toThrow(/rateWindowMs/)
  })
})
