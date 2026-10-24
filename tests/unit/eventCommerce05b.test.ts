// RD-EVENT-COMMERCE-05B — wizard order (Review → License & Services LAST), Review = information
// only, and "Pay & Submit Event" on the final step. Server guarantees (no submission before a
// verified payment, exactly-once, retry without re-charge) are in serviceAllowances.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stepsFor, indexOfStep, wizardStepsFor } from '@/lib/events/builder/stepRegistry'
import { WIZARD_STEPS } from '@/lib/events/builder/constants'

const read = (p: string) => readFileSync(p, 'utf8')
const PAGE  = read('app/(dashboard)/dashboard/events/new/page.tsx').replace(/\r\n/g, '\n')
const STEP7 = PAGE.slice(PAGE.indexOf('function Step7View('), PAGE.indexOf('// --- Campaign Publish Success'))
const PANEL = read('components/wizard/ActivationPaymentPanel.tsx')
const LSS   = read('components/wizard/LicenseServicesStep.tsx')

describe('the exact eight-step order', () => {
  it('Event Type → Visibility → Access Control → Passes & Pricing → Form → Details → Review → License & Services', () => {
    const names = ['Event Type', 'Visibility', 'Access Control', 'Passes & Pricing', 'Form', 'Details', 'Review', 'License & Services']
    expect(wizardStepsFor('standard').map(s => s.name)).toEqual(names)
    expect(WIZARD_STEPS.map(s => s.name)).toEqual(names)                 // the stepper's constant agrees
    expect(indexOfStep('standard', 'license')).toBe(stepsFor('standard').length - 1)   // LAST
    expect(indexOfStep('standard', 'review')).toBe(indexOfStep('standard', 'license') - 1)
  })
  it('fundraising keeps its extra step and the same ending', () => {
    expect(wizardStepsFor('fundraising').map(s => s.name).slice(-3)).toEqual(['Fundraising', 'Review', 'License & Services'])
    expect(PAGE).toMatch(/\{ name: 'Fundraising' \},[\s\S]{0,160}\{ name: 'Review' \},\s*\{ name: 'License & Services' \},/)
  })
  it('the page mounts Review and License & Services by step ID, not by number', () => {
    expect(PAGE).toContain("const reviewStepIndex  = indexOfStep(wizardFlow, 'review')")
    expect(PAGE).toContain("const licenseStepIndex = indexOfStep(wizardFlow, 'license')")
    expect(PAGE).toContain('{currentStep === reviewStepIndex && (')
    expect(PAGE).toContain('{currentStep === licenseStepIndex && (isSubmittedDraftStatus(draftStatus) ? (')
    expect(PAGE).not.toMatch(/currentStep === [678] && [!]?isEventPlusDonation && \(\s*<(LicenseStepView|Step7View)/)
  })
})

describe('Review shows the event information only', () => {
  it('continues to License & Services; takes no money, creates no order, submits nothing', () => {
    // RD-EVENT-COMMERCE-05C — a NEW event's Review says "Continue"; only an already-PUBLISHED event
    // (opened via "Edit event" on the same route) keeps its legitimate "Save Changes".
    expect(STEP7).toContain("nextLabel={isAlreadyPublished ? (saveChangesState === 'saving' ? 'Saving…' : 'Save Changes') : 'Continue'}")   // 05D: pending label
    expect(STEP7).toContain("onNext={isAlreadyPublished ? handleSaveChanges : () => onNext('Reviewed')}")
    // The agreement, the wallet gate and the final action exist ONLY in the final phase.
    expect(STEP7).toContain("{phase === 'final' && !isSubmitted && <div id=\"publish-agreement\"")   // 05F: anchored for scroll-into-view
    // RD-COMMS-P1 — an advisory WhatsApp-capacity hint (no communication-balance top-up), never a gate.
    expect(STEP7).toContain("{phase === 'final' && needsWhatsappCapacity && (")
    expect(STEP7).not.toContain('/api/organizer/wallet/topup')
    // No purchase / confirm route, no payment panel, no second License & Services interface.
    for (const banned of ['/api/licensing/purchase', '/api/licensing/checkout/confirm', '<ActivationPaymentPanel', '<LicenseServicesStep']) {
      expect(STEP7, banned).not.toContain(banned)
    }
    // …and no tier / upgrade choice.
    expect(STEP7).not.toMatch(/Upgrade to|Select tier|Starter|Professional plan/)
  })
  it('the Review-side activation check and its "Payment outstanding" box are gone', () => {
    expect(STEP7).not.toContain('Payment outstanding')
    expect(STEP7).not.toContain('setReviewQuote')
  })
})

describe('License & Services is the final step: Pay & Submit Event / Submit Event', () => {
  it('the final action is labelled by the SERVER quote (RD-EVENT-COMMERCE-05C: Pay & Publish Event / Publish Event)', () => {
    // RD-CE-FIX M1 — no "Add Funds" in place of publishing.
    expect(STEP7).toContain("nextLabel={payCtx && !payCtx.covered ? 'Pay & Publish Event' : 'Publish Event'}")
    expect(STEP7).not.toMatch(/'Pay & Submit Event'|'Submit Event'\}/)
  })
  it('payment first; only a VERIFIED payment continues; cancel / failure / pending stop without submitting', () => {
    const publish = STEP7.slice(STEP7.indexOf('const confirmPublishOnce'), STEP7.indexOf('const [topupLoading'))
    const pay = publish.indexOf('await payCtx.pay(publishAgreement)'), post = publish.indexOf("'/api/events/publish'")
    expect(pay).toBeGreaterThan(-1); expect(pay).toBeLessThan(post)
    expect(publish).toMatch(/if \(outcome !== 'paid'\) \{[\s\S]*?return\s*\}/)
    expect(publish).toContain("outcome === 'cancelled' ? 'Payment cancelled — you were not charged and your event was not submitted.")
    expect(publish).toContain("outcome === 'pending' ? 'Your payment is still being verified, so the event has not been submitted yet.")
  })
  it('a verified payment + failed submission is recoverable, never a second charge', () => {
    expect(STEP7).toContain('Payment verified — but the event could not be submitted yet')
    expect(STEP7).toContain('you will not be charged again')
    expect(STEP7).toMatch(/if \(finalInFlight\.current\) return/)          // no double payment start
  })
  it('the payment panel reports "paid" ONLY from the server’s verification, never the Razorpay callback', () => {
    expect(PANEL).toContain("const verified = res.ok && json.success === true")
    expect(PANEL).toContain("finish(verified ? 'paid' : 'failed')")
    expect(PANEL).toContain("handler:     (resp: RazorpayResponse) => { void confirm(orderId, resp, via) }")
    expect(PANEL).toContain("release(); void refreshStatus(); finish('cancelled')")
    // one attempt at a time
    expect(PANEL).toContain("if (outcomeRef.current) { resolve('busy'); return }")
  })
  it('embedded License & Services hides its own footer and pay button (one action on the page)', () => {
    expect(LSS).toContain(') : !embeddedFinal && (')
    // RD-EVENT-COMMERCE-05E — a submitted event's panel has no pay button either (footer owns it).
    expect(LSS).toContain('hidePayButton={!!embeddedFinal || isSubmitted}')
  })
})

