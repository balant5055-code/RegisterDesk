// RD-JOB-CONT-01 · a broadcast larger than one worker budget must finish by itself.
//
// THE INCIDENT. A 218-recipient email campaign sent 54 in its first 45-second chunk, yielded
// correctly, and then stopped forever. Nothing came back for chunk two: the browser poll is
// read-only, the send request drives only the first chunk, and the 5-minute cron advances a
// job by at most ONE chunk per tick — while that cron's own schedule is serialised and
// delayed. The campaign sat at 54/218 for half an hour and was cancelled by hand.
//
// These tests drive the REAL runner and the REAL kernel against an in-memory Firestore, so
// leasing, fencing, cursor advancement and the `sent` guard are exercised rather than
// mocked. The point is not that the pieces exist — it is that 218 recipients actually
// arrive at 218/218 without anyone clicking anything.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── In-memory Firestore ──────────────────────────────────────────────────────
// Enough surface for lib/jobs/kernel (doc get/set/update, runTransaction) and for a
// cursor-paged recipients subcollection (orderBy(documentId) + startAfter + limit).

interface Doc { [k: string]: unknown }
const store = new Map<string, Doc>()          // path -> data

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

const resolveWrites = (target: Doc, patch: Doc) => {
  for (const [k, v] of Object.entries(patch)) {
    if (v === SERVER_TS) { setPath(target, k, new FakeTimestamp(Date.now())); continue }
    if (v instanceof FakeIncrement) {
      setPath(target, k, ((getPath(target, k) as number) ?? 0) + v.n); continue
    }
    setPath(target, k, v)
  }
}
// Dotted-path writes ('counts.processed') must not create a literal dotted key.
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

const snap = (path: string) => ({
  exists: store.has(path),
  id:     path.split('/').pop()!,
  // No structuredClone: documents legitimately hold sentinels (serverTimestamp) that
  // clone cannot copy. The double hands back the live object, which is fine in-process.
  data:   () => store.get(path),
})

function makeQuery(prefix: string) {
  const filters: Array<(d: Doc) => boolean> = []
  let startAfterId: string | null = null
  let lim = Infinity
  const q = {
    where(field: string, op: string, value: unknown) {
      filters.push(d => {
        const v = getPath(d, field)
        if (op === '==') return v === value
        if (op === 'in')  return Array.isArray(value) && (value as unknown[]).includes(v)
        return true
      })
      return q
    },
    orderBy() { return q },
    startAfter(v: unknown) { startAfterId = String(v); return q },
    limit(n: number) { lim = n; return q },
    select() { return q },
    async get() {
      let ids = [...store.keys()]
        .filter(k => k.startsWith(prefix) && k.slice(prefix.length).indexOf('/') === -1)
        .map(k => k.slice(prefix.length))
        .sort()
      if (startAfterId) ids = ids.filter(id => id > startAfterId!)
      const docs = ids
        .map(id => ({ id, path: prefix + id }))
        .filter(({ path }) => filters.every(f => f(store.get(path)!)))
        .slice(0, lim)
        .map(({ id, path }) => ({ id, data: () => store.get(path)! }))
      return { size: docs.length, docs, empty: docs.length === 0 }
    },
  }
  return q
}

const docRef = (path: string) => ({
  get: async () => snap(path),
  set: async (d: Doc) => { const target: Doc = {}; resolveWrites(target, d); store.set(path, target) },
  update: async (patch: Doc) => {
    if (!store.has(path)) throw new Error('no doc ' + path)
    resolveWrites(store.get(path)!, patch)
  },
  collection: (name: string) => collRef(`${path}/${name}/`),
})

const collRef = (prefix: string) => ({
  doc: (id: string) => docRef(prefix + id),
  ...makeQuery(prefix),
})

const adminDbMock = {
  collection: (name: string) => collRef(`${name}/`),
  doc: (p: string) => docRef(p),
  batch: () => {
    const ops: Array<() => void> = []
    return {
      set: (ref: { __path: string }, d: Doc) => { ops.push(() => { const t: Doc = {}; resolveWrites(t, d); store.set(ref.__path, t) }) },
      commit: async () => ops.forEach(o => o()),
    }
  },
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const tx = {
      get:    async (ref: { get: () => Promise<unknown> }) => ref.get(),
      update: (ref: { update: (p: Doc) => Promise<void> }, patch: Doc) => { void ref.update(patch) },
      set:    () => {},
      delete: () => {},
    }
    return fn(tx)
  },
}

