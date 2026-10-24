// RD-FEE-RESTORE-01 — organizer-selectable fee collection, restored behind pricingEngineEnabled.
//
// ═══ THE ONE PROPERTY THAT MATTERS MOST ══════════════════════════════════════
// Every event that exists today must keep charging exactly what it charges today. That is not
// achieved by a migration; it is achieved by reading a DIFFERENT field. `pricing.feeModel` has
// never decided a charge (RD-PHASE4-S3 · Q1 pinned every event to organizer-pays), so a stored
// `attendee_pays` is a value that never took effect. Honouring it now would start charging
// attendees fees on live events whose real behaviour never included them.
//
// So the restored flow writes `pricing.feeCollection`, and its ABSENCE is the compatibility
// guarantee. The first describe block is that guarantee; everything else supports it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  explicitFeeModel, readFeeCollection, buildFeeCollection, FEE_COLLECTION_VERSION,
} from '@/lib/fees/explicitFeeModel'
import {
  builderFeeModelToEngine, organizerPaysPricing,
  SUPPORTED_FEE_MODEL, DEFAULT_FEE_MODEL_WHEN_ENABLED,
} from '@/lib/events/builder/types'
import { buildEventEditUpdate, extractEditableSnapshot } from '@/lib/events/editing/applyEdit'
import { classifyEditKey, findForbiddenEditKeys } from '@/lib/events/editing/fieldClassification'
import { registrationTemplate } from '@/lib/email/templates/registration'
import { TAX_INCLUSIVE_NOTE, FEES_ADDED_AT_CHECKOUT_NOTE } from '@/lib/pricing/copy'
import { buildAttendeeFeeBreakdown } from '@/lib/fees/attendeeBreakdown'
import type { EventEditPayload } from '@/types/events'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments stripped — this change documents the very strings these cases assert on. */
const code  = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const ORDER   = code(read('app/api/registrations/create-order/route.ts'))
const PREVIEW = code(read('app/api/registrations/fee-preview/route.ts'))
const PAGE    = code(read('app/(dashboard)/dashboard/events/new/page.tsx'))

const NOW = '2026-10-24T12:00:00.000Z'
const CTX = { feeModelEditable: true, actorUid: 'organizer-1', nowIso: NOW }

// ═══ 1 · LEGACY EVENTS ARE UNTOUCHED ═════════════════════════════════════════

describe('RD-FEE-RESTORE-01 · an existing event keeps its current charges', () => {
  it('ignores a stored legacy feeModel entirely, including attendee_pays', () => {
    // The exact shape of a live event today. It has been charged organizer-absorbs for its
    // whole life; reading this field would silently start charging its attendees fees.
    expect(explicitFeeModel({ feeModel: 'attendee_pays', passes: [] })).toBeNull()
    expect(explicitFeeModel({ feeModel: 'organizer_absorbs', passes: [] })).toBeNull()
  })

  it('returns null for every shape that is not an explicit record', () => {
    for (const p of [null, undefined, {}, [], 'x', 0, { feeCollection: null }, { feeCollection: 'x' }]) {
      expect(explicitFeeModel(p), JSON.stringify(p)).toBeNull()
    }
  })

  it('refuses a malformed record rather than guessing — a guess would move money', () => {
    for (const fc of [
      { model: 'nonsense', setAt: NOW, setBy: 'u' },
      { model: 'attendee_pays', setBy: 'u' },              // no setAt
      { model: 'attendee_pays', setAt: NOW },               // no setBy
      { model: 'attendee_pays', setAt: '', setBy: 'u' },
      { model: 'attendee_pays', setAt: NOW, setBy: '' },
    ]) {
      expect(explicitFeeModel({ feeCollection: fc }), JSON.stringify(fc)).toBeNull()
    }
  })

  it('honours a well-formed record, in BOTH directions', () => {
    expect(explicitFeeModel({ feeCollection: buildFeeCollection('attendee_pays', 'u', NOW) })).toBe('customer_pays')
    expect(explicitFeeModel({ feeCollection: buildFeeCollection('organizer_absorbs', 'u', NOW) })).toBe('organizer_pays')
  })

  it('maps identically to the canonical builderFeeModelToEngine', () => {
    // explicitFeeModel inlines the mapping to stay out of the builder's type graph. If the
    // canonical mapping ever changes, this fails rather than the two drifting silently.
    for (const m of ['attendee_pays', 'organizer_absorbs'] as const) {
      expect(explicitFeeModel({ feeCollection: buildFeeCollection(m, 'u', NOW) }))
        .toBe(builderFeeModelToEngine(m))
    }
  })

  it('round-trips through readFeeCollection with a stamped version', () => {
    const rec = buildFeeCollection('attendee_pays', 'organizer-1', NOW)
    expect(rec.version).toBe(FEE_COLLECTION_VERSION)
    expect(readFeeCollection({ feeCollection: rec })).toEqual(rec)
  })
})

