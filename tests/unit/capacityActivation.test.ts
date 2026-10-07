// RD-CAPACITY-01 — the ACTIVATION path: who is allowed to decide what an organizer pays.
//
// ═══ WHY THESE ARE SOURCE-CONTRACT TESTS ═════════════════════════════════════
// The arithmetic is proved in capacityPricing.test.ts against the pure engine. What cannot
// be proved there is the property that actually protects the money: that no layer between
// the browser and the ledger ever takes an amount, a rate, a GST figure or a capacity from
// the request when settling. That is a property of the SOURCE — of which identifiers appear
// where — and reading the source is the only way to assert it without standing up Razorpay.
//
// Each test below therefore names the exact hazard it rules out. A future edit that
// reintroduces `body.amount` into a settlement path fails here, loudly, with the reason.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { capacityChargeSnapshot, capacityOrderDocId, isCapacityChangePurpose } from '@/lib/licensing/schema'
import { calculateActivationQuote } from '@/lib/licensing/capacityPricing'
import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** The file with comment lines stripped, so a prose mention is never mistaken for code. */
const code = (p: string) =>
  read(p).split('\n').filter(l => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

const PURCHASE = 'app/api/licensing/purchase/route.ts'
const CONFIRM  = 'app/api/licensing/checkout/confirm/route.ts'
const PUBLISH  = 'app/api/events/publish/route.ts'
const WEBHOOK  = 'app/api/webhooks/razorpay/route.ts'
const FINALIZE = 'lib/licensing/finalizeLicensePurchase.ts'

// ═══ 1 · the browser is not authoritative for money ═══════════════════════════

describe('the client cannot name a price', () => {
  it('the purchase route reads ONLY eventId, tier, couponCode, capacity and service QUANTITIES from the body', () => {
    const src = code(PURCHASE)
    // RD-EVENT-COMMERCE-02 — `services` carries quantities only (parsed + validated server-side).
    // RD-EVENT-COMMERCE-03 — `expectedTotalPaise` is only COMPARED with the server's own total
    // (a stale-quote guard); it is never used as a price.
    // RD-EVENT-COMMERCE-05F — `agreement` (the organizer's Publish Agreement ticks) is consent, not money.
    expect(src).toContain('let body: { eventId?: unknown; tier?: unknown; couponCode?: unknown; capacity?: unknown; services?: unknown; expectedTotalPaise?: unknown; agreement?: unknown }')
    expect(src).toContain('staleQuote(body.expectedTotalPaise, finalPricePaise)')
    expect(src).toContain('parseServiceSelection(body.services)')
    // No money field is even declared on the body type, so none can be read.
    for (const forbidden of ['body.amount', 'body.amountPaise', 'body.totalPaise', 'body.gst',
                             'body.gstPaise', 'body.basePaise', 'body.rate', 'body.activationRate',
                             'body.freeCapacity', 'body.price', 'body.pricePaise']) {
      expect(src, `purchase route reads ${forbidden} from the request`).not.toContain(forbidden)
    }
  })

  it('the purchase amount is the SERVER quote, computed from resolved terms', () => {
    const src = code(PURCHASE)
    expect(src).toContain('const terms  = await getEventCommercialTerms(eventId)')
    expect(src).toContain('calculateActivationQuote({ capacity: capacityRequested, terms })')
    expect(src).toContain('quotedPricePaise = quoted.quote.totalPaise')
    // …and that quote is what the order + Razorpay order are built from.
    // RD-LEGACY-01 — the quote ALONE: no tier price is looked up any more.
    expect(src).toContain('pricePaise: quotedPricePaise,')
    expect(src).not.toContain('effectivePricePaise')
  })

  // RD-LICENSE-PAYMENT-01 — the E2E-02 `|| capacitySnapshot` persist existed only for a
  // wallet-covered capacity activation. That path is gone: a payable capacity order always
  // reaches the Razorpay branch, which persists the order (with its snapshot) BEFORE checkout.
  it('creates the Razorpay order for the FULL price and persists the capacity order before checkout', () => {
    const src = code(PURCHASE)
    // RD-F2A — same rule; the persist now also reports a racing PAID order ('already_paid').
    expect(src).toContain("if ((couponFields || supersededExisting) && (await persistCreatedOrder(null)) === 'already_paid') return alreadyPaidMidway()")
    expect(src).not.toContain('|| capacitySnapshot) await persistCreatedOrder(null)')
    expect(src).toContain('razorpayAmountPaise: finalPricePaise,')
    expect(src).toMatch(/createLicenseRazorpayOrder\(\{[\s\S]*?amountPaise: pricePaise,[\s\S]*?\}\)\s*if \(\(await persistCreatedOrder\(razorpayOrderId\)\) === 'already_paid'\) return alreadyPaidMidway\(\)/)
    expect(src).toContain("checkout: { provider: 'razorpay', razorpayOrderId, amountPaise: pricePaise,")
  })

  it('a rejected capacity fails with its own reason instead of falling back to a tier price', () => {
    const src = code(PURCHASE)
    const block = src.slice(src.indexOf('calculateActivationQuote'))
    expect(block).toContain("failureReason: 'invalid_capacity'")
    expect(block).toContain('status: 422')
  })

  it('the capacity is handed to the validator RAW — never coerced', () => {
    const src = code(PURCHASE)
    for (const coercion of ['Number(body.capacity)', 'parseInt(body.capacity', 'parseFloat(body.capacity',
                            '+body.capacity', 'Math.round(body.capacity']) {
      expect(src, `purchase route coerces the capacity via ${coercion}`).not.toContain(coercion)
    }
  })
})

// ═══ 2 · confirm settles against the stored order, not the request ════════════

describe('confirmation', () => {
  const src = code(CONFIRM)

  it('takes the capacity price from the PERSISTED order, never from the body', () => {
    expect(src).toContain("preExisting?.commercialModel === 'capacity' ? preExisting.capacityChange ?? null : null")
    // RD-EVENT-COMMERCE-02 — the order's own LIST price (capacity snapshot + stored service lines).
    expect(src).toContain('let pricePaise  = capacityCharge ? orderListPricePaise(preExisting, 0) : 0')
    for (const forbidden of ['body.capacity', 'body.amount', 'body.gst', 'body.totalPaise', 'body.basePaise']) {
      expect(src, `confirm reads ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('re-checks the stored snapshot’s own arithmetic before settling anything', () => {
    // A stored value is still a value. If base + GST does not equal the total, or the base
    // is not rate × chargeable, the record has been altered and must not settle a payment.
    expect(src).toContain('capacityCharge.basePaise + capacityCharge.gstPaise === capacityCharge.totalPaise')
    expect(src).toContain('capacityCharge.chargeableCapacity * capacityCharge.activationRatePaise === capacityCharge.basePaise')
    expect(src).toContain('status: 409')
  })

  it('keeps every pre-existing payment verification: signature, fetch, amount, currency, order', () => {
    expect(src).toContain('verifier.verifySignature({ orderId, paymentId, signature })')
    expect(src).toContain('razorpay.payments.fetch(paymentId)')
    expect(src).toContain("payment.currency !== 'INR'")
    // RD-LICENSE-PAYMENT-01 — the amount checked is the WHOLE price the Razorpay order was made for.
    expect(src).toContain('payment.amount !== razorpayAmountPaise')
    expect(src).toContain('payment.order_id !== expectedOrderId')
    expect(src).toContain('flagSuspiciousPayment')
  })

  it('refuses to "confirm" a zero-cost activation, which no payment backs', () => {
    expect(src).toContain("error: 'This activation does not require payment'")
  })

  it('still settles through the ONE shared activation transaction', () => {
    expect(src).toContain('await activateLicenseOrder({')
    expect(src).toContain('capacitySnapshot: capacityCharge')
    // and introduces no transaction of its own
    expect((src.match(/runTransaction/g) ?? [])).toHaveLength(0)
  })
})

// ═══ 3 · one activation implementation, still idempotent ══════════════════════

describe('the shared activation transaction', () => {
  const src = code(FINALIZE)

  it('short-circuits an already-paid order, so a replay writes nothing', () => {
    expect(src).toContain("if (orderSnap.exists && orderSnap.data()?.status === 'paid') return 'already'")
  })

  it('keeps its deterministic order id, so a replay cannot mint a second order', () => {
    expect(src).toContain('doc(`lic_${eventId}`)')
    // RD-LICENSE-PAYMENT-01 — the `license_<eventId>` communication-wallet ledger row is gone:
    // activation writes no walletTransactions entry at all.
    expect(src).not.toContain('walletTransactions')
  })

  it('writes the capacity snapshot onto the paid order, marking the commercial model', () => {
    expect(src).toContain("commercialModel: 'capacity' as const")
    expect(src).toContain('capacityChange:  input.capacitySnapshot ?? persisted?.capacityChange')
  })

  it('falls back to the order’s own snapshot when the caller has no quote (webhook replay)', () => {
    expect(src).toContain('input.capacitySnapshot ?? persisted?.capacityChange')
  })

  it('still re-checks the coupon cap INSIDE the transaction, and refuses an underpaid order there', () => {
    const txn = src.slice(src.indexOf('runTransaction'))
    expect(txn).toContain('await txn.get(couponRef)')
    expect(txn).toContain("return 'coupon_exhausted'")
    // RD-LICENSE-PAYMENT-01 — no wallet read or 'insufficient' outcome; a Razorpay amount short
    // of the price is refused instead of being made up from the communication wallet.
    expect(txn).not.toContain('walletRef')
    expect(txn).not.toContain("return 'insufficient'")
    expect(txn).toContain("return 'underpaid'")
  })

  it('is the only activation implementation — exactly one runTransaction', () => {
    expect((src.match(/runTransaction/g) ?? [])).toHaveLength(1)
  })
})

// ═══ 4 · the webhook backstop prices a capacity order correctly ═══════════════

describe('the webhook backstop', () => {
  const src = code(WEBHOOK)

  it('prices a capacity order from its snapshot, not from a tier', () => {
    // Settling a captured capacity payment against the free tier's ₹0 would record a ₹0
    // activation for real money — the single worst failure available on this path.
    expect(src).toContain("persisted.commercialModel === 'capacity' ? persisted.capacityChange ?? null : null")
    // RD-EVENT-COMMERCE-02 — capacity snapshot total (or tier price) + stored service lines.
    expect(src).toContain('basePricePaise:    orderListPricePaise(persisted, def.licensePricePaise)')
    expect(src).toContain('capacitySnapshot: capacityCharge')
  })

  it('still verifies the captured amount and currency against the persisted Razorpay amount', () => {
    expect(src).toContain("paymentCurrency !== 'INR' || paymentAmount !== razorpayAmountPaise")
    expect(src).toContain('flagSuspiciousPayment')
  })

  it('still routes through the shared activation rather than its own', () => {
    expect(src).toContain('activateLicenseOrder({')
    expect(src).not.toContain('function activateCapacityOrder')
  })
})

// ═══ 5 · publish stores the EXACT capacity ════════════════════════════════════

describe('publish', () => {
  const src = code(PUBLISH)

  it('no longer round-trips the capacity through a bucket', () => {
    // The defect this migration removes: licence limit → CAPACITY_PLANS bucket → that
    // bucket's limit, which published a request for 437 as 500.
    expect(src).not.toContain('const licenseMaxRegistrations = defFor(resolvedTier).limits.maxRegistrations\n  const capacityPlan  = capacityPlanForRegistrationLimit(licenseMaxRegistrations)')
    expect(src).toContain('totalCapacity    = quoted.quote.capacity')
  })

  it('re-quotes the draft’s requested capacity server-side', () => {
    expect(src).toContain('typeof draft.registrationCapacity === \'number\' ? draft.registrationCapacity : null')
    expect(src).toContain('calculateActivationQuote({ capacity: requestedCapacity, terms })')
    expect(src).toContain('await getGlobalCommercialTerms()')
  })

  it('refuses to publish a chargeable capacity that no paid order covers', () => {
    expect(src).toContain('paidCapacityCharge !== null && paidCapacityCharge.capacity >= quoted.quote.capacity')
    expect(src).toContain("reason: 'CAPACITY_PAYMENT_REQUIRED'")
    expect(src).toContain('status: 402')
  })

  // RD-LICENSE-E2E-01 — every capacity order carries the free tier as a compatibility stamp,
  // so the legacy Starter "one active event" rule refused an organizer's second event AFTER
  // its activation fee was captured (reproduced: 403 on a paid 1,206-capacity draft).
  // RD-LEGACY-01 — the Starter "one active event" rule is gone (there is no Starter plan).
  it('has no legacy one-active-event rule; the capacity is resolved once', () => {
    expect(src).not.toMatch(/isFreeTier\(|starterActiveEventCount|validatePublishEligibility/)
    expect(src.match(/const requestedCapacity/g)).toHaveLength(1)
  })

  // RD-LICENSE-E2E-03 — a missing capacity used to fall through to free tier → pack_200 → 200.
  it('refuses a capacity-less draft unless it carries a PAID legacy licence', () => {
    // RD-LEGACY-01 — the entitlement is a PAID, NON-capacity (historical) tier ORDER — never the draft.
    expect(src).toContain('const hasLegacyPaidEntitlement = legacyTier !== null')
    expect(src).toMatch(/order\.status === 'paid' && order\.commercialModel !== 'capacity'/)
    expect(src).toContain('if (requestedCapacity === null && !hasLegacyPaidEntitlement) {')
    expect(src).toContain("reason: 'CAPACITY_NOT_CONFIGURED'")
    // …and refuses BEFORE governance can record a publish baseline or anything is written.
    const refuse = src.indexOf("reason: 'CAPACITY_NOT_CONFIGURED'")
    expect(refuse).toBeLessThan(src.indexOf('await governPublish('))
    expect(refuse).toBeLessThan(src.indexOf('runTransaction'))
  })

  it('only trusts a PAID capacity order', () => {
    expect(src).toContain("order?.commercialModel === 'capacity' && order.status === 'paid'")
  })

  it('preserves the legacy tier-derived path for drafts with no chosen capacity', () => {
    // Grandfathering: a pre-migration draft must publish exactly as it did before.
    const legacy = src.slice(src.indexOf('} else {'), src.indexOf('// LS1'))
    expect(legacy).toContain('defFor(resolvedTier).limits.maxRegistrations')
    expect(legacy).toContain('capacityPlanForRegistrationLimit(licenseMaxRegistrations)')
    expect(legacy).toContain('resolveTotalCapacity(capacityPlan)')
  })

  it('still writes capacityPlan for backward compatibility, derived FROM the exact capacity', () => {
    expect(src).toContain('capacityPlan     = capacityPlanForRegistrationLimit(quoted.quote.capacity)')
    expect(src).toContain('capacityPlan,\n        totalCapacity,')
  })

  it('still links the licence to the paid order and records the real amount', () => {
    // Non-obvious and load-bearing. `hasPaidOrder` compares the ORDER's tier to the draft's
    // tier, and a capacity order carries the version's free tier as its compatibility stamp —
    // the same value the draft now always holds. So the comparison passes and the licence gets
    // `orderId` + `amountPaise` from the capacity order. If the purchase route ever stamped a
    // different tier, a paid activation would silently record ₹0 and no order id.
    expect(src).toContain('const resolvedOrderId     = hasPaidOrder ? `lic_${draftId}` : null')
    expect(src).toContain("const resolvedAmountPaise = hasPaidOrder && typeof order?.amountPaise === 'number' ? order.amountPaise : 0")
    // Both sides of that comparison resolve to the version default when nothing is chosen.
    expect(code(PURCHASE)).toContain('defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION)')
    expect(src).toContain('defaultLicenseTierForVersion(currentVersion)')
  })

  it('records the capacity and its pricing on the licence in the SAME transaction as the event', () => {
    expect(src).toContain('activation:      activationCharge')
    expect(src).toContain('capacity:        totalCapacity')
    expect(src).toContain('capacityOpSeq:   0')
  })

  it('does not pull the registration gate into the publish path', () => {
    // Publish legitimately CREATES the counter document — that is pre-existing behaviour
    // and untouched here. What must not happen is publish acquiring an opinion about
    // enforcement: the gate stays the only place capacity is enforced at registration time.
    expect(src).not.toContain('checkRegistrationGate')
    expect(src).not.toContain('lib/registrations/gate')
    // …and the capacity block itself writes no counter.
    const block = src.slice(src.indexOf('const requestedCapacity'), src.indexOf('const rawLinkedCampaign'))
    expect(block).not.toContain('registrationCounters')
  })
})

// ═══ 6 · the snapshot is a faithful, self-verifying record ════════════════════

describe('the charge snapshot', () => {
  it('carries every input and output of the quote it froze', () => {
    const r = calculateActivationQuote({ capacity: 437, terms: DEFAULT_COMMERCIAL_TERMS })
    if (!r.ok) throw new Error(r.message)
    const snap = capacityChargeSnapshot(r.quote)
    expect(snap).toMatchObject({
      operation: 'activation', capacity: 437, previousCapacity: null,
      freeCapacity: 100, activationRatePaise: 150, chargeableCapacity: 337,
      basePaise: 50_550, gstRatePercent: 18, gstPaise: 9_099, totalPaise: 59_649,
    })
    // self-verifying: both identities the confirm route re-checks hold
    expect(snap.basePaise + snap.gstPaise).toBe(snap.totalPaise)
    expect(snap.chargeableCapacity * snap.activationRatePaise).toBe(snap.basePaise)
    expect(snap.terms).toEqual(DEFAULT_COMMERCIAL_TERMS)
  })

  it('deep-copies the terms, so a later configuration change cannot rewrite history', () => {
    const terms = { ...DEFAULT_COMMERCIAL_TERMS }
    const r = calculateActivationQuote({ capacity: 500, terms })
    if (!r.ok) throw new Error(r.message)
    const snap = capacityChargeSnapshot(r.quote)
    terms.activationRatePaise = 9_999
    terms.gstRatePercent = 0
    expect(snap.terms.activationRatePaise).toBe(150)
    expect(snap.terms.gstRatePercent).toBe(18)
    expect(snap.totalPaise).toBe(70_800)
  })

  it('omits the decrease-only fields on an activation, rather than storing zeros', () => {
    const r = calculateActivationQuote({ capacity: 500, terms: DEFAULT_COMMERCIAL_TERMS })
    if (!r.ok) throw new Error(r.message)
    const snap = capacityChargeSnapshot(r.quote)
    expect('removedCapacityValuePaise' in snap).toBe(false)
    expect('decreaseFeePercent' in snap).toBe(false)
  })
})

// ═══ 7 · order identity keeps activation and changes separate ═════════════════

describe('order identity', () => {
  it('a capacity change never collides with the event’s single activation order', () => {
    // `lic_<eventId>` must stay a singleton: the activation transaction short-circuits on
    // `paid`, so a capacity change written to that id would be silently swallowed as an
    // idempotent replay — a free capacity increase.
    expect(capacityOrderDocId('summer-run-2026', 1)).toBe('cap_summer-run-2026_1')
    expect(capacityOrderDocId('summer-run-2026', 1)).not.toBe('lic_summer-run-2026')
  })

  it('is deterministic in the sequence number, so retrying ONE change is idempotent', () => {
    expect(capacityOrderDocId('e', 3)).toBe(capacityOrderDocId('e', 3))
    expect(capacityOrderDocId('e', 3)).not.toBe(capacityOrderDocId('e', 4))
  })

  it('distinguishes a capacity change from an activation and from a tier upgrade', () => {
    expect(isCapacityChangePurpose('capacity_increase')).toBe(true)
    expect(isCapacityChangePurpose('capacity_decrease')).toBe(true)
    expect(isCapacityChangePurpose('purchase')).toBe(false)
    expect(isCapacityChangePurpose('upgrade')).toBe(false)
    expect(isCapacityChangePurpose(undefined)).toBe(false)
  })
})

// ═══ 8 · the protected surfaces stayed protected ══════════════════════════════

describe('blast radius', () => {
  it('the registration gate and the counter transaction were not touched', () => {
    for (const f of ['lib/registrations/gate.ts', 'lib/firebase/firestore/registrations.ts']) {
      expect(code(f), `${f} was pulled into the licensing migration`).not.toContain('capacityPricing')
      expect(code(f)).not.toContain('capacityCommercial')
    }
    // totalCapacity remains the single enforced value the gate reads.
    expect(code('lib/registrations/gate.ts')).toContain('totalCapacity')
  })

  it('the wallet, settlement and payout modules were not touched', () => {
    for (const f of ['lib/wallet/resolveWalletConfig.ts', 'lib/billing/feeEngine.ts']) {
      expect(code(f), `${f} imports the capacity engine`).not.toContain('capacityPricing')
    }
  })

  it('the pure engine reaches no infrastructure at all', () => {
    // Checked against the CODE, not the comments: the module headers discuss businessConfig
    // and Firestore deliberately, to say where the values come from and why they are copied.
    for (const f of ['lib/licensing/capacityPricing.ts', 'lib/licensing/capacityCommercial.ts']) {
      const src = code(f)
      for (const forbidden of ['firebase', 'adminDb', 'razorpay', 'businessConfig', 'Date.now', 'process.env', 'import(']) {
        expect(src, `${f} reaches ${forbidden}`).not.toContain(forbidden)
      }
      // The only import either module may have is the other one.
      const imports = (src.match(/^import .*$/gm) ?? [])
      for (const line of imports) expect(line, `${f}: ${line}`).toContain('./capacityCommercial')
    }
  })
})
