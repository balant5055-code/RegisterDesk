// RD-TEAM-IMPL-01 — the email invitation flow is gone, and cannot come back quietly.
//
// ═══ WHAT THIS REPLACES ══════════════════════════════════════════════════════
// tests/unit/teamInviteAuthorization.test.ts pinned the authorization of
// POST /api/organizer/team: who could invite, and that a forged organizerUid /
// workspaceUid / actorUid in the body was ignored. That endpoint no longer exists,
// so those assertions could not be kept as written.
//
// Their VALUE was never about invitations — it was about the surface that mints
// workspace access. That surface is now POST /api/organizer/staff, and
// tests/unit/staffManagerAuthorization.test.ts already holds the equivalent matrix
// (organizer 201, checkin_staff 403, checkin_lead 403, forged body ignored,
// authentication server-side). Nothing was dropped; it moved with the capability.
//
// What is left to prove here is the removal itself: that no runtime path can invite,
// accept, or mail an invitation, and that the pieces which legitimately remain are
// the ones that must.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const SERVICE = code(read('lib/team/service.ts'))
const TYPES   = code(read('lib/team/types.ts'))
const ROUTE   = code(read('app/api/organizer/team/route.ts'))
const PAGE    = code(read('app/(dashboard)/dashboard/settings/team/page.tsx'))

describe('RD-TEAM-IMPL-01 · the invitation code path is gone', () => {
  it('1 · the acceptance route and page no longer exist', () => {
    expect(existsSync(resolve(process.cwd(), 'app/api/team/accept/route.ts'))).toBe(false)
    expect(existsSync(resolve(process.cwd(), 'app/team/accept/page.tsx'))).toBe(false)
  })

  it('2 · the invitation email template no longer exists', () => {
    expect(existsSync(resolve(process.cwd(), 'lib/email/templates/team-invite.ts'))).toBe(false)
  })

  it('3 · the service exports neither inviteMember nor acceptInvite', () => {
    expect(SERVICE).not.toContain('export async function inviteMember')
    expect(SERVICE).not.toContain('export async function acceptInvite')
  })

  it('4 · the service can no longer CREATE a member row', () => {
    // Only updates and deletes remain. A `set` or `create` here would be a new way
    // into teamMembers that bypasses the staff lifecycle.
    expect(SERVICE).not.toMatch(/txn\.set\(/)
    expect(SERVICE).not.toMatch(/\.create\(/)
  })

  it('5 · the team route exposes no POST', () => {
    expect(ROUTE).not.toContain('export async function POST')
    expect(ROUTE).toContain('export async function GET')
  })

  it('6 · nothing sends mail from the team path', () => {
    expect(SERVICE).not.toMatch(/notificationEngine|teamInviteTemplate|NotificationType/)
  })

  it('7 · no invitation token is generated anywhere in the team path', () => {
    expect(SERVICE).not.toMatch(/randomBytes|inviteToken:\s*token/)
    expect(TYPES).not.toContain('export const INVITE_TTL_MS')
  })

  it('8 · the Team UI has no email input, no invite control and no pending list', () => {
    expect(PAGE).not.toMatch(/type="email"/)
    expect(PAGE).not.toMatch(/Invite a member|Pending invitation|Send invitation/i)
    expect(PAGE).not.toMatch(/inviteEmail|inviteRole/)
  })

  it('9 · the Team UI creates STAFF instead', () => {
    expect(PAGE).toContain('/api/organizer/staff')
    expect(PAGE).toContain('Create staff')
  })
})

describe('RD-TEAM-IMPL-01 · what legitimately remains, remains', () => {
  it('10 · teamMembers is still the substrate — the list and mutations survive', () => {
    // Rows created by the old flow are still live grants. Removing the ability to
    // SEE or RETIRE them would strand real access in a workspace.
    for (const fn of ['listTeam', 'changeRole', 'setMemberStatus', 'removeMember']) {
      expect(SERVICE, fn).toContain(`export async function ${fn}`)
    }
  })

  it('11 · staff rows are still refused by the team mutations', () => {
    expect((SERVICE.match(/return fail\(409, STAFF_ROW_REFUSAL\)/g) ?? []).length).toBe(3)
  })

  it('12 · the legacy invite fields stay declared so historical rows parse', () => {
    // Declared, never written by a live path. The deprecation note is asserted
    // against the RAW source, since `code()` strips exactly the comments that carry
    // the intent.
    expect(TYPES).toContain('inviteToken:  string | null')
    expect(read('lib/team/types.ts')).toMatch(/@deprecated Legacy invitation artefact/)
  })

  it('13 · inert invited rows are hidden rather than deleted', () => {
    // The documents stay in Firestore; the list simply does not surface a state that
    // can no longer progress.
    expect(SERVICE).toContain("m.status === 'active'")
    expect(SERVICE).toContain("m.status === 'suspended'")
    // The one remaining reference to the invited state is a DEFENSIVE guard —
    // setMemberStatus refuses to suspend a historical pending row — not a way to
    // create or progress one. Keeping it is correct: the rows still exist.
    expect(SERVICE).toContain("if (m.status === 'invited') return fail(409")
    // Nothing queries for them, and nothing deletes them.
    expect(SERVICE).not.toMatch(/where\('status', '==', 'invited'\)/)
    expect(SERVICE).not.toMatch(/invited[\s\S]{0,40}\.delete\(\)/)
  })

  it('14 · RD-CAPACITY-01 · the paid-feature gate is gone, the AUTHORIZATION is not', () => {
    // The original concern was that staff creation grants the same workspace access the
    // invite route used to, so it must not be the cheaper door. Under the capacity model
    // there is no paid door at all — team access is included for every organizer — so the
    // concern now reduces entirely to authorization, which must still be enforced.
    const staffRoute = code(read('app/api/organizer/staff/route.ts'))
    expect(staffRoute).not.toContain("requireFeature(caller.uid, 'teamAccess')")
    expect(staffRoute).not.toContain("requireLimit(caller.uid, 'maxTeamMembers'")
    // What must remain: identity, then staff-manager authorization, then creation.
    expect(staffRoute).toContain('verifyCaller')
    expect(staffRoute).toContain('requireStaffManager')
  })
})