// ═══ 2 · PUBLISH AND DUPLICATE CARRY THE RECORD ══════════════════════════════

describe('RD-FEE-RESTORE-01 · the choice survives publish and duplicate', () => {
  // organizerPaysPricing runs on BOTH paths. It coerces the legacy field and must leave the
  // explicit record alone — if it stripped it, a selection would silently revert on publish,
  // which is the single most likely way this feature breaks.
  const chosen = buildFeeCollection('attendee_pays', 'organizer-1', NOW)

  it('preserves feeCollection while still pinning the legacy field', () => {
    const out = organizerPaysPricing({ eventType: 'paid', feeModel: 'attendee_pays', feeCollection: chosen, passes: [] })
    expect((out as { feeCollection?: unknown }).feeCollection).toEqual(chosen)
    expect((out as { feeModel?: unknown }).feeModel).toBe(SUPPORTED_FEE_MODEL)
    expect(explicitFeeModel(out)).toBe('customer_pays')
  })

  it('invents no record for an event that never had one', () => {
    const out = organizerPaysPricing({ eventType: 'paid', feeModel: 'organizer_absorbs', passes: [] })
    expect((out as { feeCollection?: unknown }).feeCollection).toBeUndefined()
    expect(explicitFeeModel(out)).toBeNull()
  })
})

// ═══ 3 · THE EDIT PATH · FLAG GATING AND PROVENANCE ══════════════════════════

describe('RD-FEE-RESTORE-01 · post-publish editing', () => {
  const draft = { pricing: { feeModel: 'organizer_absorbs', passes: [{ id: 'p1', name: '10K', price: 500 }] } }

  it('is a recognised edit key again, while prices and licence stay forbidden', () => {
    expect(classifyEditKey('feeModel')).toBe('safe')
    expect(findForbiddenEditKeys(['feeModel'])).toEqual([])
    expect(findForbiddenEditKeys(['price', 'passPrices', 'pricingModel', 'licenseTier']).sort())
      .toEqual(['licenseTier', 'passPrices', 'price', 'pricingModel'])
  })

  it('REFUSES the write when the pricing engine is off — the gate is a pure rule, not just a route', () => {
    // Default context reproduces the flag-off state, so any caller that forgets to pass the
    // flag fails closed rather than writing a money-affecting field.
    expect(() => buildEventEditUpdate({ feeModel: 'attendee_pays' } as EventEditPayload, draft, {}))
      .toThrow(RangeError)
    expect(() => buildEventEditUpdate({ feeModel: 'attendee_pays' } as EventEditPayload, draft, {},
      { ...CTX, feeModelEditable: false })).toThrow(RangeError)
  })

  it('writes pricing.feeCollection — never the legacy pricing.feeModel', () => {
    const out = buildEventEditUpdate({ feeModel: 'attendee_pays' } as EventEditPayload, draft, {}, CTX)
    expect(out.updates['pricing.feeCollection']).toEqual(buildFeeCollection('attendee_pays', 'organizer-1', NOW))
    expect(out.updates['pricing.feeModel']).toBeUndefined()
    expect(out.changedFields).toContain('feeModel')
  })

  it('refuses an unknown model, and refuses to record one without an actor', () => {
    expect(() => buildEventEditUpdate({ feeModel: 'free_for_all' } as never, draft, {}, CTX)).toThrow(RangeError)
    expect(() => buildEventEditUpdate({ feeModel: 'attendee_pays' } as EventEditPayload, draft, {},
      { ...CTX, actorUid: '' })).toThrow(RangeError)
    expect(() => buildEventEditUpdate({ feeModel: 'attendee_pays' } as EventEditPayload, draft, {},
      { ...CTX, nowIso: '' })).toThrow(RangeError)
  })

  it('leaves every other edit untouched when no fee model is sent', () => {
    const out = buildEventEditUpdate({ name: 'New name' } as EventEditPayload, draft, {}, CTX)
    expect(out.updates['pricing.feeCollection']).toBeUndefined()
    expect(out.changedFields).toEqual(['name'])
  })

  it('the audit before-snapshot still reads the stored value and invents none', () => {
    expect(extractEditableSnapshot(draft).feeModel).toBe('organizer_absorbs')
    expect('feeModel' in extractEditableSnapshot({ pricing: { passes: [] } })).toBe(false)
  })
})

// ═══ 4 · THE SERVER DECIDES, NOT THE BUILDER ═════════════════════════════════