vi.mock('firebase-admin/firestore', () => ({
  Timestamp:  FakeTimestamp,
  FieldPath:  { documentId: () => '__name__' },
  FieldValue: {
    serverTimestamp: () => SERVER_TS,
    increment: (n: number) => new FakeIncrement(n),
    delete: () => '__DELETED__',
  },
}))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: adminDbMock, adminAuth: {} }))

const { leaseJob, createJob, failJob, listActiveJobs } = await import('@/lib/jobs/kernel')
const { runJobChunk } = await import('@/lib/jobs/runner')
const {
  shouldChain, readChainDepth, MAX_CHAIN_DEPTH, CHAIN_DEPTH_HEADER,
} = await import('@/lib/jobs/continuation')
// Hoisted deliberately: importing this route lazily inside a test loads a cold module
// graph and can blow the default 5s timeout — a flake, not a real failure.
const { STALE_AFTER_MS, HARD_STALE_AFTER_MS } = await import('@/app/api/cron/job-reaper/route')

// ─── A broadcast-shaped strategy over the real runner ────────────────────────

const COL = 'emailBroadcastJobs'
const rid = (i: number) => `r${String(i).padStart(7, '0')}`

/** Every send attempt, in order — the duplicate detector. */
let sends: string[] = []
let msPerItem = 10
let failOn: Set<string> = new Set()
let throwOn: Set<string> = new Set()
/** Recipients whose `sent: true` write fails AFTER the provider already accepted. */
let markerFailOn: Set<string> = new Set()
let now = 1_000_000

const nowSpy = () => vi.spyOn(Date, 'now').mockImplementation(() => now)

async function seedJob(jobId: string, total: number) {
  await createJob(COL, jobId, { organizerUid: 'u1', campaignId: 'c1' }, total)
  for (let i = 0; i < total; i++) {
    store.set(`${COL}/${jobId}/recipients/${rid(i)}`, { email: `a${i}@x.com`, sent: false })
  }
}

/** Mirrors emailJob's strategy: cursor-paged recipients, skip `sent`, mark sent AFTER send. */
const strategy = (jobId: string) => ({
  async loadContext() { return { ok: true as const, ctx: {} } },
  async fetchPage(_j: unknown, _c: unknown, cursor: string | null, limit: number) {
    const q = collRef(`${COL}/${jobId}/recipients/`)
    let qq = q.orderBy()
    if (cursor) qq = qq.startAfter(cursor)
    const s = await qq.limit(limit).get()
    return {
      items: s.docs.map(d => ({ ...(d.data() as Doc), __id: d.id })),
      nextCursor: s.docs.length ? s.docs[s.docs.length - 1].id : cursor,
      hasMore: s.size === limit,
    }
  },
  async processItem(item: Doc & { __id: string }) {
    if (item.sent === true) return { ok: true }              // the idempotency guard
    if (throwOn.has(item.__id)) throw new Error('boom ' + item.__id)
    now += msPerItem                                          // consume the budget
    sends.push(item.__id)
    if (failOn.has(item.__id)) return { ok: false, error: 'provider said no' }
    // AWAITED and GUARDED, mirroring emailJob/whatsappJob exactly: the provider has
    // already accepted at this point, so a marker-write failure must NOT flip the item to
    // failed (that would re-queue it and guarantee the duplicate).
    try {
      if (markerFailOn.has(item.__id)) throw new Error('FirestoreError: UNAVAILABLE')
      await docRef(`${COL}/${jobId}/recipients/${item.__id}`).update({ sent: true })
    } catch { /* logged in production */ }
    return { ok: true }
  },
})

const CONFIG = { collection: COL, pageSize: 2, budgetMs: 45_000, leaseMs: 60_000 }

const drive = (jobId: string) => runJobChunk(jobId, strategy(jobId) as never, CONFIG)
const job   = (jobId: string) => store.get(`${COL}/${jobId}`) as Doc & { counts: Record<string, number> }

