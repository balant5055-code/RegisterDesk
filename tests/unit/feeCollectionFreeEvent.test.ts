// RD-PAYMENT · Fee Collection Method is a PAID-EVENT surface.
//
// ═══ THE BUG THIS PINS ═══════════════════════════════════════════════════════
// The Review step (Step7View) derived `isFreeEvent` correctly and guarded every other
// payment-specific section with it — but rendered <FeeCollectionCard /> unconditionally.
// A free event therefore showed "Fee Collection Method · Organizer Absorbs Fees /
// Attendee Pays Fees", and because `samplePrice` finds no paid pass on a free event it
// fell through to FeeCollectionSection's `samplePrice = 500` default — inventing a ₹500
// ticket to demonstrate fees nobody is charged. Directly beneath it the Final Cost
// Summary read "Fee Model: Free Event / Settlement: N/A". The page contradicted itself.
//
// ═══ WHY THESE TESTS READ SOURCE ═════════════════════════════════════════════
// Step7View is a ~1000-line client component that is not exported and depends on the
// wizard's hooks and config context, so it cannot be mounted in a unit test. The
// visibility DECISION is still tested for real: the `isFreeEvent` expression is extracted
// FROM THE SOURCE and evaluated against fixtures, so these are not assertions about a
// copy of the rule. Change the derivation and this test evaluates the new one.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PAGE = 'app/(dashboard)/dashboard/events/new/page.tsx'
const SRC  = readFileSync(resolve(process.cwd(), PAGE), 'utf8')

/** Source with comments stripped — this file DOCUMENTS the strings asserted absent. */
const code = SRC.split('\n').filter(l => {
  const t = l.trim()
  return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
}).join('\n')

// ─── The canonical decision, lifted out of the component itself ────────────────

/** The literal `isFreeEvent` expression as the Review step actually writes it. */
const isFreeEventExpr = (() => {
  const m = code.match(/const\s+isFreeEvent\s*=\s*([^\n]+?)\n/)
  if (!m) throw new Error('isFreeEvent is no longer derived in ' + PAGE)
  return m[1].trim()
})()

/** Evaluate THAT expression against a pricing fixture. */
function isFreeEvent(pricingData: unknown): boolean {
  const fn = new Function('pricingData', `return ${isFreeEventExpr}`) as (p: unknown) => boolean
  return fn(pricingData)
}

type Pass = { id: string; name: string; type: string; price: number }
const freePass: Pass = { id: 'p_free', name: 'Free entry',  type: 'free', price: 0 }
const paidPass: Pass = { id: 'p_paid', name: 'Full ticket', type: 'paid', price: 500 }

// ═══ 1 · The decision ════════════════════════════════════════════════════════

describe('the canonical condition is the event-level pricing.eventType', () => {
  it('is derived from pricingData.eventType and nothing else', () => {
    expect(isFreeEventExpr).toBe("pricingData?.eventType === 'free'")
    // Never the event taxonomy, never a per-pass price.
    expect(isFreeEventExpr).not.toContain('eventTypeId')
    expect(isFreeEventExpr).not.toContain('eventSubtype')
    expect(isFreeEventExpr).not.toContain('price')
    expect(isFreeEventExpr).not.toContain('passes')
  })

  it('TEST 1 — a free event is free', () => {
    expect(isFreeEvent({ eventType: 'free', feeModel: 'organizer_absorbs', passes: [] })).toBe(true)
  })

  it('TEST 2 — a paid event is not free', () => {
    expect(isFreeEvent({ eventType: 'paid', feeModel: 'attendee_pays', passes: [paidPass] })).toBe(false)
  })

  it('TEST 3 — "free event" does not mean "no passes"', () => {
    // The exact production shape: Palm Seed Plantation Festival.
    expect(isFreeEvent({ eventType: 'free', feeModel: 'organizer_absorbs', passes: [freePass] })).toBe(true)
  })

  it('TEST 4 — a PAID event containing a zero-price pass stays paid', () => {
    // The rule is event-level, not per-pass. A ₹0 pass inside a paid event must not
    // flip the event to free and strip the organizer's fee configuration.
    expect(isFreeEvent({ eventType: 'paid', passes: [freePass, paidPass] })).toBe(false)
    expect(isFreeEvent({ eventType: 'paid', passes: [freePass] })).toBe(false)
  })

  it('absent or malformed pricing is NOT treated as free', () => {
    // Defaulting to "free" would hide fee configuration from a paid event whose pricing
    // block failed to load — the opposite failure, and the more damaging one.
    for (const p of [null, undefined, {}, { eventType: '' }, { eventType: 'FREE' }, { eventType: 0 }]) {
      expect(isFreeEvent(p), JSON.stringify(p)).toBe(false)
    }
  })

  it('is event-type agnostic', () => {
    // Same pricing, different taxonomy → same answer.
    for (const et of ['custom', 'sports', 'conference', 'workshop', 'expo']) {
      expect(isFreeEvent({ eventType: 'free', eventTypeId: et }), et).toBe(true)
      expect(isFreeEvent({ eventType: 'paid', eventTypeId: et }), et).toBe(false)
    }
  })
})

// ═══ 2 · The render site ═════════════════════════════════════════════════════

