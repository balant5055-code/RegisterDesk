// RD-PRINT-SCALE-IMPLEMENTATION-01 · print-job creation at 20,000 registrations —
// REAL Firestore (emulator).
//
// ═══ WHY 20,000 AND NOT 500 ══════════════════════════════════════════════════
// The defect this closes is invisible at small scale: `resolvePrintItems` did one
// unbounded `.get()` over every registration for the event, so a 500-row fixture and a
// 20,000-row fixture behave identically — both "work", one of them only in a test.
// The failure is a property of the READ SHAPE, so it can only be caught by measuring
// the read shape at a size where an unbounded read is obviously wrong.
//
// ═══ WHAT IS ACTUALLY MEASURED ═══════════════════════════════════════════════
// Not "a loop ran 20,000 times". Every Firestore Query.get() issued during job
// creation is intercepted and its RESULT SIZE recorded, so:
//
//   • the largest single read is asserted — that is the real memory bound, and it is
//     the number that used to be 20,000
//   • the page COUNT is asserted against the arithmetic, which only holds if the
//     cursor advanced correctly on every page
//   • the write batches are counted and sized
//
// Then the resulting item set is compared against the exact expected roster: every
// eligible registration present exactly once, every excluded one absent.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID  = process.pid
const UID  = `ps01-org-${PID}`
const EV   = `ps01-event-${PID}`
const OTHER_UID   = `ps01-other-org-${PID}`
const OTHER_EVENT = `ps01-other-event-${PID}`

// ─── The fixture, sized so every exclusion is independently visible ─────────────
const ELIGIBLE   = 17_300   // confirmed + payable  → MUST become items
const CANCELLED  =    900
const PENDING    =    700
const WAITLISTED =    500
const REJECTED   =    400
const REFUNDED   =    200   // confirmed BUT paymentStatus 'refunded' → must NOT
const TOTAL      = ELIGIBLE + CANCELLED + PENDING + WAITLISTED + REFUNDED + REJECTED  // 20,000

/** Rows a foreign organizer / a different event owns. Must never leak in. */
const FOREIGN = 60

/** Mirrors SEED_PAGE_SIZE in lib/printAssets/generationJob.ts. */
const PAGE = 400
/** The scan filters status server-side, so ONLY 'confirmed' rows are ever read. */
const READABLE   = ELIGIBLE + REFUNDED                    // 17,500
const EXPECTED_PAGES = Math.ceil(READABLE / PAGE)         // 44

/** A minority pass, so the pushed-down pass filter has something to prove. */
const PASS_MAIN = 'pass-main'
const PASS_VIP  = 'pass-vip'
const VIP_EVERY = 10        // every 10th eligible row is VIP

const regId = (i: number) => `${EV}-reg-${String(i).padStart(5, '0')}`

interface Row { id: string; status: string; paymentStatus: string; passId: string; eligible: boolean }

function buildRows(): Row[] {
  const rows: Row[] = []
  let i = 0
  const push = (n: number, status: string, paymentStatus: string, eligible: boolean) => {
    for (let k = 0; k < n; k++, i++) {
      // Interleave the pass so eligible/VIP rows are spread across every page rather
      // than sitting in one contiguous block a broken cursor could still get right.
      const passId = eligible && i % VIP_EVERY === 0 ? PASS_VIP : PASS_MAIN
      rows.push({ id: regId(i), status, paymentStatus, passId, eligible })
    }
  }
  // Deliberately interleaved rather than grouped, so excluded rows fall inside pages.
  for (let block = 0; block < 20; block++) {
    push(ELIGIBLE   / 20, 'confirmed',  'paid',     true)
    push(CANCELLED  / 20, 'cancelled',  'paid',     false)
    push(PENDING    / 20, 'pending',    'pending',  false)
    push(WAITLISTED / 20, 'waitlisted', 'pending',  false)
    push(REJECTED   / 20, 'rejected',   'paid',     false)
    push(REFUNDED   / 20, 'confirmed',  'refunded', false)
  }
  return rows
}

