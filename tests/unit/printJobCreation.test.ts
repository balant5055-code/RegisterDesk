// RD-PRINT-SCALE-IMPLEMENTATION-01 — bounded, resumable print-job creation.
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// `resolvePrintItems` read EVERY registration for the event with one unbounded
// `.get()`, filtered in memory, and handed back the whole set as an array. At 20,000
// registrations that is 20,000 documents materialised inside a single POST, followed by
// 50 sequential batch commits and a render chunk — all before the response is sent.
// Two further defects rode along: a selection over 5,000 was silently truncated by
// `ids.slice(0, 5000)` and still answered 201, and NO status predicate was applied, so
// cancelled and refunded registrations were issued working event credentials.
//
// ═══ HOW THESE TESTS WORK ════════════════════════════════════════════════════
// Against a RECORDING fake Firestore, not the source text. Every query, every batch and
// every commit is captured, so "the pass filter is pushed down", "explicit ids never
// scan" and "the walk is paginated" are assertions about what the code DID, not about
// what it looks like. The 20k behaviour is proven separately and for real in
// tests/emulator/printJobScale.emu.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Recording fake Firestore ───────────────────────────────────────────────────

interface RecordedQuery {
  path:    string
  wheres:  [string, string, unknown][]
  limit:   number | null
  startAfter: string | null
  ordered: boolean
}
interface RecordedCommit { ops: number }

const store   = new Map<string, Record<string, unknown>>()
const queries: RecordedQuery[]  = []
const commits: RecordedCommit[] = []
let getAllCalls: string[][] = []

const parentPath = (p: string) => p.slice(0, p.lastIndexOf('/'))
const docId      = (p: string) => p.slice(p.lastIndexOf('/') + 1)

class FakeQuery {
  constructor(
    readonly path: string,
    readonly wheres: [string, string, unknown][] = [],
    readonly ordered = false,
    readonly after: string | null = null,
    readonly lim: number | null = null,
  ) {}
  where(f: string, op: string, v: unknown) { return new FakeQuery(this.path, [...this.wheres, [f, op, v]], this.ordered, this.after, this.lim) }
  orderBy()             { return new FakeQuery(this.path, this.wheres, true, this.after, this.lim) }
  startAfter(c: string)  { return new FakeQuery(this.path, this.wheres, this.ordered, c, this.lim) }
  limit(n: number)       { return new FakeQuery(this.path, this.wheres, this.ordered, this.after, n) }
  select()               { return this }
  async get() {
    queries.push({ path: this.path, wheres: this.wheres, limit: this.lim, startAfter: this.after, ordered: this.ordered })
    let rows = [...store.entries()]
      .filter(([p]) => parentPath(p) === this.path)
      .map(([p, data]) => ({ id: docId(p), data }))
      .filter(({ data }) => this.wheres.every(([f, , v]) => data[f] === v))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (this.after) rows = rows.filter(r => r.id > this.after!)
    if (this.lim !== null) rows = rows.slice(0, this.lim)
    return {
      empty: rows.length === 0,
      size:  rows.length,
      docs:  rows.map(r => ({ id: r.id, exists: true, data: () => r.data })),
    }
  }
}

class FakeDoc {
  constructor(readonly path: string) {}
  get id() { return docId(this.path) }
  collection(sub: string) { return new FakeCollection(`${this.path}/${sub}`) }
  async set(data: Record<string, unknown>) { store.set(this.path, { ...data }) }
  async update(data: Record<string, unknown>) { store.set(this.path, { ...(store.get(this.path) ?? {}), ...data }) }
  async get() { const d = store.get(this.path); return { exists: !!d, id: this.id, data: () => d } }
}

class FakeCollection extends FakeQuery {
  constructor(path: string) { super(path) }
  doc(id: string) { return new FakeDoc(`${this.path}/${id}`) }
}

