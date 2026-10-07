// RD-EVENT-COMMERCE-05E — Fee Collection Method editable after publishing (future checkouts only),
// locked-by-default purchase quantities with ONE Unlock / ONE Cancel, and ONE footer action.
// Server behaviour through the real routes: tests/emulator/eventCommerce05e.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/firebase/auth', () => ({ auth: { currentUser: null } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }), usePathname: () => '/dashboard/events/new' }))

import { buildEventEditUpdate, extractEditableSnapshot, FEE_MODELS } from '@/lib/events/editing/applyEdit'
import { classifyEditKey, findForbiddenEditKeys } from '@/lib/events/editing/fieldClassification'
import { findCommercialPricingChanges } from '@/lib/events/editing/pricingIntegrity'
import { openAttemptFeeModel, INTENT_REUSE_WINDOW_MS } from '@/lib/registrations/paymentAttempt'
import { submittedPurchaseFooter, PurchasedPanel, LicenseServicesStep } from '@/components/wizard/LicenseServicesStep'
import { EMPTY_SELECTION } from '@/lib/licensing/serviceAllowances'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const PAGE  = read('app/(dashboard)/dashboard/events/new/page.tsx')
const STEP7 = PAGE.slice(PAGE.indexOf('function Step7View('), PAGE.indexOf('// --- Campaign Publish Success'))
const LSS   = read('components/wizard/LicenseServicesStep.tsx')
const PANEL = read('components/wizard/ActivationPaymentPanel.tsx')
const EDIT  = read('app/api/organizer/events/[eventId]/edit/route.ts')
const SAVE  = read('app/api/organizer/events/[eventId]/save-changes/route.ts')
const ORDER = read('app/api/registrations/create-order/route.ts')
const SWEEP = read('lib/payments/registrationReconciliation.ts')

// ═══ 1 · Fee Collection Method: the ONE post-publish pricing exception ═════════════════════
describe('Fee Collection Method is organizer-editable after publishing — and only it', () => {
  const draft = { pricing: { feeModel: 'organizer_absorbs', passes: [{ id: 'p1', name: '10K', price: 500 }] } }

  // RD-PHASE4-S3 · Q1 — SUPERSEDED: fee collection is fixed to organizer-pays and organizers no longer
  // choose it, so `feeModel` is no longer a safe edit key and the mapper refuses it outright.
  it('is NOT an editable key any more; prices, free/paid and licence fields stay forbidden too', () => {
    expect(classifyEditKey('feeModel')).not.toBe('safe')
    expect(findForbiddenEditKeys(['feeModel'])).toEqual(['feeModel'])
    expect(findForbiddenEditKeys(['feeModel', 'price', 'passPrices', 'pricingModel', 'licenseTier']).sort())
      .toEqual(['feeModel', 'licenseTier', 'passPrices', 'price', 'pricingModel'])
  })
  it('the mapper never writes pricing.feeModel — any feeModel in a payload is refused', () => {
    for (const v of ['attendee_pays', 'organizer_absorbs']) {
      expect(() => buildEventEditUpdate({ feeModel: v as never }, draft, {})).toThrow(RangeError)
    }
  })
  it('only the two EXISTING options are accepted, meanings unchanged', () => {
    expect([...FEE_MODELS]).toEqual(['organizer_absorbs', 'attendee_pays'])
    for (const bad of ['customer_pays', 'organizer_pays', '', null, 7]) {
      expect(() => buildEventEditUpdate({ feeModel: bad as never }, draft, {})).toThrow(RangeError)
    }
  })
  it('the edit-history "before" holds the stored value, and invents none for a legacy event', () => {
    expect(extractEditableSnapshot(draft).feeModel).toBe('organizer_absorbs')
    expect('feeModel' in extractEditableSnapshot({ pricing: { passes: [] } })).toBe(false)
  })
  it('Save Changes ignores ONLY the fee model; every other commercial change is still refused', () => {
    const live = { eventType: 'paid', feeModel: 'organizer_absorbs', passes: [{ id: 'p1', type: 'paid', price: 500 }] }
    const feeOnly = { ...live, feeModel: 'attendee_pays' }
    expect(findCommercialPricingChanges(live, feeOnly)).toEqual(['fee model'])              // default unchanged
    expect(findCommercialPricingChanges(live, feeOnly, { ignoreFeeModel: true })).toEqual([])
    const priced = { ...feeOnly, passes: [{ id: 'p1', type: 'paid', price: 900 }] }
    expect(findCommercialPricingChanges(live, priced, { ignoreFeeModel: true })).toEqual(['ticket "p1" price'])
  })
  it('the edit route REFUSES feeModel (403 PRICING_NOT_ORGANIZER_EDITABLE); nothing fee-related is written live', () => {
    expect(EDIT).toContain("const authz = await authorizeWorkspace(req, 'events')")
    expect(EDIT).toContain("if (Object.prototype.hasOwnProperty.call(body, 'feeModel')) {")
    expect(EDIT).toContain("code: 'PRICING_NOT_ORGANIZER_EDITABLE'")
    expect(EDIT).not.toContain('isPendingFeeChange')
    expect(EDIT).not.toContain("'pricing.feeModel'")
    // no order, payment or lifecycle field is ever written by this route
    expect(EDIT).not.toMatch(/licenseOrders|lifecycleStatus:|publishedAt:/)
  })
  it('save-changes keeps the LIVE fee model (never copies the draft’s)', () => {
    expect(SAVE).toContain('findCommercialPricingChanges(live.pricing, dn.pricing, { ignoreFeeModel: true })')
    expect(SAVE).toContain("nextPricing = livePricing && 'feeModel' in livePricing ? { ...rest, feeModel: livePricing.feeModel } : rest")
  })
})

