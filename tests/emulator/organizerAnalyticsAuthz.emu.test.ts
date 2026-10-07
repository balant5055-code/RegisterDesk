// RD-ANALYTICS-12-15 · Organizer Analytics authorization, END TO END. REAL Firestore + Auth.
//
// ═══ WHY THIS CANNOT BE A UNIT TEST ══════════════════════════════════════════
// The unit suite mocks `authorizeAnyWorkspace` with the rule the real one implements. That
// proves the ROUTE honours the rule; it cannot prove the rule itself, because the real one
// is three reads deep: verify a Firebase ID token, read `teamMembers` to find the caller's
// workspace and role, then decide. A widening — which is what this phase is — has to be
// checked against the thing that actually decides in production.
//
// So every caller here is a REAL Auth user with a REAL ID token, every membership is a REAL
// Firestore document, and the REAL route handlers run. Nothing about authorization is
// stubbed: `verifyCaller`, `resolveWorkspaceUid`, `isCheckinOnlyRole` and the route are all
// the shipping code.
//
// ═══ WHAT IT PROVES ══════════════════════════════════════════════════════════
//   • finance reaches Analytics WITHOUT holding `events`            (the phase's purpose)
//   • gate roles are still refused, before any read                 (nothing widened)
//   • workspace A cannot read workspace B's event                   (isolation intact)
//   • manager receives NO money; owner and finance do               (the money boundary)
//   • the event list finance needs is workspace-scoped              (the dependency)
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const PID = process.pid
const WS_A_OWNER = `a1215-a-owner-${PID}@rd.test`
const WS_A_FIN   = `a1215-a-fin-${PID}@rd.test`
const WS_A_MGR   = `a1215-a-mgr-${PID}@rd.test`
const WS_A_GATE  = `a1215-a-gate-${PID}@rd.test`
const WS_A_LEAD  = `a1215-a-lead-${PID}@rd.test`
const WS_B_OWNER = `a1215-b-owner-${PID}@rd.test`
const PASSWORD   = 'Emulator-Passw0rd!'

const SLUG_A  = `a1215-event-a-${PID}`
const SLUG_B  = `a1215-event-b-${PID}`

