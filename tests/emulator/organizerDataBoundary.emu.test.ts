// RD-ANALYTICS-12-17 · both data boundaries, END TO END. REAL Firestore + Auth.
//
// ═══ WHY THIS CANNOT BE A UNIT TEST ══════════════════════════════════════════
// The unit suite pins the STRUCTURE of both gates — the right permission, the null tail, the
// skipped read. What it cannot do is prove that a real `manager`, holding a real
// `teamMembers` row, calling the real handler with a real ID token, receives no money. That
// is three reads deep (verify token → resolve workspace → decide), and a widening or a
// narrowing of a data boundary has to be checked against the thing that actually decides.
//
// So every caller here is a real Auth user with a real token, every membership is a real
// document, and both revenue routes plus the dashboard run unmocked.
//
// ═══ WHAT IT PROVES ══════════════════════════════════════════════════════════
//   A · owner and finance receive `confirmedRevenuePaise`; admin and manager receive null
//   A · null is not zero — an authorized event with no revenue still reports 0
//   A · both routes, because gating only the list would move the gap
//   B · attendeeName survives for every role that holds registrations OR transactions
//   · cross-workspace isolation is unaffected by either change
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID = process.pid
const OWNER_A = `a1217-a-owner-${PID}@rd.test`
const FIN_A   = `a1217-a-fin-${PID}@rd.test`
const MGR_A   = `a1217-a-mgr-${PID}@rd.test`
const ADM_A   = `a1217-a-adm-${PID}@rd.test`
const GATE_A  = `a1217-a-gate-${PID}@rd.test`
const OWNER_B = `a1217-b-owner-${PID}@rd.test`
const PASSWORD = 'Emulator-Passw0rd!'

const PAID_A = `a1217-paid-${PID}`    // workspace A, has revenue
const FREE_A = `a1217-zero-${PID}`    // workspace A, genuinely zero revenue
const EVENT_B = `a1217-b-event-${PID}`
const REVENUE_PAISE = 4_820_000

