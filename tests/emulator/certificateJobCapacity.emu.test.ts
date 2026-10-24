// RD-CERT-JOB-CAPACITY-01 · the bulk certificate job pre-check, on REAL Firestore (emulator).
//
// POST /certificates/jobs now refuses UP FRONT (402 CERTIFICATE_CAPACITY_REQUIRED, structured
// required/available/shortfall + the License & Services link) a job that CERTAINLY needs more new
// certificates than the event can fund — and creates no job. Everything else is accepted and left
// to the authoritative per-certificate reservation:
//
//   • zero capacity / insufficient capacity ⇒ 402, no job document
//   • enough capacity ⇒ 201, job created
//   • every target already has a certificate ⇒ accepted with ZERO capacity (nothing new is needed)
//   • refunded registrations are not counted as needing capacity (they are ineligible)
//   • explicit ids (≤ 30) are counted exactly; a program filter cannot be bounded ⇒ accepted
//   • concurrency: two jobs can each pass the pre-check; the RESERVATION still never lets the
//     event exceed its capacity (8 parallel reservations against 3 units ⇒ exactly 3 succeed)

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const UID = `cjc-org-${P}`

vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID, role: 'owner', permissions: ['certificates'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))
vi.mock('@/lib/admin/organizerStatus', async orig => ({
  ...(await orig<typeof import('@/lib/admin/organizerStatus')>()),
  organizerStatusGuard: async () => null,
}))

type Body = Record<string, unknown>

