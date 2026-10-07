// RD-SEC-01 — final security & authorization audit: regression pins for every fix.
//
// REAL Firestore + REAL Auth-emulator ID tokens; the real route handlers. No identity mocks.
// Email is stubbed (nothing leaves the process); no payment provider is reachable.
//
//   ROLE   exactly two roles — a legacy `admin: true` claim, `isAdmin`, `role` and profile
//          fields grant NOTHING; only ADMIN_UIDS is a Super Admin
//   TEN    tenant isolation — campaign publish cannot take over another organizer's campaign;
//          certificate settings/template cannot be reached through a re-used draft id
//   ESC    a gate (staff) credential cannot promote itself to workspace owner; a check-in
//          member cannot schedule attendee emails (reminders need 'broadcasts')
//   AUTH   send-otp hourly window survives in-window sends; a moderated organizer's API key
//          is refused; the dev WhatsApp test route is closed to anonymous and to production

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `sec01-${process.pid}`
const PASSWORD = 'Sec01Passw0rd!'
const SUPER = `${P}-super`

const sent = vi.hoisted(() => ({ emails: 0 }))
vi.mock('@/lib/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notifications')>()
  return { ...actual, notificationEngine: { send: async () => { sent.emails++; return { success: true, messageId: 'stub' } } } }
})
vi.mock('@/lib/razorpay/client', () => new Proxy({}, { get(_t, k) {
  if (k === 'then' || typeof k === 'symbol') return undefined
  if (k === 'RAZORPAY_KEY_ID' || k === 'RAZORPAY_KEY_SECRET') return 'rzp_test_sec01'
  throw new Error('payment provider touched')
} }))

async function idToken(email: string): Promise<string> {
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  })
  return (await r.json() as { idToken: string }).idToken
}
const req = (url: string, method: string, token?: string, body?: unknown) => new NextRequest(`http://localhost${url}`, {
  method,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) })

function campaignDetails(title: string) {
  const end = new Date(Date.now() + 30 * 86_400_000).toISOString().split('T')[0]
  return {
    basics: { title, tagline: '', story: 'x'.repeat(120) },
    media: { coverImageUrl: null, promoVideoUrl: null },
    beneficiary: { name: 'Beneficiary', type: 'individual', description: '', ngoName: '', ngoRegistrationNo: '' },
    goal: { targetAmountRupees: 5000, startDate: new Date().toISOString().split('T')[0], endDate: end, allowOverFunding: true, showGoalAmount: true },
    organizer: { name: 'Organizer', email: 'organizer@registerdesk.test', phone: '', website: '' },
    taxConfig: { enabled: false, organizationPan: '', registrationNumber: '', certificateUrl: null, certificateExpiry: '' },
  }
}

