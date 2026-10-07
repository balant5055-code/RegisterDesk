// RD-ORGANIZER-MODERATION-COVERAGE-14 — the routes that leaked, measured end to end.
//
// ═══ HOW THIS SPLITS FROM THE UNIT TEST ══════════════════════════════════════
// tests/unit/organizerModerationCoverage.test.ts pins the ARCHITECTURE over all 243
// organizer routes: authentication may only happen at the seam, the opt-out is confined to
// the two workspace authorizers, and every route reaches the seam. That is the durable
// guarantee, and it is cheap because it reads the import graph rather than executing it.
//
// This file supplies the other half: PROOF that the architecture produces the behaviour, by
// invoking real handlers with a real ID token belonging to a real suspended organizer. It
// probes the routes that actually answered 200 in RD-13 plus the race-operations family this
// phase discovered, rather than all 243 — importing every organizer route pulls in the AWS,
// Razorpay, PDF and image toolchains and does not finish.
//
// ═══ WHAT WAS BROKEN ═════════════════════════════════════════════════════════
// RD-12's gate sat in lib/team/workspace's authorizers. These routes never call them: they
// call verifyCaller and go straight to their logic. So a suspended organizer could read and
// write their workspace, and — via race-operations — publish race results.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000

/**
 * The bypass surface, as measured. The first 14 are RD-13's table; race-operations was
 * missed by that audit because it reaches verifyCaller through a feature wrapper
 * (features/race-operations/services/authorize) rather than importing it in the route file.
 */
const PROBE: ReadonlyArray<{ file: string; verb: 'GET' | 'POST' | 'PUT' | 'PATCH'; why?: string }> = [
  { file: 'app/api/organizer/workspace/route.ts',    verb: 'GET' },
  { file: 'app/api/organizer/settings/route.ts',     verb: 'GET' },
  { file: 'app/api/organizer/team/route.ts',         verb: 'GET' },
  { file: 'app/api/organizer/staff/route.ts',        verb: 'GET' },
  { file: 'app/api/organizer/api-keys/route.ts',     verb: 'GET' },
  { file: 'app/api/organizer/branding/route.ts',     verb: 'GET' },
  { file: 'app/api/organizer/domain/route.ts',       verb: 'GET' },
  { file: 'app/api/organizer/campaigns/route.ts',    verb: 'GET' },
  { file: 'app/api/organizer/licenses/route.ts',     verb: 'GET' },
  { file: 'app/api/organizer/entitlements/route.ts', verb: 'GET' },
  { file: 'app/api/organizer/reminders/route.ts',    verb: 'GET' },
  { file: 'app/api/organizer/webhooks/route.ts',     verb: 'GET' },
  // mutating verbs on the same surface — a gate that only covered reads would be worthless
  { file: 'app/api/organizer/api-keys/route.ts',     verb: 'POST' },
  { file: 'app/api/organizer/webhooks/route.ts',     verb: 'PUT' },
  { file: 'app/api/organizer/settings/route.ts',     verb: 'PATCH' },
  // discovered in this phase: authenticates via a wrapper, so RD-13 never listed it
  { file: 'app/api/organizer/race-operations/races/route.ts', verb: 'GET',
    why: 'race-operations wrapper calls verifyCaller directly' },
  { file: 'app/api/organizer/race-operations/races/route.ts', verb: 'POST',
    why: 'a suspended organizer could otherwise create a race' },
]

/** Routes already covered by RD-12, kept as controls: they must keep answering 403. */
const CONTROLS: ReadonlyArray<{ file: string; verb: 'GET' }> = [
  { file: 'app/api/organizer/dashboard/route.ts', verb: 'GET' },
  { file: 'app/api/organizer/events/route.ts',    verb: 'GET' },
]

