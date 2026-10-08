// RD-EVENT-COMMERCE-05F — the organizer's Publish Agreement on License & Services: the existing
// wording, real links to the existing documents, unchecked by default, and enforced on the SERVER
// (draft purchase route before any order; publish route before any write). Server behaviour on
// real Firestore: tests/emulator/serviceAllowances.emu.test.ts (the "05F ·" cases).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  checkPublishAgreement, isPaidEventPricing, PUBLISH_AGREEMENT_DOCUMENTS, PUBLISH_AGREEMENT_ITEMS,
} from '@/lib/legal/organizerAgreement'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const PAGE    = read('app/(dashboard)/dashboard/events/new/page.tsx')
const STEP7   = PAGE.slice(PAGE.indexOf('function Step7View('), PAGE.indexOf('// --- Campaign Publish Success'))
const LSS     = read('components/wizard/LicenseServicesStep.tsx')
const PANEL   = read('components/wizard/ActivationPaymentPanel.tsx')
const PUBLISH = read('app/api/events/publish/route.ts')
const BUY     = read('app/api/licensing/purchase/route.ts')
const PUB_BUY = read('app/api/licensing/published/purchase/route.ts')
const AGREEMENT_CARD = STEP7.slice(STEP7.indexOf('{/* 4. PUBLISH AGREEMENT'), STEP7.indexOf("{(publishState === 'publishing'"))

const ALL = { accurateInformation: true, settlementFeePolicy: true, termsOfService: true, privacyPolicy: true }

describe('the server-side check (pure)', () => {
  it('a paid event needs all four items as literal `true`', () => {
    expect(checkPublishAgreement(ALL, { paidEvent: true })).toEqual({ ok: true, items: ALL })
    expect(checkPublishAgreement({ ...ALL, settlementFeePolicy: undefined }, { paidEvent: true }))
      .toEqual({ ok: false, missing: ['settlementFeePolicy'] })
  })
  it('a free event needs three; the fee-policy item is neither required nor recorded', () => {
    const three = { accurateInformation: true, termsOfService: true, privacyPolicy: true }
    expect(checkPublishAgreement(three, { paidEvent: false })).toEqual({ ok: true, items: three })
    expect(checkPublishAgreement(ALL, { paidEvent: false })).toEqual({ ok: true, items: three })
  })
  it('missing, malformed or forged consent never passes', () => {
    for (const bad of [undefined, null, {}, 'true', true, [true, true, true, true],
      { ...ALL, termsOfService: 'true' }, { ...ALL, privacyPolicy: 1 }, { ...ALL, accurateInformation: false }]) {
      expect(checkPublishAgreement(bad, { paidEvent: true }).ok, JSON.stringify(bad)).toBe(false)
    }
  })
  it('paid/free is decided exactly as the wizard decides it (eventType === "free")', () => {
    expect(isPaidEventPricing({ eventType: 'free' })).toBe(false)
    expect(isPaidEventPricing({ eventType: 'paid' })).toBe(true)
    expect(isPaidEventPricing(null)).toBe(true)                                   // fail closed: require the fee item
    expect([...PUBLISH_AGREEMENT_ITEMS]).toEqual(['accurateInformation', 'settlementFeePolicy', 'termsOfService', 'privacyPolicy'])
  })
})

describe('the agreement on License & Services (new events only)', () => {
  it('is rendered on the FINAL step for unsubmitted events — never on Review, never twice', () => {
    expect(STEP7).toContain("{phase === 'final' && !isSubmitted && <div id=\"publish-agreement\"")
    expect((PAGE.match(/Publish Agreement<\/p>/g) ?? []).length).toBe(1)
    const review = STEP7.slice(STEP7.indexOf("{phase === 'review' && <>"), STEP7.indexOf('{/* RD-EVENT-COMMERCE-05B — final step: blockers'))
    expect(review).not.toMatch(/Terms of Service|Privacy Policy|Publish Agreement/)
  })
  // RD-PHASE4-S3 — the Fee Collection card was removed; the Easy Split notice keeps its place.
  it('sits after License & Services (capacity, services, quote, payment) and the Easy Split notice', () => {
    expect(STEP7.indexOf("{phase === 'final' && renderLicense?.(setPayCtx)}")).toBeLessThan(STEP7.indexOf('<EasySplitNotice />'))
    expect(STEP7.indexOf('<EasySplitNotice />')).toBeLessThan(STEP7.indexOf('{/* 4. PUBLISH AGREEMENT'))
  })
  it('keeps the EXISTING wording; the two documents are now real links to the existing pages', () => {
    for (const s of ['Event information is accurate and complete.', 'settlement timelines and fee policy', 'I agree to RegisterDesk ', 'Terms of Service</a>.', 'Privacy Policy</a>.']) {
      expect(AGREEMENT_CARD, s).toContain(s)
    }
    expect(AGREEMENT_CARD).toContain('href={PUBLISH_AGREEMENT_DOCUMENTS.termsOfService} target="_blank" rel="noopener noreferrer"')
    expect(AGREEMENT_CARD).toContain('href={PUBLISH_AGREEMENT_DOCUMENTS.privacyPolicy} target="_blank" rel="noopener noreferrer"')
    expect(PUBLISH_AGREEMENT_DOCUMENTS).toEqual({ termsOfService: '/terms', privacyPolicy: '/privacy' })
    expect(read('app/terms/page.tsx')).toContain('title="Terms of Service"')
    expect(read('app/privacy/page.tsx')).toContain('title="Privacy Policy"')
  })
  it('every item is an accessible, named checkbox; none is pre-checked', () => {
    expect((AGREEMENT_CARD.match(/role="checkbox"/g) ?? []).length).toBe(4)
    expect(AGREEMENT_CARD).toContain('aria-labelledby="terms-tos-label"')
    expect(AGREEMENT_CARD).toContain('aria-labelledby="terms-privacy-label"')
    expect(AGREEMENT_CARD).toContain('aria-labelledby="terms-fees-label"')
    expect(STEP7).toContain('const [termInfo,        setTermInfo]        = useState(false)')
    expect(STEP7).toContain('const [feesAcceptedAt,  setFeesAcceptedAt]  = useState<string | null>(null)')
    expect(STEP7).toContain('const [consentFeeModel,   setConsentFeeModel]   = useState(false)')
    expect(STEP7).toContain('const [consentTimeline,   setConsentTimeline]   = useState(false)')
    // no nested interactive elements: the links sit in the label, not inside the checkbox button
    for (const m of AGREEMENT_CARD.matchAll(/<button type="button" onClick=\{\(\) => setConsent\w+\(v => !v\)\}[\s\S]*?<\/button>/g)) {
      expect(m[0]).not.toContain('<a ')
    }
  })
  it('explains what to do while anything is unticked', () => {
    expect(AGREEMENT_CARD).toContain('{!allTermsAccepted && (')
    expect(AGREEMENT_CARD).toContain("Required — tick every item below to enable “{payCtx && !payCtx.covered ? 'Pay & Publish Event' : 'Publish Event'}”.")
  })
})

