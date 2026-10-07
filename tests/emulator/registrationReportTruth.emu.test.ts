// RD-REPORT-02 · registration reporting tells the truth — REAL Firestore (emulator).
//
// THE DEFECT THIS FILE EXISTS TO PREVENT COMING BACK:
//
//   The event Reports tab derived every figure from `registrations.length`, an array
//   holding ONE PAGE. A 1,200-person event reported "Total Registrations 50", directly
//   beneath a header reading "1,052 registered". The correct answer was already in the
//   same response, in `stats`, unused.
//
// A unit test cannot catch that. The bug was never in a calculation — it was in WHICH
// SET was counted, which only a real dataset larger than the page size can expose. So
// this seeds more registrations than any page holds and asserts that the aggregates
// describe the EVENT rather than the page.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID  = process.pid
const UID  = `rep02-org-${PID}`
const SLUG = `rep02-event-${PID}`
const OTHER_UID  = `rep02-other-${PID}`
const OTHER_SLUG = `rep02-other-event-${PID}`

/** Larger than the 50-row default page, so a page can never masquerade as the whole. */
const N = 180

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

const PASSES = [
  { id: 'pa', name: 'Pass A' },
  { id: 'pb', name: 'Pass B' },
]
/** Deterministic, so every expected figure below is computed, never guessed. */
const statusOf = (i: number) => (i % 20 === 0 ? 'cancelled' : i % 13 === 0 ? 'pending' : 'confirmed')

