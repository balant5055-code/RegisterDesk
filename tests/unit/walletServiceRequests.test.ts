// RD-WALLET-REQ + the event-wise Wallet (2026-10-02) — the PURE rules: each service's eligibility,
// the per-line refund valuation, the 24-hour refund window (was 30 days until 2026-10-06), destinations, decisions, the allowance-ledger
// extension, the Increase Limit hand-off, the purchase-notification lines, and the structural wiring.
// Behaviour on real Firestore through the real routes is tests/emulator/walletServiceRequests.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import {
  requestEligibility, valueUnits, destinationProblem, decisionTransition, targetStatus,
  parseExternalReference, parseOrganizerNote, isClosedLifecycle, isRequestableService, REQUESTABLE_SERVICES, CARRYABLE_SERVICES,
  eventClosedAtMs, refundDeadlineMs, refundWindowProblem, REFUND_WINDOW_HOURS, REFUND_WINDOW_MS, withinRefundWindow,
  refundWindowSnapshot, refundedAmountProblem,
  type ServiceState, type EligibilityContext,
} from '@/lib/wallet/serviceRequestRules'
import { viewOf, decideReserve, availableUnits, ledgerLine, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { reconcileAllowance } from '@/lib/licensing/allowanceReconciliation'
import { withMediaBaseCap, priceServiceItem } from '@/lib/licensing/serviceAllowances'
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, isFinancialAuditEntry } from '@/lib/admin/auditConstants'
import { dayBound } from '@/lib/wallet/activityScan'
import { increaseLimitHref, intentFromParams, safeReturnTo, walletHrefFor } from '@/lib/wallet/purchaseIntent'

const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const D = 86_400_000

const state = (o: Partial<ServiceState> = {}): ServiceState => ({
  service: 'whatsapp', applicable: true, notApplicableReason: null, purchased: 100, used: 30, carriedIn: 0, carriedOut: 0, refunded: 0,
  remaining: 70, ownUnused: 70, paidPaise: 118_000, lots: [{ orderId: 'lic_a', at: 1, quantity: 100, totalPaise: 118_000 }],
  usedFront: 30, removedBack: 0, problem: null, facts: {}, ...o,
})
const ctx = (o: Partial<EligibilityContext> = {}): EligibilityContext => ({
  lifecycle: 'completed', campaignType: null, openRequest: false, closedAtMs: 0, windowAt: 1, approvedPaise: 0, ...o,
})

describe('which events and services', () => {
  it('only a lifecycle-CLOSED event (completed / archived / cancelled) — dates alone do not close one', () => {
    for (const l of ['completed', 'archived', 'cancelled'] as const) expect(isClosedLifecycle(l)).toBe(true)
    for (const l of ['published', 'registration_closed', 'unpublished', 'draft', 'pending_review'] as const) expect(isClosedLifecycle(l)).toBe(false)
    expect(requestEligibility('refund', state(), ctx({ lifecycle: 'published' }))).toMatchObject({ eligible: false, code: 'EVENT_NOT_CLOSED' })
  })
  // RD-PRINT-BILL-P4 — ID badges (prepaid units bought through a badge purchase order) join as a fifth.
  it('all five services are requestable; capacity is refund-only (never carried)', () => {
    expect(REQUESTABLE_SERVICES).toEqual(['registrations', 'whatsapp', 'certificates', 'media', 'print_badges'])
    expect(CARRYABLE_SERVICES).toEqual(['whatsapp', 'certificates', 'media', 'print_badges'])
    expect(isRequestableService('sms')).toBe(false)
    expect(requestEligibility('carry_forward', state({ service: 'registrations' }), ctx())).toMatchObject({ eligible: false, code: 'SERVICE_NOT_SUPPORTED' })
    expect(requestEligibility('refund', state({ service: 'registrations' }), ctx())).toMatchObject({ eligible: true })
  })
  it('donation campaigns and services with nothing bought are never eligible', () => {
    expect(requestEligibility('refund', state(), ctx({ campaignType: 'donation_only' }))).toMatchObject({ code: 'DONATION_CAMPAIGN' })
    expect(requestEligibility('refund', state({ applicable: false, notApplicableReason: 'x' }), ctx())).toMatchObject({ code: 'NOT_APPLICABLE', reason: 'x' })
  })
})

