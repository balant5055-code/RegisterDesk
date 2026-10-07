// RD-CHECKIN-08 Defect 1 — a staff credential cannot manage staff accounts.
//
// ═══ WHAT WENT WRONG ═════════════════════════════════════════════════════════
// The staff-management routes guarded themselves with
// `requireOwner(caller.uid, caller.uid)`. Both arguments are the same value, so the
// comparison inside it can never fail: the call authorized every authenticated
// identity, including a gate credential. RD-CHECKIN-07 proved it against production
// — a checkin_staff token POSTed to /api/organizer/staff and got 201 Created.
//
// It was never cross-tenant: these routes deliberately take the workspace from
// `caller.uid` and never from the request, so the account landed in a workspace of
// the caller's own that owns no events. What it did permit was unauthorized
// credential minting, and permanent name-claiming in the GLOBAL `staffUsernames`
// collection.
//
// ═══ WHAT IS ASSERTED ════════════════════════════════════════════════════════
// The real route handlers are invoked with real Request objects. Only the two edges
// are stubbed — token verification and the storage layer — so what runs here is the
// authorization code under test, not a re-implementation of it.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STAFF_EMAIL_DOMAIN } from '@/lib/staff/types'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// ─── Test doubles ────────────────────────────────────────────────────────────

/** The identity the (stubbed) token verifier will return. */
const caller = { uid: '', email: null as string | null, verified: true }
/** Whether a `staffAccounts/{uid}` profile exists for the caller. */
let staffProfileExists = false

const createSpy = vi.fn()
const updateSpy = vi.fn()
const deleteSpy = vi.fn()

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {
    verifyIdToken: async () => {
      if (!caller.uid) throw new Error('no such token')
      return { uid: caller.uid, email: caller.email, email_verified: caller.verified }
    },
  },
  adminDb: {
    // RD-ORGANIZER-MODERATION-COVERAGE-14 — verifyCaller now reads the caller's organizer
    // profile via adminDb.doc('users/{uid}') to enforce moderation. `exists: false` is the
    // right fixture for this file: getOrganizerAccountStatus fail-opens on a missing doc, so
    // both the organizer and the staff credential here stay unmoderated and these cases keep
    // testing ROLE authorization (403) rather than accidentally testing the new gate (401).
    doc: () => ({ get: async () => ({ exists: false }) }),
    collection: (name: string) => ({
      doc: () => ({
        get: async () => ({ exists: name === 'staffAccounts' ? staffProfileExists : false }),
      }),
      where: () => ({ where: () => ({ where: () => ({ limit: () => ({
        get: async () => ({ empty: true, docs: [] }),
      }) }) }) }),
    }),
  },
}))

vi.mock('@/lib/staff/service', () => ({
  listStaffAccounts:  async () => [],
  createStaffAccount: (input: unknown) => { createSpy(input); return Promise.resolve({ ok: true, data: { staff: { staffId: 'new-staff' }, temporaryPassword: 'x' } }) },
  updateStaffAccount: (input: unknown) => { updateSpy(input); return Promise.resolve({ ok: true, data: {} }) },
  deleteStaffAccount: (input: unknown) => { deleteSpy(input); return Promise.resolve({ ok: true, data: undefined }) },
  resetStaffPassword: async () => ({ ok: true, data: { temporaryPassword: 'x' } }),
}))

// RD-CAPACITY-01 — the entitlements stub that used to sit here is gone with the gate. The
// route no longer imports lib/licensing/workspaceEntitlements at all, so mocking it would be
// a stub for a dependency that does not exist — and a misleading hint that a licence still
// has a say in who may mint a staff credential. Tests 18 and 19 assert the removal and the
// authorization that replaced it as the only guard.

vi.mock('@/lib/rateLimit/policies', () => ({
  RATE_POLICY: { teamInvite: {} },
  checkPolicy: () => ({ limited: false }),
}))

const { GET, POST }      = await import('@/app/api/organizer/staff/route')
const { PATCH, DELETE }  = await import('@/app/api/organizer/staff/[staffId]/route')

