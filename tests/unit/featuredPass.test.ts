// RD-ATTENDEE-03B.3 — the shared "recommended / Most Popular" pass resolver.

import { describe, it, expect } from 'vitest'
import { organizerFeaturedPassId, resolveFeaturedPassId } from '@/components/event-templates/shared/utils/featuredPass'
import type { PassPublic } from '@/components/event-templates/types'

const pass = (p: Partial<PassPublic>): PassPublic => ({
  id: 'p', name: 'Pass', description: '', price: 100, quantity: null, unlimited: true, ...p,
})

describe('organizerFeaturedPassId', () => {
  it('returns the explicitly-featured pass id', () => {
    const passes = [pass({ id: 'a' }), pass({ id: 'b', featured: true }), pass({ id: 'c' })]
    expect(organizerFeaturedPassId(passes)).toBe('b')
  })
  it('returns null when no pass is featured', () => {
    expect(organizerFeaturedPassId([pass({ id: 'a' }), pass({ id: 'b' })])).toBeNull()
  })
})

describe('resolveFeaturedPassId', () => {
  it('honours the organizer flag ABOVE the name/position heuristics', () => {
    const passes = [pass({ id: 'a', name: 'VIP' }), pass({ id: 'b', name: 'General', featured: true }), pass({ id: 'c' })]
    expect(resolveFeaturedPassId(passes)).toBe('b')   // featured wins over the "VIP" name match
  })
  it('falls back to a value-tier name match when nothing is flagged', () => {
    const passes = [pass({ id: 'a', name: 'Standard' }), pass({ id: 'b', name: 'Professional Pass' }), pass({ id: 'c', name: 'Basic' })]
    expect(resolveFeaturedPassId(passes)).toBe('b')
  })
  it('falls back to the middle pass when neither flag nor name matches', () => {
    const passes = [pass({ id: 'a' }), pass({ id: 'b' }), pass({ id: 'c' })]
    expect(resolveFeaturedPassId(passes)).toBe('b')   // middle of 3
  })
  it('returns null for 0 or 1 passes (nothing to highlight)', () => {
    expect(resolveFeaturedPassId([])).toBeNull()
    expect(resolveFeaturedPassId([pass({ id: 'a', featured: true })])).toBeNull()
  })
})
