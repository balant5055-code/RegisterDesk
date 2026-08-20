// RD-WA-THRU-01 · WhatsApp broadcast throughput, measured rather than assumed.
//
// PRODUCTION EVIDENCE this file is calibrated against (campaign BVsDYpfKVhBpc2sy2yZm,
// job wab_c929d80e, 385/1472 sent over 7,180s):
//
//   median inter-message gap ....... 392 ms   ← the real per-message cost
//   messages per invocation ........ ~77
//   invocations .................... 5
//   gaps between invocations ....... 1,459,879 / 2,068,949 / 2,217,293 / 1,204,201 ms
//
// Read those last two lines together: sending a message costs 392 ms, and waiting for the
// next chunk costs TWENTY TO THIRTY-SEVEN MINUTES. The job is not slow because sending is
// slow; it is slow because almost nothing is sending almost all of the time.
//
// So the tests below measure two different things and the distinction matters:
//   • in-chunk throughput — what concurrency changes
//   • end-to-end time     — dominated by the gap between chunks, which concurrency does NOT
//     change at all
//
// Correctness runs use a virtual clock (deterministic, and able to skip a 60s lease);
// the perf runs use REAL timers with the latency scaled down, because a virtual clock
// that advances serially can never show concurrent calls overlapping.

import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Median inter-message gap measured in production. */
const PROVIDER_MS = 392

// ─── In-memory Firestore (same shape as broadcastJobContinuation.test.ts) ────

interface Doc { [k: string]: unknown }
const store = new Map<string, Doc>()

class FakeTimestamp {
  constructor(public ms: number) {}
  toMillis() { return this.ms }
  toDate()   { return new Date(this.ms) }
  static fromMillis(ms: number) { return new FakeTimestamp(ms) }
  static fromDate(d: Date)      { return new FakeTimestamp(d.getTime()) }
  static now()                  { return new FakeTimestamp(Date.now()) }
}
const SERVER_TS = Symbol('serverTimestamp')
class FakeIncrement { constructor(public n: number) {} }

const setPath = (o: Doc, path: string, v: unknown) => {
  const parts = path.split('.')
  let cur: Doc = o
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]] as Doc
  }
  cur[parts[parts.length - 1]] = v
}
const getPath = (o: Doc, path: string): unknown =>
  path.split('.').reduce<unknown>((a, p) => (a && typeof a === 'object' ? (a as Doc)[p] : undefined), o)

const resolveWrites = (target: Doc, patch: Doc) => {
  for (const [k, v] of Object.entries(patch)) {
    if (v === SERVER_TS) { setPath(target, k, new FakeTimestamp(Date.now())); continue }
    if (v instanceof FakeIncrement) { setPath(target, k, ((getPath(target, k) as number) ?? 0) + v.n); continue }
    setPath(target, k, v)
  }
}

const snap = (path: string) => ({ exists: store.has(path), id: path.split('/').pop()!, data: () => store.get(path) })

function makeQuery(prefix: string) {
  let startAfterId: string | null = null
  let lim = Infinity
  const q = {
    where() { return q },
    orderBy() { return q },
    startAfter(v: unknown) { startAfterId = String(v); return q },
    limit(n: number) { lim = n; return q },
    select() { return q },
    async get() {
      let ids = [...store.keys()]
        .filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map(k => k.slice(prefix.length))
        .sort()
      if (startAfterId) ids = ids.filter(id => id > startAfterId!)
      const docs = ids.slice(0, lim).map(id => ({ id, data: () => store.get(prefix + id)! }))
      return { size: docs.length, docs, empty: docs.length === 0 }
    },
  }
  return q
}

const docRef = (path: string) => ({
  get: async () => snap(path),
  set: async (d: Doc) => { const t: Doc = {}; resolveWrites(t, d); store.set(path, t) },
  update: async (patch: Doc) => {
    if (!store.has(path)) throw new Error('no doc ' + path)
    resolveWrites(store.get(path)!, patch)
  },
  collection: (n: string) => collRef(`${path}/${n}/`),
})
const collRef = (prefix: string) => ({ doc: (id: string) => docRef(prefix + id), ...makeQuery(prefix) })

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: FakeTimestamp,
  FieldPath: { documentId: () => '__name__' },
  FieldValue: { serverTimestamp: () => SERVER_TS, increment: (n: number) => new FakeIncrement(n), delete: () => 'DEL' },
}))
vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: (n: string) => collRef(`${n}/`),
    doc: (p: string) => docRef(p),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      update: (ref: { update: (p: Doc) => Promise<void> }, patch: Doc) => { void ref.update(patch) },
      set: () => {}, delete: () => {},
    }),
  },
}))