describeEmu('RD-ANALYTICS-12-17 · organizer data boundaries, end to end', () => {
  let adminDb: FirebaseFirestore.Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let listGET:   typeof import('@/app/api/organizer/events/route').GET
  let detailGET: typeof import('@/app/api/organizer/events/[eventId]/route').GET
  let dashGET:   typeof import('@/app/api/organizer/dashboard/route').GET

  const uid: Record<string, string> = {}
  const token: Record<string, string> = {}
  const users: string[] = []
  const members: string[] = []

  const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
  const KEY  = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'demo-key'

  const signIn = async (email: string): Promise<string> => {
    const r = await fetch(
      `http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }) })
    const j = await r.json() as { idToken?: string }
    if (!j.idToken) throw new Error(`sign-in failed for ${email}`)
    return j.idToken
  }

  const mkUser = async (email: string) => {
    const existing = await adminAuth.getUserByEmail(email).catch(() => null)
    const u = existing ?? await adminAuth.createUser({ email, password: PASSWORD, emailVerified: true })
    await adminAuth.updateUser(u.uid, { password: PASSWORD, emailVerified: true })
    users.push(u.uid); uid[email] = u.uid; token[email] = await signIn(email)
  }

  const member = async (workspaceUid: string, email: string, role: string) => {
    const id = `a1217-${role}-${uid[email]}`
    members.push(id)
    await adminDb.collection('teamMembers').doc(id).set({
      organizerUid: workspaceUid, memberUid: uid[email], email, name: role,
      role, status: 'active', eventIds: [], createdAt: new Date(),
    })
  }

  const seedEvent = async (owner: string, slug: string, revenuePaise: number) => {
    /**
     * The slug lives at `eventDetails.seo.urlSlug`, NOT at the top level.
     *
     * Both routes derive it from there, and a draft without it is listed but never enriched
     * — so every counter-backed figure comes back 0. The first two runs of this file did
     * exactly that and looked like a gating failure; it was the fixture describing a draft
     * shape the product does not use.
     */
    await adminDb.doc(`users/${owner}/eventDrafts/${slug}`).set({
      eventName: slug, status: 'published', updatedAt: new Date(),
      lifecycleStatus: 'published', eventType: 'conference', passes: [],
      eventDetails: { seo: { urlSlug: slug } },
    })
    await adminDb.doc(`events/${slug}`).set({
      uid: owner, draftId: slug, eventName: slug, slug, status: 'published',
    })
    /**
     * A COMPLETE counter, so revenue resolves from it and the ledger fallback is not needed.
     *
     * `eventSlug` and `updatedAt` are part of the RegistrationCounter shape and are not
     * decoration: the first run of this file omitted them and every authorized figure came
     * back 0, which read like a gating bug and was a fixture bug. `statsVersion` must be
     * >= EVENT_STATS_VERSION or `getEventStats` reports the counter incomplete and the route
     * falls through to the ledger aggregate.
     */
    await adminDb.doc(`registrationCounters/${slug}`).set({
      eventSlug: slug, totalCount: 10, revenuePaise, passCounts: {}, checkedInCount: 0,
      statsVersion: 99, updatedAt: new Date(),
    })
  }

  const req = async (url: string, email: string) => {
    const { NextRequest } = await import('next/server')
    return new NextRequest(url, { headers: { Authorization: `Bearer ${token[email]}` } })
  }

  const callList = async (email: string) => {
    const res = await listGET(await req('http://localhost/api/organizer/events?limit=50', email))
    return { status: res.status, body: await res.json() as { events?: Record<string, unknown>[] } }
  }
  const callDetail = async (email: string, slug: string) => {
    const res = await detailGET(
      await req(`http://localhost/api/organizer/events/${slug}`, email),
      { params: Promise.resolve({ eventId: slug }) } as never,
    )
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const callDashboard = async (email: string) => {
    const res = await dashGET(await req('http://localhost/api/organizer/dashboard', email))
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  beforeAll(async () => {
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    listGET   = (await import('@/app/api/organizer/events/route')).GET
    detailGET = (await import('@/app/api/organizer/events/[eventId]/route')).GET
    dashGET   = (await import('@/app/api/organizer/dashboard/route')).GET

    for (const e of [OWNER_A, FIN_A, MGR_A, ADM_A, GATE_A, OWNER_B]) await mkUser(e)
    await member(uid[OWNER_A], FIN_A,  'finance')
    await member(uid[OWNER_A], MGR_A,  'manager')
    await member(uid[OWNER_A], ADM_A,  'admin')
    await member(uid[OWNER_A], GATE_A, 'checkin_staff')

    await seedEvent(uid[OWNER_A], PAID_A, REVENUE_PAISE)
    await seedEvent(uid[OWNER_A], FREE_A, 0)
    await seedEvent(uid[OWNER_B], EVENT_B, 9_990_000)
  }, 600_000)

  afterAll(async () => {
    for (const m of members) await adminDb.collection('teamMembers').doc(m).delete().catch(() => {})
    for (const u of users) await adminAuth.deleteUser(u).catch(() => {})
    for (const [owner, slug] of [[uid[OWNER_A], PAID_A], [uid[OWNER_A], FREE_A], [uid[OWNER_B], EVENT_B]] as const) {
      await adminDb.doc(`users/${owner}/eventDrafts/${slug}`).delete().catch(() => {})
      await adminDb.doc(`events/${slug}`).delete().catch(() => {})
      await adminDb.doc(`registrationCounters/${slug}`).delete().catch(() => {})
    }
  }, 600_000)

  const revenueOf = (body: { events?: Record<string, unknown>[] }, slug: string) =>
    body.events?.find(e => e.draftId === slug)?.confirmedRevenuePaise

  it('0 · the fixture is real — the roles are what the matrix says', async () => {
    const { ROLE_PERMISSIONS } = await import('@/lib/team/types')
    expect(ROLE_PERMISSIONS.finance).toContain('transactions')
    expect(ROLE_PERMISSIONS.manager).not.toContain('transactions')
    expect(ROLE_PERMISSIONS.admin).not.toContain('transactions')
    const snap = await adminDb.collection('teamMembers').doc(`a1217-manager-${uid[MGR_A]}`).get()
    expect(snap.data()?.role).toBe('manager')
  }, 120_000)

  // ── CHANGE A · the event LIST ──────────────────────────────────────────────

  it('1 · A · owner and finance receive the revenue from the list', async () => {
    for (const who of [OWNER_A, FIN_A]) {
      const { status, body } = await callList(who)
      expect(status, who).toBe(200)
      expect(revenueOf(body, PAID_A), who).toBe(REVENUE_PAISE)
    }
  }, 120_000)

  it('2 · A · admin and manager receive NULL — not zero, not the figure', async () => {
    for (const who of [ADM_A, MGR_A]) {
      const { status, body } = await callList(who)
      expect(status, who).toBe(200)
      expect(revenueOf(body, PAID_A), who).toBeNull()
      // The amount must not appear anywhere in the payload.
      expect(JSON.stringify(body), who).not.toContain(String(REVENUE_PAISE))
    }
  }, 120_000)

  it('3 · A · an AUTHORIZED zero is still 0 — the distinction the design turns on', async () => {
    const { body } = await callList(OWNER_A)
    expect(revenueOf(body, FREE_A)).toBe(0)
    // …while the denied caller gets null for the very same event.
    const denied = await callList(MGR_A)
    expect(revenueOf(denied.body, FREE_A)).toBeNull()
  }, 120_000)

  it('4 · A · a denied caller is not told the read failed', async () => {
    const { body } = await callList(MGR_A)
    const ev = body.events?.find(e => e.draftId === PAID_A)
    expect(ev?.revenueUnavailable).toBeFalsy()
    // Non-financial fields are unaffected.
    expect(ev?.totalRegistrations).toBe(10)
    expect(ev?.name).toBeTruthy()
  }, 120_000)

  // ── CHANGE A · the event DETAIL route ──────────────────────────────────────

  /**
   * The detail route's ROLE SET differs from the list's, and that is pre-existing.
   *
   * It authorizes with `authorizeWorkspace(req, 'events')` — untouched by this phase and by
   * RD-ANALYTICS-12-15, which reconciled the analytics routes and the events LIST only. So
   * `finance`, holding no `events`, is refused at the route and never reaches the field gate
   * at all. The gate still matters here for `admin` and `manager`, who DO hold `events` and
   * do not hold `transactions` — and they are the roles the finding was about.
   *
   * Asserted rather than assumed: the first run of this file expected finance to reach it,
   * which would have been a claim that 12-15 widened this route. It did not.
   */
  it('5 · A · the same rule on the detail route — both, or the gap just moves', async () => {
    const owner = await callDetail(OWNER_A, PAID_A)
    expect(owner.status).toBe(200)
    expect(owner.body.confirmedRevenuePaise).toBe(REVENUE_PAISE)

    for (const who of [ADM_A, MGR_A]) {
      const { status, body } = await callDetail(who, PAID_A)
      expect(status, who).toBe(200)
      expect(body.confirmedRevenuePaise, who).toBeNull()
      expect(JSON.stringify(body), who).not.toContain(String(REVENUE_PAISE))
    }

    // finance is refused by the route itself — a different boundary, deliberately unchanged.
    expect((await callDetail(FIN_A, PAID_A)).status).toBe(403)
  }, 120_000)

  it('6 · A · manager gets null from the detail route, and an authorized zero stays 0', async () => {
    expect((await callDetail(MGR_A, PAID_A)).body.confirmedRevenuePaise).toBeNull()
    expect((await callDetail(OWNER_A, FREE_A)).body.confirmedRevenuePaise).toBe(0)
  }, 120_000)

  /**
   * RD-ANALYTICS-12-20 · the deprecated alias is gone from the WIRE, not merely from the
   * types. 12-19 emitted it for one deploy and proved it identical here; this case is the
   * mirror image — the key must no longer be present at all, asserted on real payloads
   * because a type-level removal would still compile if a literal kept emitting it.
   */
  it('6b · the removed alias is absent from real payloads, authorized and denied', async () => {
    const owner = await callList(OWNER_A)
    const oEv = owner.body.events?.find(e => e.draftId === PAID_A)
    expect(oEv?.confirmedRevenuePaise).toBe(REVENUE_PAISE)
    expect(oEv).not.toHaveProperty('estimatedRevenue')

    const mgr = await callList(MGR_A)
    const mEv = mgr.body.events?.find(e => e.draftId === PAID_A)
    // The canonical field still denies, and no alias survives to route around it.
    expect(mEv?.confirmedRevenuePaise).toBeNull()
    expect(mEv).not.toHaveProperty('estimatedRevenue')

    const d = await callDetail(OWNER_A, PAID_A)
    expect(d.body.confirmedRevenuePaise).toBe(REVENUE_PAISE)
    expect(d.body).not.toHaveProperty('estimatedRevenue')
  }, 120_000)

  it('7 · gate roles reach neither route at all', async () => {
    expect((await callList(GATE_A)).status).toBe(403)
    expect((await callDetail(GATE_A, PAID_A)).status).toBe(403)
  }, 120_000)

  // ── Cross-workspace, unaffected by either change ───────────────────────────

  it('8 · workspace A never sees workspace B\'s event or its revenue', async () => {
    for (const who of [OWNER_A, FIN_A, ADM_A, MGR_A]) {
      const { body } = await callList(who)
      const ids = (body.events ?? []).map(e => e.draftId)
      expect(ids, who).not.toContain(EVENT_B)
      expect(JSON.stringify(body), who).not.toContain('9990000')
    }
    // And B's owner, who IS entitled to money, sees only their own.
    const b = await callList(OWNER_B)
    expect(revenueOf(b.body, EVENT_B)).toBe(9_990_000)
    expect((b.body.events ?? []).map(e => e.draftId)).not.toContain(PAID_A)
  }, 180_000)

  // ── CHANGE B · attendee names ──────────────────────────────────────────────

  it('9 · B · every role that reaches the dashboard still gets names — nobody lost access', async () => {
    const { ROLE_PERMISSIONS } = await import('@/lib/team/types')
    for (const [who, role] of [[OWNER_A, 'owner'], [FIN_A, 'finance'], [ADM_A, 'admin'], [MGR_A, 'manager']] as const) {
      const p = ROLE_PERMISSIONS[role] as string[]
      // The union is what makes this true for finance, which holds no `registrations`.
      expect(p.includes('registrations') || p.includes('transactions'), role).toBe(true)
      const { status } = await callDashboard(who)
      expect(status, role).toBe(200)
    }
  }, 180_000)

  it('10 · B · a gate role reaches the dashboard not at all', async () => {
    expect((await callDashboard(GATE_A)).status).toBe(403)
  }, 120_000)

  it('11 · B · the dashboard payload never carries an attendee email or phone', async () => {
    // RD-DASH-12 removed the email; this phase must not have re-introduced any PII beside it.
    const { body } = await callDashboard(OWNER_A)
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('attendeeEmail')
    expect(raw).not.toContain('attendeePhone')
  }, 120_000)

  it('12 · B · and the dashboard\'s money gate is untouched by this phase', async () => {
    const owner   = await callDashboard(OWNER_A)
    const manager = await callDashboard(MGR_A)
    expect((owner.body.finance as { allowed: boolean }).allowed).toBe(true)
    expect((manager.body.finance as { allowed: boolean }).allowed).toBe(false)
  }, 120_000)
})
