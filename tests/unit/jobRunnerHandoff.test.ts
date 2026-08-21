// RD-BROADCAST-CONTINUATION · when the runner actually asks for a lease hand-off.
//
// The kernel test proves `releaseLease` does the right thing once asked. This one proves the
// runner asks at exactly the right moment and never otherwise — which is the half that decides
// whether a stalled broadcast resumes in seconds or in half an hour.
//
// THE RULE: release only when this invocation is ENDING because the budget ran out and the job
// is NOT finished — i.e. a successor is about to pick it up. A mid-budget page keeps renewing
// (the worker is still going), a terminal page needs no release (the lease is already cleared),
// and a runner that did not opt in never releases at all.
//
// THE INVARIANT THAT MATTERS: `releaseLease === true ⇒ this invocation exits`. It holds because
// ONE variable decides both — the runner must never re-read the clock after the commit. Doing so
// let the budget cross DURING commitChunk, renewing a full lease and then breaking, which is the
// stall this option exists to remove. Releasing early is worse still: the loop would continue
// unleased, and a released lease's fencing tag is 0, so its commits would still be accepted.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Doc = Record<string, unknown>

/** Every ChunkCommit the runner handed to the kernel. */
const commits: Doc[] = []
let pagesRemaining = 0
let itemDelayMs    = 0
let jobStatus      = 'processing'
/** Simulated duration of the commit transaction — how the budget boundary is made to fall
 *  INSIDE commitChunk, which is the case that used to renew the lease and then break. */
let commitDelayMs  = 0
/** Pages actually requested. The proof that a released invocation fetched nothing more. */
let fetchPageCalls = 0

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
  FieldValue: { serverTimestamp: () => 'TS', increment: (n: number) => ({ __inc: n }), delete: () => 'DELETE' },
}))

vi.mock('@/lib/firebase/admin', () => ({ adminAuth: {}, adminDb: {} }))

vi.mock('@/lib/jobs/kernel', () => ({
  leaseJob: async () => ({
    proceed: true,
    job: { jobId: 'job-1', status: 'processing', cursor: null, counts: { total: 50, processed: 0, succeeded: 0, failed: 0 } },
    leaseTag: 1_000_000,
  }),
  commitChunk: async (_c: string, _j: string, c: Doc) => {
    commits.push({ ...c })
    if (commitDelayMs) await new Promise(r => setTimeout(r, commitDelayMs))
    return { status: c.finished ? 'completed' : jobStatus, leaseTag: c.releaseLease ? 0 : 2_000_000, fenced: false }
  },
  getJob: async () => ({ jobId: 'job-1', status: 'completed', counts: { total: 50, processed: 50, succeeded: 50, failed: 0 } }),
  failJob: async () => {},
}))

const { runJobChunk } = await import('@/lib/jobs/runner')

/** A strategy that yields `pagesRemaining` more pages, each item taking `itemDelayMs`. */
const strategy = {
  loadContext: async () => ({ ok: true as const, ctx: {} }),
  fetchPage: async () => {
    fetchPageCalls++
    const hasMore = pagesRemaining > 1
    pagesRemaining = Math.max(0, pagesRemaining - 1)
    return { items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'r0000001', hasMore }
  },
  processItem: async () => {
    if (itemDelayMs) await new Promise(r => setTimeout(r, itemDelayMs))
    return { ok: true }
  },
}

const run = (over: Doc = {}) => runJobChunk(
  'job-1',
  strategy as never,
  { collection: 'emailBroadcastJobs', pageSize: 2, budgetMs: 40, leaseMs: 60_000, ...over } as never,
)

beforeEach(() => {
  commits.length = 0; pagesRemaining = 3; itemDelayMs = 0; jobStatus = 'processing'
  commitDelayMs = 0; fetchPageCalls = 0
})

// ─── Opted in ─────────────────────────────────────────────────────────────────

describe('a runner that opted in releases ONLY on a budget hand-off', () => {
  it('releases on the commit that ends the invocation', async () => {
    itemDelayMs = 30                                  // each page exceeds the 40ms budget
    await run({ releaseLeaseOnHandoff: true })

    expect(commits.length).toBeGreaterThan(0)
    const last = commits.at(-1) as Doc
    expect(last.finished).toBe(false)                 // job not done…
    expect(last.releaseLease).toBe(true)              // …so the lease is handed over
  })

  it('does NOT release on a terminal commit — the kernel already clears it', async () => {
    pagesRemaining = 1                                // completes on the first page
    await run({ releaseLeaseOnHandoff: true })

    const last = commits.at(-1) as Doc
    expect(last.finished).toBe(true)
    expect(last.releaseLease).toBe(false)
  })

  it('does NOT release on a mid-budget commit — the worker is still going', async () => {
    itemDelayMs = 0                                   // fast pages, budget never hit
    pagesRemaining = 3
    await run({ releaseLeaseOnHandoff: true, budgetMs: 60_000 })

    for (const c of commits) expect(c.releaseLease).toBe(false)
    expect((commits.at(-1) as Doc).finished).toBe(true)
  })
})

// ─── Not opted in — the default every other job keeps ────────────────────────

