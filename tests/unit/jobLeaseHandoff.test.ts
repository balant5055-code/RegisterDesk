// RD-BROADCAST-CONTINUATION · the opt-in lease hand-off.
//
// ═══ THE DEADLOCK THIS FIXES ═════════════════════════════════════════════════
// `commitChunk` renews the lease to `now + leaseMs` at the END of a page. A broadcast worker
// that yields at its 45s budget therefore kept a 60s lease for another full minute after it
// had stopped working. The continuation it dispatched arrived immediately, saw a live lease,
// waited out BUSY_RETRY_MAX_MS (18s) and gave up — so the chain died at depth 1 every time and
// the job fell back to the scheduled tick 20-40 minutes later. Measured in production: 7
// invocations, zero sub-minute gaps, 2.79 msg/min end-to-end against 112 msg/min in-chunk.
//
// ═══ WHAT IS ASSERTED ════════════════════════════════════════════════════════
// The fix is one optional flag, so the tests that matter most are the ones proving it changes
// NOTHING unless asked: certificates, prints, imports and reports share this kernel, and they
// must keep renewing exactly as before. Then that the hand-off is safe — fenced first, applied
// in the same transaction as the cursor, never on a terminal or cancelled commit.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Doc = Record<string, unknown>

/** The job document, mutated by the transaction exactly as Firestore would. */
let job: Doc | null = null
/** Every patch commitChunk wrote, in order. */
const writes: Doc[] = []

class FakeTimestamp {
  constructor(public ms: number) {}
  toMillis() { return this.ms }
  static fromMillis(ms: number) { return new FakeTimestamp(ms) }
}

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: FakeTimestamp,
  FieldValue: {
    serverTimestamp: () => 'TS',
    increment: (n: number) => ({ __inc: n }),
    delete: () => 'DELETE',
  },
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: () => ({ doc: () => ({ id: 'job-1' }) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      get:    async () => ({ exists: !!job, data: () => job }),
      update: (_ref: unknown, patch: Doc) => {
        writes.push(patch)
        // Apply the fields the next read would see.
        if ('lockedUntil' in patch) (job as Doc).lockedUntil = patch.lockedUntil
        if ('status' in patch)      (job as Doc).status      = patch.status
        if ('cursor' in patch)      (job as Doc).cursor      = patch.cursor
      },
      set: () => {}, delete: () => {},
    }),
  },
}))

const { commitChunk } = await import('@/lib/jobs/kernel')

const LEASE_MS = 60_000
const TAG      = 1_000_000            // the lease this worker holds

const baseJob = (over: Doc = {}): Doc => ({
  status: 'processing',
  cursor: 'r0000004',
  error:  null,
  counts: { total: 100, processed: 5, succeeded: 5, failed: 0 },
  lockedUntil: new FakeTimestamp(TAG),
  completedAt: null,
  ...over,
})

const commit = (over: Partial<Record<string, unknown>> = {}) => commitChunk('emailBroadcastJobs', 'job-1', {
  deltaProcessed: 5, deltaSucceeded: 5, deltaFailed: 0,
  cursor: 'r0000009', lastError: null,
  finished: false, leaseMs: LEASE_MS, expectedLeaseTag: TAG,
  ...over,
} as never)

const lastWrite = () => writes.at(-1) as Doc

beforeEach(() => { job = baseJob(); writes.length = 0 })

// ─── 1. Default behaviour is untouched ────────────────────────────────────────

describe('the default renews the lease, exactly as before this option existed', () => {
  it('flag ABSENT ⇒ lease renewed to a future timestamp', async () => {
    const before = Date.now()
    const r = await commit()

    expect(r.fenced).toBe(false)
    expect(r.status).toBe('processing')
    expect(lastWrite().lockedUntil).toBeInstanceOf(FakeTimestamp)
    expect((lastWrite().lockedUntil as FakeTimestamp).toMillis()).toBeGreaterThanOrEqual(before + LEASE_MS)
    expect(r.leaseTag).toBeGreaterThanOrEqual(before + LEASE_MS)
  })

  it('flag FALSE ⇒ identical to absent', async () => {
    const r = await commit({ releaseLease: false })
    expect(lastWrite().lockedUntil).toBeInstanceOf(FakeTimestamp)
    expect(r.leaseTag).toBeGreaterThan(0)
  })

  it('a certificate/print/import/report-style caller (no flag) still renews', async () => {
    // These callers construct ChunkCommit without the field at all.
    const r = await commitChunk('certificateJobs', 'job-1', {
      deltaProcessed: 5, deltaSucceeded: 5, deltaFailed: 0,
      cursor: 'c9', lastError: null, finished: false,
      leaseMs: LEASE_MS, expectedLeaseTag: TAG,
    })
    expect(lastWrite().lockedUntil).toBeInstanceOf(FakeTimestamp)
    expect(r.leaseTag).toBeGreaterThan(0)
  })

  it('the cursor and counts advance the same way either way', async () => {
    await commit()
    const renewed = { ...lastWrite() }
    job = baseJob(); writes.length = 0
    await commit({ releaseLease: true })
    const released = lastWrite()

    expect(released.cursor).toEqual(renewed.cursor)
    expect(released['counts.processed']).toEqual(renewed['counts.processed'])
    expect(released['counts.succeeded']).toEqual(renewed['counts.succeeded'])
    expect(released['counts.failed']).toEqual(renewed['counts.failed'])
    expect(released.status).toEqual(renewed.status)
  })
})

