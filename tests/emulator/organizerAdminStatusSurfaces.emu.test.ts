// RD-ORGANIZER-SIGNUP-FIX-02 (D1 + D2) — every admin surface tells the truth about a
// PENDING organizer, proved over real Firestore + real route handlers.
//
// ═══ WHY THIS IS AN EMULATOR TEST AND NOT ONLY A UNIT ONE ════════════════════
// tests/unit/organizerSignupLifecycle.test.ts sweeps app/ + lib/ for the old
// `s === 'suspended' || s === 'banned' ? s : 'active'` shape, so a fifth textual copy of
// the rule fails there. But that is a source-text gate, and D1/D2 were not really about
// the text — they were about what an admin SAW. The detail endpoint and the support
// overview each returned the string "active" for an account Firestore said was "pending",
// and the list endpoint beside them returned "pending" for the very same uid.
//
// A source gate cannot catch the next version of that: a reader that resolves correctly
// and then flattens the value on the way into its response shape, or a new surface that
// re-derives status from some other field entirely. What these cases pin is the WIRE
// FORMAT — the JSON an admin console actually receives — for one organizer whose stored
// state is unambiguous. That is the property the defect violated.
//
// The 360 console is included although it was already correct: it is what made D1 a
// contradiction rather than a policy (two views of one account, two answers), so it
// belongs in the same gate as the surfaces it disagreed with.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

