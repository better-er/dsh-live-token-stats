/**
 * Unit tests for the live rate tracker — the real-time host half that folds
 * raw `llm/stream` adapter chunks (text / reasoning / tool-call argument
 * fragments) into a per-session sliding-window tokens/sec figure.
 *
 * Focuses on the contracts the session-event projection cannot cover: the
 * same-timestamp burst guard (a large tool-call argument delta arriving in one
 * frame must not explode the rate), window expiry, and idle reset.
 */

import { describe, expect, it } from 'vitest'
import { LiveTokenRateTracker } from '../src/live-stream.ts'
import { ESTIMATOR_DEFAULTS, type EstimatorSpec } from '../src/estimator.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm/brand'

const SPEC: Readonly<EstimatorSpec> = ESTIMATOR_DEFAULTS

function textDelta(text: string): StreamChunk {
  return { type: 'text-delta', index: 0, text }
}

function toolCallDelta(argumentsDelta: string): StreamChunk {
  return { type: 'tool-call-delta', index: 0, id: CallId('call-1'), name: 'write', argumentsDelta }
}

const SESSION = 'session-1'

describe('LiveTokenRateTracker', () => {
  it('starts idle: no snapshot before any delta', () => {
    const t = new LiveTokenRateTracker(SPEC)
    const snap = t.snapshot(SESSION)
    expect(snap.tokensPerSecond).toBeUndefined()
    expect(snap.updatedAt).toBe(0)
  })

  it('ignores non-delta chunks and empty deltas', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // A usage/block-start chunk carries no output tokens.
    t.fold(SESSION, { type: 'block-start', index: 0, blockType: 'text' }, 1000)
    // An empty tool-call frame (the "brewing" empty argumentsDelta) counts nothing.
    t.fold(SESSION, toolCallDelta(''), 1000)
    expect(t.snapshot(SESSION).tokensPerSecond).toBeUndefined()
  })

  it('computes a sane rate for sparse text deltas', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // 100 tokens across 1 second → ~100 tok/s (Ascii-only text: 0.3 tok/char).
    for (let i = 0; i < 10; i += 1) {
      t.fold(SESSION, textDelta('a'.repeat(33)), 1000 + i * 100)
    }
    const snap = t.snapshot(SESSION)
    expect(snap.tokensPerSecond).toBeGreaterThan(50)
    expect(snap.tokensPerSecond).toBeLessThan(200)
    expect(snap.updatedAt).toBeGreaterThan(0)
  })

  it('does NOT explode on a huge same-timestamp tool-call argument delta (burst guard)', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // The exact pathology from the session log: one 13.5k-char argument delta
    // arrives in a single frame (single timestamp). Without the floor it would
    // divide an ~8k-token burst by ~1ms → a million tok/s.
    t.fold(SESSION, toolCallDelta('x'.repeat(13554)), 5000)
    const snap = t.snapshot(SESSION)
    const rate = snap.tokensPerSecond
    expect(rate).toBeDefined()
    // 13554 chars * 0.3 ≈ 4066 tokens; over the 50ms floor → ≤ ~81k tok/s.
    // The point is it stays bounded (no /~0 explosion), not its exact value.
    expect(rate!).toBeLessThan(100000)
  })

  it('expires samples outside the window', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // Old burst at ~1s: 10 * 99 ≈ 990 tokens. Far outside the 3s window once
    // a new sample folds at 10s.
    for (let i = 0; i < 10; i += 1) t.fold(SESSION, textDelta('a'.repeat(330)), 1000 + i)
    // New tiny sample (9.9 tokens) at 10000ms. If the old 990-token burst
    // survived, rate ≈ 1000/0.05 = 20000; if it expired, rate ≈ 9.9/0.05 = 198.
    t.fold(SESSION, textDelta('a'.repeat(33)), 10000)
    const snap = t.snapshot(SESSION)
    expect(snap.tokensPerSecond!).toBeGreaterThan(50)
    expect(snap.tokensPerSecond!).toBeLessThan(1000)
  })

  it('reset drops the session cell', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.fold(SESSION, textDelta('hello world'), 1000)
    expect(t.snapshot(SESSION).tokensPerSecond).toBeDefined()
    t.reset(SESSION)
    expect(t.snapshot(SESSION).tokensPerSecond).toBeUndefined()
  })

  it('is per-session isolated', () => {
    const t = new LiveTokenRateTracker(SPEC)
    t.fold('s-a', textDelta('a'.repeat(330)), 1000)
    expect(t.snapshot('s-b').tokensPerSecond).toBeUndefined()
    expect(t.snapshot('s-a').tokensPerSecond).toBeDefined()
  })

  it('folding a streamed arguments fragment count toward output like text', () => {
    const t = new LiveTokenRateTracker(SPEC)
    // A genuinely streamed tool-call argument arrives in small fragments: they
    // count (the user's directive: tool arguments are also streamed output).
    t.fold(SESSION, toolCallDelta('{"path": '), 1000)
    t.fold(SESSION, toolCallDelta('"C:\\\\tmp\\\\a.json", "content": "abc"'), 1100)
    const snap = t.snapshot(SESSION)
    expect(snap.tokensPerSecond).toBeDefined()
    expect(snap.tokensPerSecond!).toBeGreaterThan(0)
  })
})