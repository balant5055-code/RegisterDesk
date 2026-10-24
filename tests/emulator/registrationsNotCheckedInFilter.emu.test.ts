// RD-CHECKIN-FILTER-01 · the Registrations "Not checked in" filter, through the REAL list route on
// REAL Firestore (private emulator).
//
// Paid registrations settled before settleCapturedRegistration wrote `checkedIn: false` carry NO
// `checkedIn` field, and the route's former `where('checkedIn', '==', false)` excluded every one of
// them — a paid event with no check-ins listed nobody as "not checked in". The filter is now applied
// while paging (`checkedIn !== true`), bounded and resumable, so field-less registrations are listed
// alongside explicit `false` ones; checked-in ones never are; other filters still combine with it.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const PID  = process.pid
const UID  = `nci-org-${PID}`
const SLUG = `nci-event-${PID}`

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['registrations', 'transactions'],
  }),
  authorizeWorkspaceDownload: async () => ({
    ok: true, status: 200, error: '', workspaceUid: UID, callerUid: UID,
    role: 'owner', permissions: ['registrations', 'transactions'],
  }),
}))

/** 0..59 field-less (paid, pre-fix) · 60..79 explicit false · 80..119 checked in. All confirmed. */
const NO_FIELD = 60, EXPLICIT_FALSE = 20, CHECKED_IN = 40
const N = NO_FIELD + EXPLICIT_FALSE + CHECKED_IN

describeEmu('RD-CHECKIN-FILTER-01 · "Not checked in" includes registrations without the field', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let GET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>
  const ids: string[] = []

  const call = async (qs: string) => {
    const res = await GET(new NextRequest(`http://localhost/api/organizer/events/${SLUG}/registrations${qs}`), { params: Promise.resolve({ eventId: SLUG }) })
    return { status: res.status, body: await res.json() as { registrations: { id: string; checkedIn?: boolean; paymentStatus?: string }[]; hasMore: boolean; nextCursor: string | null; checkinFilterComplete?: boolean } }
  }
  /** Follows nextCursor until the list ends — the whole filtered set, as a user paging would see it. */
  const all = async (qs: string) => {
    const out: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 50; guard++) {
      const r = await call(`${qs}&limit=25${cursor ? `&cursor=${cursor}` : ''}`)
      expect(r.status).toBe(200)
      out.push(...r.body.registrations.map(x => x.id))
      if (!r.body.hasMore) break
      cursor = r.body.nextCursor
    }
    return out
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('Refusing to run outside a demo- project.')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ GET } = await import('@/app/api/organizer/events/[eventId]/registrations/route'))
    await adminDb.doc(`users/${UID}/eventDrafts/${SLUG}`).set({
      eventDetails: { seo: { urlSlug: SLUG }, info: { name: 'NCI' }, schedule: { timezone: 'Asia/Kolkata' } },
      pricing: { passes: [{ id: 'pa', name: 'Pass A', price: 1000 }] }, status: 'published', lifecycleStatus: 'published',
    })
    await adminDb.doc(`events/${SLUG}`).set({ lifecycleStatus: 'published', uid: UID, draftId: SLUG })
    const batch = adminDb.batch()
    const now = Date.now()
    for (let i = 0; i < N; i++) {
      const id = `${SLUG}-r${String(i).padStart(3, '0')}`
      ids.push(id)
      batch.set(adminDb.doc(`registrations/${id}`), {
        organizerUid: UID, eventSlug: SLUG, passId: 'pa', passName: 'Pass A', status: 'confirmed',
        paymentStatus: i % 2 === 0 ? 'paid' : 'not_required', amount: i % 2 === 0 ? 1000 : 0,
        attendee: { name: `P${i}`, email: `p${i}@rd.test` }, registeredAt: new Date(now - i * 60_000),
        ...(i < NO_FIELD ? {} : i < NO_FIELD + EXPLICIT_FALSE ? { checkedIn: false } : { checkedIn: true }),
      })
    }
    await batch.commit()
  }, 180_000)

  afterAll(async () => {
    const b = adminDb.batch()
    ids.forEach(id => b.delete(adminDb.doc(`registrations/${id}`)))
    await b.commit()
    await adminDb.doc(`users/${UID}/eventDrafts/${SLUG}`).delete()
    await adminDb.doc(`events/${SLUG}`).delete()
    await adminDb.doc(`registrationCounters/${SLUG}`).delete().catch(() => null)
  })

  it('lists EVERY not-checked-in registration across pages — with and without the field — exactly once', async () => {
    const got = await all('?checkin=no')
    const expected = ids.slice(0, NO_FIELD + EXPLICIT_FALSE)
    expect(got.length).toBe(expected.length)
    expect(new Set(got).size).toBe(got.length)            // no row repeated across pages
    expect([...got].sort()).toEqual([...expected].sort())
  })

  it('never lists a checked-in registration; "checked in" is unchanged', async () => {
    const notIn = new Set(await all('?checkin=no'))
    const checkedIn = await all('?checkin=yes')
    expect(checkedIn.length).toBe(CHECKED_IN)
    expect(checkedIn.some(id => notIn.has(id))).toBe(false)
    expect(notIn.size + checkedIn.length).toBe(N)          // the two directions partition the event
  })

  it('combines with other filters (payment=paid)', async () => {
    const got = await all('?checkin=no&payment=paid')
    const expected = ids.slice(0, NO_FIELD + EXPLICIT_FALSE).filter((_, i) => i % 2 === 0)
    expect([...got].sort()).toEqual([...expected].sort())
  })

  it('reports the list as complete, and the "all" mode filters the same way', async () => {
    const page = await call('?checkin=no&limit=25')
    expect(page.body.checkinFilterComplete).toBe(true)
    const allMode = await call('?checkin=no&all=true')
    expect(allMode.body.registrations.length).toBe(NO_FIELD + EXPLICIT_FALSE)
    expect(allMode.body.registrations.every(r => r.checkedIn !== true)).toBe(true)
  })
})
