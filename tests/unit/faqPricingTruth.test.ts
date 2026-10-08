// ─── /support may not contradict /pricing about money ────────────────────────
//
// RD-CAPACITY-02 · the FAQ described the retired tier model. Two answers were worse than
// stale — they told organizers that API access, webhooks, white-label and custom domains were
// restricted to Professional or Enterprise, when every one of those is now included for every
// organizer. A support page that tells a customer they cannot use something they already have
// is the most expensive kind of wrong copy there is.
//
// The original problem was the same shape: /pricing DERIVED its figures and the FAQ did not, so
// two public pages disagreed about money and the wrong one lived where nobody reviews it.
//
// ═══ WHY THE FAQ IS STILL STATIC TEXT ════════════════════════════════════════
// Deriving it was considered and rejected for a reason, not for convenience.
// getLicenseCatalogV2() — the resolver /pricing uses — is SERVER-ONLY and async, because it
// overlays runtime Business-Config overrides on the code defaults. FAQ_ITEMS is a plain
// array consumed by /support AND by SupportSearch, a client island; making it async would
// push a server-only await through a client boundary for one sentence. Deriving from
// defaultLicenseCatalogV2() instead would be actively worse: the FAQ would print CODE
// defaults while /pricing prints the OVERRIDDEN values, recreating the same disagreement
// through a different door.
//
// So the text stays static and these tests hold it to the catalog. Every assertion reads
// the canonical constant and then checks the sentence against it, which means changing a
// price or a fee percentage without updating the FAQ fails here — the drift that produced
// the bug is the thing being tested, not the wording.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { FAQ_ITEMS } from '@/content/marketing/faq'
import { SOLUTION_PAGES } from '@/content/marketing/solution-pages'
import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'
import { buildPricingPlans, PLATFORM_FEE_PREFIX } from '@/content/marketing/pricing'
import { type PublicTicketFee } from '@/lib/licensing/publicPricing'
import { getDefaultFeeConfig } from '@/lib/fees/config'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')

/** THE canonical commercial model. Every FAQ money claim is checked against this. */
const T = DEFAULT_COMMERCIAL_TERMS

/** The ticket fee a new sale resolves to under the code defaults: the commercial percentage + the canonical row's GST and cap,
 *  with NO fixed part and NO minimum (RD-FEE-01 — resolveFeeConfig zeroes them for ticket sales). */
const FEE_ROW = getDefaultFeeConfig('event_registration', 'starter')
const FEE: PublicTicketFee = {
  percent: T.attendeeTransactionFeePercent, fixedPaise: 0,
  minPaise: 0, maxPaise: FEE_ROW.platformFeeMaxPaise, gstRatePercent: FEE_ROW.gstRatePercent,
}

const plans = buildPricingPlans(T, FEE)
const plan = (id: string) => {
  const t = plans.find(x => x.id === id)
  if (!t) throw new Error('no such plan: ' + id)
  return t
}
/** The tier names that must no longer appear as ACTIVE products in public copy. */
const RETIRED_TIERS = ['Starter', 'Professional', 'Business', 'Enterprise']

const faq = (id: string) => {
  const item = FAQ_ITEMS.find(i => i.id === id)
  if (!item) throw new Error('no such FAQ item: ' + id)
  return item.answer
}
const faqItem = (id: string) => {
  const item = FAQ_ITEMS.find(i => i.id === id)
  if (!item) throw new Error('no such FAQ item: ' + id)
  return item
}

/** Every FAQ answer, as one blob — for "no page says X anywhere" assertions. */
const ALL_ANSWERS = FAQ_ITEMS.map(i => i.answer).join('\n')

// ═══════════════════════════════════════════════════════════════════════════════

describe('the canonical commercial model says what the FAQ must agree with', () => {
  it('is two states: free up to the free capacity, then pay per registration', () => {
    expect(plans.map(p => p.id)).toEqual(['free', 'payg'])
    expect(plan('free').priceLabel).toBe('Free')
    expect(plan('payg').period).toBe('/registration')
  })

  it('carries ONE RegisterDesk platform fee, not a ladder', () => {
    // RD-FEE-02 — the approved default RegisterDesk platform fee is 0.5% (was 2.5%), Super Admin editable.
    expect(T.attendeeTransactionFeePercent).toBe(0.5)
    // Both cards quote the same fee — there is no tier that pays less.
    const fees = plans.map(p => p.features.find(f => f.startsWith(PLATFORM_FEE_PREFIX)))
    expect(fees.every(Boolean)).toBe(true)
    expect(new Set(fees).size).toBe(1)
  })
})

describe('the FAQ fee answer matches the commercial model', () => {
  const answer = faq('transaction-fees')

  // RD-PRICING-CALC fee audit — the answer used to state "2.5%", but checkout charges the fee the
  // fee resolver produces (percentage + a fixed part, GST on the fee — see transactionFeePath.test.ts),
  // and every part of it is configuration or code that can change. The FAQ is static content, so it
  // now states the structure only and defers the figures to the LIVE pricing page; it can no longer
  // contradict checkout.
  it('states no fee figure of its own — it defers to the live pricing page', () => {
    expect(answer).not.toMatch(/\d/)          // no percentage, amount or count
    expect(answer).not.toMatch(/₹|%/)
    expect(faqItem('transaction-fees').href).toBe('/pricing')
    expect(answer).toMatch(/pricing page/i)
  })

  it('describes the fee structure checkout actually applies', () => {
    // RD-FEE-02 — RegisterDesk's platform fee and the payment provider's gateway charge are SEPARATE.
    expect(answer).toMatch(/paid ticket sales carry a RegisterDesk platform fee/i)
    expect(answer).toMatch(/GST charged on that fee/i)
    expect(answer).toMatch(/gateway charges are separate/i)
    expect(answer).toMatch(/charged by the payment provider, not RegisterDesk/i)
    expect(answer).not.toMatch(/transaction fee/i)
  })

  it('does not describe a per-plan fee ladder any more', () => {
    // The shape of the old claim: a range between two tiers.
    expect(answer).not.toMatch(/ranging from|down to|depends on your (event )?license/i)
    for (const name of RETIRED_TIERS) expect(answer, name).not.toContain(name)
  })

  it('never calls Starter free, and never names a retired tier at all', () => {
    expect(ALL_ANSWERS).not.toMatch(/free Starter/i)
    expect(ALL_ANSWERS).not.toMatch(/Starter (license )?is (always )?free/i)
    for (const name of RETIRED_TIERS) {
      expect(ALL_ANSWERS, `the FAQ still names the retired ${name} tier`).not.toContain(name)
    }
  })
})