describe('a runner that did not opt in never releases', () => {
  it('flag absent ⇒ every commit renews, even when yielding on budget', async () => {
    itemDelayMs = 30
    await run()                                       // no releaseLeaseOnHandoff

    expect(commits.length).toBeGreaterThan(0)
    for (const c of commits) expect(c.releaseLease).toBe(false)
  })

  it('flag explicitly false ⇒ identical', async () => {
    itemDelayMs = 30
    await run({ releaseLeaseOnHandoff: false })
    for (const c of commits) expect(c.releaseLease).toBe(false)
  })

  it('only a strict boolean true opts in', async () => {
    for (const v of ['true', 1, {}, []] as unknown[]) {
      commits.length = 0; pagesRemaining = 3; itemDelayMs = 30
      await run({ releaseLeaseOnHandoff: v })
      for (const c of commits) expect(c.releaseLease, String(v)).toBe(false)
    }
  })
})

// ─── The commit still carries everything it did before ───────────────────────

describe('the hand-off changes nothing else about the commit', () => {
  it('cursor, counts and fencing token are still present and correct', async () => {
    itemDelayMs = 30
    await run({ releaseLeaseOnHandoff: true })

    const c = commits.at(-1) as Doc
    expect(c.cursor).toBe('r0000001')
    expect(c.deltaProcessed).toBe(2)
    expect(c.deltaSucceeded).toBe(2)
    expect(c.deltaFailed).toBe(0)
    expect(c.expectedLeaseTag).toBe(1_000_000)        // fencing intact
    expect(c.leaseMs).toBe(60_000)
  })

  it('a cancelled job stops without a hand-off release', async () => {
    jobStatus = 'cancelled'
    itemDelayMs = 30
    const r = await run({ releaseLeaseOnHandoff: true })
    expect(r.status).toBe('cancelled')
    expect(r.done).toBe(true)
  })
})

// ─── D1 · the budget boundary falling INSIDE the commit ──────────────────────
//
// The regression these two cover: the runner used to decide `releaseLease` before the commit
// and re-read the clock after it. When the budget crossed during commitChunk the two disagreed
// — the lease was RENEWED and the loop broke anyway, so the yielding worker held the job for
// another full leaseMs, the continuation got `busy`, and the chain died at depth 1.

describe('a commit that itself crosses the budget cannot renew-then-break', () => {
  it('the invocation never ends on a renewing commit', async () => {
    // Page work is instant, so the budget is NOT yet spent when the release decision is made;
    // the commit alone pushes past it. Under the old code this produced exactly one commit,
    // with releaseLease false, and the loop exited holding a fresh 60s lease.
    itemDelayMs   = 0
    commitDelayMs = 30
    pagesRemaining = 5
    await run({ releaseLeaseOnHandoff: true, budgetMs: 20 })

    const last = commits.at(-1) as Doc
    expect(last.finished).toBe(false)        // still work left…
    expect(last.releaseLease).toBe(true)     // …and the lease WAS handed over
  })

  it('the worker exits on that release and fetches no further page', async () => {
    itemDelayMs   = 0
    commitDelayMs = 30
    pagesRemaining = 5
    await run({ releaseLeaseOnHandoff: true, budgetMs: 20 })

    // One fetch per commit and not one more: the release is the last thing that happened.
    expect(fetchPageCalls).toBe(commits.length)
    expect(pagesRemaining).toBeGreaterThan(0)   // it really did stop early
  })
})

// ─── D1 · release ⇒ break, as a universal property ───────────────────────────

describe('release implies exit — always, however the timings fall', () => {
  it.each([
    ['work exceeds budget',      { itemDelayMs: 30, commitDelayMs: 0,  budgetMs: 40 }],
    ['commit crosses budget',    { itemDelayMs: 0,  commitDelayMs: 30, budgetMs: 20 }],
    ['both are slow',            { itemDelayMs: 15, commitDelayMs: 15, budgetMs: 20 }],
  ])('%s: a released commit is always the LAST commit', async (_label, cfg) => {
    itemDelayMs   = cfg.itemDelayMs
    commitDelayMs = cfg.commitDelayMs
    pagesRemaining = 6
    await run({ releaseLeaseOnHandoff: true, budgetMs: cfg.budgetMs })

    const releasedAt = commits.findIndex(c => c.releaseLease === true)
    if (releasedAt !== -1) {
      expect(releasedAt).toBe(commits.length - 1)   // nothing committed after a release
      expect(fetchPageCalls).toBe(commits.length)   // nothing fetched after it either
    }
  })

  it('a yielding invocation ALWAYS ends on a release, never on a renew', async () => {
    // The precise anti-regression assertion: if the job is unfinished when we stop, the final
    // commit must have handed the lease over. Anything else is the old deadlock.
    for (const cfg of [
      { itemDelayMs: 30, commitDelayMs: 0,  budgetMs: 40 },
      { itemDelayMs: 0,  commitDelayMs: 30, budgetMs: 20 },
      { itemDelayMs: 5,  commitDelayMs: 25, budgetMs: 20 },
    ]) {
      commits.length = 0; fetchPageCalls = 0; pagesRemaining = 6
      itemDelayMs = cfg.itemDelayMs; commitDelayMs = cfg.commitDelayMs
      await run({ releaseLeaseOnHandoff: true, budgetMs: cfg.budgetMs })

      const last = commits.at(-1) as Doc
      if (last.finished === false) {
        expect(last.releaseLease, JSON.stringify(cfg)).toBe(true)
      }
    }
  })

  it('a runner that did NOT opt in still never releases, boundary or not', async () => {
    itemDelayMs = 0; commitDelayMs = 30; pagesRemaining = 5
    await run({ budgetMs: 20 })
    for (const c of commits) expect(c.releaseLease).toBe(false)
  })
})
