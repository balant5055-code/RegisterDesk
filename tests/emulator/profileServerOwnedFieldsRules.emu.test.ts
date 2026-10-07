// RD-PHASE4-C7 closeout — server-owned profile fields can be neither SELF-ASSIGNED at create nor
// changed later by a client. Proved through the CLIENT SDK (the Admin SDK bypasses rules) against an
// emulator that loads this repository's firestore.rules.
//
//   • entitlementOverrideTier (+ its stamps)  — written only by PATCH /api/admin/organizers/[uid]/plan
//   • customDomain* (every key)                — written only by lib/domains/service.ts
//   • mobile.verified / mobile.verifiedAt       — no client or server path sets them true today
//
// The control cases are the real signup payload (createOrganizerProfile) and an older bundle that
// sent no `mobile` at all — both must still work.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const AUTH_EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR && AUTH_EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid

describeEmu('RD-PHASE4-C7 · firestore.rules · server-owned profile fields', () => {
  let fs: typeof import('firebase/firestore')
  let authMod: typeof import('firebase/auth')
  const apps: import('firebase/app').FirebaseApp[] = []
  const uids: string[] = []

  /** A fresh signed-in client whose users/{uid} doc does NOT exist yet. */
  async function freshClient(tag: string) {
    const { adminAuth, adminDb } = await import('@/lib/firebase/admin')
    const email = `c7-${tag}-${P}@rd.test`, password = 'RulesPassw0rd!123'
    const old = await adminAuth.getUserByEmail(email).catch(() => null)
    if (old) { await adminAuth.deleteUser(old.uid).catch(() => null); await adminDb.doc(`users/${old.uid}`).delete().catch(() => null) }
    const uid = (await adminAuth.createUser({ email, password, emailVerified: false })).uid
    uids.push(uid)
    const { initializeApp } = await import('firebase/app')
    const app = initializeApp({ apiKey: 'demo-key', projectId: process.env.GCLOUD_PROJECT!, authDomain: `${process.env.GCLOUD_PROJECT}.firebaseapp.com` }, `c7-${tag}-${P}`)
    apps.push(app)
    const auth = authMod.getAuth(app)
    authMod.connectAuthEmulator(auth, `http://${AUTH_EMULATOR}`, { disableWarnings: true })
    const db = fs.getFirestore(app)
    const [host, port] = EMULATOR!.split(':')
    fs.connectFirestoreEmulator(db, host, Number(port))
    await authMod.signInWithEmailAndPassword(auth, email, password)
    return { uid, db, ref: fs.doc(db, 'users', uid) }
  }

  /** Exactly what createOrganizerProfile (lib/firebase/firestore/index.ts) writes today. */
  const signupPayload = (uid: string): Record<string, unknown> => ({
    uid, name: 'Probe', email: `c7-${P}@rd.test`, organizationName: 'Probe Org',
    mobile: { e164: '+919800000000', countryCode: '+91', verified: false, verifiedAt: null },
    role: 'organizer', workspaceOwner: true, accountStatus: 'pending', emailVerified: false,
    verification: { email: { verified: false, verifiedAt: null, verifiedMethod: null } },
    trust: { level: 'unverified', score: 0, badges: [] },
    createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp(),
  })

  const denied = async (op: Promise<unknown>) => {
    try { await op; return false } catch (e) { return (e as { code?: string }).code === 'permission-denied' }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    fs = await import('firebase/firestore')
    authMod = await import('firebase/auth')
  }, T)

  afterAll(async () => {
    const { adminDb, adminAuth } = await import('@/lib/firebase/admin')
    for (const uid of uids) {
      await adminDb.doc(`users/${uid}`).delete().catch(() => null)
      await adminAuth.deleteUser(uid).catch(() => null)
    }
    const { deleteApp } = await import('firebase/app')
    for (const a of apps) await deleteApp(a).catch(() => null)
  }, T)

  // ═══ CREATE ════════════════════════════════════════════════════════════════════════════════
  it('CREATE · self-assigning any server-owned field is denied; the real signup payload is then accepted', async () => {
    const { uid, ref } = await freshClient('create')
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['entitlementOverrideTier', { entitlementOverrideTier: 'enterprise' }],
      ['entitlementUpdatedBy',    { entitlementUpdatedBy: 'self' }],
      ['entitlementUpdatedAt',    { entitlementUpdatedAt: fs.serverTimestamp() }],
      ['customDomain',            { customDomain: 'victim.example.com' }],
      ['customDomain verified',   { customDomain: 'victim.example.com', customDomainStatus: 'verified', customDomainSslStatus: 'active', customDomainVerifiedAt: fs.serverTimestamp() }],
      ['customDomainToken',       { customDomainToken: 'forged' }],
      ['customDomainError',       { customDomainError: null }],
      ['customDomainUpdatedAt',   { customDomainUpdatedAt: fs.serverTimestamp() }],
      ['mobile.verified true',    { mobile: { e164: '+919800000000', countryCode: '+91', verified: true, verifiedAt: null } }],
      ['mobile.verifiedAt set',   { mobile: { e164: '+919800000000', countryCode: '+91', verified: false, verifiedAt: fs.serverTimestamp() } }],
    ]
    for (const [label, extra] of attempts) {
      expect(await denied(fs.setDoc(ref, { ...signupPayload(uid), ...extra })), label).toBe(true)
    }
    const { adminDb } = await import('@/lib/firebase/admin')
    expect((await adminDb.doc(`users/${uid}`).get()).exists).toBe(false)
    // CONTROL — the unchanged signup payload still creates the profile.
    await fs.setDoc(ref, signupPayload(uid))
    const stored = (await adminDb.doc(`users/${uid}`).get()).data()!
    expect(stored.entitlementOverrideTier).toBeUndefined()
    expect(stored.mobile).toMatchObject({ verified: false, verifiedAt: null })
  }, T)

  it('CREATE · compatibility: a payload WITHOUT `mobile` (older bundle) is still accepted', async () => {
    const { uid, ref } = await freshClient('nomobile')
    const payload = signupPayload(uid); delete payload.mobile
    await fs.setDoc(ref, payload)
    const { adminDb } = await import('@/lib/firebase/admin')
    expect((await adminDb.doc(`users/${uid}`).get()).exists).toBe(true)
  }, T)

  // ═══ Signup transition (accountStatus) + branding ════════════════════════════════════════════
  it('TRANSITION · the committed (older) signup payload — no accountStatus, no workspaceOwner — is accepted', async () => {
    const { uid, ref } = await freshClient('legacybundle')
    const legacy = signupPayload(uid)
    delete legacy.accountStatus; delete legacy.workspaceOwner      // exactly what HEAD's createOrganizerProfile sent
    await fs.setDoc(ref, legacy)
    const { adminDb } = await import('@/lib/firebase/admin')
    expect((await adminDb.doc(`users/${uid}`).get()).data()!.accountStatus).toBeUndefined()
  }, T)

  it('TRANSITION · a self-assigned status other than pending is refused (active, suspended, banned, null)', async () => {
    const { uid, ref } = await freshClient('selfstatus')
    for (const accountStatus of ['active', 'suspended', 'banned', null]) {
      expect(await denied(fs.setDoc(ref, { ...signupPayload(uid), accountStatus })), String(accountStatus)).toBe(true)
    }
    const { adminDb } = await import('@/lib/firebase/admin')
    expect((await adminDb.doc(`users/${uid}`).get()).exists).toBe(false)
  }, T)

  it('BRANDING · client-supplied branding is refused at profile creation; the signup payload is not affected', async () => {
    const { uid, ref } = await freshClient('branding')
    for (const branding of [
      { logoUrl: 'http://tracker.example.com/pixel.gif' },
      { emailSenderName: 'Support\r\nBcc: victim@example.com' },
      { hideRegisterDeskBranding: true },
      {},
    ]) {
      expect(await denied(fs.setDoc(ref, { ...signupPayload(uid), branding })), JSON.stringify(branding)).toBe(true)
    }
    await fs.setDoc(ref, signupPayload(uid))
    const { adminDb } = await import('@/lib/firebase/admin')
    expect((await adminDb.doc(`users/${uid}`).get()).data()!.branding).toBeUndefined()
  }, T)

  // ═══ UPDATE ════════════════════════════════════════════════════════════════════════════════
  it('UPDATE · server-owned fields cannot be added or changed by the owner; ordinary fields and the phone number stay editable', async () => {
    const { uid, ref } = await freshClient('update')
    await fs.setDoc(ref, signupPayload(uid))
    const { adminDb } = await import('@/lib/firebase/admin')
    // server-side state, as the Admin SDK would write it
    await adminDb.doc(`users/${uid}`).update({ customDomain: 'mine.example.com', customDomainStatus: 'pending', customDomainError: 'dns', entitlementOverrideTier: 'growth' })

    const attempts: Array<[string, Record<string, unknown>]> = [
      ['raise override tier',      { entitlementOverrideTier: 'enterprise' }],
      ['stamp override',           { entitlementUpdatedBy: 'self' }],
      ['verify own domain',        { customDomainStatus: 'verified' }],
      ['swap domain',              { customDomain: 'victim.example.com' }],
      ['clear domain error',       { customDomainError: null }],
      ['touch domain updatedAt',   { customDomainUpdatedAt: fs.serverTimestamp() }],
      ['self-verify mobile (dot)', { 'mobile.verified': true }],
      ['self-verify mobile (map)', { mobile: { e164: '+919800000000', countryCode: '+91', verified: true, verifiedAt: null } }],
      ['stamp mobile.verifiedAt',  { 'mobile.verifiedAt': fs.serverTimestamp() }],
    ]
    for (const [label, patch] of attempts) {
      expect(await denied(fs.updateDoc(ref, patch)), label).toBe(true)
    }
    expect(await denied(fs.updateDoc(ref, { entitlementOverrideTier: fs.deleteField() })), 'delete override').toBe(true)

    // CONTROLS — unaffected fields remain client-editable (nothing legitimate is broken).
    await fs.updateDoc(ref, { organizationName: 'Renamed Org' })
    await fs.updateDoc(ref, { 'mobile.e164': '+919811111111' })
    const d = (await adminDb.doc(`users/${uid}`).get()).data()!
    expect(d).toMatchObject({
      organizationName: 'Renamed Org', entitlementOverrideTier: 'growth',
      customDomain: 'mine.example.com', customDomainStatus: 'pending', customDomainError: 'dns',
      mobile: { e164: '+919811111111', verified: false, verifiedAt: null },
    })
  }, T)

  it('UPDATE · a legacy profile with NO mobile map can still be edited, and cannot gain a verified mobile', async () => {
    const { uid, ref } = await freshClient('legacy')
    const payload = signupPayload(uid); delete payload.mobile
    await fs.setDoc(ref, payload)
    await fs.updateDoc(ref, { organizationName: 'Legacy Edit' })
    expect(await denied(fs.updateDoc(ref, { mobile: { e164: '+919800000000', countryCode: '+91', verified: true, verifiedAt: null } }))).toBe(true)
    await fs.updateDoc(ref, { mobile: { e164: '+919800000000', countryCode: '+91', verified: false, verifiedAt: null } })
  }, T)
})