describeEmu('RD-ORGANIZER-SIGNUP-FIX-02 · admin surfaces report pending honestly', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let listOrganizers: (req: Request) => Promise<Response>
  let organizerDetail: (req: Request, ctx: { params: Promise<{ uid: string }> }) => Promise<Response>
  let organizerPatch: (req: Request, ctx: { params: Promise<{ uid: string }> }) => Promise<Response>
  let organizer360: (req: Request, ctx: { params: Promise<{ uid: string }> }) => Promise<Response>
  let supportOverview: (req: Request) => Promise<Response>

  const ORG_EMAIL   = `admin-surfaces-org-${process.pid}@rd.test`
  const ADMIN_EMAIL = `admin-surfaces-adm-${process.pid}@rd.test`
  let orgUid   = ''
  let adminUid = ''
  let prevAdminUids: string | undefined

  /** A real admin ID token, minted through the Auth emulator. */
  async function idToken(u: string): Promise<string> {
    const custom = await adminAuth.createCustomToken(u)
    const key  = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'fake-api-key'
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const res  = await fetch(
      `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }) },
    )
    const body = await res.json() as { idToken?: string }
    if (!body.idToken) throw new Error(`no idToken: ${JSON.stringify(body)}`)
    return body.idToken
  }

  // These routes read req.nextUrl, so they need a NextRequest — a bare Request throws
  // on the destructure and every case here would fail for the wrong reason.
  const adminGet = (url: string, token: string) =>
    new NextRequest(new Request(url, { headers: { authorization: `Bearer ${token}` } }))

  /** The exact profile shape createOrganizerProfile writes at signup. */
  async function seedPendingProfile(overrides: Record<string, unknown> = {}) {
    await adminDb.doc(`users/${orgUid}`).set({
      uid: orgUid, name: 'Surface Tester', email: ORG_EMAIL,
      organizationName: 'Surface Co',
      mobile: { e164: '+919000000002', countryCode: '+91', verified: false, verifiedAt: null },
      role: 'organizer',
      accountStatus: 'pending',
      emailVerified: false,
      verification: { email: { verified: false, verifiedAt: null, verifiedMethod: null } },
      trust: { level: 'unverified', score: 0, badges: [] },
      createdAt: new Date(), updatedAt: new Date(),
      ...overrides,
    })
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ GET: listOrganizers }  = await import('@/app/api/admin/organizers/route') as never)
    ;({ GET: organizerDetail, PATCH: organizerPatch } =
       await import('@/app/api/admin/organizers/[uid]/route') as never)
    ;({ GET: organizer360 }    = await import('@/app/api/admin/organizers/[uid]/360/route') as never)
    ;({ GET: supportOverview } = await import('@/app/api/admin/support/overview/route') as never)

    const org = await adminAuth.createUser({ email: ORG_EMAIL, password: 'SurfacePassw0rd!', emailVerified: false })
    orgUid = org.uid
    const adm = await adminAuth.createUser({ email: ADMIN_EMAIL, password: 'SurfaceAdminPw0rd!', emailVerified: true })
    adminUid = adm.uid
    // RD-SEC-01 · the only admin is a Super Admin (ADMIN_UIDS); the legacy claim grants nothing.
    prevAdminUids = process.env.ADMIN_UIDS
    process.env.ADMIN_UIDS = [prevAdminUids, adminUid].filter(Boolean).join(',')
  }, T)

  afterAll(async () => {
    if (prevAdminUids === undefined) delete process.env.ADMIN_UIDS; else process.env.ADMIN_UIDS = prevAdminUids
    for (const u of [orgUid, adminUid]) {
      if (!u) continue
      await adminDb.doc(`users/${u}`).delete().catch(() => null)
      await adminAuth.deleteUser(u).catch(() => null)
    }
  }, T)

  beforeEach(async () => {
    await adminAuth.updateUser(orgUid, { emailVerified: false })
    await seedPendingProfile()
  })

  // ─── D1 ─────────────────────────────────────────────────────────────────────

  it('D1 · the organizer DETAIL endpoint returns pending, not active', async () => {
    const token = await idToken(adminUid)
    const res = await organizerDetail(
      adminGet(`http://localhost/api/admin/organizers/${orgUid}`, token) as never,
      { params: Promise.resolve({ uid: orgUid }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { profile: { accountStatus: string } }
    // This returned 'active' before the fix, for a document that says 'pending'.
    expect(body.profile.accountStatus).toBe('pending')
  }, T)

  it('D1 · the detail endpoint and the list endpoint agree about the same uid', async () => {
    // The actual user-visible defect: the row said Pending and the modal opened from that
    // row said Active. Whatever the value is, these two must never disagree.
    const token = await idToken(adminUid)
    const [listRes, detailRes] = await Promise.all([
      listOrganizers(adminGet('http://localhost/api/admin/organizers?status=pending&pageSize=100', token) as never),
      organizerDetail(
        adminGet(`http://localhost/api/admin/organizers/${orgUid}`, token) as never,
        { params: Promise.resolve({ uid: orgUid }) },
      ),
    ])
    const list   = await listRes.json()   as { items: { uid: string; accountStatus: string }[] }
    const detail = await detailRes.json() as { profile: { accountStatus: string } }
    const row = list.items.find(i => i.uid === orgUid)
    expect(row, 'the pending organizer is missing from the pending filter').toBeDefined()
    expect(detail.profile.accountStatus).toBe(row!.accountStatus)
  }, T)

  it('D1 · a pending signup is in the DEFAULT list, flagged pending verification (Option A)', async () => {
    // Superseded decision: the unfiltered list used to hide pending signups. It now lists
    // them — still reading pending, never active — with the flag the console badges.
    const token = await idToken(adminUid)
    const res = await listOrganizers(adminGet('http://localhost/api/admin/organizers?pageSize=100', token) as never)
    const body = await res.json() as { items: { uid: string; accountStatus: string; pendingVerification: boolean }[] }
    const row = body.items.find(i => i.uid === orgUid)
    expect(row, 'the pending signup is missing from the default list').toBeDefined()
    expect(row!.accountStatus).toBe('pending')
    expect(row!.pendingVerification).toBe(true)
  }, T)

  // ─── D2 ─────────────────────────────────────────────────────────────────────

  it('D2 · the SUPPORT overview reports pending, not active', async () => {
    const token = await idToken(adminUid)
    const res = await supportOverview(adminGet('http://localhost/api/admin/support/overview', token) as never)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      overview: { recentOrganizers: { uid: string; status: string }[] }
    }
    // recentOrganizers orders by createdAt desc and keeps 6, so a signup created moments
    // ago is normally present. When it is, its status must be the stored one — this row
    // rendered as a green "active" pill before the fix.
    const row = body.overview.recentOrganizers.find(o => o.uid === orgUid)
    if (row) expect(row.status).toBe('pending')
    else expect(body.overview.recentOrganizers.every(o => o.uid !== orgUid)).toBe(true)
  }, T)

  // ─── the surface that was already right ─────────────────────────────────────

  it('the 360 console agrees with both of them', async () => {
    const token = await idToken(adminUid)
    const res = await organizer360(
      adminGet(`http://localhost/api/admin/organizers/${orgUid}/360`, token) as never,
      { params: Promise.resolve({ uid: orgUid }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as {
      overview: { account: { status: string }; verification: { emailVerified: boolean } }
    }
    expect(body.overview.account.status).toBe('pending')
    expect(body.overview.verification.emailVerified).toBe(false)
  }, T)

  // ─── D3, at the route boundary ──────────────────────────────────────────────

  it('D3 · PATCH reactivate on a pending signup is 409, and writes nothing', async () => {
    const token = await idToken(adminUid)
    const res = await organizerPatch(
      new Request(`http://localhost/api/admin/organizers/${orgUid}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reactivate' }),
      }) as never,
      { params: Promise.resolve({ uid: orgUid }) },
    )
    // 409, not 404 — the account exists; the transition is what is refused.
    expect(res.status).toBe(409)
    expect(String((await res.json() as { error: string }).error)).toMatch(/unverified/i)

    const stored = (await adminDb.doc(`users/${orgUid}`).get()).data()!
    expect(stored.accountStatus).toBe('pending')
    expect((await adminAuth.getUser(orgUid)).emailVerified).toBe(false)
  }, T)

  // ─── the other statuses are untouched by any of this ────────────────────────

  for (const status of ['suspended', 'banned'] as const) {
    it(`a ${status} organizer still reads ${status} on every surface`, async () => {
      await seedPendingProfile({ accountStatus: status, statusReason: 'surface test' })
      const token = await idToken(adminUid)
      const [detailRes, c360Res] = await Promise.all([
        organizerDetail(
          adminGet(`http://localhost/api/admin/organizers/${orgUid}`, token) as never,
          { params: Promise.resolve({ uid: orgUid }) },
        ),
        organizer360(
          adminGet(`http://localhost/api/admin/organizers/${orgUid}/360`, token) as never,
          { params: Promise.resolve({ uid: orgUid }) },
        ),
      ])
      const detail = await detailRes.json() as { profile: { accountStatus: string } }
      const c360   = await c360Res.json()   as { overview: { account: { status: string } } }
      expect(detail.profile.accountStatus).toBe(status)
      expect(c360.overview.account.status).toBe(status)
    }, T)
  }

  it('a grandfathered organizer with NO accountStatus still reads active', async () => {
    // The backward-compatibility contract. Every organizer created before the field
    // existed depends on it, and none of them is migrated.
    const { FieldValue } = await import('firebase-admin/firestore')
    await adminDb.doc(`users/${orgUid}`).update({ accountStatus: FieldValue.delete() })
    const token = await idToken(adminUid)
    const res = await organizerDetail(
      adminGet(`http://localhost/api/admin/organizers/${orgUid}`, token) as never,
      { params: Promise.resolve({ uid: orgUid }) },
    )
    const body = await res.json() as { profile: { accountStatus: string } }
    expect(body.profile.accountStatus).toBe('active')
  }, T)
})