beforeEach(() => {
  store.clear(); sends = []; failOn = new Set(); throwOn = new Set(); markerFailOn = new Set(); msPerItem = 10; now = 1_000_000
  vi.restoreAllMocks(); nowSpy()
})

// ─── The incident, reproduced and fixed ──────────────────────────────────────

describe('218 recipients across multiple chunks', () => {
  it('the FIRST chunk yields at the budget instead of finishing', async () => {
    await seedJob('j1', 218)
    msPerItem = 814                                  // the measured production pace
    const r = await drive('j1')

    expect(r.done).toBe(false)
    expect(r.status).toBe('processing')
    expect(r.processed).toBeGreaterThan(0)
    expect(r.processed).toBeLessThan(218)            // this is the stall the incident began with
    expect(job('j1').cursor).toBe(rid(r.processed - 1))
  })

  it('a SECOND chunk resumes from the cursor and sends nobody twice', async () => {
    await seedJob('j2', 218)
    msPerItem = 814
    const first = await drive('j2')
    now += 61_000                                    // lease expires
    const second = await drive('j2')

    expect(second.processed).toBeGreaterThan(0)
    expect(job('j2').counts.processed).toBe(first.processed + second.processed)
    expect(new Set(sends).size).toBe(sends.length)   // no repeats
  })

  it('repeated chunks carry all 218 to completion — the whole point', async () => {
    await seedJob('j3', 218)
    msPerItem = 814
    let guard = 0
    for (;;) {
      const r = await drive('j3')
      if (r.done || ++guard > 20) break
      now += 61_000
    }
    const j = job('j3')
    expect(j.status).toBe('completed')
    expect(j.counts.processed).toBe(218)
    expect(j.counts.succeeded).toBe(218)
    expect(sends).toHaveLength(218)
    expect(new Set(sends).size).toBe(218)            // 218 distinct recipients, once each
  })

  it('a single-chunk job still completes in ONE pass — no regression for 1/1', async () => {
    // Every prior campaign was 1/1 and finished inside the send request. That must not change.
    await seedJob('j4', 1)
    const r = await drive('j4')
    expect(r.done).toBe(true)
    expect(job('j4').status).toBe('completed')
    expect(sends).toEqual([rid(0)])
  })
})

// ─── Leases ───────────────────────────────────────────────────────────────────

describe('lease behaviour is unchanged', () => {
  it('a held lease returns busy and does no work', async () => {
    await seedJob('j5', 10)
    await leaseJob(COL, 'j5', 60_000)                // someone else holds it
    const r = await drive('j5')
    expect(r.reason).toBe('busy')
    expect(r.processed).toBe(0)
    expect(sends).toHaveLength(0)
  })

  it('an EXPIRED lease lets another worker resume', async () => {
    await seedJob('j6', 10)
    await leaseJob(COL, 'j6', 60_000)
    now += 61_000
    const r = await drive('j6')
    expect(r.reason).toBeUndefined()
    expect(r.processed).toBeGreaterThan(0)
  })

  it('a cancelled job is never resumed', async () => {
    await seedJob('j7', 10)
    await drive('j7')
    store.get(`${COL}/j7`)!.status = 'cancelled'
    const before = sends.length
    const r = await drive('j7')
    expect(r.reason).toBe('cancelled')
    expect(sends).toHaveLength(before)
  })

  it('a completed job is never reprocessed', async () => {
    await seedJob('j8', 2)
    await drive('j8')
    expect(job('j8').status).toBe('completed')
    const before = sends.length
    const r = await drive('j8')
    expect(r.reason).toBe('completed')
    expect(sends).toHaveLength(before)
  })
})

// ─── Duplicate protection ─────────────────────────────────────────────────────

