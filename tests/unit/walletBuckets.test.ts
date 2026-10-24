// Phase 3.1 — the pure per-bucket wallet comparison (integer paise).

import { describe, it, expect } from 'vitest'
import { evaluateWalletBuckets } from '@/lib/reconciliation/walletBuckets'

const clean = { expectedTotal: 130_000, expectedPending: 50_000, expectedSettled: 60_000, expectedInTransit: 5_000 }
const stored = { pendingPaise: 50_000, availablePaise: 20_000, inTransitPaise: 5_000, settledPaise: 60_000 }

describe('evaluateWalletBuckets', () => {
  it('a consistent wallet: every bucket ok; available = total − pending − settled; in-transit is inside available', () => {
    const r = evaluateWalletBuckets({ stored, ...clean })
    expect(r.buckets).toEqual([
      { bucket: 'pendingPaise', expected: 50_000, stored: 50_000, variance: 0, verdict: 'ok' },
      { bucket: 'availablePaise', expected: 20_000, stored: 20_000, variance: 0, verdict: 'ok' },
      { bucket: 'inTransitPaise', expected: 5_000, stored: 5_000, variance: 0, verdict: 'ok' },
      { bucket: 'settledPaise', expected: 60_000, stored: 60_000, variance: 0, verdict: 'ok' },
    ])
    expect(r.inTransitExcessPaise).toBe(0)
  })
  it('money in the WRONG bucket (total unchanged) is caught per bucket, with the variance', () => {
    const r = evaluateWalletBuckets({ stored: { ...stored, pendingPaise: 45_000, availablePaise: 25_000 }, ...clean })
    expect(r.buckets.find(b => b.bucket === 'pendingPaise')).toMatchObject({ verdict: 'mismatch', expected: 50_000, stored: 45_000, variance: -5_000 })
    expect(r.buckets.find(b => b.bucket === 'availablePaise')).toMatchObject({ verdict: 'mismatch', expected: 20_000, stored: 25_000, variance: 5_000 })
  })
  it('in-transit: a wrong reservation total, and in-transit above available', () => {
    expect(evaluateWalletBuckets({ stored: { ...stored, inTransitPaise: 7_000 }, ...clean }).buckets[2]).toMatchObject({ verdict: 'mismatch', variance: 2_000 })
    expect(evaluateWalletBuckets({ stored: { ...stored, availablePaise: 3_000 }, ...clean }).inTransitExcessPaise).toBe(2_000)
  })
  it('unknown inputs give NO verdict (never a guessed mismatch); available needs total, pending and settled', () => {
    const r = evaluateWalletBuckets({ stored, ...clean, expectedPending: null, expectedInTransit: null })
    expect(r.buckets.map(b => b.verdict)).toEqual(['unverifiable', 'unverifiable', 'unverifiable', 'ok'])
    expect(r.buckets[1]).toMatchObject({ expected: null, variance: null })
    expect(evaluateWalletBuckets({ stored, ...clean, expectedTotal: null }).buckets[1].verdict).toBe('unverifiable')
  })
  it('missing stored fields read as 0 (historical wallets)', () => {
    const r = evaluateWalletBuckets({ stored: { pendingPaise: 50_000, availablePaise: 20_000, settledPaise: 60_000 }, ...clean, expectedInTransit: 0 })
    expect(r.buckets[2]).toMatchObject({ stored: 0, verdict: 'ok' })
  })
})