describe('eligibility', () => {
  it('only the unused units of the event’s own purchase, and a data problem always blocks (review)', () => {
    expect(requestEligibility('refund', state(), ctx())).toMatchObject({ eligible: true, quantity: 70 })
    expect(requestEligibility('carry_forward', state(), ctx())).toEqual({ eligible: true, quantity: 70 })
    expect(requestEligibility('refund', state({ ownUnused: 0 }), ctx())).toMatchObject({ code: 'NOTHING_UNUSED' })
    expect(requestEligibility('refund', state({ problem: { code: 'HISTORICAL_DATA_UNAVAILABLE', reason: 'old' } }), ctx())).toMatchObject({ code: 'HISTORICAL_DATA_UNAVAILABLE' })
    expect(requestEligibility('refund', state({ problem: { code: 'LEDGER_UNRECONCILED', reason: 'r' } }), ctx())).toMatchObject({ code: 'LEDGER_UNRECONCILED' })
  })
  it('one undecided request per event + service', () => {
    expect(requestEligibility('refund', state(), ctx({ openRequest: true }))).toMatchObject({ code: 'REQUEST_OPEN' })
  })
  it('the cap is never more than what was paid minus what was already approved; no paid basis → review', () => {
    expect(requestEligibility('refund', state(), ctx({ approvedPaise: 100_000 }))).toMatchObject({ eligible: true, upperBoundPaise: 18_000 })
    expect(requestEligibility('refund', state(), ctx({ approvedPaise: 118_000 }))).toMatchObject({ code: 'NO_PAID_BASIS' })
    expect(requestEligibility('refund', state({ lots: [{ orderId: 'x', at: 1, quantity: 100, totalPaise: 0 }], paidPaise: 0 }), ctx())).toMatchObject({ code: 'NO_PAID_BASIS' })
  })
  it('positions that do not fit the purchase lines are refused (review), never guessed', () => {
    expect(requestEligibility('refund', state({ ownUnused: 90, usedFront: 30 }), ctx())).toMatchObject({ code: 'LEDGER_UNRECONCILED' })
  })
})

describe('valuation — each unused unit at the price actually paid for it', () => {
  const lots = [
    { orderId: 'old', at: 1, quantity: 10, totalPaise: 1_180 },    // ₹1.18 / unit
    { orderId: 'new', at: 2, quantity: 10, totalPaise: 2_360 },    // ₹2.36 / unit
  ]
  it('usage consumes the OLDEST units first; the unused units are the newest, valued line by line', () => {
    expect(valueUnits(lots, 5, 0, 15)).toEqual({ valuePaise: 590 + 2_360, parts: [{ orderId: 'old', units: 5, valuePaise: 590 }, { orderId: 'new', units: 10, valuePaise: 2_360 }] })
    expect(valueUnits(lots, 12, 0, 8)).toEqual({ valuePaise: 1_888, parts: [{ orderId: 'new', units: 8, valuePaise: 1_888 }] })
  })
  it('units that already left (refund / carry-forward / capacity reduction) leave from the NEWEST end', () => {
    expect(valueUnits(lots, 0, 10, 10)).toEqual({ valuePaise: 1_180, parts: [{ orderId: 'old', units: 10, valuePaise: 1_180 }] })
  })
  it('order of lines is by time, not by array position; a full line is its exact total', () => {
    expect(valueUnits([...lots].reverse(), 0, 0, 20)!.valuePaise).toBe(3_540)
  })
  it('remainder paise: partial refunds of one line can never add up to more than the line', () => {
    const one = [{ orderId: 'l', at: 1, quantity: 3, totalPaise: 1_000 }]
    const first = valueUnits(one, 0, 0, 1)!.valuePaise            // floor(333.33) = 333
    const rest = valueUnits(one, 0, 1, 2)!.valuePaise             // floor(666.66) = 666
    expect(first).toBe(333); expect(rest).toBe(666)
    expect(first + rest).toBeLessThanOrEqual(1_000)
  })
  it('impossible positions → null', () => {
    expect(valueUnits(lots, 15, 0, 10)).toBeNull()
    expect(valueUnits(lots, -1, 0, 1)).toBeNull()
  })
})

