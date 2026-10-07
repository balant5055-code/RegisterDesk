// RD-PRICING-UI-LOCK-01 — the wizard shows a PUBLISHED event's commercial pricing as read-only.
//
// The authority is the server: POST /save-changes refuses any commercial change with 409
// (tests/emulator/publishedPricingSafety.emu.test.ts, tests/unit/pricingIntegrity.test.ts).
// These tests pin the UI half:
//   • the real Step 4 and pass editor render locked controls for `status: 'published'` and
//     fully editable ones for a draft — for more than one event type;
//   • the lock comes ONLY from the server-written lifecycle status; extra client flags neither
//     lock nor unlock it, and the draft rules still refuse client writes to `status`;
//   • the pure defence-in-depth helper restores every commercial field and nothing else.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { Step4View } from '@/components/event-builder/steps/Step4View'
import { AddPassEditor } from '@/components/wizard/AddPassEditor'
import { lockPublishedPricing, lockPassCommercialFields } from '@/lib/events/editing/publishedPricingLock'
import { findCommercialPricingChanges } from '@/lib/events/editing/pricingIntegrity'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const LOCK_NOTE = 'Ticket pricing is locked after publication'

const pass = (over: Record<string, unknown> = {}) => ({
  id: 'p1', name: '10K', code: 'TENK', description: 'Ten kilometres.', type: 'paid', price: 1500,
  earlyBirdEnabled: true, earlyBirdPrice: 1200, earlyBirdEndDate: '2099-01-01T00:00',
  unlimited: false, quantity: 500, minPurchase: 1, maxPurchase: 5, hideWhenSoldOut: false,
  salesStartDate: '', salesEndDate: '', showRemainingSeats: true, visibility: 'public', featured: false,
  benefits: ['Medal'], customBenefits: [], raceDetails: null, eventType: 'sports', eventSubtype: 'running',
  advancedSettings: { transferable: false, refundable: false, waitlist: false, groupBooking: false,
    badgePrefix: '', badgeCategory: '', couponEligible: true, taxApplicable: false },
  status: 'active', ...over,
})
const pricing = (over: Record<string, unknown> = {}, passes = [pass()]) => ({
  eventType: 'paid', feeModel: 'organizer_absorbs', estimatedRegistrations: 100, passes,
  registrationOpenDate: '', registrationEndDate: '', showRemainingSeats: true,
  whatsappEnabled: false, smsEnabled: false, certEnabled: false,
  advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] }, ...over,
})

const step4 = (initialData: Record<string, unknown>) => renderToStaticMarkup(createElement(Step4View, {
  currentStep: 3, completedValues: [], onNext: () => {}, onBack: () => {}, initialData,
}))

/** Whether the button whose visible text / aria-label contains `label` carries the DISABLED attribute
 *  (React renders it as `disabled=""`; Tailwind `disabled:` class variants do not count). */
function isDisabled(html: string, label: string): boolean {
  return /\sdisabled=""/.test(buttonAttrs(html, label))
}

/** The HTML attributes of the button whose visible text / aria-label contains `label`. */
function buttonAttrs(html: string, label: string): string {
  const i = html.indexOf(label)
  expect(i, `no "${label}" in markup`).toBeGreaterThan(-1)
  const open = html.lastIndexOf('<button', i)
  return html.slice(open, html.indexOf('>', open))
}