const { createJob, leaseJob } = await import('@/lib/jobs/kernel')
const { runJobChunk } = await import('@/lib/jobs/runner')

// ─── A WhatsApp-shaped strategy ──────────────────────────────────────────────

const COL = 'whatsappBroadcastJobs'
const rid = (i: number) => `r${String(i).padStart(7, '0')}`

let sends: string[] = []
/** Recipients in flight right now — the concurrency observer. */
let inFlight = 0
let maxInFlight = 0
let providerFailOn = new Set<string>()
let markerFailOn = new Set<string>()
let now = 1_000_000
/**
 * Perf runs use REAL timers so overlapping provider calls actually overlap. Correctness
 * runs keep the virtual clock, because they need to fast-forward past a 60s lease.
 */
let realTiming = false
/** Scaled provider latency for perf runs: 392ms measured / 20 = 19.6ms, rounded. */
const SCALED_MS = 20

async function seed(jobId: string, total: number) {
  await createJob(COL, jobId, { organizerUid: 'u1', campaignId: 'c1' }, total)
  for (let i = 0; i < total; i++) {
    store.set(`${COL}/${jobId}/recipients/${rid(i)}`, { phone: `9${String(i).padStart(9, '0')}`, sent: false })
  }
}

/** Mirrors lib/broadcasts/whatsappJob processItem: skip sent → provider → await marker. */
const strategy = (jobId: string) => ({
  async loadContext() { return { ok: true as const, ctx: {} } },
  async fetchPage(_j: unknown, _c: unknown, cursor: string | null, limit: number) {
    let q = collRef(`${COL}/${jobId}/recipients/`).orderBy()
    if (cursor) q = q.startAfter(cursor)
    const s = await q.limit(limit).get()
    return {
      items: s.docs.map(d => ({ ...(d.data() as Doc), __id: d.id })),
      nextCursor: s.docs.length ? s.docs[s.docs.length - 1].id : cursor,
      hasMore: s.size === limit,
    }
  },
  async processItem(item: Doc & { __id: string }) {
    if (item.sent === true) return { ok: true }          // THE idempotency guard

    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    if (realTiming) {
      // A real await, so N workers genuinely wait in parallel rather than in sequence.
      await new Promise(r => setTimeout(r, SCALED_MS))
    } else {
      // Virtual clock: correctness only. Advancing serially here is fine because these
      // tests assert WHAT happened, never how long it took.
      const start = now
      await Promise.resolve()
      now = Math.max(now, start) + PROVIDER_MS
    }
    inFlight--

    sends.push(item.__id)
    if (providerFailOn.has(item.__id)) return { ok: false, error: 'provider said no' }

    try {
      if (markerFailOn.has(item.__id)) throw new Error('FirestoreError: UNAVAILABLE')
      await docRef(`${COL}/${jobId}/recipients/${item.__id}`).update({ sent: true })
    } catch { /* logged in production; still counts as sent */ }
    return { ok: true }
  },
})

const cfg = (concurrency: number) => ({
  collection: COL, pageSize: 5, budgetMs: 45_000, leaseMs: 60_000, concurrency,
})
const drive = (jobId: string, c = 1) => runJobChunk(jobId, strategy(jobId) as never, cfg(c))
const job = (id: string) => store.get(`${COL}/${id}`) as Doc & { counts: Record<string, number> }