const adminDb = {
  collection: (p: string) => new FakeCollection(p),
  doc:        (p: string) => new FakeDoc(p),
  batch() {
    const ops: [string, Record<string, unknown>][] = []
    return {
      set(ref: FakeDoc, data: Record<string, unknown>) { ops.push([ref.path, data]) },
      update(ref: FakeDoc, data: Record<string, unknown>) { ops.push([ref.path, data]) },
      async commit() {
        commits.push({ ops: ops.length })
        for (const [p, d] of ops) store.set(p, { ...(store.get(p) ?? {}), ...d })
      },
    }
  },
  async getAll(...refs: FakeDoc[]) {
    getAllCalls.push(refs.map(r => r.id))
    return refs.map(r => ({ id: r.id, exists: store.has(r.path), data: () => store.get(r.path) }))
  },
}

vi.mock('@/lib/firebase/admin', () => ({ adminDb }))
// The renderer is never exercised here — creation is the subject.
vi.mock('@/lib/printAssets/render', () => ({
  normalizeDesign: (d: unknown) => d, validateRenderDocument: () => ({ ok: true }),
  renderToPdf: async () => new Uint8Array(), RenderError: class extends Error {},
  buildVariableMap: () => ({}), collectImageSources: () => [], ensurePrintAssets: () => ({}),
}))
vi.mock('@/lib/firebase/storage/admin', () => ({ uploadServerFile: async () => ({ url: '', path: '' }) }))
vi.mock('@/lib/notifications/inbox/notify', () => ({ notifyPrintJobComplete: async () => {} }))
// RD-PRINT-P1 — job creation pins the template's current version (a Firestore transaction,
// covered on the real emulator by printTemplateVersioning.emu.test.ts). This fake store has
// no transactions, so the pin is stubbed; job SELECTION is what this file tests.
vi.mock('@/lib/printAssets/versions', () => ({
  ensureCurrentVersion: async () => ({ version: 1, hash: 'h1', created: false }),
  getTemplateVersion:   async () => null,
}))
vi.mock('@/lib/branding/service', () => ({ resolvePublicBranding: async () => null }))

const REGS = 'registrations'
const UID  = 'org-1'
const SLUG = 'my-event'

type RegSeed = Partial<Record<string, unknown>>
const reg = (id: string, over: RegSeed = {}) => {
  store.set(`${REGS}/${id}`, {
    organizerUid: UID, eventSlug: SLUG, status: 'confirmed', paymentStatus: 'paid',
    eventName: 'My Event', ticketCode: `TC-${id}`, passId: 'pass-a', passName: 'General',
    bibCategory: '10K', passType: 'Runner', attendee: { name: `N-${id}`, email: '', phone: '', formResponses: {} },
    ...over,
  })
}

const resetAll = () => { store.clear(); queries.length = 0; commits.length = 0; getAllCalls = [] }

/** Queries this run made against the registrations collection. */
const regQueries = () => queries.filter(q => q.path === REGS)
/** Item docs seeded under a job. */
const seededIds = (jobId: string) => [...store.keys()]
  .filter(k => k.startsWith(`printGenerationJobs/${jobId}/items/`))
  .map(k => docId(k)).sort()

// ─── The predicate ───────────────────────────────────────────────────────────────

