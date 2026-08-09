// RD-AI-01 — retry backoff.

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BACKOFF, DEFAULT_MAX_ATTEMPTS, backoffMs, clampMaxAttempts, nextAttemptAt,
} from '@/features/ai/utils/backoff'

describe('backoffMs', () => {
  it('grows geometrically from the base delay', () => {
    expect(backoffMs(1)).toBe(30_000)
    expect(backoffMs(2)).toBe(120_000)
    expect(backoffMs(3)).toBe(480_000)
  })

  it('is capped, so an outage never pushes a job days out', () => {
    expect(backoffMs(4)).toBe(DEFAULT_BACKOFF.maxMs)
    expect(backoffMs(50)).toBe(DEFAULT_BACKOFF.maxMs)
    // Math.pow overflows to Infinity long before this; the cap must still hold.
    expect(backoffMs(10_000)).toBe(DEFAULT_BACKOFF.maxMs)
  })

  it('is monotonic', () => {
    let previous = 0
    for (let attempt = 1; attempt <= 12; attempt++) {
      const delay = backoffMs(attempt)
      expect(delay).toBeGreaterThanOrEqual(previous)
      previous = delay
    }
  })

  it('treats a corrupt attempt counter as the first attempt rather than throwing', () => {
    // A job that cannot be rescheduled because its counter is wrong is worse than one
    // rescheduled with the shortest delay.
    expect(backoffMs(0)).toBe(backoffMs(1))
    expect(backoffMs(-5)).toBe(backoffMs(1))
    expect(backoffMs(1.9)).toBe(backoffMs(1))
  })

  it('is DETERMINISTIC — the same attempt always yields the same delay', () => {
    // No jitter: one leased dispatcher drains this queue, so there is no herd to spread,
    // and a random delay would make an incident harder to reason about.
    const runs = Array.from({ length: 20 }, () => backoffMs(2))
    expect(new Set(runs).size).toBe(1)
  })

  it('honours a custom policy', () => {
    expect(backoffMs(1, { baseMs: 1000, factor: 2, maxMs: 10_000 })).toBe(1000)
    expect(backoffMs(3, { baseMs: 1000, factor: 2, maxMs: 10_000 })).toBe(4000)
    expect(backoffMs(9, { baseMs: 1000, factor: 2, maxMs: 10_000 })).toBe(10_000)
  })
})

describe('nextAttemptAt', () => {
  it('is always in the future relative to the supplied clock', () => {
    const now = 1_700_000_000_000
    for (let attempt = 1; attempt <= 6; attempt++) {
      expect(nextAttemptAt(now, attempt)).toBeGreaterThan(now)
    }
  })

  it('takes its clock from the caller, so a schedule is reproducible', () => {
    expect(nextAttemptAt(0, 1)).toBe(30_000)
    expect(nextAttemptAt(5, 1)).toBe(30_005)
  })
})

describe('clampMaxAttempts', () => {
  it('defaults anything non-numeric', () => {
    for (const v of [undefined, null, 'three', NaN, Infinity, {}]) {
      expect(clampMaxAttempts(v)).toBe(DEFAULT_MAX_ATTEMPTS)
    }
  })

  it('keeps a sane value and clamps the rest', () => {
    expect(clampMaxAttempts(1)).toBe(1)
    expect(clampMaxAttempts(5)).toBe(5)
    expect(clampMaxAttempts(0)).toBe(1)
    expect(clampMaxAttempts(-9)).toBe(1)
    expect(clampMaxAttempts(999)).toBe(10)
  })
})
