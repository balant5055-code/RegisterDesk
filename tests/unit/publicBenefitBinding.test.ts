// ─── Phase 8F: no public surface renders a stored benefit key ───────────────
//
// Phase 8E found the event hero publishing database keys as attendee copy:
//
//   Secure Registration · Instant Confirmation · e_certificate · medical_support
//   · water_stations · finisher_medal · tshirt
//
// The resolver had existed since RD-ST6.0 — `formatBenefit`, built for exactly this,
// with its own header noting "the public page was rendering the raw IDs". It reached
// `challengeModel` (the registration path) and stopped there. `rankPassBenefits` kept
// returning the stored string as `label`, and NINE render sites across the event
// templates printed `pass.benefits` straight into the DOM.
//
// ═══ WHY THE FIX FORMATS AT THE EMIT BOUNDARY, NOT AT THE SOURCE ═════════════
// Formatting `PassPublic.benefits` upstream would have fixed every consumer at once and
// been wrong: `benefitIcon` matches loose substrings against the SAME string, so a
// resolved label changes which icon is chosen. Measured across all 75 curated IDs, six
// diverge — and two of them regress: `biz_lounge` and `matchmaking` both format to
// "Business …", which the `/bus/` rule turns into a bus icon. So the stored entry stays
// the stored entry, and only the copy handed to a reader is resolved.
//
// These tests pin the contract, not the wording: a curated ID must never survive to a
// public surface, and the ranking model's counts, order and cap must be exactly what
// they were before.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { formatBenefit, formatBenefits } from '@/components/event-templates/shared/registration/benefitLabels'
import { rankPassBenefits, benefitCoverage } from '@/components/event-templates/shared/registration/passBenefits'
import { benefitIcon } from '@/components/event-templates/shared/ui/framework'
import { PASS_BENEFITS_BY_EVENT_TYPE } from '@/components/wizard/passEventTypeConfig'
import type { PassPublic } from '@/components/event-templates/types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function pass(id: string, benefits: string[], status: 'active' | 'inactive' = 'active'): PassPublic {
  return { id, name: id, description: '', price: 0, quantity: null, unlimited: true,
           status, benefits } as PassPublic
}

/** Every benefit ID the organiser wizard can write. */
const CURATED_IDS: string[] = (() => {
  const ids = new Set<string>()
  for (const cfg of Object.values(PASS_BENEFITS_BY_EVENT_TYPE))
    for (const group of cfg.groups) for (const b of group.benefits) ids.add(b.id)
  return [...ids]
})()

/** The shape of an unresolved stored key, per the Phase 8F brief. */
const LOOKS_LIKE_A_KEY = /^[a-z0-9]+([_-][a-z0-9]+)*$/

// ═══ 1. THE FIVE IDS THAT WERE VISIBLE IN PRODUCTION ═════════════════════════

describe('the exact keys Phase 8E saw on the live event page', () => {
  it('each resolves to attendee-facing copy', () => {
    expect(formatBenefit('e_certificate')).toBe('E-Certificate')
    expect(formatBenefit('medical_support')).toBe('Medical Support')
    expect(formatBenefit('water_stations')).toBe('Water Stations')
    expect(formatBenefit('finisher_medal')).toBe('Finisher Medal')
    expect(formatBenefit('tshirt')).toBe('Event T-Shirt')
  })

  it('reaches the hero strip as copy, through the ranking model', () => {
    // The real path: stored benefits -> rankPassBenefits -> the hero's `label`.
    const ranked = rankPassBenefits([
      pass('A', ['e_certificate', 'medical_support', 'water_stations', 'finisher_medal', 'tshirt']),
    ])
    expect(ranked.map(b => b.label)).toEqual([
      'E-Certificate', 'Medical Support', 'Water Stations', 'Finisher Medal', 'Event T-Shirt',
    ])
  })
})

// ═══ 2. NO CURATED ID SURVIVES TO A PUBLIC SURFACE ═══════════════════════════