describe('RD-PRINT-SCALE-01 · who may be issued a printed credential', () => {
  it('1 · a confirmed, paid registration is included', async () => {
    const { printCredentialBlockReason } = await import('@/lib/printAssets/generationJob')
    expect(printCredentialBlockReason({ status: 'confirmed', paymentStatus: 'paid' })).toBeNull()
  })

  it('2 · confirmed with no payment required, pending or refund_pending is still included', async () => {
    const { printCredentialBlockReason } = await import('@/lib/printAssets/generationJob')
    // refund_pending is NOT refunded — the money has not gone back, and the gate still
    // admits them. Excluding it here would strand people at the door with no badge.
    for (const paymentStatus of ['not_required', 'pending', 'refund_pending']) {
      expect(printCredentialBlockReason({ status: 'confirmed', paymentStatus })).toBeNull()
    }
  })

  it('3 · cancelled, rejected, pending and waitlisted are excluded', async () => {
    const { printCredentialBlockReason } = await import('@/lib/printAssets/generationJob')
    for (const status of ['cancelled', 'rejected', 'pending', 'waitlisted']) {
      expect(printCredentialBlockReason({ status, paymentStatus: 'paid' })).toBe('NOT_ON_ROSTER')
    }
  })

  it('4 · a confirmed registration whose payment was refunded is excluded', async () => {
    const { printCredentialBlockReason } = await import('@/lib/printAssets/generationJob')
    expect(printCredentialBlockReason({ status: 'confirmed', paymentStatus: 'refunded' })).toBe('REFUNDED')
  })

  it('5 · an unknown, missing or non-string status fails CLOSED', async () => {
    const { printCredentialBlockReason } = await import('@/lib/printAssets/generationJob')
    for (const status of ['archived', '', undefined, null, 42, {}]) {
      expect(printCredentialBlockReason({ status, paymentStatus: 'paid' })).toBe('NOT_ON_ROSTER')
    }
  })

  it('6 · everyone this job prints for is someone check-in would admit', async () => {
    // The invariant that makes the rule defensible: a printed card is a credential, and
    // a credential the gate refuses is worse than no credential. Print must stay a
    // SUBSET of admission — asserted here across the whole status × payment matrix so
    // the two rules cannot drift apart silently.
    const { printCredentialBlockReason } = await import('@/lib/printAssets/generationJob')
    const { checkInBlockReason } = await import('@/lib/registrations/checkinEligibility')
    const statuses = ['confirmed', 'cancelled', 'waitlisted', 'pending', 'rejected', 'weird']
    const payments = ['not_required', 'pending', 'paid', 'refund_pending', 'refunded']
    for (const status of statuses) {
      for (const paymentStatus of payments) {
        if (printCredentialBlockReason({ status, paymentStatus }) === null) {
          expect(checkInBlockReason({ status, paymentStatus }), `${status}/${paymentStatus}`).toBeNull()
        }
      }
    }
  })
})

// ─── Filter semantics ────────────────────────────────────────────────────────────

describe('RD-PRINT-SCALE-01 · filter semantics are unchanged', () => {
  it('7 · category matches ANY of bibCategory, passType or passName', async () => {
    const { matchesPrintFilters } = await import('@/lib/printAssets/generationJob')
    const f = { category: 'Elite' }
    expect(matchesPrintFilters({ bibCategory: 'Elite', passType: 'x', passName: 'y' }, f)).toBe(true)
    expect(matchesPrintFilters({ bibCategory: 'x', passType: 'Elite', passName: 'y' }, f)).toBe(true)
    expect(matchesPrintFilters({ bibCategory: 'x', passType: 'y', passName: 'Elite' }, f)).toBe(true)
    expect(matchesPrintFilters({ bibCategory: 'x', passType: 'y', passName: 'z' }, f)).toBe(false)
  })

  it('8 · pass is an equality on passId, and no filter means everyone', async () => {
    const { matchesPrintFilters } = await import('@/lib/printAssets/generationJob')
    expect(matchesPrintFilters({ passId: 'p1' }, { pass: 'p1' })).toBe(true)
    expect(matchesPrintFilters({ passId: 'p2' }, { pass: 'p1' })).toBe(false)
    expect(matchesPrintFilters({ passId: 'p2' }, {})).toBe(true)
  })

  it('9 · pass and category are ANDed', async () => {
    const { matchesPrintFilters } = await import('@/lib/printAssets/generationJob')
    const f = { pass: 'p1', category: 'Elite' }
    expect(matchesPrintFilters({ passId: 'p1', bibCategory: 'Elite' }, f)).toBe(true)
    expect(matchesPrintFilters({ passId: 'p1', bibCategory: '10K' }, f)).toBe(false)
    expect(matchesPrintFilters({ passId: 'p9', bibCategory: 'Elite' }, f)).toBe(false)
  })
})

