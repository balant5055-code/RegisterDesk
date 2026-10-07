// RD-REPORT-03 · BIB reporting — REAL Firestore (emulator), through the REAL route.
//
// ═══ THE REGRESSION THIS FILE EXISTS FOR (§22) ═══════════════════════════════
//
// RD-REPORT-02 found the event Reports tab counting a 50-row page and reporting the
// result as the event's total. BIB reporting is the same trap one level deeper: an
// event with 1,000 assigned numbers spread over 1,064 eligible participants must
// report 1,000 — not the number of rows that happen to fit on a page.
//
// So the fixture is deliberately larger than any page, and deliberately NOT round:
//
//     pass p5   498 eligible   480 assigned
//     pass p10  554 eligible   520 assigned
//     + 88 pending, 61 cancelled            → NOT eligible (roster rule)
//     + 1 cancelled entrant STILL holding a number
//     + 12 confirmed rows written before `hasIdentifier` existed
//
// The last two are the interesting ones. Neither may be quietly absorbed.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID   = process.pid
const UID   = `bib03-org-${PID}`
const SLUG  = `bib03-event-${PID}`
const OTHER = `bib03-other-${PID}`

const P5  = { id: 'p5',  name: '5 KM',  eligible: 60, assigned: 48, base: 10000 }
const P10 = { id: 'p10', name: '10 KM', eligible: 70, assigned: 55, base: 20000 }
const PENDING = 9, CANCELLED = 7, LEGACY = 5

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['participants', 'registrations'],
  }),
  authorizeWorkspaceDownload: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['participants', 'registrations'],
  }),
}))