describe('the 24-hour refund window (2026-10-06; was 30 days) and coupons (Option A)', () => {
  const none = { completedAt: null, cancelledAt: null, archivedAt: null, restoredAt: null }
  it('closure = the first closure stamp after the last restore; none recorded → null', () => {
    expect(eventClosedAtMs(none)).toBeNull()
    expect(eventClosedAtMs({ ...none, completedAt: 100 })).toBe(100)
    expect(eventClosedAtMs({ ...none, completedAt: 100, archivedAt: 500 })).toBe(100)
    expect(eventClosedAtMs({ ...none, cancelledAt: 100, archivedAt: 200, restoredAt: 300 })).toBeNull()
    expect(eventClosedAtMs({ ...none, cancelledAt: 100, archivedAt: 200, restoredAt: 300, completedAt: 900 })).toBe(900)
  })
  it('the window is exactly 24 h from closure; the deadline itself is OUTSIDE; unknown closure fails closed', () => {
    expect(REFUND_WINDOW_HOURS).toBe(24)
    expect(REFUND_WINDOW_MS).toBe(24 * 3_600_000)
    expect(refundDeadlineMs(0)).toBe(D)
    expect(refundWindowProblem({ closedAtMs: 0, windowAt: D - 1 })).toBeNull()
    expect(refundWindowProblem({ closedAtMs: 0, windowAt: D })).toMatchObject({ code: 'REFUND_WINDOW_CLOSED' })
    expect(refundWindowProblem({ closedAtMs: null, windowAt: 1 })).toMatchObject({ code: 'CLOSURE_DATE_UNKNOWN' })
    expect(requestEligibility('refund', state(), ctx({ windowAt: 30 * D }))).toMatchObject({ code: 'REFUND_WINDOW_CLOSED' })   // the old 30 days no longer applies
    expect(withinRefundWindow(D - 1, 0)).toBe(true); expect(withinRefundWindow(D, 0)).toBe(false); expect(withinRefundWindow(5, null)).toBeNull()
  })
  // The spec's example: closed 2026-10-10 10:00:00 ⇒ eligible before 2026-10-11 10:00:00, rejected at/after it.
  const CLOSED = Date.parse('2026-10-10T10:00:00Z')
  const H = 3_600_000, M = 60_000, S = 1_000
  it.each(['completed', 'cancelled', 'archived'] as const)('%s: 23h59m ⇒ eligible · exactly 24h ⇒ rejected · 24h+1s ⇒ rejected', lifecycle => {
    const at = (ms: number) => requestEligibility('refund', state(), ctx({ lifecycle, closedAtMs: CLOSED, windowAt: CLOSED + ms }))
    expect(at(23 * H + 59 * M)).toMatchObject({ eligible: true, quantity: 70 })
    expect(at(24 * H - 1)).toMatchObject({ eligible: true })
    expect(at(24 * H)).toMatchObject({ eligible: false, code: 'REFUND_WINDOW_CLOSED' })
    expect(Date.parse('2026-10-11T10:00:00Z')).toBe(CLOSED + 24 * H)
    expect(at(24 * H + S)).toMatchObject({ eligible: false, code: 'REFUND_WINDOW_CLOSED' })
    // missing closure timestamp ⇒ never silently eligible
    expect(requestEligibility('refund', state(), ctx({ lifecycle, closedAtMs: null, windowAt: CLOSED }))).toMatchObject({ eligible: false, code: 'CLOSURE_DATE_UNKNOWN' })
  })
  it('open lifecycles never become eligible because time passed; the window never touches the unused-units rule', () => {
    for (const lifecycle of ['draft', 'published', 'registration_closed', 'pending_review', 'unpublished'] as const) {
      expect(requestEligibility('refund', state(), ctx({ lifecycle, closedAtMs: CLOSED, windowAt: CLOSED + H }))).toMatchObject({ code: 'EVENT_NOT_CLOSED' })
      expect(requestEligibility('refund', state(), ctx({ lifecycle, closedAtMs: null, windowAt: CLOSED + 99 * D }))).toMatchObject({ code: 'EVENT_NOT_CLOSED' })
    }
    // inside the window: still only the UNUSED units (70 of 100), and nothing when all are used
    expect(requestEligibility('refund', state(), ctx({ closedAtMs: CLOSED, windowAt: CLOSED + H }))).toMatchObject({ eligible: true, quantity: 70 })
    expect(requestEligibility('refund', state({ ownUnused: 0, used: 100, remaining: 0, usedFront: 100 }), ctx({ closedAtMs: CLOSED, windowAt: CLOSED + H })))
      .toMatchObject({ eligible: false, code: 'NOTHING_UNUSED' })
    expect(requestEligibility('refund', state(), ctx({ closedAtMs: CLOSED, windowAt: CLOSED + H, openRequest: true }))).toMatchObject({ code: 'REQUEST_OPEN' })
  })
  it('the window is a SUBMISSION rule (no windowAt at approval) and never applies to carry-forward', () => {
    expect(requestEligibility('refund', state(), ctx({ windowAt: undefined, closedAtMs: null }))).toMatchObject({ eligible: true })
    expect(requestEligibility('carry_forward', state(), ctx({ windowAt: 99 * D }))).toMatchObject({ eligible: true })
    const svc = code('lib/wallet/serviceRequests.ts')
    expect(svc).toContain("const e = eligibilityOf(rec, r.kind, state, { exceptId: id })")
  })
  it('Option A — no coupon allocation anywhere in the refund path; the premise is pinned to the code', () => {
    expect(code('lib/wallet/serviceRequests.ts')).not.toMatch(/couponOnServiceOrder|COUPON_ALLOCATION/)
    const purchase = code('app/api/licensing/purchase/route.ts')
    expect(purchase).toContain('tier: request.tier, eventType, pricePaise: basePricePaise,')
    expect(purchase).toContain('finalPricePaise += servicesTotalPaise')
    expect(code('lib/licensing/coupons/validate.ts')).toContain('discount = Math.max(0, Math.min(discount, ctx.pricePaise))')
    for (const f of ['lib/licensing/capacityChange.ts', 'lib/licensing/draftCommerce.ts']) expect(code(f), f).not.toMatch(/coupon|discountPaise/i)
  })
  it('capacity: the activation coupon reduced exactly the capacity part — its lot is what was COLLECTED for it', () => {
    expect(code('lib/wallet/serviceRequests.ts')).toContain('Math.min(int(c.totalPaise), int(o.amountPaise) - int(o.servicesTotalPaise))')
  })
})