// ─── Seeding behaviour ───────────────────────────────────────────────────────────

describe('RD-PRINT-SCALE-01 · job creation is bounded', () => {
  beforeEach(resetAll)

  const create = async (filters: Record<string, unknown> = {}) => {
    const { createPrintGenerationJob } = await import('@/lib/printAssets/generationJob')
    return createPrintGenerationJob({
      templateId: 't1', eventId: 'draft-1', eventSlug: SLUG, assetType: 'badge',
      filters, organizerUid: UID, createdBy: UID,
    } as never)
  }

  it('10 · the whole-event scan is paginated — every read carries a limit', async () => {
    for (let i = 0; i < 950; i++) reg(`r${String(i).padStart(4, '0')}`)
    const job = await create()

    expect(seededIds(job.jobId)).toHaveLength(950)
    // The defect was a single unbounded .get(). Not one read may be unbounded.
    expect(regQueries().length).toBeGreaterThan(1)
    for (const q of regQueries()) expect(q.limit).toBe(400)
    expect(regQueries().every(q => q.ordered)).toBe(true)
  })

  it('11 · the cursor advances, so pages never repeat and nothing is skipped', async () => {
    for (let i = 0; i < 950; i++) reg(`r${String(i).padStart(4, '0')}`)
    const job = await create()

    const cursors = regQueries().map(q => q.startAfter)
    expect(cursors[0]).toBeNull()
    // Strictly increasing after the first page.
    const rest = cursors.slice(1) as string[]
    expect(rest).toHaveLength(2)
    expect(rest[0] < rest[1]).toBe(true)
    // Every registration became exactly one item — no gaps, no duplicates.
    expect(new Set(seededIds(job.jobId)).size).toBe(950)
  })

  it('12 · commits stay inside the Firestore batch limit', async () => {
    for (let i = 0; i < 950; i++) reg(`r${String(i).padStart(4, '0')}`)
    await create()
    expect(commits.length).toBeGreaterThan(1)
    for (const c of commits) expect(c.ops).toBeLessThanOrEqual(400)
  })

  it('13 · the pass filter is pushed into Firestore', async () => {
    reg('a', { passId: 'p1' }); reg('b', { passId: 'p2' })
    const job = await create({ pass: 'p1' })
    expect(regQueries()[0].wheres).toContainEqual(['passId', '==', 'p1'])
    expect(seededIds(job.jobId)).toEqual(['a'])
  })

  it('14 · the status filter is pushed into Firestore', async () => {
    const job = await create()
    expect(regQueries()[0].wheres).toContainEqual(['status', '==', 'confirmed'])
    expect(job.counts.total).toBe(0)
  })

  it('15 · category is NOT pushed down — a three-field OR is not one equality', async () => {
    reg('a', { bibCategory: 'Elite', passType: 'x', passName: 'y' })
    reg('b', { bibCategory: 'x', passType: 'Elite', passName: 'y' })
    reg('c', { bibCategory: 'x', passType: 'y', passName: 'z' })
    const job = await create({ category: 'Elite' })
    for (const q of regQueries()) {
      expect(q.wheres.map(w => w[0])).not.toContain('category')
      expect(q.wheres.map(w => w[0])).not.toContain('bibCategory')
    }
    expect(seededIds(job.jobId)).toEqual(['a', 'b'])
  })

  it('16 · a page filtered down to nothing still advances the walk', async () => {
    // 400 non-matching rows sort first, so page 1 yields zero seeds. If the cursor
    // moved on the last KEPT row instead of the last FETCHED row this loops for ever.
    for (let i = 0; i < 400; i++) reg(`a${String(i).padStart(4, '0')}`, { passId: 'other' })
    for (let i = 0; i < 5;   i++) reg(`z${i}`, { passId: 'wanted' })
    const job = await create({ category: 'nope-nothing-matches-this' })
    expect(seededIds(job.jobId)).toHaveLength(0)
    expect(regQueries().length).toBeGreaterThanOrEqual(2)
  })
})