// ═══ 1 · the pure lock ════════════════════════════════════════════════════════
describe('lockPublishedPricing restores exactly the commercial fields', () => {
  const published = pricing()

  it('price, pass type, early bird, event type, fee model and event taxes/fees are restored', () => {
    const tampered = pricing({
      eventType: 'free', feeModel: 'attendee_pays',
      advancedSettings: { taxes: [{ rate: 18 }], fees: [], coupons: [], discounts: [] },
    }, [pass({ type: 'free', price: 0, earlyBirdEnabled: false, earlyBirdPrice: null, earlyBirdEndDate: '' })])
    const locked = lockPublishedPricing(published, tampered)
    expect(findCommercialPricingChanges(published, locked)).toEqual([])   // server would accept it
    expect(locked.passes[0]).toMatchObject({ type: 'paid', price: 1500, earlyBirdEnabled: true, earlyBirdPrice: 1200 })
  })

  it('a new ticket category is dropped and a removed one is restored', () => {
    const added = lockPublishedPricing(published, pricing({}, [pass(), pass({ id: 'p2', name: 'VIP', price: 9 })]))
    expect(added.passes.map(p => p.id)).toEqual(['p1'])
    const removed = lockPublishedPricing(published, pricing({}, []))
    expect(removed.passes.map(p => p.id)).toEqual(['p1'])
  })

  it('every NON-commercial edit survives', () => {
    const edited = pricing({ whatsappEnabled: true, certEnabled: true, registrationEndDate: '2099-12-30' }, [pass({
      name: '10K Open', description: 'Now with a medal.', benefits: ['Medal', 'Tee'], quantity: 800,
      salesEndDate: '2099-12-29', visibility: 'private', featured: true, status: 'inactive',
      advancedSettings: { ...pass().advancedSettings, transferable: true, refundable: true },
    })])
    const locked = lockPublishedPricing(published, edited)
    expect(locked).toMatchObject({ whatsappEnabled: true, certEnabled: true, registrationEndDate: '2099-12-30' })
    expect(locked.passes[0]).toMatchObject({ name: '10K Open', quantity: 800, visibility: 'private', featured: true,
      status: 'inactive', benefits: ['Medal', 'Tee'] })
    expect(locked.passes[0].advancedSettings).toMatchObject({ transferable: true, refundable: true, couponEligible: true, taxApplicable: false })
  })

  it('the pass editor’s save-time lock restores type, price and early bird — and nothing else', () => {
    const out = lockPassCommercialFields(pass(), pass({ name: 'Renamed', price: 1, type: 'free',
      advancedSettings: { ...pass().advancedSettings, transferable: true } }))
    expect(out).toMatchObject({ name: 'Renamed', price: 1500, type: 'paid' })
    expect(out.advancedSettings).toMatchObject({ transferable: true })
  })

  // RD-PRICING-UI-CLEANUP-01 — the inert flags are no longer treated as commercial, but their
  // STORED values are carried through untouched (no migration, no deletion).
  it('stored couponEligible / taxApplicable values pass through the lock unchanged', () => {
    const stored = pass({ advancedSettings: { ...pass().advancedSettings, couponEligible: true, taxApplicable: true } })
    expect(lockPassCommercialFields(stored, stored).advancedSettings).toMatchObject({ couponEligible: true, taxApplicable: true })
    const locked = lockPublishedPricing(pricing({}, [stored]), pricing({}, [stored]))
    expect(locked.passes[0].advancedSettings).toMatchObject({ couponEligible: true, taxApplicable: true })
    // …and they are not part of the server's commercial comparison either.
    const flipped = pass({ advancedSettings: { ...pass().advancedSettings, couponEligible: false, taxApplicable: false } })
    expect(findCommercialPricingChanges(pricing({}, [stored]), pricing({}, [flipped]))).toEqual([])
  })

  it('no baseline (a draft) ⇒ nothing is locked', () => {
    const next = pricing({ eventType: 'free' }, [])
    expect(lockPublishedPricing(null, next)).toBe(next)
  })
})

