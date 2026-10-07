// RD-ORGANIZER-SIGNUP-RULEFIX-05 — firestore.rules for /users/{userId}, exercised with
// CLIENT credentials.
//
// ═══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════
// Every other emulator test in this repo drives the Admin SDK, which BYPASSES security
// rules. That is the right tool for testing business logic, and it is also why a signup
// blocker shipped undetected: RD-ORGANIZER-SIGNUP-02 added `accountStatus: 'pending'` to
// the client-side profile create while firestore.rules still said
// `!('accountStatus' in request.resource.data)`. Every unit and emulator gate passed;
// every real browser signup died with PERMISSION_DENIED, surfacing only as a generic
// "Something went wrong. Please try again."
//
// No test in the tree could have caught that, because none of them was a client.
//
// These cases are clients. They mint a real user ID token through the Auth emulator and
// hit the Firestore REST API with it, so the emulator evaluates the rules exactly as it
// would for the browser SDK. The Admin SDK is used only to set up fixtures and to read
// back ground truth.
//
// ═══ WHAT IT PINS ════════════════════════════════════════════════════════════
// The create rule constrains the profile to its canonical initial shape, so a client
// cannot forge server-owned identity / moderation / trust state at create time. The
// update rule then blocks the client from ever changing those fields. Between them, an
// organizer can create itself ONLY as an unverified, untrusted, pending account, and can
// never promote itself — activation happens exclusively through
// POST /api/auth/verify-otp, on the Admin SDK.
//
// The rules under test are loaded from firestore.rules ON DISK in beforeAll, so this file
// pins the behaviour of the committed file rather than whatever ruleset the running
// emulator happened to start with.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000

const FS_HOST   = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
// RD-PREPROD · test isolation — this suite PUTs firestore.rules into the emulator. Done against
// the SHARED project it replaced the ruleset every other suite and the local dev server run
// under. It now uses its OWN emulator project for Firestore (documents + rules). Auth stays on
// the emulator's default project: the Auth emulator has no per-project REST sign-in, and the
// Firestore emulator honours that token under this project's rules (verified 2026-10-07).
const PROJECT   = 'demo-registerdesk-user-profile-rules'
const API_KEY   = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'demo-api-key'
const DOCS      = `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`