describe('RD-PRINT-SCALE-01 · an explicit selection never scans', () => {
  beforeEach(resetAll)

  const create = async (filters: Record<string, unknown>) => {
    const { createPrintGenerationJob } = await import('@/lib/printAssets/generationJob')
    return createPrintGenerationJob({
      templateId: 't1', eventId: 'draft-1', eventSlug: SLUG, assetType: 'badge',
      filters, organizerUid: UID, createdBy: UID,
    } as never)
  }

  it('17 · explicit ids are fetched by document id, not by scanning the collection', async () => {
    for (let i = 0; i < 500; i++) reg(`r${String(i).padStart(4, '0')}`)
    const job = await create({ registrationIds: ['r0001', 'r0002'] })

    expect(regQueries()).toHaveLength(0)        // the collection is never queried
    expect(getAllCalls).toHaveLength(1)
    expect(getAllCalls[0]).toEqual(['r0001', 'r0002'])
    expect(seededIds(job.jobId)).toEqual(['r0001', 'r0002'])
  })

  it('18 · a large selection is chunked, not fanned out in one call', async () => {
    const ids: string[] = []
    for (let i = 0; i < 700; i++) { const id = `r${String(i).padStart(4, '0')}`; reg(id); ids.push(id) }
    const job = await create({ registrationIds: ids })
    expect(getAllCalls.length).toBeGreaterThan(1)
    for (const c of getAllCalls) expect(c.length).toBeLessThanOrEqual(300)
    expect(seededIds(job.jobId)).toHaveLength(700)
  })

  it('19 · another organizer\'s registration id is dropped, not printed', async () => {
    reg('mine'); reg('theirs', { organizerUid: 'org-2' })
    const job = await create({ registrationIds: ['mine', 'theirs'] })
    expect(seededIds(job.jobId)).toEqual(['mine'])
  })

  it('20 · another event\'s registration id is dropped, not printed', async () => {
    reg('mine'); reg('other-event', { eventSlug: 'a-different-event' })
    const job = await create({ registrationIds: ['mine', 'other-event'] })
    expect(seededIds(job.jobId)).toEqual(['mine'])
  })

  it('21 · a non-existent id is skipped without failing the job', async () => {
    reg('mine')
    const job = await create({ registrationIds: ['mine', 'ghost'] })
    expect(seededIds(job.jobId)).toEqual(['mine'])
    expect(job.counts.total).toBe(1)
  })

  it('22 · status still applies to an explicit selection', async () => {
    // The selection UI can hold a row that was cancelled after it was ticked.
    reg('ok'); reg('gone', { status: 'cancelled' }); reg('refunded', { paymentStatus: 'refunded' })
    const job = await create({ registrationIds: ['ok', 'gone', 'refunded'] })
    expect(seededIds(job.jobId)).toEqual(['ok'])
  })

  it('23 · pass and category still apply to an explicit selection', async () => {
    reg('a', { passId: 'p1' }); reg('b', { passId: 'p2' })
    const job = await create({ registrationIds: ['a', 'b'], pass: 'p1' })
    expect(seededIds(job.jobId)).toEqual(['a'])
  })
})