// ═══ 2 · Step 4 rendered: published vs draft ═════════════════════════════════
describe('Passes & Pricing — published event is read-only, draft is not', () => {
  for (const [eventTypeId, eventSubtype] of [['sports', 'running'], ['conference', 'tech'], ['workshop', 'hands_on']] as const) {
    it(`${eventTypeId}: published ⇒ free/paid, add, duplicate and delete are locked, with one explanation`, () => {
      const html = step4({ pricing: pricing(), eventTypeId, eventSubtype, status: 'published' })
      expect(html).toContain(LOCK_NOTE)
      expect(html).toMatch(/aria-disabled="true"[^>]*aria-describedby="registration-type-locked"|aria-describedby="registration-type-locked"[^>]*/)
      expect(isDisabled(html, 'Add Pass')).toBe(true)
      expect(isDisabled(html, 'Duplicate 10K')).toBe(true)
      expect(isDisabled(html, 'Delete 10K')).toBe(true)
      expect(html).not.toContain('Add another pass')
      // Ordinary controls stay usable: edit and activate/deactivate.
      expect(isDisabled(html, 'Edit 10K')).toBe(false)
      expect(isDisabled(html, 'Deactivate 10K')).toBe(false)
    })

    it(`${eventTypeId}: draft ⇒ everything stays editable, no lock note`, () => {
      const html = step4({ pricing: pricing(), eventTypeId, eventSubtype, status: 'draft' })
      expect(html).not.toContain(LOCK_NOTE)
      expect(html).not.toContain('aria-disabled="true"')
      expect(isDisabled(html, 'Add Pass')).toBe(false)
      expect(isDisabled(html, 'Duplicate 10K')).toBe(false)
      expect(isDisabled(html, 'Delete 10K')).toBe(false)
      expect(html).toContain('Add another pass')
    })
  }

  it('client flags cannot unlock a published event — only the server-written status counts', () => {
    const html = step4({ pricing: pricing(), eventTypeId: 'sports', eventSubtype: 'running', status: 'published',
      pricingLocked: false, isPublished: false, locked: false, allowPricingChange: true })
    expect(html).toContain(LOCK_NOTE)
    expect(isDisabled(html, 'Add Pass')).toBe(true)
  })

  it('…and client flags do not lock a draft either (the lock is derived, not supplied)', () => {
    const html = step4({ pricing: pricing(), eventTypeId: 'sports', eventSubtype: 'running', status: 'draft',
      pricingLocked: true, isPublished: true })
    expect(html).not.toContain(LOCK_NOTE)
  })

  it('a free published event renders locked too (no switch to paid)', () => {
    const html = step4({ pricing: pricing({ eventType: 'free' }, [pass({ type: 'free', price: 0, earlyBirdEnabled: false })]),
      eventTypeId: 'community', eventSubtype: null, status: 'published' })
    expect(html).toContain(LOCK_NOTE)
    expect(html).toContain('aria-describedby="registration-type-locked"')
  })
})

// ═══ 3 · the pass editor ═════════════════════════════════════════════════════
describe('pass editor — published pass type is locked, draft is not', () => {
  const editor = (pricingLocked: boolean) => renderToStaticMarkup(createElement(AddPassEditor, {
    isOpen: true, onClose: () => {}, onSave: () => {}, editingPass: pass() as never,
    eventTypeId: 'sports', eventSubtype: 'running', isFreeEvent: false, pricingLocked,
  }))

  it('published: the pass-type choices are disabled and explained; the name stays editable', () => {
    const html = editor(true)
    expect(html).toContain(LOCK_NOTE)
    expect(html).toContain('aria-describedby="pass-type-locked"')
    const typeButtons = html.match(/<button[^>]*aria-pressed="(true|false)"[^>]*>/g) ?? []
    expect(typeButtons.length).toBeGreaterThan(0)
    for (const b of typeButtons) expect(b).toContain('disabled')
    expect(html).not.toMatch(/<input[^>]*value="10K"[^>]*disabled/)
  })

  it('draft: the pass-type choices are selectable and there is no lock note', () => {
    const html = editor(false)
    expect(html).not.toContain(LOCK_NOTE)
    const typeButtons = html.match(/<button[^>]*aria-pressed="(true|false)"[^>]*>/g) ?? []
    for (const b of typeButtons) expect(b).not.toMatch(/\sdisabled(=|\s|>)/)
  })
})

