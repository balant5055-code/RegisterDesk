// RD-CHECKIN-2.0 — staff accounts: credentials, containment and the audit trail.
//
// ═══ THE TWO THINGS THIS MUST NOT BECOME ═════════════════════════════════════
//
// 1. A SECOND AUTHORIZATION SYSTEM. A staff account is a Firebase Auth user plus a
//    row in `teamMembers`. Every permission it holds is re-derived from the ONE
//    role matrix on every request, and every event it may work comes from that same
//    row through the existing scope helpers. Nothing in lib/staff decides access.
//
// 2. A PLACE PASSWORDS LIVE. Firebase owns the credential. This codebase never
//    stores one, never reads one back, and never writes one to a log or an audit
//    record. The organizer can ISSUE a password; they can never RETRIEVE one.
//
// Also pinned here: the append-only check-in history, whose whole value is that
// nothing can update or delete an entry — a source-level property that exercising
// one write cannot establish.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  normalizeUsername, isValidUsername, staffEmailForUsername, isStaffEmail,
  usernameFromStaffEmail, passwordProblem, formatTempPassword,
  STAFF_EMAIL_DOMAIN, PASSWORD_MIN, TEMP_PASSWORD_BYTES,
} from '@/lib/staff/types'
import {
  STAFF_ROLES, isStaffRole, isCheckinOnlyRole, permissionsForRole,
} from '@/lib/team/types'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const SERVICE   = code(read('lib/staff/service.ts'))
const ME        = code(read('app/api/staff/me/route.ts'))
const PASSWORD  = code(read('app/api/staff/password/route.ts'))
const LIST      = code(read('app/api/organizer/staff/route.ts'))
const ITEM      = code(read('app/api/organizer/staff/[staffId]/route.ts'))
const LOGIN     = code(read('app/staff/login/StaffLoginClient.tsx'))
const HISTORY   = code(read('lib/checkin/history.ts'))

// ─── 1. Usernames ────────────────────────────────────────────────────────────

describe('1 — a username is a stable, unambiguous key', () => {
  it('case folds, so one person is one account', () => {
    expect(normalizeUsername('  GATE.Arun  ')).toBe('gate.arun')
    expect(staffEmailForUsername('GATE.Arun')).toBe(staffEmailForUsername('gate.arun'))
  })

  it('accepts the shapes an organizer will actually type', () => {
    for (const u of ['arun', 'gate.arun', 'gate_arun', 'gate-arun', 'gate1', 'a1b']) {
      expect(isValidUsername(u), u).toBe(true)
    }
  })

  it('rejects anything that could change which account a login reaches', () => {
    for (const u of [
      '', 'ab', 'a'.repeat(33),
      'arun@x',        // an @ would re-point the derived address
      'arun kumar',    // whitespace
      '.arun', 'arun.',// leading/trailing separator
      'gate..arun',    // doubled separator — a typo far more often than intent
      'Arun/Kumar',
    ]) {
      expect(isValidUsername(u), JSON.stringify(u)).toBe(false)
    }
  })
})

// ─── 2. The reserved address namespace ──────────────────────────────────────