// ─── 2. The hand-off ──────────────────────────────────────────────────────────

describe('releaseLease: true hands the job over', () => {
  it('clears the lease to null — not Timestamp(0)', async () => {
    const r = await commit({ releaseLease: true })
    expect(lastWrite().lockedUntil).toBeNull()
    expect(r.leaseTag).toBe(0)
    expect(r.fenced).toBe(false)
  })

  it('still advances the cursor in the SAME write as the release', async () => {
    await commit({ releaseLease: true })
    const w = lastWrite()
    expect(w.cursor).toBe('r0000009')      // progress…
    expect(w.lockedUntil).toBeNull()       // …and release, one atomic patch
    expect(writes).toHaveLength(1)
  })

  it('a successor can acquire immediately — the doc reads as unheld', async () => {
    await commit({ releaseLease: true })
    expect((job as Doc).lockedUntil).toBeNull()
    expect((job as Doc).status).toBe('processing')   // still resumable, not terminal
  })

  it('keeps the job non-terminal so the cron backstop still owns it', async () => {
    const r = await commit({ releaseLease: true })
    expect(r.status).toBe('processing')
    expect(lastWrite().completedAt).toBeNull()
  })
})

// ─── 3. Fencing is unchanged and is checked FIRST ─────────────────────────────

describe('fencing still rejects a stale worker', () => {
  it('a stale expectedLeaseTag is rejected with NO mutation — flag or not', async () => {
    for (const releaseLease of [false, true]) {
      job = baseJob({ lockedUntil: new FakeTimestamp(TAG + 5_000) })   // someone re-leased
      writes.length = 0
      const r = await commit({ expectedLeaseTag: TAG, releaseLease })
      expect(r.fenced, String(releaseLease)).toBe(true)
      expect(writes, String(releaseLease)).toEqual([])
    }
  })

  it('a stale worker CANNOT release the live owner’s lease', async () => {
    job = baseJob({ lockedUntil: new FakeTimestamp(TAG + 5_000) })
    await commit({ expectedLeaseTag: TAG, releaseLease: true })
    // The current owner's lease is untouched.
    expect((job as Doc).lockedUntil).toBeInstanceOf(FakeTimestamp)
    expect(((job as Doc).lockedUntil as FakeTimestamp).toMillis()).toBe(TAG + 5_000)
  })

  it('a missing job is fenced, never released', async () => {
    job = null
    const r = await commit({ releaseLease: true })
    expect(r.fenced).toBe(true)
    expect(writes).toEqual([])
  })
})

// ─── 4. Terminal and cancelled commits ────────────────────────────────────────

describe('terminal and cancelled commits are unaffected', () => {
  it('finished ⇒ lease cleared because it is terminal, not because of the flag', async () => {
    const r = await commit({ finished: true })
    expect(lastWrite().lockedUntil).toBeNull()
    expect(r.status).toBe('completed')
    expect(r.leaseTag).toBe(0)
  })

  it('finished + releaseLease ⇒ still completed, no double handling', async () => {
    const r = await commit({ finished: true, releaseLease: true })
    expect(r.status).toBe('completed')
    expect(lastWrite().lockedUntil).toBeNull()
    expect(lastWrite().completedAt).toBe('TS')
  })

  it('cancellation still wins over the hand-off', async () => {
    job = baseJob({ status: 'cancelled' })
    const r = await commit({ releaseLease: true })
    expect(r.status).toBe('cancelled')
    expect(lastWrite().lockedUntil).toBeNull()
    expect(lastWrite().completedAt).toBeNull()   // cancelled is not a completion
  })

  it('a cancelled job never reports completed even when finished is true', async () => {
    job = baseJob({ status: 'cancelled' })
    const r = await commit({ finished: true, releaseLease: true })
    expect(r.status).toBe('cancelled')
  })
})

// ─── 5. Only the opt-in caller is affected ────────────────────────────────────

