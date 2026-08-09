import { describe, it, expect } from 'vitest'
import { passesToChallenges } from '@/components/event-templates/shared/registration/challengeModel'
import type { PassPublic } from '@/components/event-templates/types'

function pass(over: Partial<PassPublic> = {}): PassPublic {
  return {
    id: 'p1', name: '10K Run', description: '', price: 500,
    quantity: null, unlimited: true, status: 'active',
    ...over,
  } as PassPublic
}

describe('passesToChallenges — display data', () => {
  it('resolves stored benefit IDs into labels, never raw keys', () => {
    const [c] = passesToChallenges([pass({ benefits: ['timing_chip', 'finisher_medal'] })], {})
    expect(c.benefits).toEqual(['Timing Chip', 'Finisher Medal'])
    expect(c.benefits.join(' ')).not.toMatch(/_/)
  })

  it('merges custom free-text benefits after the curated ones', () => {
    const [c] = passesToChallenges([pass({ benefits: ['bib'], customBenefits: ['Free parking'] })], {})
    expect(c.benefits).toEqual(['Bib', 'Free parking'])
  })

  it('takes distance from the pass builder race category', () => {
    const [c] = passesToChallenges([pass({ raceDetails: { category: '10K' } })], {})
    expect(c.distance).toBe('10K')
  })

  it('prefers a custom race category over the stored one', () => {
    const [c] = passesToChallenges([pass({ raceDetails: { category: 'other', customCategory: '21.1K' } })], {})
    expect(c.distance).toBe('21.1K')
  })

  it('carries age eligibility through when the organiser set it', () => {
    const [c] = passesToChallenges([pass({ raceDetails: { minAge: 16, maxAge: 60 } })], {})
    expect(c.minAge).toBe(16)
    expect(c.maxAge).toBe(60)
  })

  it('leaves age null when unset, so the field can self-hide', () => {
    const [c] = passesToChallenges([pass()], {})
    expect(c.minAge).toBeNull()
    expect(c.maxAge).toBeNull()
  })
})

describe('passesToChallenges — notes are derived, never invented', () => {
  it('returns no notes when the organiser set no policy flags', () => {
    expect(passesToChallenges([pass()], {})[0].notes).toEqual([])
  })

  it('derives every note from a real builder flag', () => {
    const [c] = passesToChallenges([pass({
      maxPurchase: 4,
      advancedSettings: { groupBooking: true, transferable: true, refundable: true, waitlist: true },
    })], {})
    expect(c.notes).toEqual([
      'Up to 4 entries per booking',
      'Group booking available',
      'Entry is transferable',
      'Entry is refundable',
      'Waitlist available when sold out',
    ])
  })

  it('omits the booking-limit note when only one entry is allowed', () => {
    expect(passesToChallenges([pass({ maxPurchase: 1 })], {})[0].notes).toEqual([])
  })

  it('renders only the flags that are actually true', () => {
    const [c] = passesToChallenges([pass({
      advancedSettings: { groupBooking: false, transferable: true, refundable: false, waitlist: false },
    })], {})
    expect(c.notes).toEqual(['Entry is transferable'])
  })
})