describe('2 — the derived address is an identifier, not a mailbox', () => {
  it('uses an RFC 2606 reserved domain that can never resolve', () => {
    expect(STAFF_EMAIL_DOMAIN.endsWith('.invalid')).toBe(true)
  })

  it('round-trips a username through the address', () => {
    expect(usernameFromStaffEmail(staffEmailForUsername('gate.arun'))).toBe('gate.arun')
  })

  it('recognises its own namespace and nothing else', () => {
    expect(isStaffEmail(staffEmailForUsername('arun'))).toBe(true)
    expect(isStaffEmail('arun@gmail.com')).toBe(false)
    expect(isStaffEmail(null)).toBe(false)
    expect(usernameFromStaffEmail('arun@gmail.com')).toBeNull()
  })

  // RD-TEAM-IMPL-01 re-anchor. This asserted that `inviteMember` guarded the reserved
  // namespace, so an organizer could not invite a credential the invite flow did not
  // own. The guard is gone because the FLOW is gone — and the invariant it protected
  // is now structural rather than conditional: with no way to create a member row by
  // email, there is no second path to a grant to defend. That is a stronger property,
  // so it is asserted directly.
  it('no email path can mint a grant for the staff namespace — there is no invite flow', () => {
    const team = code(read('lib/team/service.ts'))
    expect(team).not.toContain('export async function inviteMember')
    expect(team).not.toContain('export async function acceptInvite')
    // The only remaining writer of a member row is the staff service itself.
    expect(team).not.toMatch(/txn\.set\(ref|\.create\(/)
  })

  it('the team MUTATIONS refuse staff rows, so half an account cannot be deleted', () => {
    const team = code(read('lib/team/service.ts'))
    expect((team.match(/return fail\(409, STAFF_ROW_REFUSAL\)/g) ?? []).length).toBe(3)
    expect(team).toContain('.filter(m => !isStaffRow(m.email))')
  })
})

// ─── 3. Passwords ────────────────────────────────────────────────────────────

describe('3 — passwords are Firebase\'s, and this code refuses only the obvious', () => {
  it('enforces a length floor and nothing performative', () => {
    expect(passwordProblem('short')).toBe('TOO_SHORT')
    expect(passwordProblem('   ')).toBe('WHITESPACE_ONLY')
    expect(passwordProblem('a'.repeat(129))).toBe('TOO_LONG')
    expect(passwordProblem('correct horse battery')).toBeNull()
  })

  it('the generated temporary password clears the floor and is readable aloud', () => {
    const pw = formatTempPassword(new Uint8Array(TEMP_PASSWORD_BYTES).fill(7))
    expect(pw.length).toBeGreaterThanOrEqual(PASSWORD_MIN)
    expect(pw.split('-')).toHaveLength(3)
    // No 0/O, 1/l/I or 5/S — the pairs that are ambiguous across a noisy tent.
    expect(pw).not.toMatch(/[0O1lI5S]/)
  })

  it('nothing stores, returns or logs a password', () => {
    // The staff document type has no password field, and none of the routes echo one.
    const types = code(read('lib/staff/types.ts'))
    expect(types).not.toMatch(/passwordHash|password:\s*string\s*$/m)
    for (const [name, src] of [['service', SERVICE], ['list', LIST], ['item', ITEM]] as const) {
      expect(src, name).not.toMatch(/console\.(log|error|warn)\([^)]*password/i)
    }
  })

  it('the ONE returned password is the freshly issued one, at creation or reset only', () => {
    expect(SERVICE).toContain('temporaryPassword')
    // Never READ BACK from storage. The only password expressions in the service are
    // the organizer's optional choice and the generated one, and both are handed
    // straight to Firebase — there is no path that loads one from a document.
    expect(SERVICE).not.toMatch(/data\(\)[?.]*\.password/)
    expect(SERVICE).not.toMatch(/doc\.password/)
    expect(SERVICE).not.toMatch(/snap\.[\w.]*password/)
    expect(SERVICE).toContain('adminAuth.createUser({')
    expect(SERVICE).toContain('adminAuth.updateUser(')
  })

  it('a reset revokes existing sessions', () => {
    const reset = SERVICE.slice(SERVICE.indexOf('export async function resetStaffPassword'))
    expect(reset.slice(0, 900)).toContain('revokeRefreshTokens')
  })

  it('changing your own password requires an authenticated, unrevoked token', () => {
    expect(PASSWORD).toContain('verifyCaller(req)')
    expect(PASSWORD).toContain('getStaffAccount(caller.uid)')
    expect(PASSWORD).toContain("staff.status !== 'active'")
    // And it is rate limited — this reaches the Auth backend.
    expect(PASSWORD).toContain('checkRateLimit(')
  })
})

// ─── 4. Containment ──────────────────────────────────────────────────────────

describe('4 — a staff credential can never become organizer access', () => {
  it('only gate roles may be issued as a staff account', () => {
    expect(STAFF_ROLES).toEqual(['checkin_staff', 'checkin_lead'])
    for (const r of STAFF_ROLES) expect(isCheckinOnlyRole(r), r).toBe(true)
    for (const r of ['owner', 'admin', 'manager', 'finance']) expect(isStaffRole(r), r).toBe(false)
  })

  it('no staff role holds a single organizer permission', () => {
    const organizerPerms = ['events', 'registrations', 'broadcasts', 'certificates',
      'participants', 'wallet', 'settlements', 'transactions']
    for (const role of STAFF_ROLES) {
      for (const perm of organizerPerms) {
        expect(permissionsForRole(role), `${role} / ${perm}`).not.toContain(perm)
      }
    }
  })

  it('the service refuses a non-gate role rather than silently downgrading it', () => {
    expect(SERVICE).toContain('if (!isStaffRole(input.role))')
    expect(SERVICE).toContain('Staff accounts may only be Check-in Staff or Check-in Lead.')
  })

  it('a staff account MUST name its events — [] would mean the whole workspace', () => {
    // Empty means "unrestricted" everywhere else in this codebase (the backward
    // compatible reading for rows written before assignment existed). For an account
    // created today for one gate, that reading is exactly wrong.
    expect((SERVICE.match(/A staff account cannot be workspace-wide\./g) ?? []).length).toBe(2)
  })

  it('permissions are written from the MATRIX, never from the request', () => {
    expect(SERVICE).toContain('permissions:  permissionsForRole(role)')
    expect(SERVICE).not.toMatch(/permissions:\s*(input|body)\./)
  })

  it('suspension lands on the MEMBER row — the row authorization actually reads', () => {
    expect(SERVICE).toContain('memberPatch.status  = input.status')
    expect(SERVICE).toContain('revokeRefreshTokens(input.staffId)')
  })

  it('deletion revokes the GRANT before anything else', () => {
    const del = SERVICE.slice(SERVICE.indexOf('export async function deleteStaffAccount'))
    const grantAt = del.indexOf('TEAM_COLLECTION')
    const authAt  = del.indexOf('adminAuth.deleteUser')
    expect(grantAt).toBeGreaterThan(-1)
    // A half-completed delete must leave an account that can sign in and reach
    // nothing, never one that still holds a workspace grant.
    expect(grantAt).toBeLessThan(authAt)
  })
})

// ─── 5. Creation is compensated, not best-effort ────────────────────────────

describe('5 — a partial create leaves nothing behind', () => {
  it('the username lock is taken FIRST, with create() as the uniqueness constraint', () => {
    expect(SERVICE).toContain('await lockRef.create({')
    const lockAt = SERVICE.indexOf('await lockRef.create({')
    const userAt = SERVICE.indexOf('adminAuth.createUser({')
    expect(lockAt).toBeLessThan(userAt)
  })

  it('a failed Auth create releases the lock', () => {
    const seg = SERVICE.slice(SERVICE.indexOf('adminAuth.createUser({'))
    expect(seg.slice(0, 1200)).toContain('lockRef.delete()')
  })

  it('a failed grant write deletes the Auth user AND the lock', () => {
    const seg = SERVICE.slice(SERVICE.indexOf('await batch.commit()'))
    expect(seg.slice(0, 900)).toContain('adminAuth.deleteUser(staffId)')
    expect(seg.slice(0, 900)).toContain('lockRef.delete()')
  })

  it('the grant and the profile are written TOGETHER', () => {
    // Otherwise an operator could exist with a profile and no permissions, or the
    // reverse — a credential nobody can see but that still opens a gate.
    expect(SERVICE).toContain('const batch = adminDb.batch()')
    expect(SERVICE).toContain('await batch.commit()')
  })
})

// ─── 6. The routes ───────────────────────────────────────────────────────────

describe('6 — the management routes are owner-scoped and self-scoped', () => {
  // RD-CHECKIN-08 re-anchor. These two pinned the OLD spelling of the guard,
  // `requireOwner(caller.uid, caller.uid)`. That call passes the same value to both
  // sides of its own comparison, so it was true for every authenticated identity and
  // authorized nothing — RD-CHECKIN-07 proved a gate credential could POST here and
  // receive 201. The PROPERTY these tests exist to defend has not changed and is
  // still asserted below: the workspace comes from the caller and never from the
  // request. What changed is that it is now paired with a check that can actually
  // fail, so the assertions follow it. This is a strictly stronger contract.
  it('the workspace is always the caller\'s OWN uid, never a request value', () => {
    for (const [name, src] of [['list', LIST], ['item', ITEM]] as const) {
      expect(src, name).toContain('organizerUid: caller.uid')
      expect(src, name).not.toMatch(/organizerUid:\s*body\./)
      expect(src, name).not.toMatch(/organizerUid:\s*(req|request|params)\./)
    }
  })

  it('issuing and revoking a credential is an OWNER action, closed to credentials', () => {
    // All four handlers — GET/POST on the collection, PATCH/DELETE on the item.
    expect((LIST.match(/await requireStaffManager\(caller\)/g) ?? []).length).toBe(2)
    expect((ITEM.match(/await requireStaffManager\(caller\)/g) ?? []).length).toBe(2)
    // And the tautology must not return by edit.
    for (const src of [LIST, ITEM]) {
      expect(src).not.toMatch(/require(Owner|Admin)\(\s*caller\.uid\s*,\s*caller\.uid\s*\)/)
    }
  })

  it('a password reset is an explicit intent, not a side effect of an edit', () => {
    expect(ITEM).toContain("if (body.action === 'reset_password')")
  })

  it('/api/staff/me resolves identity, status, events and permissions server-side', () => {
    expect(ME).toContain('verifyCaller(req)')
    expect(ME).toContain('resolveWorkspaceUid(caller.uid, caller.email)')
    expect(ME).toContain('eventIds:    ctx.eventIds')
    expect(ME).toContain('permissions: ctx.permissions')
    // A revoked staff grant resolves to its own workspace; that is refused here
    // rather than reported as a working session.
    expect(ME).toContain('if (staff && (ctx.isOwner || ctx.workspaceUid === caller.uid))')
  })

  it('the login form derives the address locally — no username oracle exists', () => {
    expect(LOGIN).toContain('staffEmailForUsername(u)')
    expect(LOGIN).toContain('authenticateUser(')
    // Wrong username and wrong password give the SAME sentence.
    const copy = LOGIN.match(/'auth\/user-not-found':\s*'([^']+)'/)?.[1]
    const wrong = LOGIN.match(/'auth\/wrong-password':\s*'([^']+)'/)?.[1]
    expect(copy).toBeDefined()
    expect(copy).toBe(wrong)
  })

  it('a temporary password is changed BEFORE the operator reaches a gate', () => {
    expect(LOGIN).toContain('me.mustChangePassword')
    expect(LOGIN).toContain("setStage('password_change')")
  })
})