describe('the FAQ refund and fee answers match what the product does (RD-PREPROD)', () => {
  it('refunds are a Super Admin action — organizers have no refund control', () => {
    const answer = faq('refunds')
    expect(answer).toMatch(/Super Admin/)
    expect(answer).toMatch(/refund policy/i)
    expect(answer).not.toMatch(/Organizers can issue|from the dashboard;|partial refunds/i)
  })

  it('the fee answer makes no "flat" or "no plan-dependent rates" promise', () => {
    // The fee engine has fixed components, minimums and per-event overrides; "flat" was false.
    const answer = faq('transaction-fees')
    expect(answer).not.toMatch(/flat|no plan-dependent/i)
  })
})

describe('the FAQ free-events answer matches the commercial model', () => {
  const answer = faq('free-events')

  it('states the CONFIGURED free capacity', () => {
    expect(answer).toContain(String(T.freeRegistrationCapacity))
  })

  it('keeps the claims that ARE supported', () => {
    // One-time, per event — never recurring. Free registrations are a real capability.
    expect(answer).toMatch(/no subscriptions/i)
    expect(answer).toMatch(/no-charge registrations/i)
    expect(answer).toMatch(/pay once|once for the extra capacity/i)
    // And the pricing page still describes the charge as per-registration, one-time.
    expect(read('content/marketing/pricing.ts')).toContain("period:      '/registration'")
    expect(read('content/marketing/pricing.ts')).toContain('One-time activation — no subscription')
  })

  it('no longer frames the free state as a licence TIER', () => {
    expect(answer).not.toMatch(/Free license/i)
  })
})

describe('the FAQ entitlement claims match the fact that everything is included', () => {
  it('API access is no longer gated by a plan — and the CODE agrees', () => {
    expect(faq('api')).not.toMatch(/Professional and above/)
    expect(faq('api')).toMatch(/included for every organizer/i)
    // The claim is checked against the enforcement, not just against itself: no route may
    // still gate API access on a licence feature.
    for (const f of ['app/api/organizer/api-keys/route.ts', 'app/api/organizer/webhooks/route.ts']) {
      expect(read(f), f).not.toContain('requireFeature')
    }
  })

  it('white-label and custom domains are no longer gated — and the CODE agrees', () => {
    const answer = faq('white-label')
    expect(answer).not.toMatch(/Professional and above|available on Enterprise/i)
    expect(answer).toMatch(/included for every organizer/i)
    for (const f of [
      'app/api/organizer/branding/route.ts',
      'app/api/organizer/domain/route.ts',
      'lib/branding/service.ts',
    ]) {
      expect(read(f), f).not.toContain('requireFeature')
    }
  })

  it('does not promise custom domains — there is no host routing (RD-PREPROD)', () => {
    expect(faq('white-label')).not.toMatch(/custom domains (are )?included/i)
    expect(faq('white-label')).toMatch(/Custom domains are not available/i)
  })

  it('no FAQ answer invents a subscription or monthly plan', () => {
    // Activation is one-time per event. A "per month" answer would contradict the model,
    // not just a number.
    expect(ALL_ANSWERS).not.toMatch(/per month|monthly (fee|plan|subscription)|billed annually/i)
  })
})

describe('no public copy promises recurring donations', () => {
  it('the fundraisers page describes one-off giving only', () => {
    const fundraisers = SOLUTION_PAGES.fundraisers
    expect(fundraisers, 'the fundraisers solution page should exist').toBeTruthy()
    const blob = JSON.stringify(fundraisers)
    expect(blob).not.toMatch(/recurring/i)
    expect(blob).toMatch(/one-off/i)
  })

  it('no solutions page mentions recurring giving at all', () => {
    const all = JSON.stringify(SOLUTION_PAGES)
    for (const term of [/recurring/i, /monthly donation/i, /subscription donation/i, /autopay/i, /standing instruction/i]) {
      expect(all, 'unsupported recurring-donation language').not.toMatch(term)
    }
  })

  it('and the reason still holds — there is no recurring donation model', () => {
    // The condition that made the claim false. If a recurring mechanism ever ships, this
    // fails and the claim may come back.
    for (const f of [
      'lib/donations/donationService.ts',
      'lib/donations/types.ts',
    ]) {
      expect(read(f), f).not.toMatch(/recurringDonation|subscriptionId|mandateId|autopay/i)
    }
  })

  it('one-off donation support is still represented', () => {
    const all = JSON.stringify(SOLUTION_PAGES)
    expect(all).toMatch(/Donation campaigns/)
    expect(all).toMatch(/80G/)
    expect(all).toMatch(/Donor CRM/)
  })
})