describe('a stored key never reaches a reader', () => {
  it('no curated ID resolves to something still shaped like a key', () => {
    // Deliberately not a bare regex sweep over arbitrary output: it asks the real
    // question — can a value the wizard can store still look like a key afterwards?
    const unresolved = CURATED_IDS.filter(id => LOOKS_LIKE_A_KEY.test(formatBenefit(id)))
    expect(unresolved, 'these IDs still render as keys').toEqual([])
  })

  it('covers every curated ID, not just the sports vocabulary', () => {
    // A guard on the guard: if the registry were ever read wrongly and came back empty,
    // the assertion above would pass vacuously.
    expect(CURATED_IDS.length).toBeGreaterThan(50)
    expect(CURATED_IDS).toContain('finisher_medal')
    expect(CURATED_IDS).toContain('gala_dinner')
  })

  it('ranks and formats through the shared model, exposing the raw entry separately', () => {
    const [b] = rankPassBenefits([pass('A', ['finisher_medal'])])
    expect(b!.label).toBe('Finisher Medal')   // what a reader sees
    expect(b!.id).toBe('finisher_medal')      // what the icon still matches on
  })
})

// ═══ 3. FREE TEXT AND UNKNOWN IDS ════════════════════════════════════════════

describe('everything that is not a curated ID is left alone', () => {
  it('organiser free text passes through verbatim, casing included', () => {
    expect(formatBenefit('Free parking near the start line')).toBe('Free parking near the start line')
    const [b] = rankPassBenefits([pass('A', ['Free parking near the start line'])])
    expect(b!.label).toBe('Free parking near the start line')
  })

  it('an unknown key is humanised rather than shown raw or dropped', () => {
    expect(formatBenefit('some_new_perk')).toBe('Some New Perk')
    expect(rankPassBenefits([pass('A', ['some_new_perk'])])[0]!.label).toBe('Some New Perk')
  })

  it('empty, blank and missing benefits stay safe', () => {
    expect(formatBenefit('')).toBe('')
    expect(formatBenefits(undefined, undefined)).toEqual([])
    expect(formatBenefits([], [])).toEqual([])
    expect(rankPassBenefits([pass('A', [])])).toEqual([])
    expect(rankPassBenefits([])).toEqual([])
    // A blank entry must not become a bullet with no text.
    expect(rankPassBenefits([pass('A', ['', '   ', 'finisher_medal'])]).map(b => b.label))
      .toEqual(['Finisher Medal'])
  })
})

// ═══ 4. RANKING SEMANTICS ARE UNCHANGED ══════════════════════════════════════