// ═══ 4 · wiring that static render cannot reach (non-default tabs, Review) ═══
describe('source contracts', () => {
  const ED   = read('components/wizard/AddPassEditor.tsx')
  const S4   = read('components/event-builder/steps/Step4View.tsx')
  const PAGE = read('app/(dashboard)/dashboard/events/new/page.tsx')

  it('pricing tab: price, early-bird switch/price/end date are disabled when locked', () => {
    expect(ED).toContain('disabled={!isPaid || pricingLocked}')
    expect(ED).toContain('disabled={!pass.earlyBirdEnabled || !isPaid || pricingLocked}')
    expect(ED).toMatch(/label="Enable Early Bird Pricing"[\s\S]{0,120}disabled=\{pricingLocked\}/)
    expect(ED).toMatch(/onChange=\{e => onChange\(\{ earlyBirdEndDate: e\.target\.value \}\)\}\s*disabled=\{pricingLocked\}/)
  })
  it('advanced tab: the ineffective Coupon Eligible / Tax Applicable switches are gone (RD-PRICING-UI-CLEANUP-01)', () => {
    expect(ED).not.toContain('label="Coupon Eligible"')
    expect(ED).not.toContain('label="Tax Applicable"')
    expect(ED).not.toContain('updateAdv({ couponEligible')
    expect(ED).not.toContain('updateAdv({ taxApplicable')
    expect(ED).not.toContain('Apply GST or applicable taxes to this pass price')
    expect(ED).not.toContain('Allow discount codes to be applied to this pass')
    // No control is locked on this tab any more; its other settings are unchanged.
    expect(ED).toContain("{activeTab === 'advanced' && <TabAdvanced pass={pass} onChange={handleChange} />}")
    expect(ED).toContain('onChange={v => updateAdv({ transferable: v })}')
  })
  it('the editor restores the published commercial fields on save', () => {
    expect(ED).toContain('pricingLocked && editingPass ? lockPassCommercialFields(editingPass, pass) : pass')
  })
  it('Step 4 derives the lock from the lifecycle status alone and re-locks every update', () => {
    expect(S4).toContain("const pricingLocked     = initialData?.status === 'published'")
    expect(S4).toContain('return publishedPricing ? lockPublishedPricing(publishedPricing, next) : next')
    expect(S4).toContain('if (pricingLocked && !editingPass)')
  })
  it('the wizard passes the server-written status to Step 4; there is no organizer fee-model control at all', () => {
    expect(PAGE).toMatch(/const pricingInitialData = useMemo\(\(\) => \(\{[\s\S]*?status:\s+draft\?\.status \?\? null/)
    // RD-PHASE4-S3 · Q1 — SUPERSEDES RD-EVENT-COMMERCE-05E: fee collection is fixed to organizer-pays,
    // so there is no Fee Collection control to lock or to save (before OR after publishing).
    expect(PAGE).not.toContain('locked={isAlreadyPublished}')
    expect(PAGE).not.toContain('saveLiveFeeModel')
    expect(PAGE).not.toContain('<FeeCollectionCard')
  })
  it('the draft rules still refuse client writes to the lifecycle status the lock depends on', () => {
    const rules = read('firestore.rules')
    const drafts = rules.slice(rules.indexOf('match /eventDrafts/{draftId}'), rules.indexOf('match /campaignDrafts/{draftId}'))
    // RD-CE-FIX M2 — an ALLOW-list: updates may touch only draftWizardKeys(), which excludes every
    // lifecycle/status stamp; creation must start as an unpublished 'draft'.
    expect(drafts).toContain('.affectedKeys().hasOnly(draftWizardKeys())')
    expect(drafts).toContain("request.resource.data.status == 'draft'")
    const keys = rules.slice(rules.indexOf('function draftWizardKeys()'), rules.indexOf('function draftSlugOf('))
    for (const k of ['status', 'lifecycleStatus', 'publishedAt', 'completedAt', 'restoredAt', 'reviewStatus']) expect(keys).not.toContain(`'${k}'`)
  })
  it('the server-side protection is untouched', () => {
    expect(read('app/api/organizer/events/[eventId]/save-changes/route.ts'))
      .toContain('findCommercialPricingChanges(live.pricing, dn.pricing, { ignoreFeeModel: true })')
  })
})