describe('RD-PRINT-SCALE-01 · the job document', () => {
  beforeEach(resetAll)

  it('24 · total counts the ELIGIBLE registrations, not everyone read', async () => {
    const { createPrintGenerationJob } = await import('@/lib/printAssets/generationJob')
    for (let i = 0; i < 10; i++) reg(`r${i}`)
    reg('c1', { status: 'cancelled' }); reg('c2', { paymentStatus: 'refunded' })
    const job = await createPrintGenerationJob({
      templateId: 't1', eventId: 'draft-1', eventSlug: SLUG, assetType: 'badge',
      filters: {}, organizerUid: UID, createdBy: UID,
    } as never)
    expect(job.counts.total).toBe(10)
    expect(job.counts.processed).toBe(0)
    expect(job.status).toBe('pending')
    expect(job.eventName).toBe('My Event')
  })

  it('25 · items are seeded BEFORE the job doc exists, so no driver sees a partial total', async () => {
    // The cron scans listActiveJobs; a job doc that appears while its item count is
    // still climbing would be driven against an incomplete roster.
    for (let i = 0; i < 5; i++) reg(`r${i}`)
    const order: string[] = []
    const realSet = FakeDoc.prototype.set
    FakeDoc.prototype.set = async function (data: Record<string, unknown>) {
      order.push(this.path.includes('/items/') ? 'item' : 'job')
      return realSet.call(this, data)
    }
    try {
      const { createPrintGenerationJob } = await import('@/lib/printAssets/generationJob')
      await createPrintGenerationJob({
        templateId: 't1', eventId: 'draft-1', eventSlug: SLUG, assetType: 'badge',
        filters: {}, organizerUid: UID, createdBy: UID,
      } as never)
    } finally { FakeDoc.prototype.set = realSet }
    expect(order[order.length - 1]).toBe('job')
    expect(order.indexOf('item')).toBeLessThan(order.lastIndexOf('job'))
  })

  // RD-PRINT-P0 — this used to assert the OPPOSITE: that every attendee field (name,
  // email, phone, ticket, QR value, form answers) was copied into the job. Print history
  // must hold no attendee copy, so the seed now carries selection metadata only and the
  // card's values are built in memory from the LIVE registration (printCardFieldsFor).
  it('26 · the seed carries selection metadata only; card fields come from the live registration', async () => {
    reg('r1', { bibNumber: '101', companyName: 'Acme', designation: 'Dev',
                attendee: { name: 'Asha', email: 'a@b.c', phone: '+91', formResponses: { tshirt: 'M' } } })
    const { createPrintGenerationJob, printCardFieldsFor } = await import('@/lib/printAssets/generationJob')
    const job = await createPrintGenerationJob({
      templateId: 't1', eventId: 'draft-1', eventSlug: SLUG, assetType: 'badge',
      filters: {}, organizerUid: UID, createdBy: UID,
    } as never)
    const item = store.get(`printGenerationJobs/${job.jobId}/items/r1`)!
    expect(Object.keys(item).sort()).toEqual(['category', 'passId', 'passName', 'registrationId'])
    expect(item).toMatchObject({ registrationId: 'r1', category: '10K', passId: 'pass-a' })
    const fields = printCardFieldsFor('r1', store.get('registrations/r1') as never, SLUG)
    expect(fields).toMatchObject({ name: 'Asha', bibNumber: '101', company: 'Acme', designation: 'Dev', ticketCode: 'TC-r1', formResponses: { tshirt: 'M' } })
    expect(fields.qrValue).toBeTruthy()          // built from the ticket code
  })
})

// ─── The create route ────────────────────────────────────────────────────────────