describe('photos — the base limit is recorded on every new media line', () => {
  const cfg = { unitPricePaise: 200, gstRatePercent: 18, onExhausted: 'block' as const } as never
  it('withMediaBaseCap stamps media lines only, and only with a real base', () => {
    const items = [priceServiceItem('media', 10, cfg), priceServiceItem('whatsapp', 5, cfg)]
    expect(withMediaBaseCap(items, 500).map(i => i.baseCapAtPurchase)).toEqual([500, undefined])
    expect(withMediaBaseCap(items, null)).toBe(items)
  })
  it('every order-creation path records it', () => {
    expect(code('app/api/licensing/published/purchase/route.ts')).toContain('withMediaBaseCap(SERVICE_KINDS.filter(k => additional[k] > 0)')
    expect(code('app/api/licensing/published/purchase/route.ts')).toContain('mediaBaseCap: mediaBase')
    expect(code('app/api/licensing/purchase/route.ts')).toContain('withMediaBaseCap(SERVICE_KINDS')
    expect(code('app/api/licensing/purchase/route.ts')).toContain('mediaBaseCap: mediaBase')
    expect(code('lib/licensing/draftCommerce.ts')).toContain('withMediaBaseCap(quote.serviceItems, args.mediaBaseCap ?? null)')
  })
  it('the upload gate honours carried / refunded photo units (RD-PHOTO-01: one canonical rule)', () => {
    expect(code('lib/licensing/photoCapacity.ts'))
      .toContain('n(line?.purchased) + n(line?.carriedIn) - n(line?.carriedOut) - n(line?.refunded)')
    expect(code('features/media-studio/services/photoCapacityGate.ts')).toContain('paidPhotoCapacity(')
  })
  it('RD-PHOTO-01 · every new media line records a base of 0 — there are no free photos', () => {
    expect(code('lib/licensing/mediaAllowance.ts')).toMatch(/Promise<number> \{[^}]*return 0\s*\}/)
  })
})

describe('destinations', () => {
  it('another of the organizer’s events that can still use units', () => {
    expect(destinationProblem({ draftId: 'b', lifecycle: 'published', campaignType: null }, 'a')).toBeNull()
    expect(destinationProblem({ draftId: 'b', lifecycle: 'draft', campaignType: null }, 'a')).toBeNull()
    expect(destinationProblem({ draftId: 'a', lifecycle: 'published', campaignType: null }, 'a')).toMatch(/different event/)
    expect(destinationProblem({ draftId: 'b', lifecycle: 'cancelled', campaignType: null }, 'a')).toMatch(/closed/)
    expect(destinationProblem({ draftId: 'b', lifecycle: 'published', campaignType: 'donation_only' }, 'a')).toMatch(/Donation/)
  })
})

