// RD-PHASE4-S1 · C7 — the admin entitlement override is server-owned, proved through REAL rules.
//
// users/{uid}.entitlementOverrideTier is the admin comp lever (PATCH /api/admin/organizers/[uid]/plan,
// Admin SDK) and it can only RAISE the effective workspace tier. If the browser could write it, an
// organizer could grant themselves that tier. The writes under test go through the CLIENT SDK signed
// in as the profile's owner (the Admin SDK bypasses rules, so it would prove nothing), against an
// emulator that loads this repository's firestore.rules. The first case is the control.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const AUTH_EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR && AUTH_EMULATOR ? describe : describe.skip
const T = 120_000

describeEmu('RD-PHASE4-S1 · C7 · firestore.rules protect the entitlement override', () => {
  let clientApp: import('firebase/app').FirebaseApp
  let db: import('firebase/firestore').Firestore
  let fs: typeof import('firebase/firestore')
  let uid = ''

  const EMAIL = `entrules-${process.pid}@rd.test`
  const PASSWORD = 'RulesPassw0rd!123'

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const { adminDb, adminAuth } = await import('@/lib/firebase/admin')
    const existing = await adminAuth.getUserByEmail(EMAIL).catch(() => null)
    if (existing) await adminAuth.deleteUser(existing.uid).catch(() => null)
    const user = await adminAuth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true })
    uid = user.uid
    await adminDb.doc(`users/${uid}`).set({
      uid, email: EMAIL, name: 'Rules Probe', organizationName: 'Before',
      role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true,
      verification: { email: { verified: true, verifiedAt: null, verifiedMethod: 'otp' } },
      trust: { level: 'email_verified', score: 45, badges: ['email'] },
      // an admin-granted override already present (written by the Admin SDK, as the plan route does)
      entitlementOverrideTier: 'growth', entitlementUpdatedBy: 'admin-x', entitlementUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    })

    const { initializeApp } = await import('firebase/app')
    const authMod = await import('firebase/auth')
    fs = await import('firebase/firestore')
    clientApp = initializeApp({
      apiKey: 'demo-key', projectId: process.env.GCLOUD_PROJECT!,
      authDomain: `${process.env.GCLOUD_PROJECT}.firebaseapp.com`,
    }, `entrules-${process.pid}`)
    const auth = authMod.getAuth(clientApp)
    authMod.connectAuthEmulator(auth, `http://${AUTH_EMULATOR}`, { disableWarnings: true })
    const [host, port] = EMULATOR!.split(':')
    db = fs.getFirestore(clientApp)
    fs.connectFirestoreEmulator(db, host, Number(port))
    await authMod.signInWithEmailAndPassword(auth, EMAIL, PASSWORD)
  }, T)

  afterAll(async () => {
    const { adminDb, adminAuth } = await import('@/lib/firebase/admin')
    await adminDb.doc(`users/${uid}`).delete().catch(() => null)
    await adminAuth.deleteUser(uid).catch(() => null)
    const { deleteApp } = await import('firebase/app')
    if (clientApp) await deleteApp(clientApp).catch(() => null)
  }, T)

  it('CONTROL · the signed-in owner can still edit an ordinary profile field', async () => {
    await fs.updateDoc(fs.doc(db, 'users', uid), { organizationName: 'After' })
    const snap = await fs.getDoc(fs.doc(db, 'users', uid))
    expect(snap.data()?.organizationName).toBe('After')
  }, T)

  for (const [field, value] of [
    ['entitlementOverrideTier', 'enterprise'],
    ['entitlementUpdatedBy', 'self'],
    ['entitlementUpdatedAt', new Date('2030-01-01T00:00:00Z')],
  ] as const) {
    it(`the client can NOT change ${field}`, async () => {
      await expect(fs.updateDoc(fs.doc(db, 'users', uid), { [field]: value })).rejects.toMatchObject({ code: 'permission-denied' })
      // …not even smuggled in with a legitimate change
      await expect(fs.updateDoc(fs.doc(db, 'users', uid), { organizationName: 'Smuggle', [field]: value })).rejects.toMatchObject({ code: 'permission-denied' })
    }, T)
  }

  it('the client can NOT delete the override either, and the stored values are untouched', async () => {
    await expect(fs.updateDoc(fs.doc(db, 'users', uid), { entitlementOverrideTier: fs.deleteField() })).rejects.toMatchObject({ code: 'permission-denied' })
    const { adminDb } = await import('@/lib/firebase/admin')
    const d = (await adminDb.doc(`users/${uid}`).get()).data()!
    expect(d.entitlementOverrideTier).toBe('growth')
    expect(d.entitlementUpdatedBy).toBe('admin-x')
    expect(d.organizationName).toBe('After')
  }, T)

  it('an organizer WITHOUT an override cannot create one', async () => {
    const { adminDb } = await import('@/lib/firebase/admin')
    await adminDb.doc(`users/${uid}`).update({
      entitlementOverrideTier: (await import('firebase-admin/firestore')).FieldValue.delete(),
    })
    await expect(fs.updateDoc(fs.doc(db, 'users', uid), { entitlementOverrideTier: 'enterprise' })).rejects.toMatchObject({ code: 'permission-denied' })
    await fs.updateDoc(fs.doc(db, 'users', uid), { organizationName: 'Still editable' })
    expect((await adminDb.doc(`users/${uid}`).get()).data()!.entitlementOverrideTier).toBeUndefined()
  }, T)
})