const req = (body?: unknown, token = 'tok') => new Request('http://localhost/api/organizer/staff', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any

const ctx = { params: Promise.resolve({ staffId: 'staff-1' }) }

const VALID_BODY = {
  username: 'gate.arun', displayName: 'Arun', role: 'checkin_staff', eventIds: ['ev-1'],
}

/** Become an ORGANIZER: an ordinary address, no staff profile. */
function asOrganizer(uid = 'org-1') {
  caller.uid = uid; caller.email = 'organizer@example.com'; caller.verified = true
  staffProfileExists = false
}
/** Become a STAFF CREDENTIAL of the given role. */
function asStaff(uid = 'staff-uid', username = 'gate.arun') {
  caller.uid = uid; caller.email = `${username}@${STAFF_EMAIL_DOMAIN}`; caller.verified = true
  staffProfileExists = true
}

beforeEach(() => {
  createSpy.mockClear(); updateSpy.mockClear(); deleteSpy.mockClear()
})

// ─── Phase 6 — the required security regression ──────────────────────────────

describe('RD-CHECKIN-08 · POST /api/organizer/staff', () => {
  it('1 · an authorized organizer CAN create a staff account → 201', async () => {
    asOrganizer()
    const res = await POST(req(VALID_BODY))
    expect(res.status).toBe(201)
    expect(createSpy).toHaveBeenCalledTimes(1)
  })

  it('2 · checkin_staff CANNOT create a staff account → 403', async () => {
    asStaff('staff-checkin', 'gate.one')
    const res = await POST(req(VALID_BODY))
    expect(res.status).toBe(403)
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('3 · checkin_lead CANNOT create a staff account → 403', async () => {
    // A lead is still a credential on the reserved namespace; role does not matter.
    asStaff('staff-lead', 'gate.lead')
    const res = await POST(req(VALID_BODY))
    expect(res.status).toBe(403)
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('4 · a staff caller cannot escape the refusal by changing its token email', async () => {
    // The address is only the cheap first answer. The `staffAccounts/{uid}` profile
    // is server-written and denied to the client SDK, so it settles the question even
    // if the Auth email were ever moved out of the reserved namespace.
    caller.uid = 'staff-sneaky'; caller.email = 'looks.like.a.person@gmail.com'
    caller.verified = true; staffProfileExists = true
    const res = await POST(req(VALID_BODY))
    expect(res.status).toBe(403)
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('5 · the workspace is the CALLER, never a value from the request body', async () => {
    asOrganizer('org-real')
    const res = await POST(req({
      ...VALID_BODY,
      organizerUid: 'victim-org', workspaceUid: 'victim-org', actorUid: 'victim-org',
    }))
    expect(res.status).toBe(201)
    const arg = createSpy.mock.calls[0]![0] as { organizerUid: string; actorUid: string }
    expect(arg.organizerUid).toBe('org-real')
    expect(arg.actorUid).toBe('org-real')
  })

  it('6 · legitimate creation still forwards the caller\'s fields unchanged', async () => {
    asOrganizer()
    await POST(req(VALID_BODY))
    const arg = createSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(arg.username).toBe('gate.arun')
    expect(arg.displayName).toBe('Arun')
    expect(arg.role).toBe('checkin_staff')
    expect(arg.eventIds).toEqual(['ev-1'])
  })

  it('7 · authentication stays server-side — no token and unverified email are refused', async () => {
    asOrganizer()
    const noHeader = await POST(new Request('http://localhost/x', {
      method: 'POST', body: JSON.stringify(VALID_BODY),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)
    expect(noHeader.status).toBe(401)

    caller.verified = false
    expect((await POST(req(VALID_BODY))).status).toBe(401)
    expect(createSpy).not.toHaveBeenCalled()
  })
})

describe('RD-CHECKIN-08 · the rest of the staff-management path', () => {
  it('8 · GET is refused to a staff credential and allowed to an organizer', async () => {
    asStaff()
    expect((await GET(req())).status).toBe(403)
    asOrganizer()
    expect((await GET(req())).status).toBe(200)
  })

  it('9 · PATCH is refused to a staff credential', async () => {
    asStaff()
    expect((await PATCH(req({ displayName: 'x' }), ctx)).status).toBe(403)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('10 · DELETE is refused to a staff credential', async () => {
    asStaff()
    expect((await DELETE(req(), ctx)).status).toBe(403)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('11 · PATCH and DELETE still work for the organizer, scoped to their own uid', async () => {
    asOrganizer('org-9')
    expect((await PATCH(req({ displayName: 'Renamed' }), ctx)).status).toBe(200)
    expect((updateSpy.mock.calls[0]![0] as { organizerUid: string }).organizerUid).toBe('org-9')
    expect((await DELETE(req(), ctx)).status).toBe(200)
    expect((deleteSpy.mock.calls[0]![0] as { organizerUid: string }).organizerUid).toBe('org-9')
  })
})

// ─── Source contracts: the defect cannot come back by edit ───────────────────

describe('RD-CHECKIN-08 · the tautology is gone from the staff path', () => {
  const LIST = code(read('app/api/organizer/staff/route.ts'))
  const ITEM = code(read('app/api/organizer/staff/[staffId]/route.ts'))
  const ACCESS = code(read('lib/team/access.ts'))

  it('12 · no route passes the same uid to both sides of an ownership check', () => {
    for (const src of [LIST, ITEM]) {
      expect(src).not.toMatch(/requireOwner\(\s*caller\.uid\s*,\s*caller\.uid\s*\)/)
      expect(src).not.toMatch(/requireAdmin\(\s*caller\.uid\s*,\s*caller\.uid\s*\)/)
    }
  })

  it('13 · every staff-management handler authorizes through requireStaffManager', async () => {
    // Four handlers: GET + POST on the collection, PATCH + DELETE on the item.
    const calls = (LIST + ITEM).match(/await requireStaffManager\(caller\)/g) ?? []
    expect(calls).toHaveLength(4)
  })

  it('14 · the username lock is still the service\'s job, not the route\'s', () => {
    // The route must not have grown its own uniqueness handling as part of this fix.
    expect(LIST).not.toMatch(/staffUsernames/)
    expect(code(read('lib/staff/service.ts'))).toMatch(/STAFF_USERNAME_COLLECTION/)
  })

  it('15 · the refusal is derived from identity, never from a request field', () => {
    expect(ACCESS).toMatch(/export async function isStaffCredential/)
    expect(ACCESS).toMatch(/isStaffEmail\(caller\.email\)/)
    expect(ACCESS).toMatch(/STAFF_COLLECTION/)
    // Nothing in the check may read the body.
    expect(ACCESS).not.toMatch(/req\.json\(\)/)
  })
})

// ─── RD-TEAM-IMPL-01 — staff is now the ONLY way in ─────────────────────────

describe('RD-TEAM-IMPL-01 · the staff lifecycle is audited and gated', () => {
  const SERVICE = code(read('lib/staff/service.ts'))
  const AUDIT   = code(read('lib/team/audit.ts'))
  const ROUTE   = code(read('app/api/organizer/staff/route.ts'))

  it('16 · every lifecycle transition writes an audit row', () => {
    // Issuing a credential was previously the one action that left no trace, while a
    // team invite wrote one. That asymmetry is what this closes.
    for (const action of [
      'staff.created', 'staff.events_changed', 'staff.suspended',
      'staff.reactivated', 'staff.password_reset', 'staff.removed',
    ]) {
      expect(SERVICE, action).toContain(`'${action}'`)
      expect(AUDIT, action).toContain(`'${action}'`)
    }
  })

  it('17 · the audit never carries credential material', () => {
    // The metadata objects may name a username or an event count; a password must
    // never appear in one.
    const audits = SERVICE.match(/logTeamAction\(\{[\s\S]*?\}\)/g) ?? []
    expect(audits.length).toBeGreaterThanOrEqual(4)
    for (const a of audits) {
      // The ACTION NAME may legitimately say `staff.password_reset` — that is what
      // happened, not the secret. What must never appear is a credential VALUE, so
      // the action line is excluded and the rest is checked for one.
      const body = a.split('\n').filter(l => !l.includes('action:')).join('\n')
      expect(body, a.slice(0, 70)).not.toMatch(/temporaryPassword|password:|secret|\bpwd\b/i)
    }
  })

  it('18 · RD-CAPACITY-01 · the paid-feature and seat gates are GONE, by design', () => {
    // The capacity-based commercial model retired licence tiers, and with them team access
    // as a paid feature and maxTeamMembers as a seat cap. Every organizer gets both.
    //
    // This test is inverted rather than deleted: the original asserted the gates existed,
    // and an inverted assertion is what stops them being reintroduced by a merge that
    // resurrects the tier vocabulary. What replaced them is asserted in 19.
    expect(ROUTE).not.toContain("requireFeature(caller.uid, 'teamAccess')")
    expect(ROUTE).not.toContain("requireLimit(caller.uid, 'maxTeamMembers'")
    expect(ROUTE).not.toContain('workspaceEntitlements')
  })

  it('19 · removing the licence gate did NOT remove the authorization gate', () => {
    // This is the half that mattered all along. The original test said a 402 ("authorized
    // but unpaid") must never be what stops an unauthorized caller — requireStaffManager is
    // what does that. With the payment gate gone, requireStaffManager is now the ONLY thing
    // standing between a caller and the creation of a staff account that grants workspace
    // access, so its presence is load-bearing in a way it was not before.
    expect(ROUTE).toContain('requireStaffManager')
    // …and it still runs before anything is created or read.
    const authzAt  = ROUTE.indexOf('requireStaffManager')
    const createAt = ROUTE.indexOf('createStaffAccount')
    expect(authzAt).toBeGreaterThanOrEqual(0)
    expect(createAt).toBeGreaterThan(authzAt)
    // The caller is still identified before any of it.
    expect(ROUTE.indexOf('verifyCaller')).toBeLessThan(authzAt)
  })

  it('20 · an empty or malformed assignment is still refused server-side', () => {
    // The fail-closed property Check-in depends on (RD-CHECKIN-11).
    expect(SERVICE).toContain('sanitizeEventIds')
    expect((SERVICE.match(/ids\.length === 0|eventIds\.length === 0/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