describe('decisions', () => {
  it('valid transitions only; a repeat is "already"; processed is refunds-only and only after approval', () => {
    expect(decisionTransition('refund', 'submitted', 'approve')).toBe('apply')
    expect(decisionTransition('refund', 'submitted', 'reject')).toBe('apply')
    expect(decisionTransition('refund', 'submitted', 'mark_processed')).toBe('refuse')
    expect(decisionTransition('refund', 'approved', 'mark_processed')).toBe('apply')
    expect(decisionTransition('refund', 'approved', 'approve')).toBe('already')
    expect(decisionTransition('refund', 'approved', 'reject')).toBe('refuse')
    expect(decisionTransition('refund', 'processed', 'mark_processed')).toBe('already')
    expect(decisionTransition('refund', 'rejected', 'approve')).toBe('refuse')
    expect(decisionTransition('carry_forward', 'approved', 'mark_processed')).toBe('refuse')
    expect(decisionTransition('carry_forward', 'submitted', 'mark_processed')).toBe('refuse')
    expect(targetStatus('mark_processed')).toBe('processed')
  })
  it('the external reference is validated, never generated; notes are trimmed and bounded', () => {
    expect(parseExternalReference(' rfnd_ABC123 ')).toEqual({ ok: true, value: 'rfnd_ABC123' })
    for (const bad of ['', 'ab', 'has space', '<script>', null, 42]) expect(parseExternalReference(bad).ok).toBe(false)
    expect(parseOrganizerNote('  hi  ')).toBe('hi')
    expect(parseOrganizerNote('x'.repeat(900))).toHaveLength(500)
    expect(parseOrganizerNote({})).toBe('')
  })
  it('audit actions and a FINANCIAL entity type exist', () => {
    for (const a of ['wallet_service_request.approved', 'wallet_service_request.rejected', 'wallet_service_request.processed']) expect(AUDIT_ACTIONS).toContain(a)
    expect(AUDIT_ENTITY_TYPES).toContain('wallet_service_request')
    expect(isFinancialAuditEntry({ entityType: 'wallet_service_request' })).toBe(true)
  })
})

describe('the allowance ledger extension (missing fields = 0: older ledgers behave exactly as before)', () => {
  const doc = (wa: Record<string, unknown>) => ({ draftId: 'd', organizerUid: 'u', whatsapp: wa }) as unknown as ServiceLedgerDoc
  it('viewOf: purchased keeps its meaning; remaining = purchased + carriedIn − consumed − carriedOut − refunded', () => {
    expect(viewOf(doc({ purchased: 100, consumed: 30, onExhausted: 'block' }))).toMatchObject({
      purchased: { whatsapp: 100 }, consumed: { whatsapp: 30 }, remaining: { whatsapp: 70 }, carriedIn: { whatsapp: 0 }, refunded: { whatsapp: 0 },
    })
    expect(viewOf(doc({ purchased: 100, consumed: 30, refunded: 70, onExhausted: 'block' })).remaining.whatsapp).toBe(0)
    expect(viewOf(doc({ carriedIn: 40, consumed: 5 })).remaining.whatsapp).toBe(35)
    expect(availableUnits(ledgerLine(doc({ purchased: 1, consumed: 5 }), 'whatsapp'))).toBe(0)
    expect(ledgerLine(doc({ purchased: 'x' as unknown as number }), 'whatsapp').purchased).toBe(0)
  })
  it('decideReserve — unchanged for ledgers without the new fields', () => {
    expect(decideReserve(undefined, false, 'whatsapp', 1)).toEqual({ mode: 'none' })
    expect(decideReserve(doc({ purchased: 10, consumed: 3, onExhausted: 'block' }), false, 'whatsapp', 7)).toEqual({ mode: 'allowance', already: false })
    expect(decideReserve(doc({ purchased: 10, consumed: 10, onExhausted: 'block' }), false, 'whatsapp', 1)).toEqual({ mode: 'exhausted', policy: 'block' })
    expect(decideReserve(doc({ purchased: 10, consumed: 10 }), false, 'whatsapp', 1)).toEqual({ mode: 'exhausted', policy: 'block' })
    expect(decideReserve(doc({ purchased: 10, consumed: 10, onExhausted: 'wallet_payg' }), false, 'whatsapp', 1)).toEqual({ mode: 'exhausted', policy: 'wallet_payg' })
    expect(decideReserve(doc({ purchased: 10, consumed: 10 }), true, 'whatsapp', 1)).toEqual({ mode: 'allowance', already: true })
  })
  it('decideReserve — refunded / carried-out units are no longer usable; carried-in units are', () => {
    expect(decideReserve(doc({ purchased: 10, consumed: 3, refunded: 7, onExhausted: 'block' }), false, 'whatsapp', 1)).toEqual({ mode: 'exhausted', policy: 'block' })
    expect(decideReserve(doc({ carriedIn: 5, consumed: 4 }), false, 'whatsapp', 1)).toEqual({ mode: 'allowance', already: false })
    expect(decideReserve(doc({ carriedIn: 5, consumed: 5 }), false, 'whatsapp', 1)).toEqual({ mode: 'none' })
    expect(decideReserve(doc({ purchased: 5, carriedIn: 5, consumed: 10, onExhausted: 'block' }), false, 'whatsapp', 1)).toEqual({ mode: 'exhausted', policy: 'block' })
  })
  it('reconciliation (dry-run) accounts for the new fields and still flags real disagreements', () => {
    const paid = [{ orderId: 'o', status: 'paid', serviceItems: [{ service: 'whatsapp' as const, quantity: 10, unitPricePaise: 100, basePaise: 1000, gstRatePercent: 0, gstPaise: 0, totalPaise: 1000, onExhausted: 'block' as const }] }]
    expect(reconcileAllowance({ whatsapp: { purchased: 10, consumed: 3, refunded: 7 }, appliedOrders: { o: true } }, paid, [{ service: 'whatsapp', quantity: 3 }]).lines.find(l => l.service === 'whatsapp')).toMatchObject({ remaining: 0, issues: [] })
    expect(reconcileAllowance({ whatsapp: { purchased: 10, consumed: 5, refunded: 7 }, appliedOrders: { o: true } }, paid, [{ service: 'whatsapp', quantity: 5 }]).lines.find(l => l.service === 'whatsapp')!.issues.join()).toMatch(/exceeds/)
  })
})