describeEmu('RD-PRINT-SCALE-01 · job creation at 20,000 registrations', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let createPrintGenerationJob: typeof import('@/lib/printAssets/generationJob').createPrintGenerationJob

  const rows = buildRows()
  const eligibleIds = new Set(rows.filter(r => r.eligible).map(r => r.id))
  /** Derived from the fixture, never assumed: the interleaving decides how many
   *  eligible rows land on a VIP index, and that is not ELIGIBLE / VIP_EVERY. */
  const VIP_ELIGIBLE = rows.filter(r => r.eligible && r.passId === PASS_VIP).length
  const foreignIds: string[] = []

  /** Result sizes of every Query.get() issued while the recorder is armed. */
  let readSizes: number[] = []
  let commitSizes: number[] = []
  let recording = false
  let restore: (() => void) | null = null

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ createPrintGenerationJob } = await import('@/lib/printAssets/generationJob'))

    await adminDb.doc(`users/${UID}/eventDrafts/${EV}`).set({
      eventDetails: { seo: { urlSlug: EV }, info: { name: 'Print Scale Event' } },
      status: 'published', lifecycleStatus: 'published',
    })

    const write = async (batchRows: [string, Record<string, unknown>][]) => {
      for (let i = 0; i < batchRows.length; i += 450) {
        const b = adminDb.batch()
        for (const [id, data] of batchRows.slice(i, i + 450)) {
          b.set(adminDb.collection('registrations').doc(id), data)
        }
        await b.commit()
      }
    }

    await write(rows.map(r => [r.id, {
      organizerUid: UID, eventSlug: EV, eventName: 'Print Scale Event',
      status: r.status, paymentStatus: r.paymentStatus,
      passId: r.passId, passName: r.passId === PASS_VIP ? 'VIP' : 'General',
      bibCategory: '10K', passType: 'Runner', bibNumber: '', ticketCode: `TC-${r.id}`,
      attendee: { name: `Runner ${r.id}`, email: `${r.id}@test.local`, phone: '', formResponses: {} },
      registeredAt: new Date(),
    }]))

    // Foreign rows: half owned by another organizer, half belonging to another event.
    // Both are confirmed and paid, so ONLY the scope checks can keep them out.
    const foreign: [string, Record<string, unknown>][] = []
    for (let i = 0; i < FOREIGN; i++) {
      const id = `${EV}-foreign-${i}`
      foreignIds.push(id)
      foreign.push([id, {
        organizerUid: i % 2 === 0 ? OTHER_UID : UID,
        eventSlug:    i % 2 === 0 ? EV        : OTHER_EVENT,
        eventName: 'Foreign', status: 'confirmed', paymentStatus: 'paid',
        passId: PASS_MAIN, passName: 'General', bibCategory: '10K', passType: 'Runner',
        ticketCode: `TC-${id}`, bibNumber: '',
        attendee: { name: 'Foreign', email: 'f@test.local', phone: '', formResponses: {} },
        registeredAt: new Date(),
      }])
    }
    await write(foreign)

    // ── Arm the recorder ────────────────────────────────────────────────────────
    // Patched on the live prototypes, so this measures the REAL driver's reads and
    // writes — there is no fake in this file.
    const sampleQuery = adminDb.collection('registrations').where('organizerUid', '==', UID)
    const QueryProto  = Object.getPrototypeOf(sampleQuery) as { get: () => Promise<{ size: number }> }
    const origGet     = QueryProto.get
    QueryProto.get = async function (this: unknown, ...args: unknown[]) {
      const snap = await (origGet as (...a: unknown[]) => Promise<{ size: number }>).apply(this, args)
      if (recording && typeof snap.size === 'number') readSizes.push(snap.size)
      return snap
    } as typeof origGet

    const origBatch = adminDb.batch.bind(adminDb)
    ;(adminDb as unknown as { batch: () => unknown }).batch = () => {
      const b = origBatch()
      let ops = 0
      const origSet    = b.set.bind(b)
      const origCommit = b.commit.bind(b)
      ;(b as unknown as { set: unknown }).set = (...a: Parameters<typeof origSet>) => { ops++; return origSet(...a) }
      ;(b as unknown as { commit: unknown }).commit = async () => {
        if (recording) commitSizes.push(ops)
        return origCommit()
      }
      return b
    }

    restore = () => {
      QueryProto.get = origGet
      ;(adminDb as unknown as { batch: unknown }).batch = origBatch
    }
  }, 600_000)

  afterAll(async () => {
    restore?.()
    const del = async (ids: string[]) => {
      for (let i = 0; i < ids.length; i += 400) {
        const b = adminDb.batch()
        ids.slice(i, i + 400).forEach(id => b.delete(adminDb.collection('registrations').doc(id)))
        await b.commit()
      }
    }
    await del(rows.map(r => r.id))
    await del(foreignIds)
    await adminDb.doc(`users/${UID}/eventDrafts/${EV}`).delete()
    // Job + item docs.
    const jobs = await adminDb.collection('printGenerationJobs').where('organizerUid', '==', UID).get()
    for (const job of jobs.docs) {
      const items = await job.ref.collection('items').get()
      for (let i = 0; i < items.docs.length; i += 400) {
        const b = adminDb.batch()
        items.docs.slice(i, i + 400).forEach(d => b.delete(d.ref))
        await b.commit()
      }
      await job.ref.delete()
    }
  }, 600_000)

  // ── The whole-event job ──────────────────────────────────────────────────────

  describe('the whole-event scan', () => {
    let jobId = ''
    let itemIds: string[] = []

    it('1 · creates the job over 20,000 registrations', async () => {
      readSizes = []; commitSizes = []; recording = true
      const job = await createPrintGenerationJob({
        templateId: 't1', eventId: EV, eventSlug: EV, assetType: 'badge',
        filters: {}, organizerUid: UID, createdBy: UID,
      })
      recording = false
      jobId = job.jobId

      const snap = await adminDb.collection('printGenerationJobs').doc(jobId).collection('items').get()
      itemIds = snap.docs.map(d => d.id)

      expect(job.counts.total).toBe(ELIGIBLE)
      expect(job.status).toBe('pending')
      expect(job.eventName).toBe('Print Scale Event')
    }, 600_000)

    it('2 · NO read returned more than one page — the 20k array cannot exist', () => {
      // This single number is the whole fix. Before this phase it was 20,000.
      expect(Math.max(...readSizes)).toBeLessThanOrEqual(PAGE)
      expect(readSizes.length).toBeGreaterThan(1)
    })

    it('3 · the walk paged exactly as the arithmetic requires', () => {
      // 17,500 readable rows at 400/page = 44 pages, the last one short. Getting this
      // count right is only possible if the cursor advanced correctly every time: a
      // cursor that stalled would loop, one that over-shot would come up short.
      expect(readSizes).toHaveLength(EXPECTED_PAGES)
      expect(readSizes.slice(0, -1).every(n => n === PAGE)).toBe(true)
      expect(readSizes[readSizes.length - 1]).toBe(READABLE - (EXPECTED_PAGES - 1) * PAGE)
      expect(readSizes.reduce((a, b) => a + b, 0)).toBe(READABLE)
    })

    it('4 · the status filter was served by Firestore, not by reading everything', () => {
      // 20,000 rows exist; only the 17,500 'confirmed' ones were ever transferred.
      const read = readSizes.reduce((a, b) => a + b, 0)
      expect(read).toBe(READABLE)
      expect(read).toBeLessThan(TOTAL)
    })

    it('5 · writes stayed inside the Firestore batch limit', () => {
      expect(commitSizes.length).toBeGreaterThan(1)
      expect(Math.max(...commitSizes)).toBeLessThanOrEqual(PAGE)
      expect(commitSizes.reduce((a, b) => a + b, 0)).toBe(ELIGIBLE)
    })

    it('6 · every eligible registration became an item — none skipped', () => {
      expect(itemIds).toHaveLength(ELIGIBLE)
      const got = new Set(itemIds)
      expect(got.size).toBe(ELIGIBLE)              // no duplicates
      for (const id of eligibleIds) {
        if (!got.has(id)) throw new Error(`missing eligible registration ${id}`)
      }
    })

    it('7 · cancelled, pending, waitlisted and rejected produced no credential', () => {
      const got = new Set(itemIds)
      const excluded = rows.filter(r => !r.eligible && r.paymentStatus !== 'refunded')
      expect(excluded.length).toBe(CANCELLED + PENDING + WAITLISTED + REJECTED)
      for (const r of excluded) {
        if (got.has(r.id)) throw new Error(`${r.status} registration ${r.id} was issued a badge`)
      }
    })

    it('8 · a confirmed-but-REFUNDED registration produced no credential', () => {
      // These ARE read (status is 'confirmed'), so only the in-memory arm can exclude
      // them — the one the server-side query cannot express.
      const got = new Set(itemIds)
      const refunded = rows.filter(r => r.paymentStatus === 'refunded')
      expect(refunded).toHaveLength(REFUNDED)
      for (const r of refunded) {
        if (got.has(r.id)) throw new Error(`refunded registration ${r.id} was issued a badge`)
      }
    })

    it('9 · no foreign organizer or foreign event row leaked in', () => {
      const got = new Set(itemIds)
      for (const id of foreignIds) expect(got.has(id)).toBe(false)
    })

    it('10 · the snapshot each item carries is complete', async () => {
      const one = [...eligibleIds][0]
      const snap = await adminDb.collection('printGenerationJobs').doc(jobId)
        .collection('items').doc(one).get()
      const item = snap.data() as Record<string, unknown>
      expect(item.registrationId).toBe(one)
      expect(item.name).toBe(`Runner ${one}`)
      expect(item.ticketCode).toBe(`TC-${one}`)
      expect(item.qrValue).toBeTruthy()
      expect(item.passName).toBeTruthy()
    })
  })

  // ── The pushed-down pass filter ──────────────────────────────────────────────

  describe('the pass filter is served by Firestore', () => {
    it('11 · a pass-scoped job reads only that pass, not the whole event', async () => {
      readSizes = []; commitSizes = []; recording = true
      const job = await createPrintGenerationJob({
        templateId: 't1', eventId: EV, eventSlug: EV, assetType: 'badge',
        filters: { pass: PASS_VIP }, organizerUid: UID, createdBy: UID,
      })
      recording = false

      const read = readSizes.reduce((a, b) => a + b, 0)
      // The decisive assertion: a VIP job transfers ~1,730 documents, not 17,500. If
      // the pass filter were still applied in memory this would read every confirmed row.
      expect(read).toBe(VIP_ELIGIBLE)
      expect(read).toBeLessThan(READABLE / 5)
      expect(job.counts.total).toBe(VIP_ELIGIBLE)
      expect(Math.max(...readSizes)).toBeLessThanOrEqual(PAGE)

      const snap = await adminDb.collection('printGenerationJobs').doc(job.jobId).collection('items').get()
      expect(snap.size).toBe(VIP_ELIGIBLE)
      for (const d of snap.docs) expect(d.data().passId).toBe(PASS_VIP)
    }, 600_000)
  })

  // ── The explicit selection ───────────────────────────────────────────────────

  describe('an explicit selection', () => {
    it('12 · reads only the ids asked for — the collection is never scanned', async () => {
      const picked = [...eligibleIds].slice(0, 900)
      readSizes = []; commitSizes = []; recording = true
      const job = await createPrintGenerationJob({
        templateId: 't1', eventId: EV, eventSlug: EV, assetType: 'badge',
        filters: { registrationIds: picked }, organizerUid: UID, createdBy: UID,
      })
      recording = false

      // getAll() is not a Query, so a document-id lookup records NO query reads at all.
      // A single scan of the collection would show up here as 44 pages.
      expect(readSizes).toHaveLength(0)
      expect(job.counts.total).toBe(900)
      expect(Math.max(...commitSizes)).toBeLessThanOrEqual(PAGE)
    }, 600_000)

    it('13 · an ineligible or out-of-scope id in the selection is dropped', async () => {
      const cancelled = rows.find(r => r.status === 'cancelled')!.id
      const refunded  = rows.find(r => r.paymentStatus === 'refunded')!.id
      const eligible  = [...eligibleIds][0]
      const job = await createPrintGenerationJob({
        templateId: 't1', eventId: EV, eventSlug: EV, assetType: 'badge',
        filters: { registrationIds: [eligible, cancelled, refunded, foreignIds[0], 'does-not-exist'] },
        organizerUid: UID, createdBy: UID,
      })
      const snap = await adminDb.collection('printGenerationJobs').doc(job.jobId).collection('items').get()
      expect(snap.docs.map(d => d.id)).toEqual([eligible])
      expect(job.counts.total).toBe(1)
    }, 600_000)
  })
})