// ═══ 2 · Future checkouts only ═══════════════════════════════════════════════════════════
describe('an in-progress checkout keeps the fee terms it started with', () => {
  const now = 1_000_000_000
  const open = {
    status: 'created' as const, amount: 51_475, passId: 'p1', attendeeEmail: 'A@x.com',
    createdAtMs: now - 60_000, feeModel: 'organizer_pays' as const,
  }
  const req = { passId: 'p1', attendeeEmail: 'a@x.com', nowMs: now }

  it('an OPEN attempt is re-priced with its own snapshot, not the event’s new setting', () => {
    expect(openAttemptFeeModel(open, req)).toBe('organizer_pays')
    expect(openAttemptFeeModel({ ...open, feeModel: 'customer_pays' }, req)).toBe('customer_pays')
  })
  it('anything that is not the same open attempt uses the event’s CURRENT setting (null)', () => {
    expect(openAttemptFeeModel(null, req)).toBeNull()
    expect(openAttemptFeeModel({ ...open, feeModel: null }, req)).toBeNull()                 // engine off / legacy
    expect(openAttemptFeeModel({ ...open, status: 'paid', registrationId: 'r1' }, req)).toBeNull()
    expect(openAttemptFeeModel({ ...open, status: 'failed' }, req)).toBeNull()
    expect(openAttemptFeeModel({ ...open, refundId: 'rf_1' }, req)).toBeNull()
    expect(openAttemptFeeModel(open, { ...req, passId: 'p2' })).toBeNull()
    expect(openAttemptFeeModel(open, { ...req, attendeeEmail: 'b@x.com' })).toBeNull()
    expect(openAttemptFeeModel({ ...open, createdAtMs: now - INTENT_REUSE_WINDOW_MS - 1 }, req)).toBeNull()
  })
  it('create-order prefers the pinned model; settlement and the ledger sweep read the INTENT snapshot', () => {
    expect(ORDER).toContain('eventFeeModel: pinnedFeeModel ?? builderFeeModelToEngine(')
    expect(ORDER).toContain('feeModel: priorIntent.financials?.feeModel ?? null')
    expect(SWEEP).toContain('financials:       intent.financials,')
    expect(read('lib/payments/settleCapturedRegistration.ts')).toContain('financials:       intent.financials,')
  })
})