describe('Increase Limit hand-off (existing purchase flow, never a parallel checkout)', () => {
  it('builds the wizard link with the event, the service and a Wallet-only return path', () => {
    const href = increaseLimitHref('draft_1', 'whatsapp')
    expect(href.startsWith('/dashboard/events/new/visibility?')).toBe(true)
    const p = new URLSearchParams(href.split('?')[1])
    expect(intentFromParams(p, 5)).toEqual({ draftId: 'draft_1', service: 'whatsapp', returnTo: walletHrefFor('draft_1'), at: 5 })
  })
  it('never returns anywhere but the Wallet (no open redirect); a non-hand-off is ignored', () => {
    expect(safeReturnTo('/dashboard/wallet')).toBe('/dashboard/wallet')
    expect(safeReturnTo('/dashboard/wallet?eventId=abc')).toBe('/dashboard/wallet?eventId=abc')
    for (const bad of ['https://evil.example', '//evil', '/dashboard/settings', '/dashboard/wallet?eventId=a&x=1', null]) expect(safeReturnTo(bad)).toBeNull()
    expect(intentFromParams(new URLSearchParams('draftId=a&step=license&returnTo=https://x'))).toBeNull()
    expect(intentFromParams(new URLSearchParams('draftId=a'))).toBeNull()
  })
  it('the wizard opens License & Services for it and the step returns only after a VERIFIED grant', () => {
    expect(code('app/(dashboard)/dashboard/events/new/page.tsx')).toContain("walletIntent ? indexOfStep(draftFlow, 'license')")
    const step = code('components/wizard/LicenseServicesStep.tsx')
    expect(step).toContain('if (lastGrantKey !== null && walletIntent) setReturnAfterPurchase(walletIntent.returnTo)')
  })
  it('a DRAFT’s purchase is paid with its submission: the success screen offers the return to the same event’s Wallet', () => {
    const wizard = code('app/(dashboard)/dashboard/events/new/page.tsx')
    const success = wizard.slice(wizard.indexOf("if (publishState === 'published' && !isAlreadyPublished) {"))
    expect(success).toContain('const walletIntent = readIntent(draftId)')
    expect(success).toContain('<Link href={walletIntent.returnTo} onClick={() => clearIntent()}')
  })
})