describeEmu('RD-CERT-JOB-CAPACITY-01 · bulk job capacity pre-check (real Firestore)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let POST: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  const paths = new Set<string>()
  let n = 0

  /** A published event with `confirmed` registrations (+ `refunded`), `existing` participation
   *  certificates already issued to the first registrations, and `purchased`/`consumed` units. */
  async function event(o: { confirmed: number; refunded?: number; existing?: number; purchased: number | null; consumed?: number; checkedIn?: number }) {
    const k = ++n, d = `cjc-d${k}-${P}`, slug = `cjc-ev${k}-${P}`
    for (const p of [`users/${UID}/eventDrafts/${d}`, `events/${slug}`, `eventServiceAllowances/${d}`]) paths.add(p)
    await db.doc(`users/${UID}/eventDrafts/${d}`).set({ status: 'published', eventDetails: { seo: { urlSlug: slug }, info: { name: `J${k}` } } })
    await db.doc(`events/${slug}`).set({ uid: UID, draftId: d, slug, lifecycleStatus: 'published' })
    if (o.purchased !== null) await db.doc(`eventServiceAllowances/${d}`).set({ draftId: d, organizerUid: UID, certificates: { purchased: o.purchased, consumed: o.consumed ?? 0, onExhausted: 'block' } })
    const tpl = `cjc-tpl-${d}`
    paths.add(`certificateTemplates/${tpl}`)
    await db.doc(`certificateTemplates/${tpl}`).set({ templateId: tpl, eventId: d, organizerUid: UID, isActive: true, name: 'T' })
    const ids: string[] = []
    const total = o.confirmed + (o.refunded ?? 0)
    for (let i = 0; i < total; i++) {
      const id = `cjc-r-${d}-${i}`
      ids.push(id); paths.add(`registrations/${id}`)
      await db.doc(`registrations/${id}`).set({ organizerUid: UID, eventSlug: slug, status: 'confirmed', paymentStatus: i < o.confirmed ? 'paid' : 'refunded', checkedIn: i < (o.checkedIn ?? total), attendee: { name: `A${i}` } })
    }
    for (let i = 0; i < (o.existing ?? 0); i++) {
      const c = `cjc-cert-${d}-${i}`
      paths.add(`certificates/${c}`)
      await db.doc(`certificates/${c}`).set({ certificateId: c, eventId: d, organizerUid: UID, registrationId: ids[i], certificateType: 'participation', status: 'generated' })
    }
    return { d, slug, ids }
  }
  const jobsFor = async (d: string) => (await db.collection('certificateJobs').where('eventId', '==', d).get()).docs
  const create = async (d: string, body: Body) => {
    const res = await POST(new NextRequest(`http://localhost/api/organizer/events/${d}/certificates/jobs`, {
      method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ eventId: d }) })
    return { status: res.status, body: await res.json() as Body }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ POST } = await import('@/app/api/organizer/events/[eventId]/certificates/jobs/route') as never)
  }, T)
  afterAll(async () => {
    for (const p of paths) await db.recursiveDelete(db.doc(p)).catch(() => null)
    for (const j of (await db.collection('certificateJobs').where('organizerUid', '==', UID).get()).docs) await j.ref.delete()
  }, T)

  it('zero capacity ⇒ 402 with a structured body and the purchase link; no job created', async () => {
    const ev = await event({ confirmed: 3, purchased: null })
    const r = await create(ev.d, { scope: 'all', certificateType: 'participation' })
    expect(r.status).toBe(402)
    expect(r.body).toMatchObject({ code: 'CERTIFICATE_CAPACITY_REQUIRED', capacity: { state: 'none', available: 0, required: 3, shortfall: 3 } })
    expect(String((r.body.capacity as Body).manageHref)).toContain('service=certificates')
    expect(await jobsFor(ev.d)).toHaveLength(0)
  }, T)

  it('insufficient capacity ⇒ 402 with the shortfall; no job created', async () => {
    const ev = await event({ confirmed: 5, purchased: 4, consumed: 2 })
    const r = await create(ev.d, { scope: 'all', certificateType: 'participation' })
    expect(r).toMatchObject({ status: 402, body: { code: 'CERTIFICATE_CAPACITY_REQUIRED', capacity: { state: 'available', available: 2, required: 5, shortfall: 3 } } })
    expect(String(r.body.error)).toContain('at least 5')
    expect(await jobsFor(ev.d)).toHaveLength(0)
  }, T)

  it('enough capacity ⇒ 201 and the job is created', async () => {
    const ev = await event({ confirmed: 3, purchased: 3 })
    const r = await create(ev.d, { scope: 'all', certificateType: 'participation' })
    expect(r.status).toBe(201)
    expect(await jobsFor(ev.d)).toHaveLength(1)
  }, T)

  it('every target already certified ⇒ accepted even with ZERO capacity (nothing new is needed)', async () => {
    const ev = await event({ confirmed: 2, existing: 2, purchased: null })
    expect((await create(ev.d, { scope: 'all', certificateType: 'participation' })).status).toBe(201)
  }, T)

  it('existing certificates and refunded registrations reduce what is needed', async () => {
    // 6 confirmed, 2 of them already certified, + 3 refunded (ineligible) ⇒ needs ≥ 4; 4 available ⇒ OK
    const ev = await event({ confirmed: 6, refunded: 3, existing: 2, purchased: 4 })
    expect((await create(ev.d, { scope: 'all', certificateType: 'participation' })).status).toBe(201)
  }, T)

  it('checked-in scope counts only checked-in registrations', async () => {
    const ev = await event({ confirmed: 5, checkedIn: 1, purchased: 1 })
    expect((await create(ev.d, { scope: 'checked_in', certificateType: 'participation' })).status).toBe(201)
    expect((await create(ev.d, { scope: 'all', certificateType: 'participation' })).status).toBe(402)
  }, T)

  it('explicit ids are counted exactly (already-certified and foreign ids need nothing)', async () => {
    const ev = await event({ confirmed: 3, existing: 1, purchased: 1 })
    expect((await create(ev.d, { scope: 'selected', certificateType: 'participation', registrationIds: [ev.ids[0], ev.ids[1], 'not-a-registration'] })).status).toBe(201)
    expect((await create(ev.d, { scope: 'selected', certificateType: 'participation', registrationIds: [ev.ids[1], ev.ids[2]] }))
      .body).toMatchObject({ code: 'CERTIFICATE_CAPACITY_REQUIRED', capacity: { required: 2, available: 1, shortfall: 1 } })
  }, T)

  it('concurrency: two jobs may both pass the pre-check, but the reservation never exceeds capacity', async () => {
    const ev = await event({ confirmed: 3, purchased: 3 })
    const [a, b] = await Promise.all([
      create(ev.d, { scope: 'all', certificateType: 'participation' }),
      create(ev.d, { scope: 'all', certificateType: 'participation' }),
    ])
    expect([a.status, b.status]).toEqual([201, 201])                       // the pre-check is not the authority
    const { reserveServiceUnits } = await import('@/lib/licensing/serviceAllowanceLedger')
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      reserveServiceUnits({ draftId: ev.d, service: 'certificates', unitKey: `cert_cjc_${P}_${i}`, source: 'test' })))
    expect(outcomes.filter(o => o.mode === 'allowance')).toHaveLength(3)
    expect((await db.doc(`eventServiceAllowances/${ev.d}`).get()).data()?.certificates?.consumed).toBe(3)
  }, T)
})
