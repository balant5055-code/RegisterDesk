// Phase 3.10A — the PURE parts of release-attempt evidence: failure-code classification, and how recorded
// evidence refines the stuck-release verdict (confirmed repeated refusal vs predicted vs unverifiable).

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))
vi.mock('@/lib/settlements/resolveSettlementConfig', () => ({ getSettlementConfig: async () => ({}) }))

const { classifyReleaseFailure } = await import('@/lib/settlements/releaseAttempts')
const { classifyOverdueReleases, classifyOpenEvidence, STUCK_RELEASE_GRACE_MS } = await import('@/lib/reconciliation/stuckReleases')

describe('classifyReleaseFailure', () => {
  it('INSUFFICIENT is a refusal with its evidence; data problems are errors with their own code', () => {
    expect(classifyReleaseFailure('INSUFFICIENT:1000:5000')).toEqual({ record: true, code: 'INSUFFICIENT', outcome: 'refused', detail: { pendingPaise: 1_000, amountPaise: 5_000 } })
    expect(classifyReleaseFailure('INSUFFICIENT:x')).toMatchObject({ record: true, code: 'INSUFFICIENT', detail: null })
    for (const c of ['NO_WALLET', 'INVALID_AMOUNT:-5', 'CLAWBACK_SET_TOO_LARGE', 'CLAWBACK_INVALID: bad']) {
      expect(classifyReleaseFailure(c)).toMatchObject({ record: true, code: c.split(':')[0], outcome: 'error' })
    }
  })
  it('idempotency races and refund holds are NOT recorded; anything else is transient/unknown, never a refusal', () => {
    for (const c of ['ALREADY_RELEASED', 'TX_GONE', 'REFUND_HOLD']) expect(classifyReleaseFailure(c)).toEqual({ record: false })
    expect(classifyReleaseFailure('10 ABORTED: Too much contention on these documents')).toEqual({ record: true, code: 'TRANSIENT_OR_UNKNOWN', outcome: 'error', detail: null })
    expect(classifyReleaseFailure('unknown')).toMatchObject({ code: 'TRANSIENT_OR_UNKNOWN', outcome: 'error' })
  })
})

describe('stuck-release verdict with recorded evidence', () => {
  const HOUR = 3_600_000
  const now = 1_000 * 24 * HOUR
  const config = { enabled: true, frozen: false, holdHours: 48, maximumSettlementsPerRun: 500 }
  const paid = now - 48 * HOUR - STUCK_RELEASE_GRACE_MS - HOUR
  const row = (id: string, net: number, organizerUid = id) => ({ id, organizerUid, netSettlementPaise: net, paidAtMs: paid })
  const open = (lastCode: string, attempts = 3) => ({ status: 'open', attempts, lastCode, firstAttemptAtMs: paid, lastAttemptAtMs: now - HOUR })
  const run = (rows: ReturnType<typeof row>[], pending: Record<string, number>, attempts: Record<string, unknown>) =>
    classifyOverdueReleases({ rows, pendingByOrganizer: new Map(Object.entries(pending)), config, nowMs: now, scanCapped: false, attemptsById: new Map(Object.entries(attempts) as never) })
  it('recorded INSUFFICIENT refusals + a replay that would refuse again ⇒ CONFIRMED repeated refusal (with the evidence)', () => {
    const [e] = run([row('a', 5_000)], { a: 1_000 }, { a: open('INSUFFICIENT', 4) })
    expect(e).toMatchObject({ verdict: 'stuck', reason: 'repeated_refusal', evidence: { failureEvidencePersisted: true, attempt: { attempts: 4, lastCode: 'INSUFFICIENT' } } })
  })
  it('no record ⇒ predicted only (never attempted since evidence exists, or refused before) — the Phase 3.8 reasons stand', () => {
    expect(run([row('a', 5_000)], { a: 1_000 }, {})[0]).toMatchObject({ verdict: 'stuck', reason: 'pending_below_release', evidence: { failureEvidencePersisted: false, attempt: null } })
    expect(run([row('a', 500)], { a: 1_000 }, {})[0]).toMatchObject({ verdict: 'unverifiable', reason: 'no_failure_evidence' })
  })
  it('recorded evidence that does not prove a deterministic refusal stays UNVERIFIABLE', () => {
    expect(run([row('a', 500)], { a: 1_000 }, { a: open('INSUFFICIENT') })[0]).toMatchObject({ verdict: 'unverifiable', reason: 'refused_before_now_coverable' })
    expect(run([row('a', 500)], { a: 1_000 }, { a: open('TRANSIENT_OR_UNKNOWN', 1) })[0]).toMatchObject({ verdict: 'unverifiable', reason: 'release_error:TRANSIENT_OR_UNKNOWN' })
    expect(run([row('a', 500)], { a: 1_000 }, { a: open('NO_WALLET', 2) })[0]).toMatchObject({ verdict: 'unverifiable', reason: 'release_error:NO_WALLET' })
    // a transient record never upgrades a predicted refusal to "confirmed"
    expect(run([row('a', 5_000)], { a: 1_000 }, { a: open('TRANSIENT_OR_UNKNOWN', 1) })[0]).toMatchObject({ verdict: 'stuck', reason: 'pending_below_release' })
  })
  it('a RESOLVED or unreadable record counts as no evidence', () => {
    expect(run([row('a', 5_000)], { a: 1_000 }, { a: { ...open('INSUFFICIENT'), status: 'resolved' } })[0]).toMatchObject({ reason: 'pending_below_release', evidence: { attempt: null } })
    expect(run([row('a', 5_000)], { a: 1_000 }, { a: { ...open('INSUFFICIENT'), attempts: 'x' } })[0]).toMatchObject({ reason: 'pending_below_release', evidence: { attempt: null } })
  })
})

describe('Phase 3.10B · lifecycle classification of an OPEN record (read-only)', () => {
  it('classifies from the ledger row; nothing about it closes a record', () => {
    expect(classifyOpenEvidence({ status: 'completed', releaseStatus: 'pending' })).toBe('active')
    expect(classifyOpenEvidence({ status: 'completed', releaseStatus: 'held', releaseHold: {} })).toBe('row_held')
    expect(classifyOpenEvidence({ status: 'completed', releaseStatus: 'pending', releaseHold: { reason: 'refund_review' } })).toBe('row_held')
    expect(classifyOpenEvidence({ status: 'refunded', releaseStatus: 'pending' })).toBe('row_reversed')
    expect(classifyOpenEvidence({ status: 'disputed', releaseStatus: 'released' })).toBe('row_reversed')
    expect(classifyOpenEvidence(null)).toBe('row_deleted')
    expect(classifyOpenEvidence({ status: 'completed', releaseStatus: 'released' })).toBe('released_unresolved')
    expect(classifyOpenEvidence({ status: 'completed' })).toBe('unreadable')
    expect(classifyOpenEvidence({ status: 'weird' })).toBe('unreadable')
  })
})