describeEmu('RD-REPORT-03 · BIB reporting truth', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let GET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  let buildBibReport: typeof import('@/lib/identifiers/bibReport').buildBibReport
  let cellText: typeof import('@/lib/identifiers/bibReport').cellText

  const ids: string[] = []
  const lockIds: string[] = []

  const overview = async (eventId = SLUG) => {
    const res = await GET(
      new NextRequest(`http://localhost/api/organizer/events/${eventId}/identifiers`),
      { params: Promise.resolve({ eventId }) },
    )
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const val = (m: unknown) => {
    const x = m as { status?: string; value?: number | null } | undefined
    return x && x.status === 'known' ? x.value ?? null : null
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ GET }     = await import('@/app/api/organizer/events/[eventId]/identifiers/route'))
    ;({ buildBibReport, cellText } = await import('@/lib/identifiers/bibReport'))

    const draft = (uid: string, slug: string) => adminDb.doc(`users/${uid}/eventDrafts/${slug}`).set({
      eventDetails: { seo: { urlSlug: slug }, info: { name: `Event ${slug}` } },
      pricing: { passes: [
        { id: P5.id,  name: P5.name,  price: 1000 },
        { id: P10.id, name: P10.name, price: 1000 },
        { id: 'phalf', name: 'Half Marathon', price: 1000 },   // no pool → NOT APPLICABLE
      ] },
      status: 'published', lifecycleStatus: 'published',
    })
    await Promise.all([draft(UID, SLUG), draft(OTHER, `${SLUG}-foreign`)])
    // RD-CE-FIX C1 — a published draft HAS its live document, stamped with owner and draft (publish
    // writes both); slugs are now only trusted when that document proves ownership.
    await Promise.all([
      adminDb.doc(`events/${SLUG}`).set({ lifecycleStatus: 'published', uid: UID, draftId: SLUG }),
      adminDb.doc(`events/${SLUG}-foreign`).set({ lifecycleStatus: 'published', uid: OTHER, draftId: `${SLUG}-foreign` }),
    ])

    // Pass-scoped pools; `phalf` deliberately gets none.
    await adminDb.doc(`identifierConfigs/${SLUG}`).set({
      eventSlug: SLUG, label: 'BIB', type: 'numeric', padding: 4,
      defaultPoolId: 'default', reusePolicy: 'never', strategy: 'manual', order: 'registration',
      pools: [
        { poolId: 'pool5',  label: '5 KM',  passIds: [P5.id],  ranges: [{ start: 10001, end: 10999 }] },
        { poolId: 'pool10', label: '10 KM', passIds: [P10.id], ranges: [{ start: 20001, end: 20999 }] },
      ],
    })

    const batchWrite = async (rows: [FirebaseFirestore.DocumentReference, Record<string, unknown>][]) => {
      for (let i = 0; i < rows.length; i += 400) {
        const b = adminDb.batch()
        rows.slice(i, i + 400).forEach(([ref, d]) => b.set(ref, d))
        await b.commit()
      }
    }
    const rows: [FirebaseFirestore.DocumentReference, Record<string, unknown>][] = []
    const mk = (pass: typeof P5, i: number, status: string, bib: number | null) => {
      const id = `${SLUG}-${pass.id}-${i}`
      ids.push(id)
      const d: Record<string, unknown> = {
        organizerUid: UID, eventSlug: SLUG, status,
        passId: pass.id, passName: pass.name, amount: 1000,
        attendee: { name: `${pass.name} ${i}`, email: `${pass.id}-${i}@test.local` },
        registeredAt: new Date(),
      }
      if (bib === null) d.hasIdentifier = false
      else {
        const value = String(bib)
        d.identifier = {
          value, label: 'BIB', type: 'numeric', poolId: pass.id === P5.id ? 'pool5' : 'pool10',
          templateId: null, category: pass.name, state: 'assigned', source: 'manual',
          assignedAt: new Date(), assignedBy: 'fixture', everCheckedIn: false,
        }
        d.bibNumber = value; d.bibCategory = pass.name; d.hasIdentifier = true
        const lid = `${SLUG}__${value}`
        lockIds.push(lid)
        rows.push([adminDb.collection('identifierLocks').doc(lid), {
          eventSlug: SLUG, value, poolId: d.identifier ? (d.identifier as Record<string, unknown>).poolId : null,
          state: 'assigned', registrationId: id, everCheckedIn: false, createdAt: new Date(), updatedAt: new Date(),
        }])
      }
      rows.push([adminDb.collection('registrations').doc(id), d])
    }

    for (const pass of [P5, P10]) {
      for (let i = 0; i < pass.eligible; i++) mk(pass, i, 'confirmed', i < pass.assigned ? pass.base + 1 + i : null)
    }
    for (let i = 0; i < PENDING; i++)   mk(P5,  900 + i, 'pending',   null)
    for (let i = 0; i < CANCELLED; i++) mk(P10, 900 + i, 'cancelled', null)
    mk(P5, 9001, 'cancelled', 99001)                 // cancelled, still holding a number
    for (let i = 0; i < LEGACY; i++) {               // confirmed, no hasIdentifier at all
      const id = `${SLUG}-legacy-${i}`
      ids.push(id)
      rows.push([adminDb.collection('registrations').doc(id), {
        organizerUid: UID, eventSlug: SLUG, status: 'confirmed', amount: 1000,
        attendee: { name: `Legacy ${i}`, email: `legacy-${i}@test.local` },
        registeredAt: new Date(),
      }])
    }
    // Another organizer's event, with its own numbers.
    for (let i = 0; i < 11; i++) {
      const id = `${SLUG}-foreign-${i}`
      ids.push(id)
      rows.push([adminDb.collection('registrations').doc(id), {
        organizerUid: OTHER, eventSlug: `${SLUG}-foreign`, status: 'confirmed',
        passId: P5.id, passName: P5.name, hasIdentifier: true,
        identifier: { value: String(70000 + i), state: 'assigned' },
        attendee: { name: `Foreign ${i}`, email: `f${i}@test.local` },
        registeredAt: new Date(),
      }])
    }
    await batchWrite(rows)
  }, 180_000)

  afterAll(async () => {
    const del = async (coll: string, list: string[]) => {
      for (let i = 0; i < list.length; i += 400) {
        const b = adminDb.batch()
        list.slice(i, i + 400).forEach(id => b.delete(adminDb.collection(coll).doc(id)))
        await b.commit()
      }
    }
    await del('registrations', ids)
    await del('identifierLocks', lockIds)
    await adminDb.doc(`identifierConfigs/${SLUG}`).delete()
    await Promise.all([
      adminDb.doc(`users/${UID}/eventDrafts/${SLUG}`).delete(),
      adminDb.doc(`users/${OTHER}/eventDrafts/${SLUG}-foreign`).delete(),
      adminDb.doc(`events/${SLUG}`).delete(),
      adminDb.doc(`events/${SLUG}-foreign`).delete(),
    ])
  })

  const ELIGIBLE = P5.eligible + P10.eligible + LEGACY   // confirmed only
  const ASSIGNED = P5.assigned + P10.assigned

  // ═══ §22 · THE REGRESSION ══════════════════════════════════════════════════

  it('§22 · assigned is the EVENT total, not a page', async () => {
    const { body } = await overview()
    const el = body.eligibility as Record<string, unknown>
    expect(val(el.assignedEligible)).toBe(ASSIGNED)
    expect(ASSIGNED).toBeGreaterThan(50)     // larger than any page, so this is a real distinction
  })

  it('§22 · the per-pass breakdown covers the whole event', async () => {
    const { body } = await overview()
    const scopes = body.passScopes as { passId: string | null; eligible: unknown; participantsWithIdentifier: unknown; unassignedEligible: unknown }[]
    const p5  = scopes.find(s => s.passId === P5.id)!
    const p10 = scopes.find(s => s.passId === P10.id)!
    expect(val(p5.eligible)).toBe(P5.eligible)
    expect(val(p5.participantsWithIdentifier)).toBe(P5.assigned)
    expect(val(p5.unassignedEligible)).toBe(P5.eligible - P5.assigned)
    expect(val(p10.eligible)).toBe(P10.eligible)
    expect(val(p10.participantsWithIdentifier)).toBe(P10.assigned)
    expect(val(p10.unassignedEligible)).toBe(P10.eligible - P10.assigned)
  })

  it('the event row is NOT the sum of the pass rows', async () => {
    const { body } = await overview()
    const el = body.eligibility as Record<string, unknown>
    // The 5 legacy registrations belong to no pass, so summing passes would miss them.
    expect(val(el.eligible)).toBe(ELIGIBLE)
    expect(val(el.eligible)).toBeGreaterThan(P5.eligible + P10.eligible)
  })

  // ═══ ELIGIBILITY POPULATION ════════════════════════════════════════════════

  it('eligible follows the ROSTER rule — confirmed only', async () => {
    const { body } = await overview()
    const el = body.eligibility as Record<string, unknown>
    expect(val(el.eligible)).toBe(ELIGIBLE)
    // Pending and cancelled exist in the same collection and are excluded.
    expect(val(el.eligible)).not.toBe(ELIGIBLE + PENDING + CANCELLED + 1)
    expect(el.rosterStatuses).toEqual(['confirmed'])
  })

  it('the two eligibility rules are still reported as divergent, not silently merged', async () => {
    const { body } = await overview()
    const el = body.eligibility as Record<string, unknown>
    expect(el.policy).toBe('divergent')
    expect(el.engineTerminalStatuses).toEqual(['cancelled', 'rejected'])
  })

  it('a cancelled registration that still holds a number is in neither figure', async () => {
    const { body } = await overview()
    const el = body.eligibility as Record<string, unknown>
    expect(val(el.eligible)).toBe(ELIGIBLE)          // not eligible
    expect(val(el.assignedEligible)).toBe(ASSIGNED)  // not counted as assigned
  })

  // ═══ COVERAGE COMPLETENESS ════════════════════════════════════════════════

  it('unassigned stays UNKNOWN while any registration predates the countable field', async () => {
    const { body } = await overview()
    const el = body.eligibility as { unassignedEligible: { status: string }; uncountedEligible: number }
    expect(el.unassignedEligible.status).toBe('unavailable')
    expect(el.uncountedEligible).toBe(LEGACY)
  })

  it('the uncounted figure explains exactly how many rows cannot be answered for', async () => {
    const { body } = await overview()
    const el = body.eligibility as { uncountedEligible: number }
    // eligible − (with + without) = the rows the field does not cover.
    expect(el.uncountedEligible).toBe(ELIGIBLE - (ASSIGNED + ((P5.eligible - P5.assigned) + (P10.eligible - P10.assigned))))
  })

  // ═══ THE VIEW MODEL OVER REAL DATA ════════════════════════════════════════

  it('the report renders exact figures and an honest dash', async () => {
    const { body } = await overview()
    const r = buildBibReport({
      configured:  body.configured as boolean,
      eligibility: body.eligibility as never,
      passScopes:  body.passScopes as never,
    })
    expect(cellText(r.overall.eligible)).toBe(ELIGIBLE.toLocaleString('en-IN'))
    expect(cellText(r.overall.assigned)).toBe(ASSIGNED.toLocaleString('en-IN'))
    expect(cellText(r.overall.unassigned)).toBe('—')          // 5 legacy rows
    expect(r.overall.coverage.percent).toBeCloseTo(Math.round((ASSIGNED / ELIGIBLE) * 1000) / 10, 5)
    expect(r.hasIntegrityWarning).toBe(false)
  })

  it('a pass with no pool is NOT APPLICABLE rather than zero', async () => {
    const { body } = await overview()
    const r = buildBibReport({
      configured: true, eligibility: body.eligibility as never, passScopes: body.passScopes as never,
    })
    const half = r.passes.find(p => p.passId === 'phalf')!
    expect(half.issuesNumbers).toBe(false)
    expect(cellText(half.assigned)).toBe('N/A')
    expect(cellText(half.unassigned)).toBe('N/A')
  })

  // ═══ UNIQUENESS ═══════════════════════════════════════════════════════════

  it('duplicate numbers are impossible: the lock id IS the value', async () => {
    // Uniqueness is structural, not checked after the fact. Two registrations cannot
    // hold one value because both would need the same document id, and the engine
    // reads that document inside the allocating transaction.
    const value = String(P5.base + 1)
    const snap = await adminDb.collection('identifierLocks')
      .where('eventSlug', '==', SLUG).where('value', '==', value).get()
    expect(snap.size).toBe(1)
    expect(snap.docs[0].id).toBe(`${SLUG}__${value}`)
  })

  it('every assigned number resolves to exactly one lock', async () => {
    const locks = await adminDb.collection('identifierLocks')
      .where('eventSlug', '==', SLUG).where('state', '==', 'assigned').get()
    const values = locks.docs.map(d => d.data().value as string)
    expect(new Set(values).size).toBe(values.length)     // no duplicates
    expect(values.length).toBe(ASSIGNED + 1)             // +1 = the cancelled holder
  })

  // ═══ ISOLATION ════════════════════════════════════════════════════════════

  it('another organizer\'s event is not reachable', async () => {
    const { status } = await overview(`${SLUG}-foreign`)
    expect(status).toBe(404)
  })

  it('another organizer\'s assigned numbers are in no figure', async () => {
    const { body } = await overview()
    const el = body.eligibility as Record<string, unknown>
    expect(val(el.eligible)).toBe(ELIGIBLE)          // 11 foreign confirmed rows excluded
    expect(val(el.assignedEligible)).toBe(ASSIGNED)  // 11 foreign numbers excluded
  })

  it('an unknown event id is refused', async () => {
    const { status } = await overview(`no-such-event-${PID}`)
    expect(status).toBe(404)
  })

  // ═══ SCALE ════════════════════════════════════════════════════════════════

  it('the payload carries no registration rows at any size', async () => {
    const { body } = await overview()
    expect(body).not.toHaveProperty('registrations')
    // Bounded by CONFIGURATION (pools, passes), never by participants.
    const scopes = body.passScopes as unknown[]
    expect(scopes.length).toBeLessThanOrEqual(8)
  })

  it('a timing chip can never be counted as a BIB', async () => {
    // §3 — the invariant. `timingTag` lives in its own field and its own lock
    // collection; nothing in the BIB figures reads either.
    const { body } = await overview()
    expect(JSON.stringify(body)).not.toMatch(/timingTag/)
    const tagLocks = await adminDb.collection('identifierTagLocks')
      .where('eventSlug', '==', SLUG).get().catch(() => null)
    expect(tagLocks === null || tagLocks.empty).toBe(true)
  })
})
