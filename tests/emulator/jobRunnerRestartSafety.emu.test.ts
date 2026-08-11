// Restart safety for the job runner that drives email broadcasts and reminders.
// REAL Firestore (emulator) — leases, cursors and per-page commits are datastore behaviour.
//
// WHY THIS MATTERS AT 10,000 RECIPIENTS. A broadcast to 10,000 attendees is never one
// invocation: the runner processes a page, commits, and yields when its time budget is
// spent; the GitHub Actions schedule calls back every 5 minutes to resume. Every one of
// those hand-offs is a chance to send an email twice, to skip recipients, or to have two
// workers stomp on each other. `lib/broadcasts/emailJob.ts` relies entirely on the runner
// for those guarantees and had NO test coverage.
//
// The strategy below mirrors emailJob's real shape — a `recipients` subcollection with a
// per-item `sent` flag — so these are the actual guarantees the broadcast depends on, not
// an abstract exercise of the runner.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { FieldPath, Timestamp } from 'firebase-admin/firestore'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

vi.mock('@/lib/monitoring/sentry', () => ({
  captureError: () => {}, captureFinancialError: () => {}, captureWebhookError: () => {},
  flushMonitoring: async () => {},
}))

let adminDb: import('firebase-admin/firestore').Firestore
let runJobChunk: typeof import('@/lib/jobs/runner')['runJobChunk']

const COLLECTION = 'testRestartJobs'
const JOB_ID     = 'job-restart-1'

/** Every send this run performed, in order — the duplicate detector. */
let delivered: string[] = []
/** Recipient ids whose send should fail. */
let failing = new Set<string>()

const jobRef = () => adminDb.collection(COLLECTION).doc(JOB_ID)
const recipientsRef = () => jobRef().collection('recipients')

async function seedJob(recipientCount: number) {
  await jobRef().set({
    jobId: JOB_ID, organizerUid: 'org-1', createdBy: 'org-1',
    status: 'pending',
    counts: { total: recipientCount, processed: 0, succeeded: 0, failed: 0 },
    cursor: null, error: null, lockedUntil: null,
    createdAt: Timestamp.now(), startedAt: null, updatedAt: Timestamp.now(), completedAt: null,
  })
  for (let i = 0; i < recipientCount; i++) {
    // Zero-padded so document-id ordering matches insertion order.
    const id = `r${String(i).padStart(3, '0')}`
    await recipientsRef().doc(id).set({ email: `${id}@example.com`, sent: false })
  }
}

/** Mirrors lib/broadcasts/emailJob.ts: id-ordered paging + a per-recipient `sent` flag. */
const strategy = {
  loadContext: async () => ({ ok: true as const, ctx: {} }),
  fetchPage: async (_job: unknown, _ctx: unknown, cursor: string | null, limit: number) => {
    let q = recipientsRef().orderBy(FieldPath.documentId())
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.limit(limit).get()
    return {
      items:      snap.docs.map(d => ({ ...(d.data() as { email: string; sent: boolean }), __id: d.id })),
      nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor,
      hasMore:    snap.size === limit,
    }
  },
  processItem: async (item: { __id: string; sent: boolean }) => {
    if (item.sent) return { ok: true }                     // already delivered — never resend
    if (failing.has(item.__id)) return { ok: false, error: 'provider rejected' }
    delivered.push(item.__id)
    await recipientsRef().doc(item.__id).update({ sent: true })
    return { ok: true }
  },
}

// budgetMs 0 ⇒ the runner yields after exactly one page, which is how a real chunk ends.
// leaseMs 1 ⇒ the lease has lapsed by the time the next call arrives, modelling the real
// gap between cron invocations (5 minutes) rather than an instant re-entry. Holding a live
// lease is exercised separately by the concurrency test below.
const config = { collection: COLLECTION, pageSize: 2, budgetMs: 0, leaseMs: 1 }

/** Drive the job to completion the way the cron does: repeated independent calls. */
async function runToCompletion(maxCalls = 50) {
  let calls = 0
  for (;;) {
    const r = await runJobChunk(JOB_ID, strategy as never, config)
    calls++
    if (r.done || calls >= maxCalls) return { calls, last: r }
  }
}

describeEmu('job runner · restart safety (drives email broadcasts + reminders)', () => {
  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ runJobChunk } = await import('@/lib/jobs/runner'))
  })

  beforeEach(async () => {
    delivered = []
    failing = new Set()
    const subs = await recipientsRef().limit(300).get()
    await Promise.all(subs.docs.map(d => d.ref.delete()))
    await jobRef().delete().catch(() => {})
  })

  it('resumes across many chunks and delivers to EVERY recipient exactly once', async () => {
    await seedJob(9)

    const { calls, last } = await runToCompletion()

    expect(last.done).toBe(true)
    expect(last.status).toBe('completed')
    expect(calls).toBeGreaterThan(1)                       // genuinely multi-chunk
    expect(delivered).toHaveLength(9)
    expect(new Set(delivered).size).toBe(9)                // no duplicates
    expect((await jobRef().get()).data()?.counts.processed).toBe(9)
  }, 60_000)

  it('a re-run after completion sends nothing — cron re-invocation is safe', async () => {
    await seedJob(4)
    await runToCompletion()
    const afterFirst = [...delivered]

    const again = await runJobChunk(JOB_ID, strategy as never, config)

    expect(again.done).toBe(true)
    expect(again.reason).toBe('completed')
    expect(again.processed).toBe(0)
    expect(delivered).toEqual(afterFirst)
  }, 60_000)

  it('an interrupted run resumes from the cursor without resending earlier recipients', async () => {
    await seedJob(6)

    // One chunk only — simulates the function being cut off mid-job.
    await runJobChunk(JOB_ID, strategy as never, config)
    const partial = [...delivered]
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(6)

    await runToCompletion()

    expect(delivered).toHaveLength(6)
    expect(new Set(delivered).size).toBe(6)
    // The recipients from the interrupted chunk appear once, and first.
    expect(delivered.slice(0, partial.length)).toEqual(partial)
  }, 60_000)

  it('one failing recipient never stops the rest, and is counted as failed', async () => {
    await seedJob(6)
    failing = new Set(['r002'])

    const { last } = await runToCompletion()

    expect(last.status).toBe('completed')
    expect(delivered).toHaveLength(5)
    expect(delivered).not.toContain('r002')
    const counts = (await jobRef().get()).data()?.counts
    expect(counts.failed).toBe(1)
    expect(counts.succeeded).toBe(5)
  }, 60_000)

  it('a second concurrent worker is refused by the lease — no double sending', async () => {
    await seedJob(6)
    // Take the lease and hold it (long lease, budget spent after one page).
    await runJobChunk(JOB_ID, strategy as never, { ...config, leaseMs: 120_000 })
    await jobRef().update({ lockedUntil: Timestamp.fromMillis(Date.now() + 120_000), status: 'processing' })
    const held = [...delivered]

    const second = await runJobChunk(JOB_ID, strategy as never, config)

    expect(second.reason).toBe('busy')
    expect(second.processed).toBe(0)
    expect(delivered).toEqual(held)
  }, 60_000)
})