describe('purchase notifications', () => {
  it('lines come from the order’s own snapshots (capacity + service lines)', async () => {
    const { purchaseLines } = await import('@/lib/notifications/servicePurchase')
    const lines = purchaseLines({
      capacityChange: { operation: 'increase', capacity: 300, previousCapacity: 200, basePaise: 15_000, gstPaise: 2_700, totalPaise: 17_700 },
      serviceItems: [{ service: 'whatsapp', quantity: 50, basePaise: 5_000, gstPaise: 900, totalPaise: 5_900 }],
    })
    expect(lines).toEqual([
      { label: 'Registration capacity', quantity: 100, basePaise: 15_000, gstPaise: 2_700, totalPaise: 17_700 },
      { label: 'WhatsApp messages', quantity: 50, basePaise: 5_000, gstPaise: 900, totalPaise: 5_900 },
    ])
  })
  it('every settlement path triggers it AFTER a successful apply; it claims the order once and reads it back as paid', () => {
    expect(code('app/api/licensing/checkout/confirm/route.ts')).toContain('scheduleServicePurchaseNotification(addonOrderId)')
    expect(code('app/api/licensing/checkout/confirm/route.ts')).toContain('scheduleServicePurchaseNotification(`lic_${eventId}`)')
    expect(code('app/api/licensing/capacity/confirm/route.ts')).toContain('scheduleServicePurchaseNotification(orderId)')
    expect(code('app/api/webhooks/razorpay/route.ts').match(/scheduleServicePurchaseNotification\(persisted\.orderId\)/g)).toHaveLength(3)
    expect(code('app/api/licensing/purchase/route.ts')).toContain('scheduleServicePurchaseNotification(`lic_${eventId}`)')
    const n = code('lib/notifications/servicePurchase.ts')
    // Super Admin email = the support inbox + every ADMIN_UIDS account (never the legacy admin:true claim).
    expect(n).toContain("process.env.ADMIN_UIDS ?? ''")
    expect(n).toContain('for (const to of adminRecipients)')
    expect(n).not.toMatch(/customClaims|\.admin === true/)
    // after() inside a request; outside a request scope (scripts, direct handler calls) it falls back.
    expect(n).toContain('try { after(() => notifyServicePurchase(orderId)) }')
    expect(n).toContain("if (!order || order.status !== 'paid') return 'not_paid'")
    expect(n).toContain('await claim.create(')
    expect(n).toContain("dedupeId: `purchase-${orderId}`")
    // The activation email is no longer sent twice (the old LICENSE_PURCHASED email was replaced).
    expect(code('app/api/licensing/checkout/confirm/route.ts')).not.toContain('notificationEngine.send(NotificationType.LICENSE_PURCHASED')
  })
})

describe('activity', () => {
  it('the server’s credit types are exactly the Transactions page’s credit set', async () => {
    const { WALLET_CREDIT_TXN_TYPES, txnDirection, parseTxnDirection } = await import('@/lib/wallet/eventWalletView')
    expect([...WALLET_CREDIT_TXN_TYPES]).toEqual(['fund_added', 'license_refund', 'refund'])
    expect(code('app/(dashboard)/dashboard/wallet/transactions/TransactionsClient.tsx')).toContain("new Set<WalletTxnType>(['fund_added', 'license_refund', 'refund'])")
    expect(txnDirection('license_refund')).toBe('credit')
    expect(parseTxnDirection('sideways')).toBeNull()
  })
  it('date bounds are YYYY-MM-DD in India time; anything else is ignored', () => {
    expect(dayBound('2026-09-01', 'start')!.toISOString()).toBe('2026-08-31T18:30:00.000Z')
    expect(dayBound('2026-09-01', 'end')!.toISOString()).toBe('2026-09-01T18:29:59.999Z')
    for (const v of ['', null, '2026-9-1', '2026-13-40', 'today']) expect(dayBound(v, 'start')).toBeNull()
  })
})

