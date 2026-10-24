// "Approved Contact List" access is enforced by BOTH registration endpoints — the free path
// (POST /api/registrations/submit) and the paid path (POST /api/registrations/create-order) —
// from a VERIFIED email only (attendee OTP session, or a Firebase token with email_verified),
// for the verified person only, and fails closed. Open and invite-code events are unchanged.
//
// Stubbed (as tests/emulator/checkoutFeeSnapshot does): the registration gate, rate limiters, fee
// plan, payment provider (no real gateway call) and confirmation email. The attendee session is
// stubbed because its real reader needs a request cookie context; the Firebase-token path is real.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `aca${process.pid}`
const OWNER = `${P}-owner`

const h = vi.hoisted(() => ({ session: null as null | { sessionId: string; email: string; normalizedEmail: string }, seq: 0, orders: [] as string[] }))

vi.mock('@/lib/attendee/auth', async orig => ({
  ...(await orig<typeof import('@/lib/attendee/auth')>()),
  verifyAttendeeSession: async () => h.session,
}))
vi.mock('@/lib/platform/pricing/resolver', async orig => ({
  ...(await orig<typeof import('@/lib/platform/pricing/resolver')>()),
  resolvePlatformPricing: async () => ({ features: { pricingEngineEnabled: false } }),
}))
vi.mock('@/lib/billing/feeEngine', async orig => ({
  ...(await orig<typeof import('@/lib/billing/feeEngine')>()),
  getFeePlanForOrganizer: async () => ({ planTier: 'starter', feeConfigId: 'plan:starter' }),
}))
vi.mock('@/lib/rateLimit/redis', () => ({ checkDistributedRateLimit: async () => ({ allowed: true, resetAt: 0 }) }))
vi.mock('@/lib/rateLimit', async orig => ({
  ...(await orig<typeof import('@/lib/rateLimit')>()),
  checkRateLimit: () => ({ allowed: true, remaining: 99, resetAt: 0 }),
}))
vi.mock('@/lib/registrations/gate', async orig => ({
  ...(await orig<typeof import('@/lib/registrations/gate')>()),
  checkRegistrationGate: async () => ({ allowed: true }),
}))
vi.mock('@/lib/registrations/sendConfirmationEmail', () => ({ sendConfirmationEmail: async () => undefined }))
vi.mock('@/lib/payments/providers', async orig => {
  const real = await orig<typeof import('@/lib/payments/providers')>()
  const adapter = {
    createOrder: async () => {
      const id = `order_${P}_${++h.seq}`
      h.orders.push(id)
      return { providerOrderId: id, checkout: { provider: 'razorpay', keyId: 'rzp_test_stub' } }
    },
    getCheckoutHandoff: async () => ({ provider: 'razorpay', keyId: 'rzp_test_stub' }),
    fetchOrderPayments: async () => [],
  }
  return { ...real, resolveActivePaymentProviderForNewOrder: async () => ({ ok: true, provider: 'razorpay' }), resolvePaymentProvider: () => adapter }
})

const APPROVED = 'approved.person@rd.test'
const CONTACTS = [
  { id: 'c1', name: 'Approved Person', mobileNumber: '+919000000001', email: 'Approved.Person@RD.test', memberId: 'M1', addedAt: '' },
  { id: 'c2', name: 'Phone Only', mobileNumber: '+919000000002', email: '', memberId: 'M2', addedAt: '' },
  { id: 'c3', name: 'Token Person', mobileNumber: '', email: 'token.person@rd.test', memberId: 'M3', addedAt: '' },
]