describeEmu('RD-REPORT-02 · registration reporting truth', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let GET: (req: NextRequest, ctx: { params: Promise<{ eventId: string }> }) => Promise<Response>

  const truth = { total: N, confirmed: 0, pending: 0, cancelled: 0, byPass: {} as Record<string, { confirmed: number; cancelled: number }> }
  const ids: string[] = []

  const call = async (qs: string, eventId = SLUG) => {
    const res = await GET(
      new NextRequest(`http://localhost/api/organizer/events/${eventId}/registrations${qs}`),
      { params: Promise.resolve({ eventId }) },
    )
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ GET }     = await import('@/app/api/organizer/events/[eventId]/registrations/route'))

    for (const p of PASSES) truth.byPass[p.id] = { confirmed: 0, cancelled: 0 }

    // Two drafts: the organizer's own, and another organizer's (isolation).
    const draft = (uid: string, slug: string) => adminDb.doc(`users/${uid}/eventDrafts/${slug}`).set({
      eventDetails: { seo: { urlSlug: slug }, info: { name: `Event ${slug}` }, schedule: { timezone: 'Asia/Kolkata' } },
      pricing: { passes: PASSES.map(p => ({ id: p.id, name: p.name, price: 1000 })) },
      status: 'published', lifecycleStatus: 'published',
    })
    await Promise.all([draft(UID, SLUG), draft(OTHER_UID, OTHER_SLUG)])
    // RD-CE-FIX C1 — the live documents as publish writes them (owner + draft stamps).
    await Promise.all([
      adminDb.doc(`events/${SLUG}`).set({ lifecycleStatus: 'published', uid: UID, draftId: SLUG }),
      adminDb.doc(`events/${OTHER_SLUG}`).set({ lifecycleStatus: 'published', uid: OTHER_UID, draftId: OTHER_SLUG }),
    ])

    const now = Date.now()
    for (let start = 0; start < N; start += 400) {
      const batch = adminDb.batch()
      for (let i = start; i < Math.min(start + 400, N); i++) {
        const pass = PASSES[i % 2]
        const status = statusOf(i)
        if (status === 'confirmed') { truth.confirmed++; truth.byPass[pass.id].confirmed++ }
        else if (status === 'cancelled') { truth.cancelled++; truth.byPass[pass.id].cancelled++ }
        else truth.pending++
        const id = `${SLUG}-${String(i).padStart(4, '0')}`
        ids.push(id)
        batch.set(adminDb.collection('registrations').doc(id), {
          organizerUid: UID, eventSlug: SLUG, status,
          passId: pass.id, passName: pass.name, amount: 1000,
          attendee: { name: `P${i}`, email: `p${i}@test.local`, phone: `9${100000000 + i}` },
          registeredAt: new Date(now - i * 60_000),
        })
      }
      await batch.commit()
    }

    // The other organizer's registrations — must never appear in any figure above.
    const ob = adminDb.batch()
    for (let i = 0; i < 25; i++) {
      const id = `${OTHER_SLUG}-${i}`
      ids.push(id)
      ob.set(adminDb.collection('registrations').doc(id), {
        organizerUid: OTHER_UID, eventSlug: OTHER_SLUG, status: 'confirmed',
        passId: 'pa', passName: 'Pass A', amount: 1000,
        attendee: { name: `Other ${i}`, email: `o${i}@test.local` },
        registeredAt: new Date(now),
      })
    }
    await ob.commit()
  }, 120_000)

  afterAll(async () => {
    for (let i = 0; i < ids.length; i += 400) {
      const b = adminDb.batch()
      ids.slice(i, i + 400).forEach(id => b.delete(adminDb.collection('registrations').doc(id)))
      await b.commit()
    }
    await Promise.all([
      adminDb.doc(`users/${UID}/eventDrafts/${SLUG}`).delete(),
      adminDb.doc(`users/${OTHER_UID}/eventDrafts/${OTHER_SLUG}`).delete(),
    ])
  })

  // ═══ A · the aggregate describes the EVENT, not the page ═══════════════════

  it('A · summary stats equal the whole event, not the page size', async () => {
    const { body } = await call('?view=summary')
    expect(body.stats).toMatchObject({
      total:     truth.total,
      confirmed: truth.confirmed,
      pending:   truth.pending,
      cancelled: truth.cancelled,
    })
  })

  it('B · the total is NOT the length of any returned array', async () => {
    const { body } = await call('?view=summary')
    const rows = body.registrations as unknown[]
    // Summary transfers no rows at all, so "count the array" cannot even be attempted.
    expect(rows).toHaveLength(0)
    expect((body.stats as { total: number }).total).toBe(N)
    expect(N).toBeGreaterThan(50)          // the old page size, so this is a real distinction
  })

  it('B2 · the ROW mode still pages, and says so — the page is not the truth', async () => {
    const { body } = await call('')
    const rows = body.registrations as unknown[]
    expect(rows.length).toBeLessThan(N)     // it is a page
    expect(body.hasMore).toBe(true)         // and it admits it
    expect((body.stats as { total: number }).total).toBe(N)   // while stats stay whole
  })

  it('C · confirmed / cancelled / pending keep their existing meanings', async () => {
    const { body } = await call('?view=summary')
    const s = body.stats as Record<string, number>
    // `total` is every registration in any state — the sum of the parts, not a synonym
    // for confirmed. This is the distinction the two surfaces used to disagree on.
    expect(s.confirmed + s.pending + s.cancelled + s.rejected + s.waitlisted).toBe(s.total)
    expect(s.confirmed).toBeLessThan(s.total)
  })

  // ═══ D · per-pass breakdown ════════════════════════════════════════════════

  it('D · per-pass counts are exact over the whole event', async () => {
    const { body } = await call('?view=summary')
    const stats = body.passStats as { id: string; confirmed: number | null; cancelled: number | null }[]
    expect(stats).toHaveLength(PASSES.length)
    for (const p of PASSES) {
      const row = stats.find(x => x.id === p.id)!
      expect(row.confirmed).toBe(truth.byPass[p.id].confirmed)
      expect(row.cancelled).toBe(truth.byPass[p.id].cancelled)
    }
  })

  it('D2 · per-pass confirmed sums to the event confirmed total', async () => {
    const { body } = await call('?view=summary')
    const stats = body.passStats as { confirmed: number | null }[]
    const sum = stats.reduce((s, p) => s + (p.confirmed ?? 0), 0)
    expect(sum).toBe(truth.confirmed)
  })

  it('D3 · the breakdown reports whether it covered every pass', async () => {
    const { body } = await call('?view=summary')
    expect(body.passStatsTruncated).toBe(false)
  })

  // ═══ E · trend uses the registration timestamp, over the whole dataset ═════

  it('E · the trend counts every registration in the window, not a page', async () => {
    const { body } = await call('?view=summary&trend=7')
    const trend = body.trend as { buckets: { date: string; count: number | null }[] } | undefined
    expect(trend).toBeDefined()
    expect(trend!.buckets).toHaveLength(7)
    // Fixtures are one minute apart from now, so every one falls in the most recent day.
    // The point is that the figure exceeds any page size — it was counted, not sampled.
    const total = trend!.buckets.reduce((s, b) => s + (b.count ?? 0), 0)
    expect(total).toBeGreaterThan(50)
    expect(trend!.buckets.every(b => b.count === null || b.count >= 0)).toBe(true)
  })

  it('E2 · trend mode returns no rows — an aggregate chart transfers no attendees', async () => {
    const { body } = await call('?trend=7')
    expect(body.registrations).toHaveLength(0)
  })

  // ═══ F · isolation ════════════════════════════════════════════════════════

  it('F · another organizer\'s event is not reachable by id', async () => {
    const { status } = await call('?view=summary', OTHER_SLUG)
    expect(status).toBe(404)
  })

  it('F2 · another organizer\'s registrations are in NO figure', async () => {
    const { body } = await call('?view=summary')
    const s = body.stats as { total: number }
    // 25 foreign rows exist in the same collection; the totals must not have moved.
    expect(s.total).toBe(N)
  })

  it('F3 · an unknown event id is refused, never answered with someone else\'s data', async () => {
    const { status } = await call('?view=summary', `no-such-event-${PID}`)
    expect(status).toBe(404)
  })

  // ═══ G · zero and edge states ═════════════════════════════════════════════

  it('G · an event with no registrations reports real zeros', async () => {
    const empty = `rep02-empty-${PID}`
    await adminDb.doc(`users/${UID}/eventDrafts/${empty}`).set({
      eventDetails: { seo: { urlSlug: empty }, info: { name: 'Empty' } },
      pricing: { passes: [{ id: 'pa', name: 'Pass A', price: 0 }] },
      status: 'published', lifecycleStatus: 'published',
    })
    await adminDb.doc(`events/${empty}`).set({ lifecycleStatus: 'published', uid: UID, draftId: empty })   // RD-CE-FIX C1
    const { body } = await call('?view=summary', empty)
    expect(body.stats).toMatchObject({ total: 0, confirmed: 0, cancelled: 0, pending: 0 })
    // Zero passes sold is a measurement here, not a failed read.
    expect((body.passStats as { confirmed: number | null }[])[0].confirmed).toBe(0)
    await adminDb.doc(`users/${UID}/eventDrafts/${empty}`).delete()
    await adminDb.doc(`events/${empty}`).delete()
  })

  // ═══ H · reads are bounded by PASSES, never by registrations ══════════════

  it('H · summary cost does not grow with the number of registrations', async () => {
    // The breakdown is aggregates, so the response must stay row-free at any size.
    const { body } = await call('?view=summary')
    expect(body.registrations).toHaveLength(0)
    expect((body.passStats as unknown[]).length).toBe(PASSES.length)
    expect((body.stats as { total: number }).total).toBe(N)
  })
})