describeEmu('firestore.rules · /users/{userId} with CLIENT credentials', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth

  const created: string[] = []

  async function newUser(tag: string): Promise<string> {
    const u = await adminAuth.createUser({
      email: `rules-${tag}-${process.pid}-${created.length}@rd.test`,
      password: 'RulesPassw0rd!',
      emailVerified: false,
    })
    created.push(u.uid)
    return u.uid
  }

  /** A real user ID token — the same credential the browser SDK would present. */
  async function idToken(uid: string): Promise<string> {
    const custom = await adminAuth.createCustomToken(uid)
    const res = await fetch(
      `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }) },
    )
    const body = await res.json() as { idToken?: string }
    if (!body.idToken) throw new Error(`no idToken: ${JSON.stringify(body)}`)
    return body.idToken
  }

  /**
   * The payload lib/firebase/firestore createOrganizerProfile writes, in REST encoding.
   * `accountStatus` is a parameter so each case varies ONLY that field — anything else
   * differing would make a denial ambiguous.
   */
  function profileFields(uid: string, accountStatus: string | null): Record<string, unknown> {
    const f: Record<string, unknown> = {
      uid:              { stringValue: uid },
      name:             { stringValue: 'Rules Tester' },
      email:            { stringValue: 'rules@rd.test' },
      organizationName: { stringValue: 'Rules Co' },
      mobile: { mapValue: { fields: {
        e164:        { stringValue: '+919000000000' },
        countryCode: { stringValue: '+91' },
        verified:    { booleanValue: false },
        verifiedAt:  { nullValue: null },
      } } },
      role:          { stringValue: 'organizer' },
      emailVerified: { booleanValue: false },
      verification: { mapValue: { fields: {
        email: { mapValue: { fields: {
          verified:       { booleanValue: false },
          verifiedAt:     { nullValue: null },
          verifiedMethod: { nullValue: null },
        } } },
      } } },
      trust: { mapValue: { fields: {
        level:  { stringValue: 'unverified' },
        score:  { integerValue: '0' },
        badges: { arrayValue: { values: [] } },
      } } },
    }
    if (accountStatus !== null) f.accountStatus = { stringValue: accountStatus }
    return f
  }

  /** Client-credential CREATE of users/{docId}. Returns the HTTP status. */
  async function clientCreate(
    callerUid: string,
    docId: string,
    fields: Record<string, unknown>,
  ): Promise<number> {
    const token = await idToken(callerUid)
    const res = await fetch(`${DOCS}/users?documentId=${docId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields }),
    })
    return res.status
  }

  /**
   * Client-credential UPDATE of one field on users/{targetUid}, performed BY callerUid.
   * The two are separate parameters on purpose: deriving the token from the target would
   * make every cross-user case authenticate as the victim and quietly pass.
   */
  async function clientUpdate(
    callerUid: string, targetUid: string, field: string, value: unknown,
  ): Promise<number> {
    const token = await idToken(callerUid)
    const res = await fetch(`${DOCS}/users/${targetUid}?updateMask.fieldPaths=${field}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields: { [field]: value } }),
    })
    return res.status
  }

  /** Seed a canonical pending profile with the Admin SDK (rules bypassed). */
  async function seedPending(uid: string) {
    await adminDb.doc(`users/${uid}`).set({
      uid, name: 'Rules Tester', email: 'rules@rd.test', organizationName: 'Rules Co',
      role: 'organizer', accountStatus: 'pending', emailVerified: false,
      verification: { email: { verified: false, verifiedAt: null, verifiedMethod: null } },
      trust: { level: 'unverified', score: 0, badges: [] },
    })
  }

  const statusOf = async (uid: string) =>
    (await adminDb.doc(`users/${uid}`).get()).data()?.accountStatus

  beforeAll(async () => {
    if (!PROJECT.startsWith('demo-')) throw new Error('demo project only')
    ;({ adminAuth } = await import('@/lib/firebase/admin'))
    // Firestore through a dedicated Admin app bound to this suite's own project.
    const { initializeApp, getApps } = await import('firebase-admin/app')
    const { getFirestore } = await import('firebase-admin/firestore')
    const app = getApps().find(a => a.name === PROJECT) ?? initializeApp({ projectId: PROJECT }, PROJECT)
    adminDb = getFirestore(app)

    // Load the rules FROM DISK, so these cases pin the committed file rather than
    // whatever ruleset this emulator process was started with.
    const rules = readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8')
    const res = await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}:securityRules`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: rules }] } }),
    })
    if (!res.ok) throw new Error(`could not load firestore.rules into the emulator: ${res.status}`)
  }, T)

  afterAll(async () => {
    for (const uid of created) {
      await adminDb.doc(`users/${uid}`).delete().catch(() => null)
      await adminAuth.deleteUser(uid).catch(() => null)
    }
  }, T)

  // ═══ CREATE · accountStatus is pinned to the one safe initial value ══════════

  it('1 · create with accountStatus "pending" is ALLOWED', async () => {
    // The signup path. This is the case that was denied before the fix, taking the whole
    // browser signup down with it.
    const uid = await newUser('pending')
    expect(await clientCreate(uid, uid, profileFields(uid, 'pending'))).toBe(200)
    expect(await statusOf(uid)).toBe('pending')
  }, T)

  for (const [n, status] of [['2', 'active'], ['3', 'suspended'], ['4', 'banned']] as const) {
    it(`${n} · create with accountStatus "${status}" is DENIED`, async () => {
      // Self-promotion and self-moderation. 'active' is the dangerous one: it would let a
      // signup publish itself to the admin console as a verified organizer.
      const uid = await newUser(status)
      expect(await clientCreate(uid, uid, profileFields(uid, status))).toBe(403)
      expect((await adminDb.doc(`users/${uid}`).get()).exists).toBe(false)
    }, T)
  }

  it('5 · create with an arbitrary accountStatus is DENIED', async () => {
    // The old rule shape (`!('accountStatus' in ...)`) was replaced by an equality check
    // rather than a membership test, so an unrecognised value fails by construction — the
    // same reasoning as resolveAccountStatus having one explicit fallback.
    for (const bogus of ['vip', 'PENDING', 'pending ', '', 'verified']) {
      const uid = await newUser('bogus')
      expect(await clientCreate(uid, uid, profileFields(uid, bogus)),
        `accountStatus "${bogus}" was accepted`).toBe(403)
      expect((await adminDb.doc(`users/${uid}`).get()).exists).toBe(false)
    }
  }, T)

  it('5b · create with accountStatus OMITTED is ALLOWED during the signup transition', async () => {
    // RD-PHASE4 signup transition (approved): an OLDER app bundle — still running in open
    // tabs after a deploy — sends no accountStatus. Refusing it broke signup outright (the
    // RD-ORGANIZER-SIGNUP-RULEFIX-05 incident in the other direction), so the transitional
    // create rule accepts a missing field as well as 'pending'. It grants nothing: organizer
    // APIs still refuse an unverified token, and verify-otp activates such a never-verified
    // profile exactly like a pending one. Every OTHER value is still refused (cases 2–5).
    // Tighten back to 'pending'-only (and restore the DENIED expectation) after the window.
    const uid = await newUser('missing')
    expect(await clientCreate(uid, uid, profileFields(uid, null))).toBe(200)
    const d = (await adminDb.doc(`users/${uid}`).get()).data()!
    expect(d.accountStatus).toBeUndefined()
  }, T)

  // ═══ CREATE · the other server-owned fields are still pinned ═════════════════

  it('create is DENIED when role, emailVerified, verification or trust are forged', async () => {
    const cases: [string, (f: Record<string, unknown>) => void][] = [
      ['role != organizer',        f => { f.role = { stringValue: 'admin' } }],
      ['emailVerified true',       f => { f.emailVerified = { booleanValue: true } }],
      ['verification.email true',  f => { f.verification = { mapValue: { fields: {
        email: { mapValue: { fields: {
          verified: { booleanValue: true }, verifiedAt: { nullValue: null }, verifiedMethod: { nullValue: null },
        } } } } } } }],
      ['trust.score > 0',          f => { f.trust = { mapValue: { fields: {
        level: { stringValue: 'verified' }, score: { integerValue: '45' },
        badges: { arrayValue: { values: [] } },
      } } } }],
    ]
    for (const [label, mutate] of cases) {
      const uid = await newUser('forge')
      const fields = profileFields(uid, 'pending')
      mutate(fields)
      expect(await clientCreate(uid, uid, fields), `${label} was accepted`).toBe(403)
    }
  }, T)

  it('create is DENIED for a document belonging to ANOTHER uid', async () => {
    const me = await newUser('me')
    const victim = await newUser('victim')
    expect(await clientCreate(me, victim, profileFields(victim, 'pending'))).toBe(403)
    expect((await adminDb.doc(`users/${victim}`).get()).exists).toBe(false)
  }, T)

  // ═══ UPDATE · the client can never promote or moderate itself ════════════════

  it('6 · a client CANNOT change its own pending → active', async () => {
    // The whole point of the pending lifecycle. Activation is reachable only through
    // POST /api/auth/verify-otp, on the Admin SDK.
    const uid = await newUser('promote')
    await seedPending(uid)
    expect(await clientUpdate(uid, uid, 'accountStatus', { stringValue: 'active' })).toBe(403)
    expect(await statusOf(uid)).toBe('pending')
  }, T)

  it('7 · a client CANNOT change its own pending → suspended or banned', async () => {
    for (const status of ['suspended', 'banned']) {
      const uid = await newUser(`self-${status}`)
      await seedPending(uid)
      expect(await clientUpdate(uid, uid, 'accountStatus', { stringValue: status })).toBe(403)
      expect(await statusOf(uid)).toBe('pending')
    }
  }, T)

  it('7b · a SUSPENDED client cannot self-reactivate', async () => {
    // The original reason the update guard exists.
    const uid = await newUser('suspended-self')
    await seedPending(uid)
    await adminDb.doc(`users/${uid}`).update({ accountStatus: 'suspended' })
    expect(await clientUpdate(uid, uid, 'accountStatus', { stringValue: 'active' })).toBe(403)
    expect(await statusOf(uid)).toBe('suspended')
  }, T)

  it('8 · the other update protections are intact, and editable fields still work', async () => {
    const uid = await newUser('update-guard')
    await seedPending(uid)

    // Server-owned — every one must be refused.
    expect(await clientUpdate(uid, uid, 'role',          { stringValue: 'admin' })).toBe(403)
    expect(await clientUpdate(uid, uid, 'emailVerified', { booleanValue: true })).toBe(403)
    expect(await clientUpdate(uid, uid, 'statusReason',  { stringValue: 'mine now' })).toBe(403)
    expect(await clientUpdate(uid, uid, 'trust', { mapValue: { fields: {
      level: { stringValue: 'verified' }, score: { integerValue: '99' },
      badges: { arrayValue: { values: [] } },
    } } })).toBe(403)
    expect(await clientUpdate(uid, uid, 'customDomainStatus', { stringValue: 'verified' })).toBe(403)

    // An ordinary editable field is still the organizer's own to change — the guard must
    // not have become a blanket write lock.
    expect(await clientUpdate(uid, uid, 'organizationName', { stringValue: 'Renamed Co' })).toBe(200)

    const after = (await adminDb.doc(`users/${uid}`).get()).data()!
    expect(after.organizationName).toBe('Renamed Co')
    expect(after.accountStatus).toBe('pending')
    expect(after.role).toBe('organizer')
    expect(after.emailVerified).toBe(false)
    expect(after.trust.score).toBe(0)
  }, T)

  it('a client cannot read or write ANOTHER organizer profile', async () => {
    const me = await newUser('reader')
    const other = await newUser('other')
    await seedPending(other)
    const token = await idToken(me)
    const read = await fetch(`${DOCS}/users/${other}`, { headers: { Authorization: `Bearer ${token}` } })
    expect(read.status).toBe(403)
    expect(await clientUpdate(me, other, 'organizationName', { stringValue: 'hijacked' })).toBe(403)
    expect((await adminDb.doc(`users/${other}`).get()).data()!.organizationName).toBe('Rules Co')
  }, T)
})