describe('a recipient is never sent twice', () => {
  it('already-sent rows are skipped on resume', async () => {
    await seedJob('j9', 6)
    msPerItem = 30_000                               // force a yield after 2
    await drive('j9')
    now += 61_000
    await drive('j9')
    now += 61_000
    await drive('j9')
    expect(new Set(sends).size).toBe(sends.length)
  })

  it('re-driving from an UNCHANGED cursor still cannot duplicate', async () => {
    // Simulates a fenced commit: cursor rolled back, page re-processed.
    await seedJob('j10', 4)
    await drive('j10')
    store.get(`${COL}/j10`)!.cursor = null           // pretend the commit was rejected
    store.get(`${COL}/j10`)!.status = 'processing'
    store.get(`${COL}/j10`)!.lockedUntil = null
    const before = [...sends]
    await drive('j10')
    // Rows already flagged `sent` are skipped, so nothing in `before` is repeated.
    for (const id of before) expect(sends.filter(s => s === id)).toHaveLength(1)
  })

  it('a per-item failure is counted, not retried into a duplicate', async () => {
    await seedJob('j11', 4)
    failOn = new Set([rid(1)])
    let guard = 0
    for (;;) { const r = await drive('j11'); if (r.done || ++guard > 10) break; now += 61_000 }
    expect(job('j11').counts.failed).toBe(1)
    expect(job('j11').counts.succeeded).toBe(3)
  })
})

// ─── Exceptions must not strand a job ────────────────────────────────────────

describe('a worker exception does not permanently strand the job', () => {
  it('the throw propagates and the job stays resumable — not silently finished', async () => {
    await seedJob('j12', 6)
    msPerItem = 30_000                                // yield after page 1 (2 items)
    throwOn = new Set([rid(2)])
    await drive('j12')                                // page 1 commits
    now += 61_000
    await expect(drive('j12')).rejects.toThrow('boom')

    const j = job('j12')
    expect(j.status).toBe('processing')               // still claimable
    expect(j.counts.processed).toBe(2)

    throwOn = new Set()
    now += 61_000
    let guard = 0
    for (;;) { const r = await drive('j12'); if (r.done || ++guard > 10) break; now += 61_000 }
    expect(job('j12').status).toBe('completed')       // the reaper's job, proven recoverable
  })
})

// ─── The chain decision ───────────────────────────────────────────────────────

describe('continuation chain', () => {
  const hdr = (v?: string) => ({ get: (n: string) => (n === CHAIN_DEPTH_HEADER && v !== undefined ? v : null) })

  it('chains after real progress on an unfinished job', () => {
    expect(shouldChain({ advanced: 54, nonTerminal: 1, depth: 0 })).toBe('dispatched')
  })

  it('does NOT chain when nothing advanced — a spin loop is the failure mode to avoid', () => {
    expect(shouldChain({ advanced: 0, nonTerminal: 1, depth: 0 })).toBe('skipped_no_progress')
  })

  it('does NOT chain when every job is finished', () => {
    expect(shouldChain({ advanced: 54, nonTerminal: 0, depth: 0 })).toBe('skipped_terminal')
  })

  it('stops at the depth cap', () => {
    expect(shouldChain({ advanced: 54, nonTerminal: 1, depth: MAX_CHAIN_DEPTH })).toBe('skipped_max_depth')
    expect(shouldChain({ advanced: 54, nonTerminal: 1, depth: MAX_CHAIN_DEPTH - 1 })).toBe('dispatched')
  })

  it('reads and sanitises the depth header', () => {
    expect(readChainDepth(hdr())).toBe(0)
    expect(readChainDepth(hdr('3'))).toBe(3)
    for (const bad of ['-1', 'abc', '999', '1.5', '']) expect(readChainDepth(hdr(bad)), bad).toBe(0)
  })
})

// ─── Reaper guards ────────────────────────────────────────────────────────────

describe('reaper thresholds protect healthy jobs', () => {
  it('a job that just moved is NOT stale', async () => {
    await seedJob('j13', 10)
    msPerItem = 30_000
    await drive('j13')
    const idle = now - (store.get(`${COL}/j13`)!.updatedAt as FakeTimestamp).toMillis()
    expect(idle).toBeLessThan(STALE_AFTER_MS)
  })

  it('the stale threshold sits well beyond one chunk + one lease + one tick', () => {
    expect(STALE_AFTER_MS).toBeGreaterThan(45_000 + 60_000 + 5 * 60_000)
    expect(HARD_STALE_AFTER_MS).toBeGreaterThan(STALE_AFTER_MS)
  })

  it('failJob records a diagnosable reason and frees the lease', async () => {
    await seedJob('j14', 10)
    await drive('j14')
    await failJob(COL, 'j14', 'Stalled at 2/10 (cursor r0000001). No progress for 31 minutes;')
    const j = job('j14')
    expect(j.status).toBe('failed')
    expect(String(j.error)).toContain('Stalled at 2/10')
    expect(j.lockedUntil).toBeNull()
  })

  it('listActiveJobs surfaces processing jobs so all three layers can see them', async () => {
    await seedJob('j15', 10)
    msPerItem = 30_000                                // ensure it yields, staying `processing`
    await drive('j15')
    expect(job('j15').status).toBe('processing')
    const active = await listActiveJobs(COL, 25)
    expect(active.map(j => j.jobId)).toContain('j15')
  })
})