describeEmu('RD-ANALYTICS-12-15 · Organizer Analytics authorization, end to end', () => {
  let adminDb: FirebaseFirestore.Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let overviewGET: typeof import('@/app/api/organizer/analytics/overview/[eventId]/route').GET
  let eventsGET:   typeof import('@/app/api/organizer/events/route').GET

  const uid: Record<string, string> = {}
  const token: Record<string, string> = {}
  const created: string[] = []

  const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
  const KEY  = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'demo-key'

  /** A real ID token from the Auth emulator — the same credential the browser sends. */
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
    // `emailVerified` matters: verifyCaller refuses an unverified token outright.
    const u = existing ?? await adminAuth.createUser({ email, password: PASSWORD, emailVerified: true })
    await adminAuth.updateUser(u.uid, { password: PASSWORD, emailVerified: true })
    created.push(u.uid)
    uid[email] = u.uid
    token[email] = await signIn(email)
    return u.uid
  }

  /** A real teamMembers row — what resolveWorkspaceUid actually reads. */
  const member = async (workspaceUid: string, email: string, role: string) => {
    const id = `a1215-${role}-${uid[email]}`
    created.push(`tm:${id}`)
    await adminDb.collection('teamMembers').doc(id).set({
      organizerUid: workspaceUid, memberUid: uid[email], email, name: role,
      role, status: 'active', eventIds: [], createdAt: new Date(),
    })
  }

  const callOverview = async (email: string, slug: string) => {
    const { NextRequest } = await import('next/server')
    const res = await overviewGET(
      new NextRequest(`http://localhost/api/organizer/analytics/overview/${slug}`, {
        headers: { Authorization: `Bearer ${token[email]}` },
      }),
      { params: Promise.resolve({ eventId: slug }) },
    )
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  const callEvents = async (email: string) => {
    const { NextRequest } = await import('next/server')
    const res = await eventsGET(new NextRequest('http://localhost/api/organizer/events?limit=50', {
      headers: { Authorization: `Bearer ${token[email]}` },
    }))
    return { status: res.status, body: await res.json() as { events?: { draftId: string }[] } }
  }

  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ adminAuth } = await import('@/lib/firebase/admin'))
    overviewGET = (await import('@/app/api/organizer/analytics/overview/[eventId]/route')).GET
    eventsGET   = (await import('@/app/api/organizer/events/route')).GET

    for (const e of [WS_A_OWNER, WS_A_FIN, WS_A_MGR, WS_A_GATE, WS_A_LEAD, WS_B_OWNER]) await mkUser(e)

    // Workspace A = the owner's own uid. The other four are members of it.
    await member(uid[WS_A_OWNER], WS_A_FIN,  'finance')
    await member(uid[WS_A_OWNER], WS_A_MGR,  'manager')
    await member(uid[WS_A_OWNER], WS_A_GATE, 'checkin_staff')
    await member(uid[WS_A_OWNER], WS_A_LEAD, 'checkin_lead')

    // One event per workspace: a draft (ownership by path) + the published bridge doc that
    // `resolveAnalyticsEventIdentity` reads.
    for (const [owner, slug] of [[uid[WS_A_OWNER], SLUG_A], [uid[WS_B_OWNER], SLUG_B]] as const) {
      await adminDb.doc(`users/${owner}/eventDrafts/${slug}`).set({
        eventName: slug, status: 'published', slug, updatedAt: new Date(),
        lifecycleStatus: 'published', eventType: 'conference',
      })
      await adminDb.doc(`events/${slug}`).set({
        uid: owner, draftId: slug, eventName: slug, slug,
        eventType: 'conference', status: 'published',
      })
    }
  }, 600_000)

  afterAll(async () => {
    for (const c of created) {
      if (c.startsWith('tm:')) await adminDb.collection('teamMembers').doc(c.slice(3)).delete().catch(() => {})
      else await adminAuth.deleteUser(c).catch(() => {})
    }
    for (const [owner, slug] of [[uid[WS_A_OWNER], SLUG_A], [uid[WS_B_OWNER], SLUG_B]] as const) {
      await adminDb.doc(`users/${owner}/eventDrafts/${slug}`).delete().catch(() => {})
      await adminDb.doc(`events/${slug}`).delete().catch(() => {})
    }
  }, 600_000)

  // ── The premise ────────────────────────────────────────────────────────────

  it('0 · the fixture is real — finance genuinely holds no `events`', async () => {
    const { ROLE_PERMISSIONS } = await import('@/lib/team/types')
    expect(ROLE_PERMISSIONS.finance).not.toContain('events')
    expect(ROLE_PERMISSIONS.manager).not.toContain('transactions')
    const snap = await adminDb.collection('teamMembers').doc(`a1215-finance-${uid[WS_A_FIN]}`).get()
    expect(snap.exists).toBe(true)
    expect(snap.data()?.role).toBe('finance')
  }, 120_000)

  // ── Who may open Analytics ─────────────────────────────────────────────────

  it('1 · owner A, finance A and manager A all reach event A', async () => {
    for (const who of [WS_A_OWNER, WS_A_FIN, WS_A_MGR]) {
      const { status } = await callOverview(who, SLUG_A)
      expect(status, who).toBe(200)
    }
  }, 120_000)

  it('2 · finance reached it WITHOUT the events permission — the point of the phase', async () => {
    const { status, body } = await callOverview(WS_A_FIN, SLUG_A)
    expect(status).toBe(200)
    expect(body.success).toBe(true)
  }, 120_000)

  it('3 · gate roles are refused — both of them, by the real matrix', async () => {
    for (const who of [WS_A_GATE, WS_A_LEAD]) {
      const { status, body } = await callOverview(who, SLUG_A)
      expect(status, who).toBe(403)
      expect(JSON.stringify(body), who).not.toMatch(/analytics|paise|revenue/i)
    }
  }, 120_000)

  it('4 · an unauthenticated request is refused', async () => {
    const { NextRequest } = await import('next/server')
    const res = await overviewGET(
      new NextRequest(`http://localhost/api/organizer/analytics/overview/${SLUG_A}`),
      { params: Promise.resolve({ eventId: SLUG_A }) },
    )
    expect(res.status).toBe(401)
  }, 120_000)

  // ── Cross-workspace isolation ──────────────────────────────────────────────

  it('5 · NO workspace-A role can read workspace B\'s event', async () => {
    for (const who of [WS_A_OWNER, WS_A_FIN, WS_A_MGR]) {
      const { status, body } = await callOverview(who, SLUG_B)
      expect(status, who).toBe(403)
      expect(JSON.stringify(body), who).not.toContain('analytics')
    }
  }, 120_000)

  it('6 · and workspace B\'s owner reads B but not A', async () => {
    expect((await callOverview(WS_B_OWNER, SLUG_B)).status).toBe(200)
    expect((await callOverview(WS_B_OWNER, SLUG_A)).status).toBe(403)
  }, 120_000)

  it('7 · a non-existent event answers exactly as a foreign one', async () => {
    const absent   = await callOverview(WS_A_FIN, `no-such-event-${PID}`)
    const foreign  = await callOverview(WS_A_FIN, SLUG_B)
    expect(absent.status).toBe(foreign.status)
    expect(absent.body).toEqual(foreign.body)
  }, 120_000)

  // ── The money boundary ─────────────────────────────────────────────────────

  it('8 · owner and finance receive the financial half; manager does NOT', async () => {
    const owner   = await callOverview(WS_A_OWNER, SLUG_A)
    const finance = await callOverview(WS_A_FIN,   SLUG_A)
    const manager = await callOverview(WS_A_MGR,   SLUG_A)

    const allowed = (b: Record<string, unknown>) =>
      (b.analytics as { financialAllowed?: boolean } | undefined)?.financialAllowed
    const revenue = (b: Record<string, unknown>) =>
      (b.analytics as { revenue?: unknown } | undefined)?.revenue

    expect(allowed(owner.body)).toBe(true)
    expect(allowed(finance.body)).toBe(true)
    expect(allowed(manager.body)).toBe(false)

    // ABSENT, not zeroed — the reads were never issued for the manager.
    expect(revenue(manager.body)).toBeUndefined()
    expect(revenue(owner.body)).toBeDefined()
  }, 120_000)

  it('9 · the manager payload carries no money field at all', async () => {
    const { body } = await callOverview(WS_A_MGR, SLUG_A)
    const raw = JSON.stringify(body)
    expect(raw).not.toMatch(/"revenue"/)
    expect(raw).not.toMatch(/"spend"/)
    expect(raw).not.toMatch(/Paise/)
  }, 120_000)

  // ── The event list the selector depends on ─────────────────────────────────

  it('10 · finance can list workspace A\'s events — the selector dependency', async () => {
    const { status, body } = await callEvents(WS_A_FIN)
    expect(status).toBe(200)
    expect(body.events?.some(e => e.draftId === SLUG_A)).toBe(true)
  }, 120_000)

  it('11 · and that list is workspace-scoped — B\'s event never appears in A\'s', async () => {
    for (const who of [WS_A_OWNER, WS_A_FIN, WS_A_MGR]) {
      const { body } = await callEvents(who)
      const ids = (body.events ?? []).map(e => e.draftId)
      expect(ids, who).not.toContain(SLUG_B)
    }
    const b = await callEvents(WS_B_OWNER)
    expect((b.body.events ?? []).map(e => e.draftId)).not.toContain(SLUG_A)
  }, 120_000)

  it('12 · gate roles cannot list events either', async () => {
    for (const who of [WS_A_GATE, WS_A_LEAD]) {
      expect((await callEvents(who)).status, who).toBe(403)
    }
  }, 120_000)
})