describe('RD-PRINT-SCALE-01 · POST /api/organizer/print-jobs', () => {
  beforeEach(() => { resetAll(); vi.resetModules() })

  const loadRoute = async (authz: Record<string, unknown> = {
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['certificates'],
  }) => {
    const chunk = vi.fn(async () => ({ status: 'completed', processed: 0 }))
    const deferred: (() => unknown)[] = []
    vi.doMock('@/lib/team/workspace', () => ({ authorizeWorkspace: async () => authz }))
    vi.doMock('@/lib/printAssets/firestore', () => ({
      getPrintTemplate: async () => ({ id: 't1', organizerUid: UID, eventId: 'draft-1', assetType: 'badge' }),
    }))
    vi.doMock('next/server', async orig => ({
      ...(await orig<typeof import('next/server')>()),
      after: (fn: () => unknown) => { deferred.push(fn) },
    }))
    const gen = await vi.importActual<typeof import('@/lib/printAssets/generationJob')>('@/lib/printAssets/generationJob')
    vi.doMock('@/lib/printAssets/generationJob', () => ({ ...gen, processPrintGenerationChunk: chunk }))

    store.set('users/org-1/eventDrafts/draft-1', { eventDetails: { seo: { urlSlug: SLUG } } })
    // RD-PRINT-BILL-P5 fix 1 — the route now proves the draft's slug through the LIVE event
    // (resolveOwnedEventSlug): publishing always stamps it with the owner uid and draft id.
    store.set(`events/${SLUG}`, { uid: UID, draftId: 'draft-1' })
    const { POST } = await import('@/app/api/organizer/print-jobs/route')
    const { NextRequest } = await import('next/server')
    return { POST, NextRequest, chunk, deferred }
  }

  const post = (NextRequest: typeof import('next/server').NextRequest, body: unknown) =>
    new NextRequest('http://localhost/api/organizer/print-jobs', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    })

  it('27 · more than 5,000 explicit ids is rejected, not truncated', async () => {
    const { POST, NextRequest } = await loadRoute()
    const ids = Array.from({ length: 5001 }, (_, i) => `r${i}`)
    const res = await POST(post(NextRequest, { templateId: 't1', filters: { registrationIds: ids } }))
    const body = await res.json() as Record<string, unknown>

    expect(res.status).toBe(413)
    expect(body.success).toBe(false)
    expect(body.requested).toBe(5001)
    expect(body.maxSelection).toBe(5000)
    expect(String(body.error)).toMatch(/5,001/)
    // The decisive part: nothing was created. The old code would have made a job here.
    expect([...store.keys()].some(k => k.startsWith('printGenerationJobs/'))).toBe(false)
  })

  it('28 · exactly 5,000 is accepted', async () => {
    const { POST, NextRequest } = await loadRoute()
    for (let i = 0; i < 5000; i++) reg(`r${i}`)
    const ids = Array.from({ length: 5000 }, (_, i) => `r${i}`)
    const res = await POST(post(NextRequest, { templateId: 't1', filters: { registrationIds: ids } }))
    expect(res.status).toBe(201)
  })

  it('29 · duplicate ids are collapsed rather than counted toward the cap', async () => {
    const { POST, NextRequest } = await loadRoute()
    reg('r1')
    const ids = Array.from({ length: 6000 }, () => 'r1')
    const res = await POST(post(NextRequest, { templateId: 't1', filters: { registrationIds: ids } }))
    expect(res.status).toBe(201)
    const body = await res.json() as { job: { counts: { total: number } } }
    expect(body.job.counts.total).toBe(1)
  })

  it('30 · the response is sent WITHOUT waiting for the first render chunk', async () => {
    const { POST, NextRequest, chunk, deferred } = await loadRoute()
    reg('r1')
    const res = await POST(post(NextRequest, { templateId: 't1', filters: {} }))

    expect(res.status).toBe(201)
    // The old code awaited this before responding.
    expect(chunk).not.toHaveBeenCalled()
    expect(deferred).toHaveLength(1)
  })

  it('31 · but generation IS handed off — after() drives the first chunk', async () => {
    const { POST, NextRequest, chunk, deferred } = await loadRoute()
    reg('r1')
    const res = await POST(post(NextRequest, { templateId: 't1', filters: {} }))
    const body = await res.json() as { jobId: string }

    await deferred[0]()
    expect(chunk).toHaveBeenCalledWith(body.jobId)
  })

  it('32 · a failing handoff never breaks the request', async () => {
    const { POST, NextRequest, chunk, deferred } = await loadRoute()
    reg('r1')
    chunk.mockRejectedValueOnce(new Error('render exploded') as never)
    const res = await POST(post(NextRequest, { templateId: 't1', filters: {} }))
    expect(res.status).toBe(201)
    await expect(deferred[0]()).resolves.not.toThrow()
  })

  it('33 · the job is still created, and the response still describes it', async () => {
    const { POST, NextRequest } = await loadRoute()
    for (let i = 0; i < 3; i++) reg(`r${i}`)
    const res = await POST(post(NextRequest, { templateId: 't1', filters: {} }))
    const body = await res.json() as { success: boolean; jobId: string; job: Record<string, unknown> }

    expect(res.status).toBe(201)
    expect(body.success).toBe(true)
    expect(body.jobId).toMatch(/^pgen_/)
    expect((body.job.counts as { total: number }).total).toBe(3)
    expect(body.job.status).toBe('pending')
    expect(store.has(`printGenerationJobs/${body.jobId}`)).toBe(true)
  })

  it('34 · authorization is unchanged — a refusal creates nothing', async () => {
    const { POST, NextRequest, chunk } = await loadRoute({
      ok: false, status: 403, error: 'Forbidden', workspaceUid: '', callerUid: '',
    })
    const res = await POST(post(NextRequest, { templateId: 't1', filters: {} }))
    expect(res.status).toBe(403)
    expect(chunk).not.toHaveBeenCalled()
    expect([...store.keys()].some(k => k.startsWith('printGenerationJobs/'))).toBe(false)
  })

  it('35 · the job is scoped to the AUTHORIZED workspace, never a client-supplied uid', async () => {
    const { POST, NextRequest } = await loadRoute()
    reg('r1')
    const res = await POST(post(NextRequest, {
      templateId: 't1', filters: {}, organizerUid: 'org-attacker', eventSlug: 'their-event',
    }))
    const body = await res.json() as { jobId: string }
    const job = store.get(`printGenerationJobs/${body.jobId}`)!
    expect(job.organizerUid).toBe(UID)
    expect(job.eventSlug).toBe(SLUG)          // resolved from the template's draft, not the body
  })
})