describe('published events are unchanged: buy more on License & Services, no submission', () => {
  it('a submitted draft buys more on License & Services — no submission, its OWN footer', () => {
    // RD-EVENT-COMMERCE-05E — rendered through the final view (one Fee Collection render site),
    // but Step7View renders NO footer for it and nothing that submits.
    const block = PAGE.slice(PAGE.indexOf('{currentStep === licenseStepIndex && (isSubmittedDraftStatus(draftStatus) ? ('))
    const submitted = block.slice(0, block.indexOf(') : ('))
    expect(submitted).toContain('<LicenseStepView')
    expect(submitted).not.toContain('embeddedFinal')
    expect(PAGE).toContain(') : isSubmitted ? null /* RD-EVENT-COMMERCE-05E')
    expect(LSS).toContain('nextLabel={submittedFooter.label}')
  })
})

// ═══ RD-EVENT-COMMERCE-05C · Fee Collection Method lives ONLY on License & Services ═══════════
describe('Fee Collection Method: License & Services only, one source of truth, saved to pricing', () => {
  // RD-PHASE4-S3 · Q1 — the Fee Collection Method is REMOVED from the organizer wizard (fee collection is
  // fixed to organizer-pays). What these pinned — one paid-only render site on the final step and the
  // local state + draft save — is replaced by: no selector anywhere, a fixed model, and the informational
  // Easy Split notice keeping the card's old place (paid events, final step).
  it('is no longer rendered anywhere; the Easy Split notice keeps its place (final phase, paid events only)', () => {
    expect(STEP7).not.toContain('<FeeCollectionCard')
    expect(STEP7).toContain("{phase === 'final' && !isFreeEvent && <EasySplitNotice />}")
    expect((STEP7.match(/<EasySplitNotice \/>/g) ?? []).length).toBe(1)
  })
  // RD-FEE-RESTORE-01 — the fee model is organizer-selectable again behind pricingEngineEnabled,
  // so "no organizer state" is no longer the property to hold. What still must hold, and is now
  // asserted: with the engine OFF the model is the fixed supported one, and the old ad-hoc save
  // paths this case was really guarding against have NOT come back — persistence goes through
  // the draft, exactly as every other Step-7 value does.
  it('the fee model is organizer state ONLY behind the flag; no ad-hoc save paths return', () => {
    expect(STEP7).toContain('!pricingEngineOn ? SUPPORTED_FEE_MODEL : (recordedFeeModel ?? DEFAULT_FEE_MODEL_WHEN_ENABLED)')
    expect(STEP7).toContain('setLocalFeeModel')
    // The two bespoke savers that used to exist alongside the draft write stay gone.
    expect(STEP7).not.toContain('saveLiveFeeModel')
    expect(STEP7).not.toContain('savePricingChanges')
  })
  it('on License & Services the save is routed to the PRICING key — never licenseTier', () => {
    const finalBlock = PAGE.slice(PAGE.indexOf('phase="final"'), PAGE.indexOf('renderLicense={onContext =>'))
    expect(finalBlock).toContain('onSaveDraft={data => saveDraft(reviewStepIndex, data)}')
    expect(finalBlock).not.toContain('onSaveDraft={handleSaveDraft}')
  })
  // RD-FEE-RESTORE-01 — replaces "no fee-collection control exists". One exists again. What this
  // case now pins is the shape the original decision cared about: exactly ONE control, in the
  // one place (final phase, paid events), and the Easy Split notice still beside it rather than
  // replaced by it.
  it('exactly ONE fee-collection control exists, in the final phase for paid events', () => {
    expect((PAGE.match(/<FeeCollectionSection/g) ?? []).length).toBe(1)
    expect((PAGE.match(/function FeeCollectionSection/g) ?? []).length).toBe(1)
    // The card wrapper that used to double as a second entry point stays gone.
    expect(PAGE).not.toMatch(/<FeeCollectionCard|function FeeCollectionCard/)
    expect(PAGE).toContain("phase === 'final' && !isFreeEvent && pricingEngineOn && feeSamplePrice !== null")
  })
})
