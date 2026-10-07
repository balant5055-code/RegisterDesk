// RD-WORKSPACE-OWNERSHIP-01 — `workspaceOwner` is server-owned, proved through REAL rules.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// The marker decides which workspace a caller resolves into (lib/team/workspace.ts), so it
// is identity, not preference. Every other identity field on the profile row — role,
// accountStatus, emailVerified, verification, trust — is already immutable to the client,
// and a new field in that class is worth nothing if the browser can rewrite it.
//
// Nothing here uses the Admin SDK for the write under test: the Admin SDK BYPASSES rules, so
// a test written with it would pass no matter what firestore.rules said. These cases sign in
// as a real emulator user through the CLIENT SDK, which is the code path a browser takes, and
// let the emulator's rules engine answer.
//
// The first case is a control. Without it, three denials could all be coming from a
// misconfigured client rather than from the rule being tested.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const AUTH_EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR && AUTH_EMULATOR ? describe : describe.skip
const T = 120_000

describeEmu('RD-WORKSPACE-OWNERSHIP-01 · firestore.rules protect the marker', () => {
  let clientApp: import('firebase/app').FirebaseApp
  let db: import('firebase/firestore').Firestore
  let fs: typeof import('firebase/firestore')
  let uid = ''

  const EMAIL = `wsorules-${process.pid}@rd.test`
  const PASSWORD = 'RulesPassw0rd!123'

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')

    // Seed the profile with the Admin SDK (bypasses rules — that is the point: the document
    // must already exist in its canonical shape before a client tries to mutate it).
    const { adminDb, adminAuth } = await import('@/lib/firebase/admin')
    const existing = await adminAuth.getUserByEmail(EMAIL).catch(() => null)
    if (existing) await adminAuth.deleteUser(existing.uid).catch(() => null)
    const user = await adminAuth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true })
    uid = user.uid
    await adminDb.doc(`users/${uid}`).set({
      uid, email: EMAIL, name: 'Rules Probe', organizationName: 'Before',
      role: 'organizer', accountStatus: 'active', emailVerified: true,
      workspaceOwner: true,
      verification: { email: { verified: true, verifiedAt: null, verifiedMethod: 'otp' } },
      trust: { level: 'email_verified', score: 45, badges: ['email'] },
    })

    // The client SDK, pointed at the same emulators, signed in as that user.
    const { initializeApp } = await import('firebase/app')
    const authMod = await import('firebase/auth')
    fs = await import('firebase/firestore')

    clientApp = initializeApp({
      apiKey: 'demo-key', projectId: process.env.GCLOUD_PROJECT!,
      authDomain: `${process.env.GCLOUD_PROJECT}.firebaseapp.com`,
    }, `wsorules-${process.pid}`)

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
    // If this fails, every denial below is meaningless.
    await fs.updateDoc(fs.doc(db, 'users', uid), { organizationName: 'After' })
    const snap = await fs.getDoc(fs.doc(db, 'users', uid))
    expect(snap.data()?.organizationName).toBe('After')
  }, T)

  it('refuses a client attempt to REVOKE its own marker', async () => {
    await expect(
      fs.updateDoc(fs.doc(db, 'users', uid), { workspaceOwner: false }),
    ).rejects.toThrow(/permission|insufficient/i)
  }, T)

  it('refuses a client attempt to GRANT the marker alongside a legitimate edit', async () => {
    // The realistic shape of an attack: hide the identity field in an otherwise valid patch.
    // `diff().affectedKeys()` must catch it regardless of what else the write carries.
    await expect(
      fs.updateDoc(fs.doc(db, 'users', uid), {
        organizationName: 'Sneaky', workspaceOwner: false,
      }),
    ).rejects.toThrow(/permission|insufficient/i)
    // …and the legitimate half must NOT have landed either.
    const snap = await fs.getDoc(fs.doc(db, 'users', uid))
    expect(snap.data()?.organizationName).not.toBe('Sneaky')
    expect(snap.data()?.workspaceOwner).toBe(true)
  }, T)

  it('allows a write that re-sends the SAME marker value', async () => {
    // diff() blocks changes, not mentions. A client echoing the value it already read must
    // not be refused, or ordinary profile saves that round-trip the whole document break.
    await fs.updateDoc(fs.doc(db, 'users', uid), {
      organizationName: 'Echoed', workspaceOwner: true,
    })
    const snap = await fs.getDoc(fs.doc(db, 'users', uid))
    expect(snap.data()?.organizationName).toBe('Echoed')
  }, T)

  it('still refuses the identity fields that were already protected', async () => {
    // Regression guard: adding a key to the list must not have disturbed the others.
    for (const patch of [
      { accountStatus: 'active2' },
      { role: 'admin' },
      { emailVerified: false },
      { trust: { level: 'forged', score: 999, badges: [] } },
    ]) {
      await expect(
        fs.updateDoc(fs.doc(db, 'users', uid), patch),
        `${Object.keys(patch)[0]} should be refused`,
      ).rejects.toThrow(/permission|insufficient/i)
    }
  }, T)
})