beforeEach(() => {
  store.clear(); sends = []; inFlight = 0; maxInFlight = 0
  providerFailOn = new Set(); markerFailOn = new Set(); now = 1_000_000
  vi.restoreAllMocks()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

/** Runs a job to completion, reporting chunk count and simulated wall-clock. */
async function runToCompletion(jobId: string, concurrency: number) {
  const t0 = now
  let chunks = 0
  for (;;) {
    const r = await drive(jobId, concurrency)
    chunks++
    if (r.done || chunks > 400) break
    now += 61_000                    // lease expiry between chunks
  }
  return { chunks, simulatedMs: now - t0 }
}

// ─── 8. The performance table ────────────────────────────────────────────────

describe('throughput by concurrency (real timers, latency scaled 392ms -> 20ms)', () => {
  const RESULTS: Array<{ c: number; perChunk: number; chunkMs: number }> = []
  /** 45s budget scaled by the same factor as the latency. */
  const SCALED_BUDGET = 45_000 / (PROVIDER_MS / SCALED_MS)

  for (const c of [1, 2, 3, 4, 5]) {
    it(`concurrency ${c}`, async () => {
      realTiming = true
      vi.restoreAllMocks()               // real Date.now, so the budget is real elapsed time
      store.clear(); sends = []; maxInFlight = 0; inFlight = 0
      await seed(`perf${c}`, 1472)

      const t0 = Date.now()
      const r  = await runJobChunk(`perf${c}`, strategy(`perf${c}`) as never, {
        collection: COL, pageSize: 5, budgetMs: SCALED_BUDGET, leaseMs: 60_000, concurrency: c,
      })
      const chunkMs = Date.now() - t0
      realTiming = false

      expect(r.processed).toBeGreaterThan(0)
      expect(maxInFlight).toBeLessThanOrEqual(c)
      RESULTS.push({ c, perChunk: r.processed, chunkMs })
    }, 30_000)
  }

  it('reports the table', () => {
    const scale = PROVIDER_MS / SCALED_MS
    console.log('\n| Concurrency | Msgs/chunk | Chunk time (scaled) | Chunks for 1472 | Est. rounds/page |')
    console.log('|---|---|---|---|---|')
    for (const r of RESULTS.sort((a, b) => a.c - b.c)) {
      console.log(`| ${r.c} | ${r.perChunk} | ${(r.chunkMs / 1000).toFixed(2)}s (~${((r.chunkMs * scale) / 1000).toFixed(0)}s real) | ${Math.ceil(1472 / r.perChunk)} | ${Math.ceil(5 / r.c)} |`)
    }
    expect(RESULTS).toHaveLength(5)

    const by = Object.fromEntries(RESULTS.map(r => [r.c, r.perChunk]))
    // Concurrency must actually buy throughput, or there is no reason to take the risk.
    expect(by[2]).toBeGreaterThan(by[1])
    expect(by[3]).toBeGreaterThan(by[2])

    // THE STRUCTURAL LIMIT, and the reason 4 is not the answer: the worker pool runs
    // WITHIN a page, and pages are 5. ceil(5/3) and ceil(5/4) are both 2 rounds, so 4
    // costs an extra concurrent provider call for nothing. Only 5 reaches one round.
    expect(Math.abs(by[4] - by[3]) / by[3]).toBeLessThan(0.15)
  })
})
// ─── 4 + 7. Concurrency safety ───────────────────────────────────────────────

describe('concurrent execution is safe', () => {
  for (const c of [1, 2, 3, 4]) {
    it(`c=${c}: 1,472 recipients complete with NO duplicate sends`, async () => {
      await seed(`safe${c}`, 1472)
      const { chunks } = await runToCompletion(`safe${c}`, c)
      const j = job(`safe${c}`)
      expect(j.status).toBe('completed')
      expect(j.counts.processed).toBe(1472)
      expect(j.counts.succeeded).toBe(1472)
      expect(sends).toHaveLength(1472)
      expect(new Set(sends).size).toBe(1472)        // each recipient exactly once
      expect(chunks).toBeGreaterThan(0)
    })
  }

  it('the pool never exceeds its configured width', async () => {
    await seed('pool', 50)
    await drive('pool', 3)
    expect(maxInFlight).toBeGreaterThan(1)          // it really did run in parallel
    expect(maxInFlight).toBeLessThanOrEqual(3)
  })

  it('already-sent recipients are skipped even under concurrency', async () => {
    await seed('skip', 40)
    await drive('skip', 4)
    // Re-drive from a rolled-back cursor: every row already carries sent:true.
    store.get(`${COL}/skip`)!.cursor = null
    store.get(`${COL}/skip`)!.status = 'processing'
    store.get(`${COL}/skip`)!.lockedUntil = null
    const before = sends.length
    await drive('skip', 4)
    expect(sends).toHaveLength(before)             // not one extra provider call
  })

  it('counters stay exact under concurrency — no lost update', async () => {
    // JS is single-threaded, so `succeeded++` between awaits cannot interleave mid-op.
    await seed('count', 100)
    providerFailOn = new Set([rid(3), rid(17), rid(44)])
    await runToCompletion('count', 4)
    const j = job('count')
    expect(j.counts.succeeded + j.counts.failed).toBe(100)
    expect(j.counts.failed).toBe(3)
  })

  it('the REAL processItem contains no wallet debit — concurrency cannot double-charge', () => {
    // Asserted against the shipped source, not the harness: a counter in a double that
    // never increments proves nothing about production.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = (require('node:fs') as typeof import('node:fs')).readFileSync('lib/broadcasts/whatsappJob.ts', 'utf8')
    const item = src.slice(src.indexOf('async processItem('), src.indexOf('// Terminal (completed)'))
    // Comment lines stripped first: processItem legitimately EXPLAINS that billing happens
    // upfront via chargeAndStartCampaign, and a naive substring match reads that prose as a
    // call. What matters is that no debit is INVOKED here.
    const code = item.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    for (const forbidden of ['chargeAndStartCampaign(', 'organizerWallets', 'FieldValue.increment']) {
      expect(code, forbidden).not.toContain(forbidden)
    }
    // The campaign is charged ONCE, upfront, outside the per-item path.
    expect(src).toContain('Billing is charged UPFRONT')
  })

  it('the shipped configuration uses the audited concurrency', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = (require('node:fs') as typeof import('node:fs')).readFileSync('lib/broadcasts/whatsappJob.ts', 'utf8')
    expect(src).toContain('const WAB_CONCURRENCY = 3')
    expect(src).toContain('concurrency: WAB_CONCURRENCY')
    // Page size unchanged — the pool runs inside a page, so raising one without the
    // other is what makes 4 pointless.
    expect(src).toContain('const WAB_PAGE_SIZE = 5')
    expect(src).toContain('const WAB_BUDGET_MS = 45_000')
    expect(src).toContain('const WAB_LEASE_MS  = 60_000')
  })

  it('a provider failure is counted, not retried into a duplicate', async () => {
    await seed('fail', 20)
    providerFailOn = new Set([rid(5)])
    await runToCompletion('fail', 3)
    expect(job('fail').counts.failed).toBe(1)
    expect(sends.filter(s => s === rid(5))).toHaveLength(1)
  })

  it('a marker-write failure still counts SENT and does not re-queue', async () => {
    await seed('marker', 20)
    markerFailOn = new Set([rid(7)])
    await drive('marker', 3)
    expect(job('marker').counts.failed).toBe(0)
    expect(store.get(`${COL}/marker/recipients/${rid(7)}`)!.sent).toBe(false)   // at-least-once, documented
  })

  it('cancellation stops the job under concurrency', async () => {
    await seed('cancel', 200)
    await drive('cancel', 4)
    store.get(`${COL}/cancel`)!.status = 'cancelled'
    const before = sends.length
    const r = await drive('cancel', 4)
    expect(r.reason).toBe('cancelled')
    expect(sends).toHaveLength(before)
  })

  it('lease fencing is unaffected by concurrency', async () => {
    await seed('lease', 50)
    await leaseJob(COL, 'lease', 60_000)
    const r = await drive('lease', 4)
    expect(r.reason).toBe('busy')
    expect(sends).toHaveLength(0)
  })

  it('a completed job is never reprocessed', async () => {
    await seed('done', 10)
    await runToCompletion('done', 4)
    const before = sends.length
    const r = await drive('done', 4)
    expect(r.reason).toBe('completed')
    expect(sends).toHaveLength(before)
  })
})

// ─── 14 + 15. Existing campaigns unchanged ───────────────────────────────────

describe('existing small campaigns behave exactly as before', () => {
  it('a 1-recipient campaign completes in ONE chunk', async () => {
    await seed('one', 1)
    const r = await drive('one', 3)
    expect(r.done).toBe(true)
    expect(job('one').status).toBe('completed')
    expect(sends).toEqual([rid(0)])
  })

  it('a small campaign yields the same result at every concurrency', async () => {
    const results: number[] = []
    for (const c of [1, 2, 3, 4]) {
      store.clear(); sends = []; now = 1_000_000
      await seed(`small${c}`, 12)
      await runToCompletion(`small${c}`, c)
      expect(job(`small${c}`).counts.succeeded).toBe(12)
      results.push(new Set(sends).size)
    }
    expect(results).toEqual([12, 12, 12, 12])
  })
})

// ─── 10. Continuation still applies ──────────────────────────────────────────

describe('continuation is unchanged by concurrency', () => {
  it('a chunk that fills its budget still yields non-terminal', async () => {
    await seed('cont', 1472)
    const r = await drive('cont', 3)
    expect(r.done).toBe(false)
    expect(r.status).toBe('processing')
    expect(r.processed).toBeLessThan(1472)          // still needs the next invocation
  })

  it('the job resumes from the cursor on the next invocation', async () => {
    await seed('cont2', 1472)
    const a = await drive('cont2', 3)
    now += 61_000
    const b = await drive('cont2', 3)
    expect(job('cont2').counts.processed).toBe(a.processed + b.processed)
    expect(new Set(sends).size).toBe(sends.length)
  })
})