describe('structural wiring', () => {
  const org = code('app/api/organizer/wallet/service-requests/route.ts')
  const adminList = code('app/api/admin/wallet-service-requests/route.ts')
  const adminOne = code('app/api/admin/wallet-service-requests/[id]/route.ts')
  const adminFeed = code('app/api/admin/notifications/route.ts')
  const svc = code('lib/wallet/serviceRequests.ts')
  it('organizer routes: `wallet` permission; SUBMITTING needs the workspace owner; money/quantity fields are refused', () => {
    expect(org).toContain("authorizeWorkspace(req, 'wallet')")
    expect(org.indexOf('if (!authz.isOwner)')).toBeLessThan(org.indexOf('submitServiceRequests('))
    expect(org).toContain("for (const k of ['quantity', 'amountPaise', 'approvedAmountPaise', 'refundUpperBoundPaise', 'refundedAmountPaise', 'window', 'capacity', 'organizerUid', 'status'])")
  })
  it('admin routes (queues, decisions, notification feed): requireSuperAdmin (ADMIN_UIDS) first on every method', () => {
    for (const src of [adminList, adminOne, adminFeed]) {
      expect(src).not.toContain('resolveAdminUid')
      for (const fn of src.split('export async function ').slice(1)) expect(fn.indexOf('await requireSuperAdmin(req)'), fn.slice(0, 20)).toBeGreaterThan(-1)
    }
    expect(adminOne).toContain('parseFinancialReason(body.reason)')
  })
  it('decisions stage their audit row in the same transaction; no payment provider or wallet balance is touched', () => {
    expect(svc).toContain('stageAdminAudit(txn,')
    // The ONE permitted mention: the stored payment id, read (never called) as review evidence.
    const paymentIdRead = 'paymentId: typeof o.razorpayPaymentId === \'string\' ? o.razorpayPaymentId : null'
    expect(svc).toContain(paymentIdRead)
    expect(svc.replace(paymentIdRead, '')).not.toMatch(/razorpay|cashfree|resolvePaymentProvider|organizerWallets|walletTransactions|mediaCreditWallets/i)
    expect(svc).not.toMatch(/purchased:\s*FieldValue\.increment|consumed:\s*FieldValue\.increment/)
    expect(svc).toContain('{ refunded: FieldValue.increment(r.quantity) }')
    expect(svc).toContain('{ carriedOut: FieldValue.increment(r.quantity) }')
    expect(svc).toContain('{ carriedIn: FieldValue.increment(r.quantity) }')
    // A capacity refund lowers the enforced capacity, never below registrations taken.
    expect(svc).toContain("if (next < (rec.sold ?? 0)) throw new ServiceRequestError(409, 'UNITS_CHANGED'")
    expect(svc).toContain('totalCapacity: next')
  })
  it('the Wallet Management console stays GET-only; decisions live in the separate queue component', () => {
    const page = code('app/(admin)/admin/wallet-management/PageClient.tsx')
    expect(page).toContain('<ServiceRequestsQueue kind="refund" />')
    expect(page).toContain('<ServiceRequestsQueue kind="carry_forward" />')
    expect(code('app/(admin)/admin/wallet-management/ServiceRequestsQueue.tsx')).toContain("const BASE = '/api/admin/wallet-service-requests'")
  })
})

describe('refund history S1 / S2 — pure rules', () => {
  const CLOSED = Date.parse('2026-10-10T10:00:00Z'), H = 3_600_000
  it('S1 · the window snapshot as accepted: closure, deadline (closure + 24 h), submission, verdict', () => {
    expect(refundWindowSnapshot(CLOSED, CLOSED + 23 * H + 59 * 60_000)).toEqual({
      closureAt: '2026-10-10T10:00:00.000Z', deadlineAt: '2026-10-11T10:00:00.000Z',
      submittedAt: '2026-10-11T09:59:00.000Z', submittedWithinWindow: true,
    })
    expect(refundWindowSnapshot(CLOSED, CLOSED + 24 * H).submittedWithinWindow).toBe(false)   // the boundary is outside
    expect(refundWindowSnapshot(null, CLOSED)).toEqual({ closureAt: null, deadlineAt: null, submittedAt: new Date(CLOSED).toISOString(), submittedWithinWindow: null })   // never invented
  })
  it('S2 · the refunded amount: whole paise, ≥ 0, ≤ approved; approved must exist', () => {
    expect(refundedAmountProblem(180_000, 200_000)).toBeNull()
    expect(refundedAmountProblem(200_000, 200_000)).toBeNull()
    expect(refundedAmountProblem(0, 200_000)).toBeNull()
    expect(refundedAmountProblem(200_001, 200_000)).toMatch(/cannot exceed/)
    expect(refundedAmountProblem(-1, 200_000)).toMatch(/negative/)
    expect(refundedAmountProblem(1.5, 200_000)).toMatch(/whole paise/)
    expect(refundedAmountProblem('1000', 200_000)).toMatch(/whole paise/)
    expect(refundedAmountProblem(100, null)).toMatch(/no approved amount/)
  })
})