describe('client enforcement: nothing starts without consent', () => {
  it('Pay & Publish Event / Publish Event are disabled until every item is ticked', () => {
    expect(STEP7).toContain('isPendingReview || !allTermsAccepted || !report.canPublish')
    expect(STEP7).toContain('if (!allTermsAccepted || !report.canPublish || publishState !== \'idle\') return')
    expect(STEP7).toContain("nextLabel={payCtx && !payCtx.covered ? 'Pay & Publish Event' : 'Publish Event'}")   // RD-CE-FIX M1
  })
  it('the ticks (this session only) go to the purchase AND the publish request', () => {
    expect(STEP7).toContain('accurateInformation: termInfo,')
    expect(STEP7).toContain('...(isFreeEvent ? {} : { settlementFeePolicy: termsFees }),')
    expect(STEP7).toContain('const outcome = await payCtx.pay(publishAgreement)')
    expect(STEP7).toContain('body: JSON.stringify({ draftId, confirmIdentityChange, agreement: publishAgreement }),')
    // RD-CLOSE — the dead WALLET_INSUFFICIENT branch ahead of it was removed.
    expect(STEP7).toContain("if (json.reason === 'AGREEMENT_REQUIRED') {")
  })
  it('the ticks survive a cancelled / failed payment and a failed submission (same component state; no reset)', () => {
    // RD-COMMS-P1 — the wizard's top-up block is gone; the handler now ends at the activation section.
    const handler = STEP7.slice(STEP7.indexOf('const confirmPublishOnce'), STEP7.indexOf('// ── Activation & services (RD-EVENT-COMMERCE-05B)'))
    expect(handler.length).toBeGreaterThan(0)
    expect(handler).not.toMatch(/setTermInfo|setConsentFeeModel|setConsentTimeline|setFeesAcceptedAt/)
  })
  it('License & Services and the payment panel pass it through; only a DRAFT purchase sends it', () => {
    expect(LSS).toContain('pay:          (agreement?: PublishAgreementInput) => Promise<PayOutcome>')
    expect(LSS).toContain('payRef.current ? payRef.current(agreement)')
    expect(PANEL).toContain("...(mode === 'draft' && agreement ? { agreement } : {}),")
    expect(PANEL).toContain('void pay(agreement)')
  })
})

describe('server enforcement placement', () => {
  it('the draft purchase route checks BEFORE any order can be created', () => {
    const at = BUY.indexOf('if (!checkPublishAgreement(body.agreement, { paidEvent: isPaidEventPricing(draftPricing) }).ok) {')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(BUY.indexOf('// ── The authoritative amount'))
    expect(BUY).toContain("code: 'AGREEMENT_REQUIRED'")
  })
  it('the publish route checks before writing, and records the consent in the SAME transaction (event + draft)', () => {
    const at = PUBLISH.indexOf('const agreement = checkPublishAgreement(')
    expect(at).toBeGreaterThan(PUBLISH.indexOf('if (!validation.canPublish) {'))
    expect(at).toBeLessThan(PUBLISH.indexOf('adminDb.runTransaction'))
    const txn = PUBLISH.slice(PUBLISH.indexOf('adminDb.runTransaction'))
    expect((txn.match(/publishAgreement: +\{ \.\.\.publishAgreementRecord, acceptedAt: FieldValue\.serverTimestamp\(\) \}/g) ?? []).length).toBe(2)
    expect(PUBLISH).not.toMatch(/publishAgreementRecord[^\n]*version/)            // no invented version
  })
  it('an existing published / pending event buys more with NO new agreement (no approved purchase terms exist)', () => {
    expect(PUB_BUY).not.toMatch(/checkPublishAgreement|agreement/)
  })
})