// RD-PHASE4-S3 · Q1 — the Fee Collection card is REMOVED (fee collection is fixed to organizer-pays, and
// organizers do not choose it). The free-event safety invariant this file protected now applies to the
// one element left in the card's place: the informational Easy Split notice, paid events only.
describe('FeeCollectionCard renders only when the event is paid', () => {
  // RD-FEE-RESTORE-01 — this case previously asserted the selector did not exist at all, which
  // was true while RD-PHASE4-S3 · Q1 had removed it. The selector is back, so the assertion
  // moves from "it is absent" to "it is absent FOR A FREE EVENT" — which is, and always was,
  // the property this file exists to protect.
  it('the fee-collection selector is guarded by !isFreeEvent', () => {
    expect(code).toContain("phase === 'final' && !isFreeEvent && pricingEngineOn && feeSamplePrice !== null")
    const lines = code.split('\n')
    const at = lines.findIndex(l => l.includes('<FeeCollectionSection'))
    expect(at).toBeGreaterThan(-1)
    // The guard sits on the conditional immediately above the element.
    expect(lines.slice(Math.max(0, at - 3), at).join('\n')).toContain('!isFreeEvent')
  })

  it('the notice in its place is guarded by !isFreeEvent (NOT rendered unconditionally)', () => {
    expect(code).toContain("{phase === 'final' && !isFreeEvent && <EasySplitNotice />}")
    const lines = code.split('\n')
    const at = lines.findIndex(l => l.includes('<EasySplitNotice />'))
    expect(at).toBeGreaterThan(-1)
    expect(lines[at]).toContain('!isFreeEvent')
  })

  it('there is exactly ONE render site, so nothing else can leak it', () => {
    expect((code.match(/<EasySplitNotice \/>/g) ?? []).length).toBe(1)
  })

  it('it is not merely hidden with CSS', () => {
    const m = code.match(/\{phase === 'final' && !isFreeEvent && <EasySplitNotice \/>\}/)
    expect(m, 'guarded notice not found').not.toBeNull()
    for (const banned of ['display: none', 'visibility: hidden', 'opacity-0', 'sr-only', 'invisible', 'className']) {
      expect(m![0], banned).not.toContain(banned)
    }
  })

  // RD-FEE-RESTORE-01 — the ACTUAL bug this file was written for was never the prop; it was the
  // DEFAULT behind it (`samplePrice = 500`), which let a free event demonstrate fees on a ticket
  // that does not exist. The prop is back; the default is not, and the value passed is the
  // event's own cheapest paid pass or nothing at all.
  it('no sample ticket price is ever invented', () => {
    expect(code).not.toMatch(/samplePrice\s*=\s*500/)
    expect(code).toContain('samplePrice: number')              // required, no default
    expect(code).toContain('samplePrice={feeSamplePrice}')      // the event's own price
    // …and when there is no paid pass, the control does not render at all.
    expect(code).toContain('feeSamplePrice !== null')
    expect(code).toContain('paid.length > 0 ? Math.min(...paid) : null')
  })

  it('it follows the guard pattern the sibling sections already use', () => {
    // Not a one-off: `!isFreeEvent &&` is how this component already gates payment UI.
    expect((code.match(/!isFreeEvent &&/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

// ═══ 3 · The Final Cost Summary is untouched (TEST 5) ════════════════════════

describe('TEST 5 — the Final Cost Summary still states the free-event position', () => {
  it('Fee Model reads "Free Event" and Settlement reads "N/A" for a free event', () => {
    expect(code).toContain("isFreeEvent ? 'Free Event' : FEE_MODEL_LABELS[feeModel]")
    expect(code).toContain("isFreeEvent ? 'N/A' : 'T+3 Business Days'")
  })

  it('so a free event states its fee position WITHOUT offering a fee choice', () => {
    // RD-PHASE4-S3 — the summary informs; there is no fee choice to offer at all any more.
    expect(code).not.toContain('<FeeCollectionCard')
    expect(code).toContain("isFreeEvent ? 'Free Event'")
  })
})

// ═══ 4 · Nothing downstream changed (TEST 6) ═════════════════════════════════

describe('TEST 6 — paid-event behaviour and the payment path are untouched', () => {
  // RD-PHASE4-S3 · Q1 — SUPERSEDED: the fee model is FIXED (organizer-pays); the organizer's stored
  // choice is neither honoured nor persisted by the wizard any more.
  // RD-FEE-RESTORE-01 — the fee model is the organizer's choice again, but ONLY with the pricing
  // engine on. With it off the behaviour this case guarded is unchanged, and that is what is
  // asserted now: the flag-off branch still resolves to SUPPORTED_FEE_MODEL, and the legacy
  // stored field is still never the seed.
  it('falls back to the supported (organizer-pays) model whenever the engine is off', () => {
    expect(code).toContain('!pricingEngineOn ? SUPPORTED_FEE_MODEL : (recordedFeeModel ?? DEFAULT_FEE_MODEL_WHEN_ENABLED)')
    expect(code).not.toContain('normalizeFeeModel(pricingData?.feeModel')
    expect(code).not.toMatch(/pricingData\?\.feeModel/)
  })

  it('no organizer fee-model persistence remains', () => {
    expect(code).not.toContain('savePricingChanges')
  })

  it('a free pass is refused by the order route, independently of this UI', () => {
    // The visibility fix must not be mistaken for the payment guard — that lives server
    // side and keys on the resolved pass amount, never on feeModel.
    const order = readFileSync(resolve(process.cwd(), 'app/api/registrations/create-order/route.ts'), 'utf8')
    expect(order).toContain('originalAmountPaise === 0')
    expect(order).toContain('This pass is free.')
  })
})
