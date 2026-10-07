// RD-PHASE4-S4 — every financial / audit collection this stage writes stays SERVER-ONLY under the
// repository's firestore.rules. The reads and writes below go through the CLIENT SDK, signed in as an
// ordinary organizer (the Admin SDK bypasses rules and would prove nothing). No rule was changed by
// this stage: `adminAuditFailures` and `configurationAudit` have no match block, so the default deny
// applies; the others are explicit `if false`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const AUTH_EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST
const describeEmu = EMULATOR && AUTH_EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid

describeEmu('RD-PHASE4-S4 · firestore.rules deny clients every financial audit collection', () => {
  let clientApp: import('firebase/app').FirebaseApp
  let db: import('firebase/firestore').Firestore
  let fs: typeof import('firebase/firestore')
  let uid = ''
  const EMAIL = `p4s4rules-${P}@rd.test`
  const PASSWORD = 'RulesPassw0rd!123'
  const seeded: string[] = []

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const { adminDb, adminAuth } = await import('@/lib/firebase/admin')
    const existing = await adminAuth.getUserByEmail(EMAIL).catch(() => null)
    if (existing) await adminAuth.deleteUser(existing.uid).catch(() => null)
    uid = (await adminAuth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true })).uid
    // documents the client will try to READ (and tamper with) — seeded with the Admin SDK
    for (const [p, data] of [
      [`adminAuditLogs/p4s4r-${P}`, { adminUid: 'x', action: 'settlement.paid', entityType: 'settlement', entityId: 's', organizerUid: uid }],
      [`adminAuditFailures/p4s4r-${P}`, { status: 'open', audit: { entityId: uid } }],
      [`configurationAudit/p4s4r-${P}`, { section: 'fees', updatedBy: 'x' }],
      [`payoutProfileHistory/p4s4r-${P}`, { organizerUid: uid, action: 'admin_verified' }],
      [`failedRefunds/p4s4r-${P}`, { status: 'review', kind: 'duplicate_hold' }],
      [`settlementRequests/p4s4r-${P}`, { organizerUid: uid, status: 'approved', approvedBy: 'someone' }],
      [`licenseHistory/p4s4r-${P}`, { organizerUid: uid, action: 'refunded' }],
    ] as const) { await adminDb.doc(p).set(data as Record<string, unknown>); seeded.push(p) }

    const { initializeApp } = await import('firebase/app')
    const authMod = await import('firebase/auth')
    fs = await import('firebase/firestore')
    clientApp = initializeApp({ apiKey: 'demo-key', projectId: process.env.GCLOUD_PROJECT!, authDomain: `${process.env.GCLOUD_PROJECT}.firebaseapp.com` }, `p4s4rules-${P}`)
    const auth = authMod.getAuth(clientApp)
    authMod.connectAuthEmulator(auth, `http://${AUTH_EMULATOR}`, { disableWarnings: true })
    const [host, port] = EMULATOR!.split(':')
    db = fs.getFirestore(clientApp)
    fs.connectFirestoreEmulator(db, host, Number(port))
    await authMod.signInWithEmailAndPassword(auth, EMAIL, PASSWORD)
  }, T)

  afterAll(async () => {
    const { adminDb, adminAuth } = await import('@/lib/firebase/admin')
    for (const p of seeded) await adminDb.doc(p).delete().catch(() => null)
    await adminAuth.deleteUser(uid).catch(() => null)
    const { deleteApp } = await import('firebase/app')
    await deleteApp(clientApp).catch(() => null)
  }, T)

  const denied = async (op: Promise<unknown>) => {
    try { await op; return false } catch (e) { return (e as { code?: string }).code === 'permission-denied' }
  }

  it('reads, creates, updates and deletes are all denied', async () => {
    for (const col of ['adminAuditLogs', 'adminAuditFailures', 'configurationAudit', 'payoutProfileHistory', 'failedRefunds', 'settlementRequests', 'licenseHistory']) {
      const ref = fs.doc(db, col, `p4s4r-${P}`)
      expect(await denied(fs.getDoc(ref)), `${col} read`).toBe(true)
      expect(await denied(fs.setDoc(fs.doc(db, col, `p4s4r-new-${P}`), { organizerUid: uid, forged: true })), `${col} create`).toBe(true)
      expect(await denied(fs.deleteDoc(ref)), `${col} delete`).toBe(true)
    }
    // the specific tampering this stage guards against
    expect(await denied(fs.updateDoc(fs.doc(db, 'failedRefunds', `p4s4r-${P}`), { status: 'open', reviewApproval: { by: uid } })), 'forge a hold approval').toBe(true)
    expect(await denied(fs.updateDoc(fs.doc(db, 'settlementRequests', `p4s4r-${P}`), { approvedBy: uid })), 'forge the approver').toBe(true)
    expect(await denied(fs.getDocs(fs.query(fs.collection(db, 'adminAuditLogs'), fs.where('organizerUid', '==', uid)))), 'query audit').toBe(true)
  }, T)
})
