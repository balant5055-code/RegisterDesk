// RD-NAV-AUDIT-01 — CRM must refuse EVERY gate-only role, not one role name.
//
// ═══ THE DEFECT THIS PINS ════════════════════════════════════════════════════
// `authorizeCrm` read `ctx.role === 'checkin_staff'`. That was the only hard-coded team-role
// comparison left in the codebase, and it had already gone stale: `checkin_lead` is equally a
// gate-only role — its entire grant is `checkin` + `walkin`, both in GATE_PERMISSIONS — and it
// is issuable today (ASSIGNABLE_ROLES, STAFF_ROLES, and the team settings page offers it as
// "Check-in Lead").
//
// So a Check-in Lead credential fell through the check and was granted `scope: 'full'` with
// `canWrite: true`: the whole workspace contact list, note/tag writes, and the bulk contact
// EXPORT endpoint — from a credential whose purpose is scanning at a gate.
//
// ═══ HOW THESE CASES WORK ════════════════════════════════════════════════════
// The expectation is DERIVED from the real `isCheckinOnlyRole` over the real matrix, never
// from a list written here. Give `checkin_lead` a non-gate permission tomorrow and the
// expectation moves with the matrix instead of this file silently going stale the way the
// implementation did.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ROLE_PERMISSIONS, isCheckinOnlyRole, type TeamRole } from '@/lib/team/types'

const ctx = { role: 'owner' as TeamRole, workspaceUid: 'ws-1', isOwner: true }
let callerOk = true

vi.mock('@/lib/team/access', () => ({
  verifyCaller: async () => (callerOk ? { uid: 'caller-1' } : null),
}))
vi.mock('@/lib/team/workspace', () => ({
  resolveWorkspaceUid: async () => ({ ...ctx }),
}))

const { authorizeCrm } = await import('@/lib/crm/access')

const ALL_ROLES = Object.keys(ROLE_PERMISSIONS) as TeamRole[]

beforeEach(() => { callerOk = true; ctx.role = 'owner'; ctx.isOwner = true })

describe('RD-NAV-AUDIT-01 · authorizeCrm denies every gate-only role', () => {
  it('refuses an unauthenticated caller before resolving anything', async () => {
    callerOk = false
    const r = await authorizeCrm(new Request('https://x.test/'))
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
  })

  it('decides every role the same way the permission matrix does', async () => {
    // The whole matrix in one pass, so a new role cannot be added without being classified.
    for (const role of ALL_ROLES) {
      ctx.role = role
      ctx.isOwner = role === 'owner'
      const r = await authorizeCrm(new Request('https://x.test/'))
      const gateOnly = isCheckinOnlyRole(role)

      expect(r.ok, `${role} ok`).toBe(!gateOnly)
      expect(r.status, `${role} status`).toBe(gateOnly ? 403 : 200)
      if (gateOnly) {
        // A denial must carry no workspace and no write capability, or a caller that
        // ignores `ok` would still read a usable authz object.
        expect(r.workspaceUid, `${role} leaks a workspace`).toBe('')
        expect(r.canWrite, `${role} can write`).toBe(false)
      }
    }
  })

  it('names checkin_lead explicitly, because that is the role that was escaping', async () => {
    // Belt and braces beside the derived sweep above: this is the concrete regression, and
    // it must read as a fact about checkin_lead rather than only as a matrix consequence.
    expect(isCheckinOnlyRole('checkin_lead')).toBe(true)
    ctx.role = 'checkin_lead'
    ctx.isOwner = false
    const r = await authorizeCrm(new Request('https://x.test/'))
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(r.canWrite).toBe(false)
    expect(r.workspaceUid).toBe('')
  })

  it('still gives finance donations-only READ access, and the full roles write access', async () => {
    // The fix must not have widened or narrowed the tiers it was not about.
    ctx.role = 'finance'; ctx.isOwner = false
    const fin = await authorizeCrm(new Request('https://x.test/'))
    expect(fin.ok).toBe(true)
    expect(fin.scope).toBe('donations')
    expect(fin.canWrite).toBe(false)

    for (const role of ['owner', 'admin', 'manager'] as TeamRole[]) {
      ctx.role = role; ctx.isOwner = role === 'owner'
      const r = await authorizeCrm(new Request('https://x.test/'))
      expect(r.ok, `${role} ok`).toBe(true)
      expect(r.scope, `${role} scope`).toBe('full')
      expect(r.canWrite, `${role} canWrite`).toBe(true)
      expect(r.workspaceUid, `${role} workspace`).toBe('ws-1')
    }
  })
})