describe('the opt-in is per-commit, never global', () => {
  it('two commits on the same collection can differ', async () => {
    await commit({ releaseLease: true })
    expect(lastWrite().lockedUntil).toBeNull()

    job = baseJob(); writes.length = 0
    await commit({ releaseLease: false })
    expect(lastWrite().lockedUntil).toBeInstanceOf(FakeTimestamp)
  })

  it('only a strict boolean true releases — no truthy coercion', async () => {
    for (const v of ['true', 1, {}, [], 'yes'] as unknown[]) {
      job = baseJob(); writes.length = 0
      await commit({ releaseLease: v as boolean })
      expect(lastWrite().lockedUntil, String(v)).toBeInstanceOf(FakeTimestamp)
    }
  })
})

// ─── D2 · an unleased worker can never commit ────────────────────────────────
//
// A released (or cleared) lease writes `lockedUntil: null`, and the fencing token derived from
// null is 0. A worker still holding tag 0 therefore satisfied `currentTag === expectedLeaseTag`
// and could commit while owning nothing — driving the same cursor as the successor that had
// legitimately re-leased the job, and sending the same paid WhatsApp messages twice.
//
// The runner never reaches that state today (a released lease always ends its loop), but that
// is a timing argument, and a timing argument is the wrong thing to rest duplicate messages on.
// Tag 0 is now refused outright, before any mutation.

describe('a commit with no lease is refused outright', () => {
  it('expectedLeaseTag 0 against a released lease (lockedUntil null) is FENCED', async () => {
    job = baseJob({ lockedUntil: null })
    const r = await commit({ expectedLeaseTag: 0 })

    expect(r.fenced).toBe(true)
    expect(writes).toEqual([])                       // no mutation whatsoever
  })

  it('the job document is completely untouched by the refusal', async () => {
    job = baseJob({ lockedUntil: null })
    const before = JSON.stringify(job)
    await commit({ expectedLeaseTag: 0 })

    expect(JSON.stringify(job)).toBe(before)
    expect((job as Doc).cursor).toBe('r0000004')     // cursor did NOT advance
    expect((job as Doc).lockedUntil).toBeNull()      // and no lease was taken
  })

  it('tag 0 is refused even when it would otherwise MATCH — this is the whole point', async () => {
    // Both sides are 0, so the equality check below would have passed.
    job = baseJob({ lockedUntil: null })
    const r = await commit({ expectedLeaseTag: 0 })
    expect(r.fenced).toBe(true)
  })

  it('tag 0 is refused on a FINISHED commit too — no terminal back door', async () => {
    job = baseJob({ lockedUntil: null })
    const r = await commit({ expectedLeaseTag: 0, finished: true })

    expect(r.fenced).toBe(true)
    expect(writes).toEqual([])                       // never completed, never counted
  })

  it('tag 0 is refused with a hand-off flag set — no interaction between the two', async () => {
    job = baseJob({ lockedUntil: null })
    const r = await commit({ expectedLeaseTag: 0, releaseLease: true })
    expect(r.fenced).toBe(true)
    expect(writes).toEqual([])
  })

  it('tag 0 is refused even against a job that IS leased by someone else', async () => {
    job = baseJob({ lockedUntil: new FakeTimestamp(TAG) })
    const r = await commit({ expectedLeaseTag: 0 })

    expect(r.fenced).toBe(true)
    expect(writes).toEqual([])
  })

  it('the refusal happens BEFORE the stale-lease comparison', async () => {
    // Ordering matters: tag 0 must be rejected on its own terms, not merely as a side effect
    // of mismatching. Proven by the case above where 0 === 0 would have matched.
    const src = (await import('node:fs')).readFileSync('lib/jobs/kernel.ts', 'utf8')
    const zeroGuard = src.indexOf('c.expectedLeaseTag === 0')
    const staleCmp  = src.indexOf('currentTag !== c.expectedLeaseTag')
    expect(zeroGuard).toBeGreaterThan(-1)
    expect(zeroGuard).toBeLessThan(staleCmp)
  })
})

// ─── D2 · legitimate commits are unaffected ──────────────────────────────────

describe('the no-lease guard changes nothing for a real lease holder', () => {
  it('a normal held-lease commit still succeeds and renews', async () => {
    const r = await commit()
    expect(r.fenced).toBe(false)
    expect(lastWrite().cursor).toBe('r0000009')
  })

  it('a genuine stale-tag mismatch is still fenced, exactly as before', async () => {
    job = baseJob({ lockedUntil: new FakeTimestamp(TAG + 5_000) })   // someone re-leased
    const r = await commit({ expectedLeaseTag: TAG })

    expect(r.fenced).toBe(true)
    expect(writes).toEqual([])
  })
})
