// RD-FIN-SCOPE-01 · Finance follows the Event Selector, on REAL Firestore (private emulator).
//
// The organizer's two events (A, B) and another organizer's event (X) each have ledger rows. The REAL
// ledger and analytics routes are called with the Event Selector's draft id:
//
//   • All events (absent / '__all__')  → A + B, never X
//   • eventId = A                      → only A's rows and totals;  B likewise; no leak either way
//   • the refunds filter and paging stay inside the event
//   • X's draft id, an unknown id, a malformed id → 404 (never widened to all events)
//   • an owned but never-published draft → 409 (it can have no finance records)
//   • the analytics route's existing eventSlug ownership gate still answers 403
//
// No money is moved: rows are fixtures; the routes are read-only.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const ORG = `fes-org-${P}`, OTHER = `fes-other-${P}`

const h = vi.hoisted(() => ({ uid: '' }))
vi.mock('@/lib/team/workspace', async orig => ({
  ...(await orig<typeof import('@/lib/team/workspace')>()),
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: h.uid, callerUid: h.uid, role: 'owner', permissions: ['transactions'], isOwner: true, eventIds: [], isStaffCredential: false }),
}))

type Body = Record<string, unknown>
const DA = `fesDA${P}`, DB = `fesDB${P}`, DX = `fesDX${P}`, DU = `fesDU${P}`
const SA = `fes-a-${P}`, SB = `fes-b-${P}`, SX = `fes-x-${P}`

