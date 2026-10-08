// RD-WALLET-W1 — pure rules and source contracts for wallet top-up payment safety. The
// behaviour on real Firestore is proved in tests/emulator/walletTopupW1.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const code = (f: string) => readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('W1.5 · license_refund is a declared, labelled CREDIT', async () => {
  const { isWalletCredit, walletTxnTypeLabel } = await import('@/lib/finance/txnMeta')
  const { WALLET_TXN_TYPE_LABELS } = await import('@/lib/wallet/types')

  it('classified as a credit with a label (it rendered as a blank debit before)', () => {
    expect(isWalletCredit('license_refund')).toBe(true)
    expect(walletTxnTypeLabel('license_refund')).toBe('Event License Refund')
    expect(WALLET_TXN_TYPE_LABELS.license_refund).toBe('Event License Refund')
  })
  it('the existing classification is unchanged', () => {
    expect(isWalletCredit('fund_added')).toBe(true)
    expect(isWalletCredit('refund')).toBe(true)
    for (const debit of ['license_charge', 'email_charge', 'sms_charge', 'whatsapp_charge', 'broadcast_sms', 'broadcast_whatsapp', 'certificate_charge', 'adjustment'] as const) {
      expect(isWalletCredit(debit), debit).toBe(false)
    }
  })
  it('every UI credit set includes it', () => {
    for (const f of [
      'app/(dashboard)/dashboard/wallet/transactions/TransactionsClient.tsx',
      'app/(dashboard)/dashboard/settings/billing/page.tsx',
      'lib/finance/txnMeta.ts',
    ]) {
      expect(code(f), f).toContain("new Set<WalletTxnType>(['fund_added', 'license_refund', 'refund'])")
    }
  })
  it('the writer still uses that type (licensing behaviour untouched)', () => {
    expect(code('lib/admin/licenseAdminService.ts')).toMatch(/type:\s*'license_refund'/)
  })
})

describe('W1.6 · the legacy non-idempotent creditWallet is gone', () => {
  it('not exported, and no caller references it', () => {
    const src = code('lib/firebase/firestore/wallet.ts')
    expect(src).not.toMatch(/export async function creditWallet\b/)
    expect(src).toMatch(/export async function atomicTopupCredit/)
    expect(src).toMatch(/export async function atomicWalletCredit/)
  })
})

describe('W1.1 / W1.2 · the credit rules are in the code paths', () => {
  it('verify never credits an authorized payment', () => {
    const src = code('app/api/organizer/wallet/topup/verify/route.ts')
    expect(src).not.toMatch(/payment\.status === 'captured' \|\| payment\.status === 'authorized'\s*\n?\s*if/)
    expect(src).toContain("PAYMENT_NOT_CAPTURED")
    const authorizedBranch = src.indexOf("if (payment.status === 'authorized')")
    const credit = src.indexOf('await atomicTopupCredit(')
    expect(authorizedBranch).toBeGreaterThan(-1)
    expect(authorizedBranch).toBeLessThan(credit)          // returns before any credit
  })
  it('the cron re-verifies capture with the gateway before replaying a credit', () => {
    const src = code('lib/wallet/topupReconciliation.ts')
    const fetchAt  = src.indexOf('razorpay.payments.fetch(')
    const creditAt = src.indexOf('await atomicTopupCredit(')
    expect(fetchAt).toBeGreaterThan(-1)
    expect(fetchAt).toBeLessThan(creditAt)
    expect(src).toContain("payment.status !== 'captured'")
  })
  it('the credit transaction refuses unverifiable orders and creates (never overwrites) the ledger row', () => {
    const src = code('lib/firebase/firestore/wallet.ts')
    for (const c of ['TOPUP_NOT_FOUND', 'TOPUP_OWNER_MISMATCH', 'TOPUP_AMOUNT_MISMATCH', 'TOPUP_NOT_CREDITABLE', 'TOPUP_LEDGER_CONFLICT']) {
      expect(src, c).toContain(`new TopupCreditError('${c}')`)
    }
    expect(src).toMatch(/txn\.create\(ledgerRef,/)
  })
})

describe('W1.7 · provider safety', () => {
  // RD-COMMS-P1 — the top-up ORDER route is retired: it mints no order with ANY provider (410), so
  // there is no provider choice left to make. verify / webhook / reconciliation still settle the
  // orders created before retirement.
  it('the order route is retired: auth, then 410 — it never mints a payment order', () => {
    const src = code('app/api/organizer/wallet/topup/route.ts')
    expect(src).toContain("authorizeWorkspace(req, 'wallet')")
    expect(src).toContain("code: 'COMMUNICATION_TOPUP_RETIRED'")
    expect(src).toContain('status: 410')
    expect(src).not.toMatch(/razorpay|orders\.create|walletTopups|adminDb/i)
  })
})

describe('RD-WALLET-W2.c · an order-level review hold is enforced INSIDE the credit transaction', () => {
  const src = code('lib/firebase/firestore/wallet.ts')
  const fn = src.slice(src.indexOf('export async function atomicTopupCredit'))
  it('reads walletTopupReconciliation/{orderId} in the same transaction as the credit', () => {
    expect(fn).toContain("adminDb.collection('walletTopupReconciliation').doc(orderId)")
    expect(fn).toContain('txn.get(holdRef)')
  })
  it('refuses needs_review with TOPUP_REVIEW_HOLD — after the idempotent credited replay, before any write', () => {
    const replay = fn.indexOf("if (topup.status === 'credited')")
    const holdAt = fn.indexOf("new TopupCreditError('TOPUP_REVIEW_HOLD')")
    const write  = fn.indexOf('txn.set(wRef')
    expect(replay).toBeGreaterThan(-1)
    expect(holdAt).toBeGreaterThan(replay)
    expect(holdAt).toBeLessThan(write)
    expect(fn).toContain("holdStatus === 'needs_review' || holdStatus === 'exhausted'")
    expect(fn).not.toMatch(/holdStatus !== 'pending'/)                        // not "every non-pending state"
  })
  it('every automated credit path goes through atomicTopupCredit (so none can bypass the hold)', () => {
    for (const f of ['app/api/webhooks/razorpay/route.ts', 'app/api/organizer/wallet/topup/verify/route.ts', 'lib/wallet/topupReconciliation.ts']) {
      const body = code(f)
      expect(body, f).toContain('atomicTopupCredit(')
      expect(body, f).not.toMatch(/collection\('walletTransactions'\)\.doc\(`topup_/)   // no second writer of the ledger row
    }
  })
})
