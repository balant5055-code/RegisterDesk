// RD-RACEOPS-01 Sprint 1 — Race Operations access predicate.
//
// The rule under test is that Race Operations is restricted to the workspace OWNER
// and `admin` team members, mirroring the server's requireAdmin(). These cases pin
// every role in the EXISTING matrix so a future role addition (or a change to
// RACE_OPS_ROLES) cannot silently widen access to manager / checkin_staff / finance.

import { describe, it, expect } from 'vitest'
import { canAccessRaceOperations, isRaceOpsRole } from '@/features/race-operations/utils/access'
import { RACE_OPS_ROLES } from '@/features/race-operations/types'
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, type TeamRole } from '@/lib/team/types'

const ALL_ROLES = Object.keys(ROLE_PERMISSIONS) as TeamRole[]

describe('canAccessRaceOperations — owner + admin only', () => {
  it('grants the workspace owner (isOwner short-circuits regardless of role string)', () => {
    expect(canAccessRaceOperations({ isOwner: true, role: 'owner'   })).toBe(true)
    expect(canAccessRaceOperations({ isOwner: true, role: 'finance' })).toBe(true)
  })

  it('grants an admin team member', () => {
    expect(canAccessRaceOperations({ isOwner: false, role: 'admin' })).toBe(true)
  })

  it.each(['manager', 'checkin_staff', 'finance'])('denies %s', role => {
    expect(canAccessRaceOperations({ isOwner: false, role })).toBe(false)
  })

  it('denies an unknown / empty role', () => {
    expect(canAccessRaceOperations({ isOwner: false, role: ''            })).toBe(false)
    expect(canAccessRaceOperations({ isOwner: false, role: 'superuser'   })).toBe(false)
    expect(canAccessRaceOperations({ isOwner: false, role: 'ADMIN'       })).toBe(false)
  })

  it('covers every role in the existing matrix — exactly two are allowed', () => {
    const allowed = ALL_ROLES.filter(role => canAccessRaceOperations({ isOwner: false, role }))
    expect(allowed.sort()).toEqual(['admin', 'owner'])
  })
})

describe('isRaceOpsRole', () => {
  it('is true only for the declared Race Operations roles', () => {
    for (const role of RACE_OPS_ROLES) expect(isRaceOpsRole(role)).toBe(true)
    expect(isRaceOpsRole('manager')).toBe(false)
  })
})

describe('Race Operations introduces no new permission model', () => {
  it('does not add a permission to the existing matrix', () => {
    // Pins Phase 0 / Sprint 1: authorization reuses requireAdmin over the existing
    // TeamPermission union. If a `raceOperations` permission is ever added, this test
    // fails and forces the change to be a deliberate, reviewed decision.
    expect(ALL_PERMISSIONS).not.toContain('raceOperations')
    expect(ALL_PERMISSIONS).toHaveLength(9)
  })

  it('every Race Operations role is a member of the existing TeamRole union', () => {
    for (const role of RACE_OPS_ROLES) expect(ALL_ROLES).toContain(role)
  })
})