// ─── The generation worker is untouched ─────────────────────────────────────────

describe('RD-PRINT-SCALE-01 · the generation worker was not rewritten', () => {
  it('36 · the chunk driver still runs the shared kernel at the same page size', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('lib/printAssets/generationJob.ts', 'utf8')
    expect(src).toContain('const PRINT_PAGE_SIZE  = 10')
    expect(src).toContain('const PRINT_BUDGET_MS  = 50_000')
    expect(src).toContain('const PRINT_LEASE_MS   = 120_000')
    expect(src).toContain('return runJobChunk(jobId, printGenerationStrategy(), {')
    // The worker still pages the ITEMS subcollection with a cursor — read-free and
    // resume-stable, exactly as before this phase.
    expect(src).toContain('let q = itemsCol(job.jobId).orderBy(FieldPath.documentId())')
    expect(src).toContain('if (cursor) q = q.startAfter(cursor)')
  })

  it('37 · the unbounded create-time read is gone for good', async () => {
    const { readFileSync } = await import('node:fs')
    const code = readFileSync('lib/printAssets/generationJob.ts', 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(code).not.toContain('resolvePrintItems')
    expect(code).not.toContain('ids.slice(0, 5000)')
    // Every registrations read in this module is bounded by a limit.
    expect(code).toContain('await q.limit(SEED_PAGE_SIZE).get()')
  })

  // RD-PRINT-P0 — packaging no longer reads stored PDFs (MAX_FILES / per-file fetch caps
  // are gone): the ZIP is rendered on demand within explicit, refusing caps.
  it('38 · packaging builds its ZIP on demand within explicit caps', async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = readFileSync('lib/printAssets/packageJob.ts', 'utf8')
    expect(pkg).toContain('buildStoredZip')
    expect(pkg).toContain('export const PRINT_PACKAGE_MAX_CARDS = 500')
    expect(pkg).toContain('export const PRINT_PACKAGE_MAX_BYTES = 4 * 1024 * 1024')
  })
})
