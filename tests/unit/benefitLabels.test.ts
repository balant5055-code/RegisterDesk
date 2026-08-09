import { describe, it, expect } from 'vitest'
import { formatBenefit, formatBenefits } from '@/components/event-templates/shared/registration/benefitLabels'
import { PASS_BENEFITS_BY_EVENT_TYPE } from '@/components/wizard/passEventTypeConfig'

describe('formatBenefit', () => {
  it('resolves curated sports IDs to their wizard labels', () => {
    expect(formatBenefit('timing_chip')).toBe('Timing Chip')
    expect(formatBenefit('finisher_medal')).toBe('Finisher Medal')
    expect(formatBenefit('e_certificate')).toBe('E-Certificate')
    expect(formatBenefit('water_stations')).toBe('Water Stations')
    expect(formatBenefit('medical_support')).toBe('Medical Support')
    expect(formatBenefit('tshirt')).toBe('Event T-Shirt')
  })

  it('strips the redundant qualifier the picker copy carries', () => {
    // The wizard label is "Bib Included" — correct in a checklist, noise in a chip.
    expect(formatBenefit('bib')).toBe('Bib')
    expect(formatBenefit('trophy')).toBe('Trophy')
  })

  it('resolves IDs from other event types too (one flattened vocabulary)', () => {
    expect(formatBenefit('gala_dinner')).toBe('Gala Dinner')
    expect(formatBenefit('vip_lounge')).toBe('VIP Lounge')
  })

  it('humanises unknown IDs so a raw key can never reach the page', () => {
    expect(formatBenefit('pace_bunny')).toBe('Pace Bunny')
    expect(formatBenefit('some-new-perk')).toBe('Some New Perk')
  })

  it('passes organiser free text through untouched', () => {
    expect(formatBenefit('Free parking near the start line')).toBe('Free parking near the start line')
  })

  it('returns empty for blank input', () => {
    expect(formatBenefit('')).toBe('')
    expect(formatBenefit('   ')).toBe('')
  })

  it('NEVER returns a snake_case key for any ID in the whole vocabulary', () => {
    const ids = Object.values(PASS_BENEFITS_BY_EVENT_TYPE)
      .flatMap(c => c.groups)
      .flatMap(g => g.benefits)
      .map(b => b.id)
    expect(ids.length).toBeGreaterThan(20)
    for (const id of ids) {
      const label = formatBenefit(id)
      expect(label).not.toMatch(/_/)
      expect(label.length).toBeGreaterThan(0)
    }
  })
})

describe('formatBenefits', () => {
  it('merges curated IDs with custom free text, in that order', () => {
    expect(formatBenefits(['timing_chip', 'bib'], ['Free parking'])).toEqual([
      'Timing Chip', 'Bib', 'Free parking',
    ])
  })

  it('de-duplicates case-insensitively across both sources', () => {
    // A curated "Bib" and a custom "bib" are one benefit.
    expect(formatBenefits(['bib'], ['BIB'])).toEqual(['Bib'])
  })

  it('drops blanks and tolerates undefined inputs', () => {
    expect(formatBenefits(['bib', '', '  '], undefined)).toEqual(['Bib'])
    expect(formatBenefits(undefined, undefined)).toEqual([])
  })
})
