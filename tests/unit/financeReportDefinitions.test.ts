// RD-FIN-15 · The finance DEFINITIONS, enforced across every surface that shows money.
//
// The RD-FIN-14 audit found the dashboard correct and the reports wrong, in ways that all
// came from the same root: each surface reconstructed the definitions for itself. A payout
// statement summed RegisterDesk's fee and Razorpay's into one field named `platformFeesPaise`
// and then subtracted the result from gross to "derive" a payable — understating a real
// organizer's payout by the entire fee total.
//
// So these tests are about the definitions themselves, not about any one event:
//
//   Platform Fee   ≠  Razorpay Fee      — two companies, never merged into one figure
//   Razorpay Tax   ⊂  Razorpay Fee      — a component inside it, never added to it
//   Razorpay Fee   =  actual ?? estimate, with the basis always travelling alongside
//   Organizer Payable = the STORED settlement, never gross − fees − refunds
//   Refunds        =  the refund ledger, including refunds nobody could attribute
//
// The pure arithmetic is exercised directly. The rest is asserted at the source level,
// because the alternative — booting Firestore — is what stopped these paths being tested at
// all. No production data, no Noyyal identifier and no reconciled total appears here.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  readReportFromLedger, readFinanceFromLedger,
} from '@/lib/platform/pricing/financeSnapshot'

const src = (p: string) => readFileSync(p, 'utf8')

/** A minimal ledger row. Synthetic figures — nothing here mirrors a real event. */
const row = (over: Record<string, number> = {}) => ({
  grossAmountPaise:        100_00,
  platformFeeBasePaise:      1_00,
  platformFeeGstPaise:         18,
  platformFeeTotalPaise:     1_18,
  gatewayFeeEstimatePaise:   2_50,
  netSettlementPaise:      100_00,
  ...over,
})

// ═══ 3 · actual is preferred over estimate ═══════════════════════════════════

describe('the report reader resolves actual over estimate', () => {
  it('uses the recorded actual when the row carries one', () => {
    const f = readReportFromLedger(row({ gatewayFeeActualPaise: 2_36, gatewayTaxPaise: 36 }))
    expect(f.gatewayFeePaise).toBe(2_36)
    expect(f.gatewayFeeBasis).toBe('actual')
    expect(f.gatewayFeeActualPaise).toBe(2_36)
  })

  it('falls back to the estimate only when no actual exists', () => {
    const f = readReportFromLedger(row())
    expect(f.gatewayFeePaise).toBe(2_50)
    expect(f.gatewayFeeBasis).toBe('estimated')
    expect(f.gatewayFeeActualPaise).toBeNull()
  })

  it('reports an unreconciled row as null, never as a ₹0 gateway charge', () => {
    const f = readReportFromLedger(row())
    expect(f.gatewayFeeActualPaise).toBeNull()
    expect(f.gatewayTaxPaise).toBeNull()
    expect(f.gatewayFeeActualPaise).not.toBe(0)
  })

  it('keeps the estimate available beside the actual rather than overwriting it', () => {
    const f = readReportFromLedger(row({ gatewayFeeActualPaise: 2_36, gatewayTaxPaise: 36 }))
    expect(f.gatewayFeeEstimatePaise).toBe(2_50)
    expect(f.gatewayFeePaise).toBe(2_36)
  })

  it('finance and report readers resolve identically — one rule, two namespaces', () => {
    const doc = row({ gatewayFeeActualPaise: 2_36, gatewayTaxPaise: 36 })
    const a = readFinanceFromLedger(doc), b = readReportFromLedger(doc)
    expect(a.gatewayFeePaise).toBe(b.gatewayFeePaise)
    expect(a.gatewayFeeBasis).toBe(b.gatewayFeeBasis)
    expect(a.gatewayTaxPaise).toBe(b.gatewayTaxPaise)
  })

  it('ignores a tax with no actual fee to attach it to', () => {
    // Tax is a component OF the actual. Without one there is nothing for it to be inside.
    const f = readReportFromLedger(row({ gatewayTaxPaise: 36 }))
    expect(f.gatewayTaxPaise).toBeNull()
  })
})

// ═══ 4 · gateway tax is contained, never added ═══════════════════════════════