describeEmu('approved-contact access control — submit + create-order', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  let submit: (r: NextRequest) => Promise<Response>
  let createOrder: (r: NextRequest) => Promise<Response>
  const slugs: string[] = []
  const authUids: string[] = []
  let keySeq = 0

  async function idToken(uid: string): Promise<string> {
    const custom = await adminAuth.createCustomToken(uid)
    const key  = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'fake-api-key'
    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
    const res  = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) })
    const body = await res.json() as { idToken?: string }
    if (!body.idToken) throw new Error(`no idToken: ${JSON.stringify(body)}`)
    return body.idToken
  }

  async function seedEvent(key: string, accessControl: Record<string, unknown>, paid: boolean) {
    const slug = `${P}-${key}`
    slugs.push(slug)
    const pass = { id: 'p1', name: 'Entry', type: paid ? 'paid' : 'free', price: paid ? 500 : 0, earlyBirdEnabled: false,
      unlimited: false, quantity: 500, visibility: 'public', status: 'active' }
    await adminDb.doc(`events/${slug}`).set({
      uid: OWNER, draftId: `${slug}-draft`, slug, status: 'published', lifecycleStatus: 'published', totalCapacity: 500,
      pricing: { eventType: paid ? 'paid' : 'free', feeModel: 'organizer_absorbs', passes: [pass] },
      eventDetails: { info: { name: `ACA ${key}` }, schedule: { startDate: '2099-12-31', timezone: 'Asia/Kolkata' }, seo: { urlSlug: slug } },
      registrationForm: { sections: [] }, accessControl,
    })
    return slug
  }

  const body = (slug: string, email: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    slug, passId: 'p1', attendee: { name: 'Attendee', email, phone: '+919000000099' }, formResponses: {},
    idempotencyKey: `${P}key${String(++keySeq).padStart(12, '0')}`, termsAccepted: true, ...extra,
  })
  const call = async (route: (r: NextRequest) => Promise<Response>, path: string, slug: string, email: string, opts: { token?: string; extra?: Record<string, unknown> } = {}) => {
    const res = await route(new NextRequest(`http://x/api/registrations/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: body(slug, email, opts.extra),
    }))
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
  }
  const registrationsFor = async (slug: string) => (await adminDb.collection('registrations').where('eventSlug', '==', slug).get()).size

  const sessionFor = (email: string) => { h.session = { sessionId: 'x'.repeat(64), email, normalizedEmail: email.toLowerCase() } }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
    ;({ POST: submit } = await import('@/app/api/registrations/submit/route') as never)
    ;({ POST: createOrder } = await import('@/app/api/registrations/create-order/route') as never)
  }, T)

  beforeEach(() => { h.session = null })

  afterAll(async () => {
    for (const slug of slugs) {
      for (const d of (await adminDb.collection('registrations').where('eventSlug', '==', slug).get()).docs) await adminDb.recursiveDelete(d.ref).catch(() => null)
      for (const c of (await adminDb.collection('paymentAttemptClaims').where('eventSlug', '==', slug).get().catch(() => null))?.docs ?? []) await c.ref.delete().catch(() => null)
      await adminDb.recursiveDelete(adminDb.doc(`events/${slug}`)).catch(() => null)
      await adminDb.doc(`registrationCounters/${slug}`).delete().catch(() => null)
    }
    for (const o of h.orders) await adminDb.doc(`paymentIntents/${o}`).delete().catch(() => null)
    for (const u of authUids) await adminAuth.deleteUser(u).catch(() => null)
  }, T)

  // ─── paid path: create-order ────────────────────────────────────────────────

  it('create-order: no verified identity → refused, no order created', async () => {
    const slug = await seedEvent('co-none', { type: 'approved_contacts', approvedContacts: CONTACTS, confirmationMode: 'auto' }, true)
    const before = h.orders.length
    const r = await call(createOrder, 'create-order', slug, APPROVED)
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('APPROVED_CONTACT_VERIFICATION_REQUIRED')
    expect(h.orders.length).toBe(before)
  }, T)

  it('create-order: a verified but UNLISTED email is refused; the list is never revealed', async () => {
    const slug = await seedEvent('co-unlisted', { type: 'approved_contacts', approvedContacts: CONTACTS }, true)
    sessionFor('stranger@rd.test')
    const r = await call(createOrder, 'create-order', slug, 'stranger@rd.test')
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('NOT_APPROVED_CONTACT')
    expect(JSON.stringify(r.body)).not.toMatch(/approved\.person|token\.person|9000000/i)
  }, T)

  it('create-order: a verified approved contact cannot register a DIFFERENT email', async () => {
    const slug = await seedEvent('co-mismatch', { type: 'approved_contacts', approvedContacts: CONTACTS }, true)
    sessionFor(APPROVED)
    const r = await call(createOrder, 'create-order', slug, 'someone.else@rd.test')
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('APPROVED_CONTACT_EMAIL_MISMATCH')
  }, T)

  it('create-order: a listed contact verified by attendee session succeeds (case-insensitive)', async () => {
    const slug = await seedEvent('co-ok', { type: 'approved_contacts', approvedContacts: CONTACTS }, true)
    sessionFor(APPROVED.toUpperCase())
    const r = await call(createOrder, 'create-order', slug, APPROVED)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  }, T)

  it('create-order: a Firebase sign-in counts only when its email is verified', async () => {
    const UNVERIFIED = `unverified.${P}@rd.test`
    const slug = await seedEvent('co-token', { type: 'approved_contacts', approvedContacts: [
      ...CONTACTS, { id: 'c4', name: 'Listed Unverified', mobileNumber: '', email: UNVERIFIED, memberId: 'M4', addedAt: '' },
    ] }, true)
    // listed + email_verified → accepted
    const vUid = `${P}-tok-v`
    await adminAuth.createUser({ uid: vUid, email: `token.person@rd.test`, emailVerified: true })
    authUids.push(vUid)
    const ok = await call(createOrder, 'create-order', slug, 'token.person@rd.test', { token: await idToken(vUid) })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    // listed, but the sign-in's email is NOT verified → no verified identity → refused
    const uUid = `${P}-tok-u`
    await adminAuth.createUser({ uid: uUid, email: UNVERIFIED, emailVerified: false })
    authUids.push(uUid)
    const no = await call(createOrder, 'create-order', slug, UNVERIFIED, { token: await idToken(uUid) })
    expect(no.status).toBe(403)
    expect(no.body.reason).toBe('APPROVED_CONTACT_VERIFICATION_REQUIRED')
  }, T)

  it('create-order: an empty / emails-missing list fails closed', async () => {
    const slug = await seedEvent('co-empty', { type: 'approved_contacts', approvedContacts: [CONTACTS[1]] }, true)
    sessionFor(APPROVED)
    const r = await call(createOrder, 'create-order', slug, APPROVED)
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('APPROVED_CONTACTS_UNAVAILABLE')
  }, T)

  // ─── free path: submit ──────────────────────────────────────────────────────

  it('submit: an unlisted verified email is refused and no registration is written', async () => {
    const slug = await seedEvent('sb-unlisted', { type: 'approved_contacts', approvedContacts: CONTACTS }, false)
    sessionFor('stranger@rd.test')
    const r = await call(submit, 'submit', slug, 'stranger@rd.test')
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('NOT_APPROVED_CONTACT')
    expect(await registrationsFor(slug)).toBe(0)
  }, T)

  it('submit: no verified identity is refused', async () => {
    const slug = await seedEvent('sb-none', { type: 'approved_contacts', approvedContacts: CONTACTS }, false)
    const r = await call(submit, 'submit', slug, APPROVED)
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('APPROVED_CONTACT_VERIFICATION_REQUIRED')
    expect(await registrationsFor(slug)).toBe(0)
  }, T)

  it('submit: a listed, verified contact registers', async () => {
    const slug = await seedEvent('sb-ok', { type: 'approved_contacts', approvedContacts: CONTACTS }, false)
    sessionFor(APPROVED)
    const r = await call(submit, 'submit', slug, APPROVED)
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300)
    expect(await registrationsFor(slug)).toBe(1)
  }, T)

  // ─── unchanged modes ────────────────────────────────────────────────────────

  it('open events need no identity on either path', async () => {
    const free = await seedEvent('open-free', { type: 'open' }, false)
    const paid = await seedEvent('open-paid', { type: 'open' }, true)
    expect((await call(submit, 'submit', free, 'anyone@rd.test')).status).toBeLessThan(300)
    expect((await call(createOrder, 'create-order', paid, 'anyone@rd.test')).status).toBe(200)
  }, T)

  it('invite-code events still require the code, and only the code', async () => {
    const ac = { type: 'invite_code', inviteCode: { code: 'SECRET42', caseSensitive: false } }
    const free = await seedEvent('ic-free', ac, false)
    const paid = await seedEvent('ic-paid', ac, true)
    const wrongFree = await call(submit, 'submit', free, 'a@rd.test', { extra: { inviteCode: 'nope' } })
    expect(wrongFree.status).toBe(403); expect(wrongFree.body.reason).toBe('INVITE_CODE_INVALID')
    const wrongPaid = await call(createOrder, 'create-order', paid, 'a@rd.test', { extra: { inviteCode: 'nope' } })
    expect(wrongPaid.status).toBe(403); expect(wrongPaid.body.reason).toBe('INVITE_CODE_INVALID')
    expect((await call(submit, 'submit', free, 'b@rd.test', { extra: { inviteCode: 'secret42' } })).status).toBeLessThan(300)
    expect((await call(createOrder, 'create-order', paid, 'b@rd.test', { extra: { inviteCode: 'secret42' } })).status).toBe(200)
  }, T)
})