describe('RD-FEE-RESTORE-01 · checkout and preview resolution', () => {
  it('create-order resolves pin → explicit → supported, and gates on the flag server-side', () => {
    expect(ORDER).toContain('eventFeeModel: pinnedFeeModel')
    expect(ORDER).toMatch(/platformSettings\.features\.pricingEngineEnabled \? explicitFeeModel\(rawPricing\) : null/)
    expect(ORDER).toContain('?? builderFeeModelToEngine(SUPPORTED_FEE_MODEL)')
  })

  it('the preview applies the SAME rule minus the pin, so a quote cannot disagree with the charge', () => {
    expect(PREVIEW).toMatch(/platformSettings\.features\.pricingEngineEnabled \? explicitFeeModel\(rawPricing\) : null/)
    expect(PREVIEW).toContain('?? builderFeeModelToEngine(SUPPORTED_FEE_MODEL)')
    // A preview has no attempt of its own to inherit from.
    expect(PREVIEW).not.toContain('pinnedFeeModel')
  })

  it('neither money path reads the legacy field', () => {
    for (const [name, src] of [['create-order', ORDER], ['fee-preview', PREVIEW]] as const) {
      expect(src, name).not.toMatch(/normalizeFeeModel\(\s*rawPricing/)
      expect(src, name).not.toMatch(/rawPricing[?.\s]*\.feeModel/)
    }
  })

  it('the in-flight pin is still consulted FIRST', () => {
    // Ordering is the contract: an organizer changing the model must never re-price a customer
    // who is already at the gateway.
    const i = ORDER.indexOf('eventFeeModel: pinnedFeeModel')
    const j = ORDER.indexOf('explicitFeeModel(rawPricing)')
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
  })
})

// ═══ 5 · THE BUILDER CONTROL ═════════════════════════════════════════════════

describe('RD-FEE-RESTORE-01 · the wizard control', () => {
  it('renders only for a PAID event, with the engine on, and a real sample price', () => {
    // The free-event guard is the defect feeCollectionFreeEvent.test.ts was written for, and
    // `feeSamplePrice !== null` is what replaced the invented ₹500 default.
    expect(PAGE).toContain("phase === 'final' && !isFreeEvent && pricingEngineOn && feeSamplePrice !== null")
  })

  it('has no invented sample price anywhere', () => {
    expect(PAGE).not.toMatch(/samplePrice\s*=\s*500/)
    expect(PAGE).toContain('samplePrice: number')   // required prop, no default
  })

  // RD-FEE-RESTORE-01 — the default is ORGANIZER-ABSORBS even with the engine on (owner's call
  // for the release). The flag is already ON in production, so an attendee-pays default would
  // have started charging attendees fees on every new paid event the moment this deployed.
  //
  // The assertion is deliberately on the VALUE and not on "it equals SUPPORTED_FEE_MODEL": the
  // two constants mean different things and may legitimately diverge again. Writing it as an
  // equality between them would make a future change to either one silently pass.
  it('defaults a new paid event to ORGANIZER-ABSORBS, with the engine on or off', () => {
    expect(DEFAULT_FEE_MODEL_WHEN_ENABLED).toBe('organizer_absorbs')
    expect(SUPPORTED_FEE_MODEL).toBe('organizer_absorbs')
    // Both branches of the initialiser therefore land on organizer-absorbs for a new event…
    expect(PAGE).toContain('!pricingEngineOn ? SUPPORTED_FEE_MODEL : (recordedFeeModel ?? DEFAULT_FEE_MODEL_WHEN_ENABLED)')
  })

  it('still OFFERS attendee-pays — the default is a starting point, not a restriction', () => {
    // Changing the default must never quietly become "the feature is off". Both options are
    // still rendered, and a RECORDED attendee-pays choice still wins over the default.
    expect(PAGE).toContain("id: 'attendee_pays' as FeeModel")
    expect(PAGE).toContain("id: 'organizer_absorbs' as FeeModel")
    expect(PAGE).toContain('label: \'Attendee Pays Fees\'')
    // A stored choice beats the default: `recordedFeeModel ?? DEFAULT_...`.
    expect(explicitFeeModel({ feeCollection: buildFeeCollection('attendee_pays', 'u', NOW) })).toBe('customer_pays')
  })

  // RD-FEE-RESTORE-02 — the reported mismatch: the builder previewed ₹1.04 from the DRAFT while
  // an attendee was charged ₹1 from the LIVE event, because the selector wrote only the draft.
  // On a published event the change must go through PATCH /edit, which writes both in one batch.
  it('sends a PUBLISHED event’s change through PATCH /edit, not a draft-only write', () => {
    expect(PAGE).toContain("const isPublishedDraft = draft?.status === 'published'")
    expect(PAGE).toMatch(/if \(isPublishedDraft\) \{/)
    expect(PAGE).toContain('/edit`, {')
    expect(PAGE).toContain("method:  'PATCH'")
    expect(PAGE).toContain("body:    JSON.stringify({ feeModel: model })")
  })

  it('reverts the selection when the save fails, so the UI never claims an unsaved choice', () => {
    expect(PAGE).toContain('const saved = await onFeeModelChange?.(m)')
    expect(PAGE).toContain('if (saved === false)')
    expect(PAGE).toContain('setLocalFeeModel(previous)')
  })

  // ═══ RD-FEE-RESTORE-03 · the attendee summary must not contradict the charge ═══════════════
  //
  // The reported symptom after the live-sync fix: the attendee page still read "Total ₹1" for a
  // ₹1 ticket under attendee-pays. The total itself is BY DESIGN — the inline panel is not
  // authoritative and the exact itemised charge is shown in the payment dialog. What was wrong
  // is what sat beside it: the DESKTOP panel is the one the organizer was looking at, it carries
  // no "fees are itemised" disclaimer (only the mobile panel does), and its `taxNote` asserted
  // "All prices include taxes" — which under attendee-pays is simply false.
  it('replaces the tax note with a fee note when the attendee bears the fees', () => {
    const REG = code(read('app/events/[slug]/register/RegisterClient.tsx'))
    expect(REG).toContain('attendeePaysFees ? FEES_ADDED_AT_CHECKOUT_NOTE : TAX_INCLUSIVE_NOTE')
    // Still null for a free event — a note about fees on a free ticket is its own lie.
    expect(REG).toContain('!isPaid ? null :')
  })

  it('resolves that flag on the SERVER from the same rule checkout prices with', () => {
    // If the wording came from a different source than the charge, the two could disagree
    // again — which is the entire class of bug this is fixing.
    const PAGE_SRV = code(read('app/events/[slug]/register/page.tsx'))
    expect(PAGE_SRV).toContain("explicitFeeModel(rawPricing) === 'customer_pays'")
    expect(PAGE_SRV).toContain('pricingEngineEnabled')
    expect(PAGE_SRV).toContain('attendeePaysFees={')
  })

  it('the fee note is honest about WHEN the fees appear', () => {
    // It promises itemisation because the payment dialog genuinely itemises from the server's
    // own breakdown. A vaguer note would leave the inline total looking final again.
    expect(FEES_ADDED_AT_CHECKOUT_NOTE).toMatch(/added at checkout/i)
    expect(FEES_ADDED_AT_CHECKOUT_NOTE).toMatch(/itemised before payment/i)
    expect(TAX_INCLUSIVE_NOTE).not.toBe(FEES_ADDED_AT_CHECKOUT_NOTE)
  })

  it('seeds from the explicit record, never the legacy field', () => {
    expect(PAGE).toContain('readFeeCollection(pricingData)?.model')
    expect(PAGE).not.toMatch(/pricingData\?\.feeModel/)
  })

  it('prices the comparison through the canonical engine adapter', () => {
    // The removed version used a page-local calcFees that taxed gateway fees for GST too,
    // showing a number checkout never charged.
    expect(PAGE).toContain("computeFeePreview(samplePrice, 'attendee_pays', rates)")
    expect(PAGE).not.toMatch(/function calcFees/)
  })
})

// ═══ 6 · THE CONFIRMATION EMAIL ══════════════════════════════════════════════

describe('RD-FEE-RESTORE-01 · the attendee confirmation email itemises what they paid', () => {
  const base = {
    to: 'a@b.test', attendeeName: 'Asha', eventName: 'Madurai Run', eventDate: 'Sat, 31 Oct 2026',
    ticketCode: 'TKT1', passName: '10K', registrationId: 'r1',
    ticketPageUrl: 'https://x.test/t', pdfDownloadUrl: 'https://x.test/p',
  }

  const financials = {
    ticketBasePaise: 3000, platformFeeBasePaise: 30, platformFeeGstPaise: 5,
    gatewayFeeEstimatePaise: 75, chargeAmountPaise: 3110, attendeeFeeTotalPaise: 110,
  }

  it('renders the itemised lines and the total actually charged', () => {
    const bd = buildAttendeeFeeBreakdown(financials)
    expect(bd).not.toBeNull()
    const { html } = registrationTemplate({ ...base, feeBreakdown: bd! })
    expect(html).toContain('Payment summary')
    expect(html).toContain('Ticket price')
    expect(html).toContain('Platform fee')
    expect(html).toContain('Total paid')
    // ₹31.10 — the charge amount, formatted to 2dp, not a bare rupee value.
    expect(html).toContain('₹31.10')
  })

  it('is ABSENT for organizer-absorbs and free — today’s email is unchanged', () => {
    // buildAttendeeFeeBreakdown returns null when the attendee bore no fees, so the mailer
    // needs no knowledge of the fee model.
    expect(buildAttendeeFeeBreakdown({ ...financials, attendeeFeeTotalPaise: 0 })).toBeNull()
    const { html } = registrationTemplate(base)
    expect(html).not.toContain('Payment summary')
    expect(html).not.toContain('Total paid')
  })
})