describe('gateway tax is inside the gateway fee', () => {
  it('the resolved fee equals the actual — tax is not added on top', () => {
    const f = readReportFromLedger(row({ gatewayFeeActualPaise: 2_36, gatewayTaxPaise: 36 }))
    expect(f.gatewayFeePaise).toBe(2_36)
    expect(f.gatewayFeePaise).not.toBe(2_36 + 36)
  })

  it('the tax never exceeds the fee that contains it', () => {
    const f = readReportFromLedger(row({ gatewayFeeActualPaise: 2_36, gatewayTaxPaise: 36 }))
    expect(f.gatewayTaxPaise).toBeLessThanOrEqual(f.gatewayFeePaise)
  })

  it('no finance or report surface adds tax to fee', () => {
    for (const f of [
      'lib/reports/builders.ts', 'lib/reports/pdf.ts', 'lib/finance/financeService.ts',
      'lib/finance/financeAnalytics.ts', 'lib/platform/pricing/financeSnapshot.ts',
      'components/dashboard/finance/TransactionExplorer.tsx',
    ]) {
      const code = src(f)
      expect(code).not.toMatch(/gatewayFeePaise\s*\+\s*gatewayTax/)
      expect(code).not.toMatch(/gatewayTax\w*\s*\+\s*gatewayFee/)
      expect(code).not.toMatch(/gatewayFeeActualPaise\s*\+\s*\w*[Tt]ax/)
    }
  })
})

// ═══ 1 + 2 · the payout statement ════════════════════════════════════════════

describe('the payout statement keeps the two companies apart', () => {
  const builders = src('lib/reports/builders.ts')
  const start = builders.indexOf('export async function buildPayoutStatement')
  const fn = builders.slice(start, builders.indexOf('\n}', start) + 2)

  it('never sums RegisterDesk fee and gateway fee into one "platform" figure', () => {
    expect(fn).not.toMatch(/platformFees\s*=\s*feesBase\s*\+\s*gateway/)
    expect(fn).toContain('const platformFeeTotal = feesBase + gst')
    // Compare the ASSIGNMENT only — a trailing comment may legitimately mention the gateway
    // in order to say the term is deliberately absent.
    const assignment = (fn.split('\n').find(l => l.includes('const platformFeeTotal =')) ?? '')
      .split('//')[0]
    expect(assignment).not.toMatch(/gateway/i)
  })

  it('publishes the components separately, not only an aggregate', () => {
    for (const field of [
      'platformFeeBasePaise', 'platformFeeGstPaise', 'platformFeeTotalPaise',
      'gatewayFeePaise', 'gatewayFeeActualPaise', 'gatewayFeeEstimatePaise',
      'gatewayTaxPaise', 'gatewayFeeBasis', 'totalFeesPaise',
    ]) {
      expect(fn).toContain(field)
    }
  })

  it('names the aggregate "total fees", not "platform fees"', () => {
    expect(fn).toContain('const totalFees        = platformFeeTotal + gatewayResolved')
    // The FIELD is gone from the contract. The name may still appear in prose explaining why.
    expect(src('lib/reports/types.ts')).not.toMatch(/^\s*platformFeesPaise\s*:/m)
    expect(src('lib/reports/pdf.ts')).not.toMatch(/stmt\.platformFeesPaise/)
    expect(fn).not.toMatch(/platformFeesPaise\s*:/)
  })

  it('takes the payable from the STORED settlement, never by subtraction', () => {
    expect(fn).not.toMatch(/gross\s*-\s*platformFees/)
    expect(fn).not.toMatch(/const net\s*=\s*gross\s*-/)
    expect(fn).toContain('net      += fig.netSettlementPaise')
  })

  it('resolves the gateway fee per transaction and reports a mixed set honestly', () => {
    expect(fn).toContain('gatewayResolved += fig.gatewayFeePaise')
    expect(fn).toContain("actualRows === count ? 'actual' : 'mixed'")
  })

  it('the PDF prints the components on separate lines with the basis', () => {
    const pdf = src('lib/reports/pdf.ts')
    expect(pdf).not.toContain("['Platform Fees',")
    expect(pdf).toContain("['Platform Fee',")
    expect(pdf).toContain("['Platform GST',")
    expect(pdf).toContain('Razorpay Fee (${basisLabel})')
    expect(pdf).toContain("['Total Fees',")
  })

  it('the PDF stops presenting the payable as a running subtraction', () => {
    const pdf = src('lib/reports/pdf.ts')
    expect(pdf).not.toContain('-stmt.platformFeesPaise')
    expect(pdf).toContain('Net Settlement is the recorded payable, not gross minus the fees above')
  })
})

// ═══ 5 + 6 · refunds ═════════════════════════════════════════════════════════