describeEmu('RD-SEC-01 · security & authorization regressions', () => {
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  let adminDb: typeof import('@/lib/firebase/admin').adminDb
  const tok: Record<string, string> = {}
  const uid = { a: `${P}-a`, b: `${P}-b`, claim: `${P}-claim`, forged: `${P}-forged`, super: SUPER, staff: `${P}-staff`, gate: `${P}-gate` }
  const prevAdminUids = process.env.ADMIN_UIDS

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    process.env.ADMIN_UIDS = SUPER
    ;({ adminAuth, adminDb } = await import('@/lib/firebase/admin'))
    const mk = async (k: keyof typeof uid, email: string, opts: { claims?: Record<string, unknown>; verified?: boolean } = {}) => {
      await adminAuth.deleteUser(uid[k]).catch(() => null)
      await adminAuth.createUser({ uid: uid[k], email, password: PASSWORD, emailVerified: opts.verified ?? true })
      if (opts.claims) await adminAuth.setCustomUserClaims(uid[k], opts.claims)
      tok[k] = await idToken(email)
    }
    await mk('a', `${P}-a@registerdesk.test`)
    await mk('b', `${P}-b@registerdesk.test`)
    await mk('claim', `${P}-claim@registerdesk.test`, { claims: { admin: true, isAdmin: true, role: 'superadmin' } })
    await mk('forged', `${P}-forged@registerdesk.test`)
    await mk('super', `${P}-super@registerdesk.test`)
    await mk('staff', `${P}-staff@staff.registerdesk.invalid`)
    await mk('gate', `${P}-gate@registerdesk.test`)
    for (const k of ['a', 'b'] as const) {
      await adminDb.doc(`users/${uid[k]}`).set({ uid: uid[k], role: 'organizer', accountStatus: 'active', workspaceOwner: true })
    }
    // A profile that LIES about being an admin (what a forged signup / client write would try).
    await adminDb.doc(`users/${uid.forged}`).set({ uid: uid.forged, role: 'superadmin', admin: true, isAdmin: true, accountStatus: 'active', workspaceOwner: true })
    // A's gate credential and a check-in member of A's workspace.
    await adminDb.doc(`teamMembers/${P}-staff-row`).set({ organizerUid: uid.a, memberUid: uid.staff, email: `${P}-staff@staff.registerdesk.invalid`, role: 'checkin_staff', status: 'active', eventIds: [] })
    await adminDb.doc(`teamMembers/${P}-gate-row`).set({ organizerUid: uid.a, memberUid: uid.gate, email: `${P}-gate@registerdesk.test`, role: 'checkin_staff', status: 'active', eventIds: [] })
  }, T)

  afterAll(() => { process.env.ADMIN_UIDS = prevAdminUids })

  // ═══ ROLE ═══════════════════════════════════════════════════════════════════
  it('ROLE · a legacy admin:true claim (with isAdmin / role:superadmin) is NOT an admin anywhere', async () => {
    const { resolveAdminUid, resolveSuperAdminUid } = await import('@/lib/admin/auth')
    expect(await resolveAdminUid(`Bearer ${tok.claim}`)).toBeNull()
    expect(await resolveSuperAdminUid(`Bearer ${tok.claim}`)).toBeNull()

    const { GET: authCheck } = await import('@/app/api/admin/auth-check/route')
    expect((await authCheck(req('/api/admin/auth-check', 'GET', tok.claim))).status).toBe(403)

    // Money + payout PII reads it used to reach.
    const { GET: payouts } = await import('@/app/api/admin/payout-profiles/route')
    expect((await payouts(req('/api/admin/payout-profiles', 'GET', tok.claim))).status).toBe(403)
    const { GET: settlements } = await import('@/app/api/admin/settlements/route')
    expect((await settlements(req('/api/admin/settlements', 'GET', tok.claim))).status).toBe(403)

    // A config write it used to reach — refused, nothing written.
    const before = (await adminDb.doc('platformSettings/publishing').get()).data() ?? null
    const { PUT: publishing } = await import('@/app/api/admin/settings/publishing/route')
    expect([401, 403]).toContain((await publishing(req('/api/admin/settings/publishing', 'PUT', tok.claim, { mode: 'auto_publish' }))).status)
    expect((await adminDb.doc('platformSettings/publishing').get()).data() ?? null).toEqual(before)

    // The financial guard still names the reason (diagnostics only — it grants nothing).
    const { requireSuperAdmin } = await import('@/lib/admin/financialGuard')
    const r = await requireSuperAdmin(req('/x', 'GET', tok.claim))
    expect(r.response?.status).toBe(403)
    expect((await r.response!.json() as { code?: string }).code).toBe('SUPER_ADMIN_REQUIRED')
  }, T)

  it('ROLE · forged profile fields (role / admin / isAdmin) grant nothing; ADMIN_UIDS is the Super Admin', async () => {
    const { resolveAdminUid, resolveSuperAdminUid } = await import('@/lib/admin/auth')
    expect(await resolveAdminUid(`Bearer ${tok.forged}`)).toBeNull()
    expect(await resolveSuperAdminUid(`Bearer ${tok.forged}`)).toBeNull()
    expect(await resolveAdminUid(`Bearer ${tok.a}`)).toBeNull()
    expect(await resolveAdminUid(`Bearer ${tok.super}`)).toBe(SUPER)
    expect(await resolveSuperAdminUid(`Bearer ${tok.super}`)).toBe(SUPER)
    const { GET: authCheck } = await import('@/app/api/admin/auth-check/route')
    expect((await authCheck(req('/api/admin/auth-check', 'GET', tok.forged))).status).toBe(403)
    expect((await authCheck(req('/api/admin/auth-check', 'GET', tok.super))).status).toBe(200)
  }, T)

  // ═══ TEN ════════════════════════════════════════════════════════════════════
  it('TEN · organizer B cannot re-publish over organizer A’s live campaign by re-using A’s draft id', async () => {
    const draftId = `${P}cmpgnAAAAAA`
    const title = `Security Campaign ${process.pid}`
    const draft = { status: 'draft', campaignType: 'donation_only', campaignDetails: campaignDetails(title), donationSettings: null, publishedCampaignId: null, publishedSlug: null }
    await adminDb.doc(`users/${uid.a}/campaignDrafts/${draftId}`).set(draft)
    const { POST: publish } = await import('@/app/api/campaigns/publish/route')
    const ok = await publish(req('/api/campaigns/publish', 'POST', tok.a, { draftId }))
    expect(ok.status).toBe(200)
    const slug = (await ok.json() as { slug: string }).slug
    const live = (await adminDb.doc(`donationCampaigns/${slug}`).get()).data()!
    expect(live.uid).toBe(uid.a)

    // B creates a draft under its OWN path with A's id and A's title → same slug.
    await adminDb.doc(`users/${uid.b}/campaignDrafts/${draftId}`).set(draft)
    const res = await publish(req('/api/campaigns/publish', 'POST', tok.b, { draftId }))
    expect(res.status).toBe(409)
    expect((await res.json() as { reason?: string }).reason).toBe('SLUG_CONFLICT')
    const after = (await adminDb.doc(`donationCampaigns/${slug}`).get()).data()!
    expect(after.uid).toBe(uid.a)
    expect(after.publishedAt).toEqual(live.publishedAt)
  }, T)

  it('TEN · certificate settings/template are unreachable through a draft id that belongs to another organizer', async () => {
    const draftId = `${P}-evt-draft`
    await adminDb.doc(`users/${uid.a}/eventDrafts/${draftId}`).set({ status: 'published' })
    await adminDb.doc(`events/${P}-evt`).set({ slug: `${P}-evt`, uid: uid.a, draftId })
    await adminDb.doc(`users/${uid.b}/eventDrafts/${draftId}`).set({ status: 'draft' })   // the forged twin

    const settings = await import('@/app/api/organizer/events/[eventId]/certificates/settings/route')
    const template = await import('@/app/api/organizer/events/[eventId]/certificates/template/route')
    const url = `/api/organizer/events/${draftId}/certificates`
    expect((await settings.GET(req(`${url}/settings`, 'GET', tok.b), ctx({ eventId: draftId }))).status).toBe(404)
    expect((await settings.PATCH(req(`${url}/settings`, 'PATCH', tok.b, { emailSubject: 'phish' }), ctx({ eventId: draftId }))).status).toBe(404)
    expect((await template.GET(req(`${url}/template`, 'GET', tok.b), ctx({ eventId: draftId }))).status).toBe(404)
    expect((await adminDb.doc(`certificateSettings/${draftId}`).get()).exists).toBe(false)
    // The real owner is unaffected.
    expect((await settings.GET(req(`${url}/settings`, 'GET', tok.a), ctx({ eventId: draftId }))).status).toBe(200)
  }, T)

  // ═══ ESC ════════════════════════════════════════════════════════════════════
  it('ESC · a gate credential that writes itself a workspaceOwner:true profile stays in its issuer’s workspace', async () => {
    await adminDb.doc(`users/${uid.staff}`).set({ uid: uid.staff, role: 'organizer', accountStatus: 'pending', workspaceOwner: true })
    const { resolveWorkspaceUid } = await import('@/lib/team/workspace')
    const ws = await resolveWorkspaceUid(uid.staff)
    expect(ws.isOwner).toBe(false)
    expect(ws.workspaceUid).toBe(uid.a)
    expect(ws.role).toBe('checkin_staff')
    // A real organizer who also holds a membership still resolves to their own workspace.
    expect((await resolveWorkspaceUid(uid.a)).isOwner).toBe(true)
  }, T)

  it('ESC · reminders need the broadcasts permission — a check-in member cannot schedule attendee email', async () => {
    const { GET, POST } = await import('@/app/api/organizer/reminders/route')
    const before = (await adminDb.collection('scheduledReminders').where('organizerUid', '==', uid.a).get()).size
    const r = await POST(req('/api/organizer/reminders', 'POST', tok.gate, {
      action: 'create', audience: 'attendees', eventId: `${P}-evt`, subject: 'x', message: 'y', sendAtMs: Date.now(),
    }))
    expect(r.status).toBe(403)
    expect((await GET(req('/api/organizer/reminders', 'GET', tok.gate))).status).toBe(403)
    expect((await adminDb.collection('scheduledReminders').where('organizerUid', '==', uid.a).get()).size).toBe(before)
    expect((await GET(req('/api/organizer/reminders', 'GET'))).status).toBe(401)
    expect((await GET(req('/api/organizer/reminders', 'GET', tok.a))).status).toBe(200)
  }, T)

  // ═══ AUTH ═══════════════════════════════════════════════════════════════════
  it('AUTH · send-otp keeps the ORIGINAL hourly window across in-window sends (the cap can fire)', async () => {
    const email = `${P}-otp@registerdesk.test`
    const otpUid = `${P}-otp`
    await adminAuth.deleteUser(otpUid).catch(() => null)
    await adminAuth.createUser({ uid: otpUid, email, password: PASSWORD, emailVerified: false })
    const t = await idToken(email)
    const limitRef = adminDb.doc(`otpRateLimits/${otpUid}_email`)
    const windowStart = new Date(Date.now() - 30 * 60_000)
    const { POST } = await import('@/app/api/auth/send-otp/route')

    await limitRef.set({ count: 1, windowStart, lastSentAt: new Date(Date.now() - 10 * 60_000) })
    for (const expected of [2, 3]) {
      const r = await POST(req('/api/auth/send-otp', 'POST', t, {}))
      expect(r.status).toBe(200)
      const d = (await limitRef.get()).data()!
      expect(d.count).toBe(expected)
      expect((d.windowStart as { toMillis(): number }).toMillis()).toBe(windowStart.getTime())
      await limitRef.update({ lastSentAt: new Date(Date.now() - 10 * 60_000) })   // step past the cooldown
    }
    const { getSecurityConfig } = await import('@/lib/config/resolveSecurityConfig')
    await limitRef.update({ count: (await getSecurityConfig()).otpMaxSendsPerHour })
    const capped = await POST(req('/api/auth/send-otp', 'POST', t, {}))
    expect(capped.status).toBe(429)
    expect((await capped.json() as { error: string }).error).toBe('RATE_LIMITED')
  }, T)

  it('AUTH · a suspended organizer’s API key is refused (it used to bypass moderation)', async () => {
    const { createApiKey, authenticateApiKey } = await import('@/lib/integrations/apiKeys')
    const { plaintextKey } = await createApiKey(uid.b, 'sec01', ['registrations.read'])
    const call = () => authenticateApiKey(new Request('http://localhost/api/public/registrations', {
      headers: { authorization: `Bearer ${plaintextKey}`, 'x-forwarded-for': `10.9.${process.pid % 250}.1` },
    }), 'registrations.read')
    expect((await call()).ok).toBe(true)
    await adminDb.doc(`users/${uid.b}`).update({ accountStatus: 'suspended' })
    const r = await call()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
    await adminDb.doc(`users/${uid.b}`).update({ accountStatus: 'active' })
  }, T)

  it('AUTH · the dev WhatsApp test route is closed to anonymous callers and to every production build', async () => {
    const { GET, POST } = await import('@/app/api/dev/whatsapp-test/route')
    const body = { to: '+910000000000' }
    expect((await POST(req('/api/dev/whatsapp-test', 'POST', undefined, body))).status).toBe(403)
    expect((await POST(req('/api/dev/whatsapp-test', 'POST', tok.a, body))).status).toBe(403)
    expect((await POST(req('/api/dev/whatsapp-test', 'POST', tok.claim, body))).status).toBe(403)
    expect((await GET(req('/api/dev/whatsapp-test', 'GET'))).status).toBe(403)
    const env = process.env as Record<string, string | undefined>
    const prev = { NODE_ENV: env.NODE_ENV, VERCEL_ENV: env.VERCEL_ENV }
    try {
      env.NODE_ENV = 'production'; env.VERCEL_ENV = 'preview'          // a Vercel preview
      expect((await POST(req('/api/dev/whatsapp-test', 'POST', tok.super, body))).status).toBe(404)
      expect((await GET(req('/api/dev/whatsapp-test', 'GET', tok.super))).status).toBe(404)
    } finally {
      env.NODE_ENV = prev.NODE_ENV
      if (prev.VERCEL_ENV === undefined) delete env.VERCEL_ENV; else env.VERCEL_ENV = prev.VERCEL_ENV
    }
  }, T)
})