// ═══ 3 · Fee Collection Method UI ══════════════════════════════════════════════════════
describe('Fee Collection Method UI: License & Services only, saved on the server when submitted', () => {
  // RD-PHASE4-S3 · Q1 — SUPERSEDED: the Fee Collection card is removed (fee collection is fixed to
  // organizer-pays). A submitted event's License & Services still goes through the same final view.
  it('no Fee Collection card anywhere; a submitted event still uses the same final view', () => {
    expect(PAGE).not.toContain('<FeeCollectionCard')
    // a submitted event's License & Services goes through the same final view
    const lic = PAGE.slice(PAGE.indexOf('{currentStep === licenseStepIndex && (isSubmittedDraftStatus(draftStatus) ? ('))
    const submitted = lic.slice(0, lic.indexOf(') : ('))
    expect(submitted).toContain('phase="final"')
    expect(submitted).toContain('onServerSaved={markPublished}')
    expect(submitted).toContain('onSaveDraft={data => saveDraft(reviewStepIndex, data)}')
  })
  it('the wizard never sends a fee model — no draft save of it, no PATCH /edit { feeModel }', () => {
    expect(PAGE).not.toContain('JSON.stringify({ feeModel')
    expect(PAGE).not.toContain('saveLiveFeeModel')
    expect(PAGE).not.toContain('savePricingChanges')
  })
  it('none of the old fee save state or its status copy remains', () => {
    for (const gone of ['feeSaveState', 'feeNotSaved', 'feeSaveInFlight', 'FeeChangeNote']) {
      expect(PAGE, gone).not.toContain(gone)
    }
  })
})