describe('the refund report covers registration refunds', () => {
  const builders = src('lib/reports/builders.ts')
  const start = builders.indexOf('export async function buildRefunds')
  const fn = builders.slice(start, builders.indexOf('\n}', start) + 2)

  it('reads BOTH ledgers, not donations alone', () => {
    // RE-ANCHORED (RD-ANALYTICS-12-01). The donation half is now read through the
    // date-scoped, cursor-paged `fetchScoped` instead of `fetchCapped` — the helper was
    // renamed because its behaviour changed, not because this rule did. The rule is
    // unchanged and still asserted: BOTH ledgers are read, and the registration half still
    // goes through the canonical shared reader.
    expect(fn).toContain("fetchScoped('donationRefunds'")
    expect(fn).toContain('listOrganizerRefunds(uid')
    // …and the donation half is genuinely scoped, not merely renamed.
    expect(fn).toContain("'createdAt', f")
  })

  it('goes through the same shared reader the dashboard uses', () => {
    expect(builders).toContain("from '@/lib/refunds/registrationRefunds'")
    expect(src('lib/finance/financeAnalytics.ts')).toContain('listOrganizerRefunds')
  })

  it('keeps unattributed refunds visible and says how they were matched', () => {
    expect(fn).toContain('Unattributed')
    expect(fn).toContain('matched via payment intent')
  })

  it('never manufactures a registration id for an unattributed refund', () => {
    expect(fn).toContain("reference:   String(r.registrationId ?? '')")
    expect(fn).not.toMatch(/registrationId\s*\|\|\s*['`]/)
    expect(fn).not.toContain('registrationId ?? r.gatewayPaymentId')
  })

  it('carries the identifiers a reconciliation actually needs', () => {
    for (const key of ['refundId', 'paymentId', 'reference', 'amount', 'status', 'attribution']) {
      expect(fn).toContain(key + ':')
    }
  })

  it('reports registration and donation refunds as separable totals', () => {
    expect(fn).toContain("label: 'Registration Refunds'")
    expect(fn).toContain("label: 'Donation Refunds'")
  })

  it('is READ-ONLY — no refund document is created, updated or deleted', () => {
    expect(fn).not.toMatch(/\.doc\([^)]*\)\s*\.\s*(set|update|delete)\(/)
    expect(fn).not.toMatch(/ensureRegistrationRefundRecord|linkRefundToRegistration/)
  })

  it('discloses truncation instead of presenting a partial total as whole', () => {
    expect(fn).toContain('!registration.complete')
  })
})

// ═══ 7 + 8 + 9 · the UI displays, it does not calculate ══════════════════════

describe('the UI displays money rather than computing it', () => {
  const explorer = src('components/dashboard/finance/TransactionExplorer.tsx')
  const page     = src('app/(dashboard)/dashboard/finance/page.tsx')

  it('the explorer shows the actual when the row has one', () => {
    expect(explorer).toContain('const gatewayFee  = t.gatewayFeeActualPaise ?? t.gatewayFeeEstimatePaise')
  })

  it('the explorer never prints the estimate under an "actual" label', () => {
    // The defect: the amount came from gatewayFeeEstimatePaise while the word came from
    // gatewayFeeBasis, so a reconciled row read "<estimate> actual".
    expect(explorer).not.toMatch(/formatCompactINR\(t\.gatewayFeeEstimatePaise\)\}\s*\{basis\}/)
    expect(explorer).toContain('{formatCompactINR(gatewayFee)} {basis}')
  })

  it('the explorer derives amount and label from the same basis', () => {
    expect(explorer).toContain("const isActual    = t.gatewayFeeBasis === 'actual'")
    expect(explorer).toContain("const basis       = isActual ? 'actual' : 'estimated'")
  })

  it('the finance page computes no fee total of its own', () => {
    expect(page).not.toMatch(/platformFeeTotalPaise\s*\+\s*\w*[Gg]ateway/)
    expect(page).toContain('formatCompactINR(tx.totalFeesPaise)')
  })

  it('the server supplies the total, with the components still separate', () => {
    const svc = src('lib/finance/financeService.ts')
    expect(svc).toContain('totalFeesPaise:          fig.platformFeeTotalPaise + gatewayFeePaise')
    expect(svc).toContain('platformFeeBasePaise')
    expect(svc).toContain('platformFeeGstPaise')
  })

  it('no surface still claims the actual gateway fee has no writer', () => {
    for (const f of [
      'lib/finance/financeService.ts',
      'components/dashboard/finance/TransactionExplorer.tsx',
      'lib/finance/financeAnalytics.ts',
      'app/api/organizer/dashboard/route.ts',
    ]) {
      expect(src(f)).not.toMatch(/gatewayFeeActualPaise[^\n]*(has no writer|has ZERO writers)/i)
      expect(src(f)).not.toMatch(/Settlements API is not integrated/i)
    }
  })
})

// ═══ 10 + 11 · the capture webhooks ══════════════════════════════════════════

describe('future captures record what the gateway actually charged', () => {
  const reg = src('app/api/webhooks/razorpay/route.ts')
  const don = src('app/api/razorpay/webhook/route.ts')

  it('the registration webhook awaits the write instead of firing and forgetting', () => {
    expect(reg).not.toContain('void recordActualGatewayFee')
    expect(reg).toContain('await recordActualGatewayFee')
  })

  it('the donation webhook records the actual fee too', () => {
    expect(don).toContain('extractActualGatewayFee')
    expect(don).toContain('await recordActualGatewayFee')
  })

  it('the donation write sits ABOVE the idempotency return, as the registration one does', () => {
    // The trap that produced zero actual fees in production: when the browser verify path
    // already completed the payment, the handler returns early and any write below it never
    // runs. The fee is independent of completion state.
    const write = don.indexOf('await recordActualGatewayFee')
    const early = don.indexOf("detail: 'already_successful'")
    expect(write).toBeGreaterThan(0)
    expect(early).toBeGreaterThan(0)
    expect(write).toBeLessThan(early)
  })

  it('both use the shared write-once primitive, creating no ledger row', () => {
    for (const code of [reg, don]) {
      expect(code).toContain("from '@/lib/payments/actualGatewayFee'")
      expect(code).toMatch(/recordActualGatewayFee\(`ptx_\$\{/)
    }
  })

  it('neither webhook moves money in response to an event', () => {
    for (const code of [reg, don]) {
      expect(code).not.toMatch(/payments\s*\.\s*refund/)
      expect(code).not.toMatch(/refunds\s*\.\s*(create|cancel)/)
      expect(code).not.toMatch(/payments\s*\.\s*capture/)
    }
  })
})

// ═══ 12 · one definition, everywhere ═════════════════════════════════════════

describe('no finance surface re-derives a definition for itself', () => {
  it('every ledger-money reader goes through the snapshot reader', () => {
    const builders = src('lib/reports/builders.ts')
    // Money is read via readReportFromLedgerData, never off the raw document.
    expect(builders).toContain('readReportFromLedgerData(d)')
    expect(builders).not.toMatch(/\+=\s*Number\(d\.gatewayFee/)
    expect(builders).not.toMatch(/\+=\s*Number\(d\.platformFee/)
  })

  it('no read path can reach a Razorpay mutation', () => {
    for (const f of [
      'lib/reports/builders.ts', 'lib/reports/pdf.ts', 'lib/finance/financeService.ts',
      'lib/finance/financeAnalytics.ts', 'lib/refunds/registrationRefunds.ts',
      'lib/platform/pricing/financeSnapshot.ts',
    ]) {
      const code = src(f)
      expect(code.toLowerCase()).not.toContain("from 'razorpay'")
      expect(code).not.toMatch(/lib\/razorpay\/client/)
      expect(code).not.toMatch(/payments\s*\.\s*(refund|capture)/)
    }
  })

  it('the report layer writes nothing to Firestore', () => {
    for (const f of ['lib/reports/builders.ts', 'lib/reports/pdf.ts']) {
      const code = src(f)
      expect(code).not.toMatch(/\.doc\([^)]*\)\s*\.\s*(set|update|delete)\(/)
      expect(code).not.toMatch(/collection\([^)]*\)\s*\.\s*add\(/)
      expect(code).not.toMatch(/runTransaction|bulkWriter|\bFieldValue\b/)
    }
  })

  it('carries no hardcoded event, payment or refund identifier', () => {
    for (const f of [
      'lib/reports/builders.ts', 'lib/reports/pdf.ts', 'lib/finance/financeService.ts',
      'lib/finance/financeAnalytics.ts', 'lib/refunds/registrationRefunds.ts',
      'lib/platform/pricing/financeSnapshot.ts',
      'components/dashboard/finance/TransactionExplorer.tsx',
    ]) {
      const code = src(f)
      expect(code).not.toMatch(/noyyal/i)
      expect(code).not.toMatch(/\bpay_[A-Za-z0-9]{8,}/)
      expect(code).not.toMatch(/\brfnd_[A-Za-z0-9]{8,}/)
    }
  })
})