describe('the ranking model behaves exactly as it did', () => {
  it('orders by coverage, then first appearance', () => {
    const ranked = rankPassBenefits([
      pass('A', ['tshirt', 'finisher_medal']),
      pass('B', ['finisher_medal']),
      pass('C', ['finisher_medal']),
    ])
    // finisher_medal is on 3 passes, tshirt on 1 — order is by count, not by input order.
    expect(ranked.map(b => b.label)).toEqual(['Finisher Medal', 'Event T-Shirt'])
    expect(ranked.map(b => b.count)).toEqual([3, 1])
  })

  it('still de-duplicates and still caps at the limit', () => {
    expect(rankPassBenefits([pass('A', ['finisher_medal', 'finisher_medal'])])).toHaveLength(1)
    const many = pass('A', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(rankPassBenefits([many])).toHaveLength(5)
    expect(rankPassBenefits([many], 3)).toHaveLength(3)
  })

  it('still ignores inactive passes and reports coverage honestly', () => {
    const ranked = rankPassBenefits([
      pass('A', ['finisher_medal']),
      pass('B', ['finisher_medal'], 'inactive'),
    ])
    expect(ranked[0]!.total).toBe(1)
    expect(benefitCoverage(ranked[0]!)).toBe('Included with your entry')
  })
})

// ═══ 5. ICONS ARE UNCHANGED ══════════════════════════════════════════════════

describe('icons are resolved from the stored entry, so none of them moved', () => {
  it('every consumer that renders a benefit icon passes the raw id, never the resolved label', () => {
    // SportsHero was the one hero that rendered benefits (a trust strip). Its replacement,
    // sports/editorial/SportsCover, renders NO benefits at all — they belong to the
    // challenges — so it must not reach for the icon map either. The rule is then pinned on
    // every remaining consumer of benefitIcon in the templates.
    const cover = code(read('components/event-templates/sports/editorial/SportsCover.tsx'))
    expect(cover).not.toMatch(/benefitIcon|rankPassBenefits|benefitCoverage|formatBenefit/)
    // sports/editorial/SportsChallenges is the icon consumer on the sports page now; the
    // shared ChallengeSelectionSection it replaced is still pinned while it exists.
    const consumers = [...PUBLIC_BENEFIT_CONSUMERS, 'components/event-templates/sports/editorial/SportsChallenges.tsx', 'components/event-templates/sports/editorial/SportsRaceKit.tsx', 'components/event-templates/shared/registration/ChallengeSelectionSection.tsx']
      .filter(f => code(read(f)).includes('benefitIcon('))
    expect(consumers.length).toBeGreaterThan(0)
    for (const f of consumers) {
      const src = code(read(f))
      expect(src, f).not.toContain('benefitIcon(p.label)')
      expect(src, f).not.toMatch(/benefitIcon\(\w+\.label\)/)
    }
  })

  it('and that matters — formatting first would move real icons', () => {
    // The concrete reason for the rule. "Business Lounge" and "Business Matchmaking"
    // both contain "bus", which benefitIcon reads as transport.
    const moved = CURATED_IDS.filter(id => benefitIcon(id) !== benefitIcon(formatBenefit(id)))
    expect(moved).toContain('biz_lounge')
    expect(moved).toContain('matchmaking')
  })
})

// ═══ 6. EVERY PUBLIC RENDER SITE GOES THROUGH THE RESOLVER ═══════════════════

/** Public templates that render a pass's benefit list. */
const PUBLIC_BENEFIT_CONSUMERS = [
  'components/event-templates/awards/AwardsTickets.tsx',
  'components/event-templates/cultural/CulturalTickets.tsx',
  'components/event-templates/exhibition/ExhibitionPasses.tsx',
  'components/event-templates/workshop/WorkshopEnrollment.tsx',
  'components/event-templates/community/CommunityRegistration.tsx',
  'components/event-templates/conference/ConferenceTickets.tsx',
  'components/event-templates/shared/registration/TicketSection.tsx',
  'components/event-templates/fallback/EventDetailClient.tsx',
] as const

describe('no public template prints pass.benefits directly', () => {
  it('every consumer routes through formatBenefits', () => {
    for (const f of PUBLIC_BENEFIT_CONSUMERS) {
      expect(code(read(f)), f + ' does not use the shared resolver').toContain('formatBenefits(')
    }
  })

  it('none of them maps or filters the RAW property any more', () => {
    // The exact idiom that shipped the bug: the stored array reached JSX directly, as
    // `pass.benefits.map(...)`, or was passed through `pass.benefits?.filter(b => b?.trim())`
    // — a blank-strip standing in for formatting that never formatted anything.
    //
    // The rule is about the raw PROPERTY, not the word: `const benefits = formatBenefits(…)`
    // followed by `benefits.map(…)` is the corrected form and must stay allowed.
    const RAW_PROPERTY_CONSUMED = /\.benefits!?\??\.(map|filter)\(/
    for (const f of PUBLIC_BENEFIT_CONSUMERS) {
      const src = code(read(f))
      expect(src, f + ' consumes the raw benefits property directly')
        .not.toMatch(RAW_PROPERTY_CONSUMED)
    }
  })

  it('that rule would have caught the original bug', () => {
    // Guard on the guard: the pattern must actually match the code that shipped.
    const RAW_PROPERTY_CONSUMED = /\.benefits!?\??\.(map|filter)\(/
    expect('{pass.benefits.map((b, i) => (').toMatch(RAW_PROPERTY_CONSUMED)
    expect('{visiblePasses[0]!.benefits!.map((b, i) => (').toMatch(RAW_PROPERTY_CONSUMED)
    expect('const benefits = pass.benefits?.filter(b => b?.trim()) ?? []').toMatch(RAW_PROPERTY_CONSUMED)
    // …and must not fire on the corrected form.
    expect('const benefits = formatBenefits(pass.benefits)').not.toMatch(RAW_PROPERTY_CONSUMED)
    expect('{benefits.map((b, i) => (').not.toMatch(RAW_PROPERTY_CONSUMED)
  })

  it('the registration path still uses the resolver it always did', () => {
    // challengeModel was already correct in RD-ST6.0; this phase must not disturb it.
    const src = code(read('components/event-templates/shared/registration/challengeModel.ts'))
    expect(src).toContain('formatBenefits(p.benefits, p.customBenefits)')
  })

  it('there is still exactly one benefit vocabulary', () => {
    // No second dictionary, and no per-key special case, anywhere in the templates.
    for (const f of [...PUBLIC_BENEFIT_CONSUMERS,
                     'components/event-templates/sports/editorial/SportsCover.tsx',
                     'components/event-templates/shared/registration/passBenefits.ts']) {
      const src = code(read(f))
      expect(src, f + ' hardcodes a benefit key').not.toMatch(
        /['"](?:e_certificate|medical_support|water_stations|finisher_medal|tshirt)['"]/)
    }
  })
})
