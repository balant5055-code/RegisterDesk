// RD-LICENSE-PAYMENT-01 — event activation and capacity changes are structurally independent
// of the communication wallet.
//
// RegisterDesk runs three separate financial systems:
//   • licensing / event activation → Razorpay only
//   • communication wallet (`organizerWallets`) → WhatsApp / bulk / SMS usage only
//   • revenue wallet (`organizerRevenueWallets`) → registration revenue / settlement only
//
// Until this change the licensing code read the communication wallet, spent it first and sent
// only the remainder to Razorpay. The behaviour is proved on real Firestore by
// tests/emulator/licensingRazorpayOnly.emu.test.ts; THIS suite makes the separation structural:
// a future edit that reaches for either wallet from the licensing payment path fails here,
// long before it can move money.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Source with comment lines stripped, so the explanatory prose never counts as code. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*')
  }).join('\n')

// Every module on the activation + capacity-change PAYMENT path, server and client.
const PAYMENT_PATH = [
  'app/api/licensing/purchase/route.ts',
  'app/api/licensing/checkout/confirm/route.ts',
  'app/api/licensing/capacity/order/route.ts',
  'app/api/licensing/capacity/confirm/route.ts',
  'lib/licensing/finalizeLicensePurchase.ts',
  'lib/licensing/capacityChange.ts',
  'components/dashboard/EventCapacityManager.tsx',
]

describe('licensing never touches the communication wallet', () => {
  for (const f of PAYMENT_PATH) {
    it(`${f} reads, debits and writes no wallet`, () => {
      const src = code(f)
      for (const forbidden of [
        'organizerWallets', 'organizerRevenueWallets', 'walletTransactions',
        'getWalletBalance', 'getWalletConfig', 'txnDeductWallet', 'resolveWalletConfig',
        '@/lib/firebase/firestore/wallet', 'walletUsePaise', 'walletApplies', 'wallet_first',
      ]) {
        expect(src, `${f} references ${forbidden}`).not.toContain(forbidden)
      }
    })
  }

  it('the webhook backstop settles licensing without any wallet outcome', () => {
    const src = code('app/api/webhooks/razorpay/route.ts')
    expect(src).not.toContain("kind === 'insufficient'")
    expect(src).toContain("activation.kind === 'underpaid'")
    expect(src).toContain("applied.kind === 'underpaid'")
  })
})

describe('Razorpay collects the WHOLE amount', () => {
  it('activation: the Razorpay order and the persisted order carry the full final price', () => {
    const src = code('app/api/licensing/purchase/route.ts')
    expect(src).toContain('razorpayAmountPaise: finalPricePaise,')
    expect(src).toContain('amountPaise: pricePaise,')
    expect(src).not.toMatch(/remainderPaise\s*=/)
  })

  it('capacity change: the order is created for the whole quoted total', () => {
    expect(code('lib/licensing/capacityChange.ts')).toContain('const razorpayAmountPaise = quote.totalPaise')
    // RD-L6 — both capacity routes create the Razorpay order through the shared helper.
    expect(code('lib/licensing/capacityOrderCheckout.ts')).toContain("amount: r.razorpayAmountPaise, currency: 'INR'")
  })

  it('an order whose Razorpay amount is not the whole price is refused, everywhere it could settle', () => {
    // The pure derivation both confirm and the activation transaction read from.
    const fin = code('lib/licensing/finalizeLicensePurchase.ts')
    expect(fin).toContain('const underpaid           = !alreadyPaid && finalPricePaise > 0 && razorpayAmountPaise !== finalPricePaise')
    expect(fin).toContain("if (underpaid) return 'underpaid'")
    expect(code('app/api/licensing/checkout/confirm/route.ts')).toContain('if (underpaid) {')
    // Capacity: refused in the route BEFORE the verification branch, and again in the txn.
    const capConfirm = code('app/api/licensing/capacity/confirm/route.ts')
    expect(capConfirm.indexOf('if (razorpayAmountPaise !== charge.totalPaise) {'))
      .toBeLessThan(capConfirm.indexOf('if (razorpayAmountPaise > 0) {'))
    expect(code('lib/licensing/capacityChange.ts')).toContain("if (razorpayAmountPaise !== total) {")
  })

  it('reusing a pending order is only allowed when it already asks Razorpay for the whole price', () => {
    const src = code('app/api/licensing/purchase/route.ts')
    expect(src).toContain('const coversFullPrice = remainder === existing.amountPaise')
    // RD-EVENT-COMMERCE-02 — also superseded when the persisted order is for a different selection.
    expect(src).toContain("if (decision === 'supersede' || !coversFullPrice || !sameSelection) {")
  })
})

describe('the activation UI shows no wallet split', () => {
  it('the capacity panel treats a missing checkout as an error, never as "nothing to pay"', () => {
    const src = code('components/dashboard/EventCapacityManager.tsx')
    expect(src).toContain("if (!data.checkout) { setPhase('idle'); setError('Could not start the payment. Please try again.'); return }")
  })
})

describe('communication billing is untouched', () => {
  it('still debits its own wallet and writes its own ledger', () => {
    const src = code('lib/communications/billing.ts')
    expect(src).toContain('organizerWallets/${args.organizerUid}')
    expect(src).toContain("collection('walletTransactions').doc(`broadcast_${args.campaignId}`)")
  })

  it('the historical `license_charge` ledger type stays readable', () => {
    // Pre-change activations wrote `license_charge` rows; they must keep their label.
    expect(code('lib/wallet/types.ts')).toContain("license_charge:     'Event License Payment'")
  })
})