// ═══ 4 · Purchases: locked by default, ONE unlock, ONE cancel ════════════════════════════
describe('a submitted event’s purchase quantities', () => {
  it('start LOCKED; the one unlock reveals capacity AND every service quantity together', () => {
    expect(LSS).toContain('const [editing, setEditing] = useState(false)')
    expect(LSS).toContain('const locked = isSubmitted && !editing')
    expect(LSS).toContain('{!locked && <section aria-labelledby="license-capacity-heading">')
    expect(LSS).toContain('open={payg.whatsappEnabled && !locked}')
    expect(LSS).toContain('open={payg.certEnabled && !locked}')
    expect(LSS).toContain('open={mediaOpen && !locked}')
    expect((LSS.match(/'Unlock to edit'/g) ?? []).length).toBe(1)            // no per-service unlocks
  })
  it('Cancel discards ONLY the pending selection and re-locks — no request, no write', () => {
    const fn = LSS.slice(LSS.indexOf('const cancelEditing'), LSS.indexOf('}, [current])') + 14)
    expect(fn).toContain('setSelection({ ...EMPTY_SELECTION })')
    expect(fn).toContain('setTarget(current)')
    expect(fn).toContain('setEditing(false)')
    expect(fn).not.toMatch(/fetch|onServicesChange|onSelectCapacity|onServiceSelectionChange|onSaveDraft/)
    expect((LSS.match(/label: 'Cancel'/g) ?? []).length).toBe(1)
  })
  it('the selection survives a failed / cancelled / unverified payment; only a VERIFIED one clears it', () => {
    expect(LSS).toContain('const onSettled = useCallback(() => { setRefreshKey(k => k + 1) }, [])')
    const pay = LSS.slice(LSS.indexOf('const payPurchase'), LSS.indexOf('const payViaPanel'))
    expect(pay).toMatch(/if \(outcome === 'paid'\) \{\s*setSelection\(\{ \.\.\.EMPTY_SELECTION \}\)\s*setEditing\(false\)/)
    expect(pay).toContain('if (purchaseInFlight.current || !payRef.current) return')   // no double payment
  })
  it('a grant seen on refresh (e.g. a payment verified later) spends the pending selection', () => {
    expect(LSS).toContain('if (lastGrantKey !== null) { setSelection({ ...EMPTY_SELECTION }); setEditing(false) }')
  })
  it('the payment panel has NO pay button here — the footer owns it; status + history stay', () => {
    expect(LSS).toContain('hidePayButton={!!embeddedFinal || isSubmitted}')
    expect(LSS).toContain('onRegisterPay={embeddedFinal || isSubmitted ? registerPay : undefined}')
    expect(PANEL).toContain('Refresh status')
    expect(PANEL).toContain('Purchase history (')
  })
  it('the live banner’s Buy uses the same single unlock (keeps any selection)', () => {
    expect(LSS).toContain('onClick={unlockAndFocus}')
  })
})

describe('submittedPurchaseFooter — exactly ONE primary action per state', () => {
  const base = { locked: false, paying: false, quoting: false, quoteReady: true, payableKind: null, payablePaise: null, blocked: false, eligible: true } as const
  it('locked → Unlock to edit (Done secondary, never a pay action)', () => {
    expect(submittedPurchaseFooter({ ...base, locked: true })).toMatchObject({ primary: 'unlock', label: 'Unlock to edit', disabled: false, secondary: 'done' })
    expect(submittedPurchaseFooter({ ...base, locked: true, eligible: false }).disabled).toBe(true)
  })
  it('unlocked + payable → Pay ₹{server amount} via Razorpay, with Cancel', () => {
    const f = submittedPurchaseFooter({ ...base, payableKind: 'capacity_change', payablePaise: 177_000 })
    expect(f).toMatchObject({ primary: 'pay', secondary: 'cancel', disabled: false })
    expect(f.label).toMatch(/^Pay ₹1,770(\.00)? via Razorpay$/)
    expect(submittedPurchaseFooter({ ...base, payableKind: 'addon', payablePaise: 11_800, blocked: true }).disabled).toBe(true)
  })
  it('unlocked, nothing due → Done (no order); a no-charge capacity change → Apply, never ₹0 Razorpay', () => {
    expect(submittedPurchaseFooter({ ...base, payableKind: 'covered', payablePaise: 0 })).toMatchObject({ primary: 'done', label: 'Done', secondary: 'cancel' })
    expect(submittedPurchaseFooter({ ...base, payableKind: 'capacity_change', payablePaise: 0 })).toMatchObject({ primary: 'apply', label: 'Apply capacity change' })
  })
  it('paying → disabled, Cancel disabled too; quoting → disabled', () => {
    expect(submittedPurchaseFooter({ ...base, paying: true, payableKind: 'addon', payablePaise: 100 })).toMatchObject({ primary: 'processing', disabled: true, secondaryDisabled: true })
    expect(submittedPurchaseFooter({ ...base, quoteReady: false, quoting: true })).toMatchObject({ primary: 'waiting', label: 'Calculating…', disabled: true })
  })
  it('the draft (new-event) footer is unchanged: Pay & Publish Event / Publish Event', () => {
    expect(STEP7).toContain("nextLabel={payCtx && !payCtx.covered ? 'Pay & Publish Event' : 'Publish Event'}")   // RD-CE-FIX M1
    expect(STEP7).toContain("nextLabel={isAlreadyPublished ? (saveChangesState === 'saving' ? 'Saving…' : 'Save Changes') : 'Continue'}")
  })
})

// ═══ 5 · Rendered output ══════════════════════════════════════════════════════════════
describe('rendered: the locked panel shows ACTUAL figures, unknown as unavailable', () => {
  const coverage = {
    activationPaid: true, paidCapacity: 1_000,
    purchased: { whatsapp: 500, certificates: 200, media: 50 },
    consumed:  { whatsapp: 120, certificates: 0, media: 0 },
    remaining: { whatsapp: 380, certificates: 200, media: 50 },
  }
  it('locked: lock + "Locked", purchased / used / remaining from the server records', () => {
    const html = renderToStaticMarkup(createElement(PurchasedPanel, {
      editing: false, capacity: { total: 1_000, used: 430 }, coverage, media: { purchased: 50, base: 0, used: 20 }, unavailable: false,
    }))
    expect(html).toContain('Locked')
    expect(html).not.toContain('Editing additional capacity and services')
    // RD-PHOTO-01 — photos: paid capacity 50, used 20 ⇒ 30 remaining (no free base).
    for (const v of ['1,000', '430', '570', '120', '380', '200', '50', '20', '30']) expect(html).toContain(`>${v}<`)
    expect(html).toContain('Photo capacity')
    expect(html).toContain('maximum 3,000 per event')
    expect(html).not.toContain('Photo limit')
  })
  it('editing: the indicator replaces Locked; the figures stay the ACTUAL ones', () => {
    const html = renderToStaticMarkup(createElement(PurchasedPanel, {
      editing: true, capacity: { total: 1_000, used: 430 }, coverage, media: { purchased: 50, base: 0, used: 20 }, unavailable: false,
    }))
    expect(html).toContain('Editing additional capacity and services')
    expect(html).toContain('>1,000<')
  })
  it('nothing known → "—", never a guessed number', () => {
    const html = renderToStaticMarkup(createElement(PurchasedPanel, {
      editing: false, capacity: null, coverage: null, media: { purchased: null, base: null, used: null }, unavailable: true,
    }))
    expect((html.match(/aria-label="unavailable"/g) ?? []).length).toBe(12)
    expect(html).toContain('couldn’t be loaded')
  })
  it('the whole step, submitted: starts locked — no capacity or quantity controls, banner once', () => {
    const html = renderToStaticMarkup(createElement(LicenseServicesStep, {
      currentStep: 7, completedValues: [], onNext: () => undefined, onBack: () => undefined,
      steps: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `Step ${i}` })) as never,
      selectedCapacity: 100, onSelectCapacity: () => undefined,
      initialServiceSelection: { ...EMPTY_SELECTION }, onServiceSelectionChange: () => undefined,
      pricing: { whatsappEnabled: true, certEnabled: true }, onServicesChange: () => undefined,
      draftStatus: 'published', draftId: 'draftA', liveStatus: { publicHref: '/events/slug-a' },
    }))
    expect(html).toContain('Purchased capacity &amp; services')
    expect(html).toContain('Locked')
    expect(html).not.toContain('id="capacity-input"')
    expect(html).not.toContain('Prepaid WhatsApp messages')
    expect(html).not.toContain('Prepaid certificates')
    expect((html.match(/Event is Live/g) ?? []).length).toBe(1)
    expect(html).not.toMatch(/Pay ₹[^<]* via Razorpay/)                        // no panel pay button
  })
  it('the whole step, draft: unchanged — quantity controls present, no locked panel, no banner', () => {
    const html = renderToStaticMarkup(createElement(LicenseServicesStep, {
      currentStep: 7, completedValues: [], onNext: () => undefined, onBack: () => undefined,
      steps: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `Step ${i}` })) as never,
      selectedCapacity: 100, onSelectCapacity: () => undefined,
      initialServiceSelection: { ...EMPTY_SELECTION }, onServiceSelectionChange: () => undefined,
      pricing: { whatsappEnabled: true }, onServicesChange: () => undefined,
      draftStatus: 'draft', draftId: 'draftA', embeddedFinal: { onContext: () => undefined },
    }))
    expect(html).toContain('id="capacity-input"')
    expect(html).toContain('Prepaid WhatsApp messages')
    expect(html).not.toContain('Purchased capacity &amp; services')
    expect(html).not.toContain('Event is Live')
  })
})