// ─── 7. Append-only check-in history ────────────────────────────────────────

describe('7 — the check-in history is append-only by construction', () => {
  it('the module writes with add() and offers no update or delete path', () => {
    expect(HISTORY).toContain('.add({')
    expect(HISTORY).not.toContain('.update(')
    expect(HISTORY).not.toContain('.delete(')
    expect(HISTORY).not.toContain('.set(')
  })

  it('it records both the check-in and its compensating undo', () => {
    expect(HISTORY).toContain("'CHECK_IN' | 'CHECK_IN_UNDO'")
  })

  it('the operator and the workspace are recorded separately', () => {
    // On a team or staff account these differ, and "who did it" is the operator.
    expect(HISTORY).toContain('operatorUid:    string')
    expect(HISTORY).toContain('workspaceUid:   string')
  })

  it('the metadata is a NARROW shape, so no caller can widen it into a secret store', () => {
    expect(HISTORY).not.toMatch(/metadata\??:\s*Record<string, unknown>/)
    for (const banned of ['password', 'token', 'secret', 'credential']) {
      expect(HISTORY.toLowerCase(), banned).not.toContain(`${banned}:`)
    }
  })

  it('the SCAN path — the one that had no record at all — now writes one', () => {
    const scan = code(read('app/api/checkin/scan/route.ts'))
    expect(scan).toContain('appendCheckinHistorySafe({')
    expect(scan).toContain("action:         'CHECK_IN'")
    expect(scan).toContain('operatorUid:    callerUid')
  })

  it('undo APPENDS a compensating entry instead of erasing evidence', () => {
    const regs = code(read('lib/firebase/firestore/registrations.ts'))
    const fn = regs.slice(regs.indexOf('export async function uncheckInRegistration'))
    expect(fn).toContain("action:       'CHECK_IN_UNDO'")
    // The snapshot is captured INSIDE the transaction, from state about to be cleared.
    expect(fn.slice(0, 1400)).toContain('reverted = {')
  })

  it('a duplicate scan creates no second CHECK_IN', () => {
    const regs = code(read('lib/firebase/firestore/registrations.ts'))
    const fn = regs.slice(regs.indexOf('export async function checkInRegistration'))
    // `admitted` is set only on the branch that actually admits, so the idempotent
    // repeat writes nothing.
    expect(fn.slice(0, 2600)).toContain('admitted = {')
    expect(fn.slice(0, 2600)).toContain("if (reg.checkedIn) return { status: 'already_checked_in' }")
  })

  it('walk-in records its admission too', () => {
    const walkin = code(read('app/api/checkin/walkin/route.ts'))
    expect(walkin).toContain('appendCheckinHistorySafe({')
    expect(walkin).toContain("method:         'walkin'")
  })
})
