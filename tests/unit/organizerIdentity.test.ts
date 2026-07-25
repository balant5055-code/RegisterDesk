// RD-AUTH-01 Phase 5 (M-C) — the canonical organizer definition.
//
// isOrganizer() is the single predicate that the admin organizers list + support
// overview now share with the count/analytics/public-stats queries (organizersQuery),
// so "who is an organizer" can never diverge between a listing and a count again.

import { describe, it, expect } from 'vitest'
import { isOrganizer, ORGANIZER_ROLE } from '@/lib/organizer/identity'

describe('organizer identity — one canonical definition', () => {
  it('ORGANIZER_ROLE is the "organizer" literal', () => {
    expect(ORGANIZER_ROLE).toBe('organizer')
  })

  it('isOrganizer is true only for role === "organizer"', () => {
    expect(isOrganizer({ role: ORGANIZER_ROLE })).toBe(true)
    expect(isOrganizer({ role: 'organizer' })).toBe(true)
  })

  it('isOrganizer is false for any other / missing role', () => {
    expect(isOrganizer({ role: 'admin' })).toBe(false)
    expect(isOrganizer({ role: 'owner' })).toBe(false)
    expect(isOrganizer({ role: undefined })).toBe(false)
    expect(isOrganizer({})).toBe(false)
    expect(isOrganizer(null)).toBe(false)
    expect(isOrganizer(undefined)).toBe(false)
  })
})
