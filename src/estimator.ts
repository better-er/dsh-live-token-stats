/**
 * Dual-density Unicode estimator for live output-token accounting.
 *
 * Provider usage is authoritative when it arrives; until then we price stream
 * deltas with a per-character density that distinguishes ASCII from CJK, per
 * the empirically common 1 token ≈ 3.33 ASCII chars / ≈ 1.67 CJK chars
 * (equivalently ASCII 0.3 / CJK 0.6 tokens-per-char). Both densities are
 * configurable, never hardcoded, and everything here is a pure function of its
 * arguments (safe to unit-test and to fold deterministically).
 *
 * @module dsh-live-token-stats/estimator
 */

/** Default-density estimator settings (also the source of the Config schema). */
export interface EstimatorSpec {
  /** ASCII characters per token fraction. */
  readonly asciiTokenPerChar: number
  /** CJK characters per token fraction. */
  readonly cjkTokenPerChar: number
  /** Sliding window (ms) for the live TPS rate. */
  readonly rateWindowMs: number
}

/** Allow partial deployment-supplied config; resolved with defaults applied. */
export type EstimatorConfig = Partial<EstimatorSpec>

/** Default values, exported for tests and for the Config schema defaults. */
export const ESTIMATOR_DEFAULTS: Readonly<EstimatorSpec> = Object.freeze({
  asciiTokenPerChar: 0.3,
  cjkTokenPerChar: 0.6,
  rateWindowMs: 3000,
})

/**
 * Resolve and validate deployment config into a fully-defaulted spec.
 *
 * Unknown keys are ignored, not rejected: this runs inside a cordis plugin
 * `apply`, and the loader injects schema-defaulted keys (e.g. `enabled`) into
 * the very config object we receive. Treating an injected key as a hard error
 * aborts the whole plugin-tree load, so only the known estimator keys are
 * consumed; anything else is dropped (strict rejection lives in the unit tests,
 * where the caller controls the input). Numeric densities are still
 * range-checked so garbage cannot corrupt the live estimate.
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
  return Object.freeze({ ...spec })
}

/**
 * Split a string into ASCII and CJK code-point counts.
 *
 * Classification is deliberately binary: a code point is ASCII when it is in
 * 0x00-0x7F, otherwise it folds into the CJK bucket (priced at
 * `cjkTokenPerChar`). Emoji, Latin accents, Cyrillic, Arabic, Thai, and every
 * other non-ASCII codepoint land in the higher-density bucket: underpricing a
 * run of them is worse for a live token readout than treating them as
 * token-dense, and the ASCII class is the only one with a genuinely low
 * per-character token cost. Surrogate pairs count as one codepoint.
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

/** Estimate the output tokens a piece of generated text represents. */
export function estimateTextTokens(text: string, spec: Readonly<EstimatorSpec>): number {
  const { ascii, cjk } = countAsciiCjk(text)
  return Math.round(ascii * spec.asciiTokenPerChar + cjk * spec.cjkTokenPerChar)
}