describeEmu('RD-FIN-SCOPE-01 · finance event scope (real Firestore)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let txGET: (r: NextRequest) => Promise<Response>
  let anGET: (r: NextRequest) => Promise<Response>
  const paths: string[] = []

  async function event(uid: string, draftId: string, slug: string | null, name: string) {
    paths.push(`users/${uid}/eventDrafts/${draftId}`)
    await db.doc(`users/${uid}/eventDrafts/${draftId}`).set({ status: slug ? 'published' : 'draft', eventDetails: { info: { name }, ...(slug ? { seo: { urlSlug: slug } } : {}) } })
    if (slug) { paths.push(`events/${slug}`); await db.doc(`events/${slug}`).set({ uid, draftId, slug, lifecycleStatus: 'published' }) }
  }
  async function ptx(id: string, uid: string, slug: string, gross: number, paidAt: string, extra: Body = {}) {
    const { Timestamp } = await import('firebase-admin/firestore')
    paths.push(`platformTransactions/${id}`)
    await db.doc(`platformTransactions/${id}`).set({
      organizerUid: uid, entityId: slug, entityType: 'event', type: 'event_registration', category: 'ticketed', status: 'completed',
      grossAmountPaise: gross, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
      netSettlementPaise: gross, sourceId: `reg-${id}`, paidAt: Timestamp.fromDate(new Date(paidAt)), ...extra,
    })
  }
  const call = async (fn: (r: NextRequest) => Promise<Response>, path: string, uid = ORG) => {
    h.uid = uid
    const res = await fn(new NextRequest(`http://localhost${path}`, { headers: { authorization: 'Bearer t' } }))
    return { status: res.status, body: await res.json() as Body }
  }
  const ids = (b: Body) => (b.transactions as { id: string }[]).map(t => t.id).sort()
  const gross = (b: Body) => ((b.ledger as { grossPaise: { ok: boolean; paise?: number } }).grossPaise)

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ GET: txGET } = await import('@/app/api/organizer/finance/transactions/route') as never)
    ;({ GET: anGET } = await import('@/app/api/organizer/finance/analytics/route') as never)
    await event(ORG, DA, SA, 'Event A')
    await event(ORG, DB, SB, 'Event B')
    await event(ORG, DU, null, 'Unpublished')
    await event(OTHER, DX, SX, 'Foreign X')
    await ptx(`fes-a1-${P}`, ORG, SA, 10_000, '2026-10-01T10:00:00Z')
    await ptx(`fes-a2-${P}`, ORG, SA, 20_000, '2026-10-03T10:00:00Z')
    await ptx(`fes-a3-${P}`, ORG, SA, 30_000, '2026-10-02T10:00:00Z', { status: 'refunded' })
    await ptx(`fes-b1-${P}`, ORG, SB, 50_000, '2026-10-04T10:00:00Z')
    await ptx(`fes-x1-${P}`, OTHER, SX, 99_000, '2026-10-05T10:00:00Z')
  }, T)
  afterAll(async () => { for (const p of paths) await db.doc(p).delete().catch(() => null) }, T)

  // ── ledger ──────────────────────────────────────────────────────────────────
  it('All events (absent and explicit) = A + B rows, never another organizer\'s', async () => {
    for (const q of ['', '&eventId=__all__']) {
      const r = await call(txGET, `/api/organizer/finance/transactions?filter=all&limit=50${q}`)
      expect(r.status).toBe(200)
      expect(ids(r.body)).toEqual([`fes-a1-${P}`, `fes-a2-${P}`, `fes-a3-${P}`, `fes-b1-${P}`].sort())
      expect(r.body.scope).toMatchObject({ eventSlug: null })
    }
  }, T)

  it('eventId = A → only A, newest first; eventId = B → only B (no leak either way)', async () => {
    const a = await call(txGET, `/api/organizer/finance/transactions?filter=all&limit=50&eventId=${DA}`)
    expect(a.status).toBe(200)
    expect((a.body.transactions as { id: string }[]).map(t => t.id)).toEqual([`fes-a2-${P}`, `fes-a3-${P}`, `fes-a1-${P}`])
    expect(a.body.scope).toMatchObject({ eventId: DA, eventSlug: SA, truncated: false })
    const b = await call(txGET, `/api/organizer/finance/transactions?filter=all&limit=50&eventId=${DB}`)
    expect(ids(b.body)).toEqual([`fes-b1-${P}`])
  }, T)

  it('the refunds filter and paging stay inside the selected event', async () => {
    const r = await call(txGET, `/api/organizer/finance/transactions?filter=refunds&limit=50&eventId=${DA}`)
    expect(ids(r.body)).toEqual([`fes-a3-${P}`])
    const p1 = await call(txGET, `/api/organizer/finance/transactions?filter=all&limit=2&eventId=${DA}`)
    expect((p1.body.transactions as { id: string }[]).map(t => t.id)).toEqual([`fes-a2-${P}`, `fes-a3-${P}`])
    expect(p1.body).toMatchObject({ hasMore: true, nextCursor: `fes-a3-${P}` })
    const p2 = await call(txGET, `/api/organizer/finance/transactions?filter=all&limit=2&eventId=${DA}&cursor=fes-a3-${P}`)
    expect((p2.body.transactions as { id: string }[]).map(t => t.id)).toEqual([`fes-a1-${P}`])
    expect(p2.body).toMatchObject({ hasMore: false, nextCursor: null })
  }, T)

  it('a foreign, unknown or malformed event id is refused (404) — never widened to all events', async () => {
    for (const bad of [DX, `nope${P}`, '../etc', 'a%20b']) {
      const r = await call(txGET, `/api/organizer/finance/transactions?filter=all&limit=50&eventId=${encodeURIComponent(bad)}`)
      expect(r.status, bad).toBe(404)
      expect(r.body.transactions).toBeUndefined()
    }
  }, T)

  it('an owned but never-published event answers 409 (no finance records can exist)', async () => {
    const r = await call(txGET, `/api/organizer/finance/transactions?filter=all&limit=50&eventId=${DU}`)
    expect(r).toMatchObject({ status: 409, body: { code: 'EVENT_NOT_PUBLISHED' } })
  }, T)

  // ── analytics (Finance Control Center) ──────────────────────────────────────
  it('analytics totals follow the selected event; All events sums only this organizer', async () => {
    const all = await call(anGET, '/api/organizer/finance/analytics?eventId=__all__')
    expect(all.status).toBe(200)
    expect(gross(all.body)).toEqual({ ok: true, paise: 110_000 })               // A 60k + B 50k, never X
    const a = await call(anGET, `/api/organizer/finance/analytics?eventId=${DA}`)
    expect(gross(a.body)).toEqual({ ok: true, paise: 60_000 })
    expect(a.body.scope).toMatchObject({ eventSlug: SA })
    const b = await call(anGET, `/api/organizer/finance/analytics?eventId=${DB}`)
    expect(gross(b.body)).toEqual({ ok: true, paise: 50_000 })
  }, T)

  it('analytics refuses a foreign / unpublished event id, and keeps its eventSlug gate (403)', async () => {
    expect((await call(anGET, `/api/organizer/finance/analytics?eventId=${DX}`)).status).toBe(404)
    expect((await call(anGET, `/api/organizer/finance/analytics?eventId=${DU}`)).status).toBe(409)
    expect((await call(anGET, `/api/organizer/finance/analytics?eventSlug=${SX}`)).status).toBe(403)
  }, T)

  it('the other organizer sees only its own event through the same routes', async () => {
    const x = await call(txGET, `/api/organizer/finance/transactions?filter=all&limit=50&eventId=${DX}`, OTHER)
    expect(ids(x.body)).toEqual([`fes-x1-${P}`])
    expect((await call(txGET, `/api/organizer/finance/transactions?filter=all&limit=50&eventId=${DA}`, OTHER)).status).toBe(404)
  }, T)
})