// ─── The provider-success / marker-write-failure window ──────────────────────
//
// CHARACTERISATION, NOT AN ASPIRATION. These tests record what the system actually
// guarantees today so nobody can mistake it for exactly-once. Neither provider offers an
// idempotency key (SES and Resend take none; Meta has no dedup token), so between
// 'provider accepted' and '`sent: true` committed' there is a window with no protection
// at all. Awaiting the write shrank that window from ~always-open to a few milliseconds —
// it did not close it.
//
// If someone later adds a pre-send claim marker, THESE TESTS SHOULD FAIL and be rewritten
// deliberately. That is the point of pinning it.

describe('provider succeeded but the sent-marker write failed', () => {
  it('the item is still counted SENT — never re-queued as a failure', async () => {
    // Flipping it to failed would retry it within the SAME chunk run: a guaranteed
    // duplicate rather than a possible one.
    await seedJob('w1', 2)
    markerFailOn = new Set([rid(0)])
    await drive('w1')
    expect(job('w1').counts.succeeded).toBe(2)
    expect(job('w1').counts.failed).toBe(0)
  })

  it('the row stays sent:false — the durable record does NOT reflect the send', async () => {
    await seedJob('w2', 2)
    markerFailOn = new Set([rid(0)])
    await drive('w2')
    expect(store.get(`${COL}/w2/recipients/${rid(0)}`)!.sent).toBe(false)
    expect(store.get(`${COL}/w2/recipients/${rid(1)}`)!.sent).toBe(true)
  })

  it('AT-LEAST-ONCE: a resume that revisits that row sends it a SECOND time', async () => {
    // The honest statement of the guarantee. The cursor normally moves past the row, so
    // this needs a fenced/rolled-back commit to revisit it — rare, but real.
    await seedJob('w3', 2)
    markerFailOn = new Set([rid(0)])
    await drive('w3')
    expect(sends.filter(x => x === rid(0))).toHaveLength(1)

    store.get(`${COL}/w3`)!.cursor = null            // commit rejected by fencing
    store.get(`${COL}/w3`)!.status = 'processing'
    store.get(`${COL}/w3`)!.lockedUntil = null
    store.get(`${COL}/w3`)!.counts = { total: 2, processed: 0, succeeded: 0, failed: 0 }
    markerFailOn = new Set()
    await drive('w3')

    expect(sends.filter(x => x === rid(0))).toHaveLength(2)   // the duplicate, documented
    expect(sends.filter(x => x === rid(1))).toHaveLength(1)   // this one was marked, so skipped
  })

  it('a row whose marker DID commit is skipped on every later pass', async () => {
    // The protection that does work, and the reason the window is narrow rather than wide.
    await seedJob('w4', 2)
    await drive('w4')
    store.get(`${COL}/w4`)!.cursor = null
    store.get(`${COL}/w4`)!.status = 'processing'
    store.get(`${COL}/w4`)!.lockedUntil = null
    await drive('w4')
    expect(sends).toHaveLength(2)                     // two rows, once each
    expect(new Set(sends).size).toBe(2)
  })

  it('a genuine provider failure is distinguishable and IS retried', async () => {
    // processItem separates the two: provider-failed returns ok:false; marker-failed
    // returns ok:true. Only the former is a failure.
    await seedJob('w5', 1)
    failOn = new Set([rid(0)])
    await drive('w5')
    expect(job('w5').counts.failed).toBe(1)
    expect(job('w5').counts.succeeded).toBe(0)
  })
})