describeEmu('RD-ORGANIZER-MODERATION-COVERAGE-14 · the bypass routes now refuse', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let adminAuth: import('firebase-admin/auth').Auth
  const created: string[] = []

  const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
  const API_KEY   = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'demo-api-key'

  /** Minted from the Auth record AS IT IS NOW — a stale token would let a broken gate pass. */
  async function freshToken(uid: string): Promise<string> {
    const custom = await adminAuth.createCustomToken(uid)
    const res = await fetch(
      `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }) },
    )
    const b = await res.json() as { idToken?: string }
    if (!b.idToken) throw new Error('no idToken')
    return b.idToken
  }

  async function seed(tag: string, accountStatus?: string): Promise<string> {
    const email = `mc14-${tag}-${process.pid}-${created.length}@rd.test`
    const u = await adminAuth.createUser({ email, password: 'Mc14Passw0rd!', emailVerified: true })
    created.push(u.uid)
    const doc: Record<string, unknown> = {
      uid: u.uid, name: 'Cov ' + tag, email, organizationName: 'Cov ' + tag + ' Co',
      role: 'organizer', emailVerified: true,
      verification: { email: { verified: true, verifiedAt: null, verifiedMethod: 'otp' } },
      trust: { level: 'email_verified', score: 45, badges: [] }, createdAt: new Date(),
    }
    if (accountStatus !== undefined) doc.accountStatus = accountStatus
    await adminDb.doc(`users/${u.uid}`).set(doc)
    return u.uid
  }

  async function call(file: string, verb: string, token: string): Promise<number | 'threw'> {
    const mod = await import(/* @vite-ignore */ '@/' + file.replace(/\.ts$/, '')) as Record<string, unknown>
    const handler = mod[verb]
    if (typeof handler !== 'function') throw new Error(`${file} exports no ${verb} — PROBE is stale`)
    const init: RequestInit = {
      method: verb,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }
    if (verb !== 'GET') init.body = '{}'
    const url = 'http://localhost/' + file.replace(/^app\//, '').replace(/\/route\.ts$/, '')
    try {
      const res = await (handler as (r: unknown, c: unknown) => Promise<Response>)(
        new NextRequest(new Request(url, init)), { params: Promise.resolve({}) },
      )
      return res.status
    } catch {
      return 'threw'
    }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb, adminAuth } = await import('@/lib/firebase/admin'))
  }, T)

  afterAll(async () => {
    for (const uid of created) {
      for (const d of (await adminDb.collection('teamMembers').where('organizerUid', '==', uid).get()).docs) await d.ref.delete()
      for (const d of (await adminDb.collection('users').doc(uid).collection('eventDrafts').get()).docs) await d.ref.delete()
      await adminDb.doc(`users/${uid}`).delete().catch(() => null)
      await adminAuth.deleteUser(uid).catch(() => null)
    }
  }, T)

  for (const status of ['suspended', 'banned'] as const) {
    it(`no probed route answers 2xx to a ${status} organizer`, async () => {
      const token = await freshToken(await seed(status, status))
      const leaked: string[] = []
      const table: string[] = []

      for (const { file, verb } of [...PROBE, ...CONTROLS]) {
        const s = await call(file, verb, token)
        table.push(`  ${String(s).padEnd(6)} ${verb.padEnd(6)} ${file}`)
        if (typeof s === 'number' && s >= 200 && s < 300) leaked.push(`${verb} ${file} -> ${s}`)
      }

      console.log(`\n[${status}]\n${table.join('\n')}`)
      expect(leaked).toEqual([])
    }, T)
  }

  it('an ACTIVE organizer still gets through every probed route — the refusals are the gate, not a broken harness', async () => {
    // Without this, a harness that denied everything for an unrelated reason (a bad token, a
    // malformed request) would "pass" both cases above while proving nothing.
    const token = await freshToken(await seed('active', 'active'))
    const refused: string[] = []
    for (const { file, verb } of [...PROBE, ...CONTROLS]) {
      if (verb !== 'GET') continue          // mutations need real bodies; reads suffice here
      const s = await call(file, verb, token)
      if (s === 401 || s === 403) refused.push(`${verb} ${file} -> ${s}`)
    }
    expect(refused).toEqual([])
  }, T)

  it('a GRANDFATHERED organizer (no accountStatus) is not caught by the new seam', async () => {
    // The backward-compatibility contract, asserted against a real route rather than a mock.
    const uid = await seed('grand')
    expect((await adminDb.doc(`users/${uid}`).get()).data()!.accountStatus).toBeUndefined()
    expect(await call('app/api/organizer/workspace/route.ts', 'GET', await freshToken(uid))).toBe(200)
  }, T)

  it('reactivating restores access to a previously-bypassing route', async () => {
    const uid = await seed('restore', 'active')
    await adminDb.doc(`users/${uid}`).update({ accountStatus: 'suspended' })
    expect(await call('app/api/organizer/workspace/route.ts', 'GET', await freshToken(uid))).toBe(401)

    const { setOrganizerAccountStatus } = await import('@/lib/admin/organizerService')
    expect((await setOrganizerAccountStatus(uid, 'reactivate', 'mc14-admin', '')).ok).toBe(true)
    expect(await call('app/api/organizer/workspace/route.ts', 'GET', await freshToken(uid))).toBe(200)
  }, T)

  it('a STAFF credential is not blocked by the token seam — it has no organizer profile', async () => {
    // Why moderation is safe in a function five domains share: isModerated fail-opens on a
    // missing users/{uid} doc, and a staff identity lives in staffAccounts/teamMembers.
    // If that ever changes, staff sign-in breaks and this fails first.
    const { isModerated } = await import('@/lib/admin/organizerStatus')
    expect(await isModerated('mc14-uid-with-no-profile-doc')).toBe(false)
  }, T)
})
