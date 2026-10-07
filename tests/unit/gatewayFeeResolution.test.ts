// RD-FIN-10 · Gateway fee resolution, and the fee/tax/refund separations around it.
//
// The reconciliation that prompted this proved three things about the gateway's own numbers,
// and every test here defends one of them:
//
//   1. `fee` is TAX-INCLUSIVE. The statement satisfies amount − fee = credit, so adding the
//      reported tax to the reported fee counts the tax twice and overstates the gateway's cut.
//   2. Coverage is partial for a long time. Actual fees arrive on new payments while
//      historical rows still carry only an estimate, so a workspace sits in a MIXED state
//      that must be neither rounded up to "actual" nor thrown away as "estimated".
//   3. A refund is not a cancellation. Money returned and a registration's status are
//      different facts from different sources, and neither may be derived from the other.
//
// `resolveGatewayFee` is pure, so the arithmetic is tested directly rather than through a
// Firestore double. The figures below are synthetic — nothing here encodes any real event.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveGatewayFee } from '@/lib/finance/gatewayFee'

const src = (p: string) => readFileSync(p, 'utf8')

/** A covered-row aggregate: actual + tax + the estimate OF THOSE SAME ROWS. */
const covered = (count: number, actual: number, tax: number, estimateOfCovered: number) => ({
  count,
  sums: {
    gatewayFeeActualPaise:   actual,
    gatewayTaxPaise:         tax,
    gatewayFeeEstimatePaise: estimateOfCovered,
  },
})

describe('resolveGatewayFee — nothing reconciled', () => {
  it('reports the estimate AS an estimate when no row carries an actual', () => {
    const r = resolveGatewayFee({ total: 775, estimateAll: 835030, covered: covered(0, 0, 0, 0) })
    expect(r.basis).toBe('estimated')
    expect(r.fee).toEqual({ ok: true, paise: 835030 })
    expect(r.coverage).toEqual({ withActual: 0, total: 775 })
  })

  it('refuses to call a zero-coverage tax ₹0 — absence is not a value', () => {
    const r = resolveGatewayFee({ total: 775, estimateAll: 835030, covered: covered(0, 0, 0, 0) })
    expect(r.tax.ok).toBe(false)
    expect(r.tax).toEqual({ ok: false, reason: 'no_authoritative_field' })
  })

  it('says requires_index — not "no data" — when the covered-row read never ran', () => {
    const r = resolveGatewayFee({ total: 775, estimateAll: 835030, covered: null })
    expect(r.basis).toBe('estimated')
    expect(r.fee).toEqual({ ok: true, paise: 835030 })
    expect(r.tax).toEqual({ ok: false, reason: 'requires_index' })
    // Coverage is UNKNOWN, which is not the same as zero.
    expect(r.coverage.withActual).toBeNull()
  })
})

describe('resolveGatewayFee — fully reconciled', () => {
  it('uses the actual and drops the estimate entirely', () => {
    const r = resolveGatewayFee({ total: 100, estimateAll: 25000, covered: covered(100, 23610, 3601, 25000) })
    expect(r.basis).toBe('actual')
    expect(r.fee).toEqual({ ok: true, paise: 23610 })
    expect(r.tax).toEqual({ ok: true, paise: 3601 })
  })

  it('reports the actual even when the estimate sum could not be read', () => {
    const r = resolveGatewayFee({ total: 100, estimateAll: null, covered: covered(100, 23610, 3601, 0) })
    expect(r.basis).toBe('actual')
    expect(r.fee).toEqual({ ok: true, paise: 23610 })
  })

  it('treats coverage beyond the counted total as fully reconciled, never as mixed', () => {
    // Rows can be added between the two aggregates; the resolver must not flip to `mixed`
    // on a race that means the opposite of incomplete.
    const r = resolveGatewayFee({ total: 100, estimateAll: 25000, covered: covered(101, 23610, 3601, 25000) })
    expect(r.basis).toBe('actual')
  })
})

describe('resolveGatewayFee — the mixed state', () => {
  // 100 rows, estimate ₹250.00 in total. 40 are reconciled: their actual is ₹94.44 and
  // their estimate had been ₹100.00. The other 60 keep their ₹150.00 estimate.
  const mixed = resolveGatewayFee({
    total: 100, estimateAll: 25000, covered: covered(40, 9444, 1440, 10000),
  })

  it('is reported as mixed, not rounded to either neighbour', () => {
    expect(mixed.basis).toBe('mixed')
    expect(mixed.coverage).toEqual({ withActual: 40, total: 100 })
  })

  it('resolves per transaction: actual for the 40, estimate for the 60', () => {
    // 9444 + (25000 − 10000) = 24444. Each row contributes exactly one of its two figures.
    expect(mixed.fee).toEqual({ ok: true, paise: 24444 })
  })

  it('never lets a row contribute both its actual and its estimate', () => {
    const bothCounted = 9444 + 25000
    const neitherKind = 25000
    expect(mixed.fee.ok && mixed.fee.paise).not.toBe(bothCounted)
    expect(mixed.fee.ok && mixed.fee.paise).not.toBe(neitherKind)
  })

  it('refuses to guess the blend when the all-rows estimate is unreadable', () => {
    const r = resolveGatewayFee({ total: 100, estimateAll: null, covered: covered(40, 9444, 1440, 10000) })
    expect(r.fee).toEqual({ ok: false, reason: 'query_failed' })
    expect(r.basis).toBe('mixed')
  })
})

describe('the gateway fee is TAX-INCLUSIVE', () => {
  it('never adds tax to fee — the resolved fee equals the actual, tax and all', () => {
    const actual = 23610, tax = 3601
    const r = resolveGatewayFee({ total: 10, estimateAll: 24000, covered: covered(10, actual, tax, 24000) })
    expect(r.fee).toEqual({ ok: true, paise: actual })
    expect(r.fee.ok && r.fee.paise).not.toBe(actual + tax)
  })

  it('satisfies the statement identity amount − fee = credit, with tax inside the fee', () => {
    // The relation the export proved. If tax were a sibling charge this would not hold.
    const amount = 100000, fee = 2360, tax = 360
    const credit = amount - fee
    expect(credit).toBe(97640)
    expect(tax).toBeLessThanOrEqual(fee)
    const r = resolveGatewayFee({ total: 1, estimateAll: 2500, covered: covered(1, fee, tax, 2500) })
    expect(amount - (r.fee.ok ? r.fee.paise : 0)).toBe(credit)
  })

  it('publishes fee and tax as separate readable components', () => {
    const r = resolveGatewayFee({ total: 5, estimateAll: 12500, covered: covered(5, 11805, 1801, 12500) })
    expect(r.fee.ok && r.tax.ok).toBe(true)
    expect(r.tax.ok && r.tax.paise).toBeLessThan(r.fee.ok ? r.fee.paise : 0)
  })
})

describe('the reader keeps the four fees apart', () => {
  const FINANCE = 'lib/finance/financeAnalytics.ts'
  const DASH    = 'app/api/organizer/dashboard/route.ts'
  const code    = src(FINANCE)

  it('exposes platform fee, its GST, gateway fee and gateway tax as distinct fields', () => {
    for (const field of ['platformFeeBase', 'platformFeeGst', 'platformFeeTotal', 'totalFees']) {
      expect(code).toContain(field)
    }
  })

  it('builds platformFeeTotal from platform components ONLY — no gateway term', () => {
    const line = code.split('\n').find(l => l.includes('money(s.platformFeeBasePaise'))
    expect(line).toBeDefined()
    expect(line).toContain('platformFeeGstPaise')
    expect(line).not.toContain('gateway')
  })

  it('builds totalFees from the RESOLVED gateway fee, so the total cannot lag its parts', () => {
    expect(code).toContain('platformFeeTotal.paise + gateway.fee.paise')
  })

  it('the dashboard total is built from the resolved fee, not the estimate', () => {
    const dash = src(DASH)
    expect(dash).toContain('feePlatform + feeGateway')
    expect(dash).not.toContain('feePlatform + feeGatewayEst')
  })

  it('the dashboard ships the basis and coverage beside the number', () => {
    const dash = src(DASH)
    for (const f of ['gatewayFeePaise', 'gatewayBasis', 'gatewayTaxPaise', 'gatewayCoverage']) {
      expect(dash).toContain(f)
    }
  })
})

describe('a refund is not a cancellation', () => {
  // RD-FIN-15 moved the query itself into lib/refunds/registrationRefunds.ts so the finance
  // dashboard and the reports read refunds through ONE function. What remains here is the
  // date window and the totalling.
  const code = src('lib/finance/financeAnalytics.ts')
  // Bounded at the function's own closing brace — a slice running to end-of-file would drag
  // in every later function and make these assertions meaningless.
  // RE-ANCHORED (RD-ANALYTICS-12-32). `getRefundTotals` now delegates to `readRefundSource`
  // (the one acquisition) and `refundTotalsFromRead` (the unchanged arithmetic); the region
  // under test spans all three so every assertion below still sees the code it pins.
  const start = code.indexOf('export async function getRefundTotals')
  const derive = code.indexOf('export function refundTotalsFromRead')
  const refundFn = code.slice(start, code.indexOf('\n}', derive) + 2)

  it('reads the shared refund ledger reader, not the registrations collection', () => {
    expect(refundFn).toContain('listOrganizerRefunds')
    expect(refundFn).not.toContain('reg()')
    expect(refundFn).not.toContain("collection('registrations')")
  })

  it('never consults a registration or payment STATUS to total refunds', () => {
    for (const forbidden of ['cancelled', 'paymentStatus', "'refunded'", 'status']) {
      expect(refundFn).not.toContain(forbidden)
    }
  })

  it('counts refunds that are linked to no registration rather than dropping them', () => {
    expect(refundFn).toContain('unlinked')
    expect(refundFn).toContain('!r.registrationId')
  })

  it('bounds the read and admits truncation instead of reporting a partial sum', () => {
    expect(refundFn).toContain('REFUND_READ_CAP')
    expect(refundFn).toContain("gone('out_of_budget')")
    expect(refundFn).toContain('complete: false')
  })

  it('reports an unreadable ledger as unavailable, never as ₹0', () => {
    expect(refundFn).toContain("gone('query_failed')")
  })
})

describe('unattributed refunds are recovered, not dropped', () => {
  // RD-FIN-13. `ensureRegistrationRefundRecord` deliberately persists a refund BEFORE
  // resolving one, so a refund that could not be attributed still exists — with a null
  // organizerUid. A reader that scopes strictly by organizerUid drops every one of them,
  // and real money that left the account becomes invisible on every finance page.
  const shared  = src('lib/refunds/registrationRefunds.ts')
  const code    = src('lib/finance/financeAnalytics.ts')
  const start   = shared.indexOf('async function recoverUnattributed(')
  const recover = shared.slice(start, shared.indexOf('\n}', start) + 2)

  it('queries the null-organizer pool explicitly', () => {
    expect(recover).toContain("where('organizerUid', '==', null)")
  })

  it('attributes through the PAYMENT INTENT, never a registration', () => {
    expect(recover).toContain("collection('paymentIntents')")
    expect(recover).toContain('intent.organizerUid !== organizerUid')
    expect(recover).not.toContain('paymentStatus')
    expect(recover).not.toContain('cancelled')
    expect(recover).not.toContain("collection('registrations')")
  })

  it('refuses to attribute a refund whose intent belongs to another organizer or event', () => {
    // RD-DASH-13 · the per-candidate reads now run concurrently, so rejecting a candidate
    // is `return null` inside the map rather than `continue` inside a loop. The TEST is
    // the same one: attribution is decided by the intent, never assumed.
    expect(recover).toMatch(/intent\.organizerUid !== organizerUid\) return null/)
    expect(recover).toMatch(/eventSlug && intent\.eventSlug !== eventSlug\) return null/)
    expect(recover).toMatch(/Promise\.all\(withOrder\.map/)
  })

  it('leaves a refund with no intent unattributed rather than guessing an owner', () => {
    expect(recover).toContain('if (!snap.exists) return null')
    // RD-DASH-13 · a refund with no gateway order id is now filtered out before the reads
    // rather than skipped inside the loop. Same rule: no intent, no attribution.
    expect(recover).toContain('candidates.filter(r => !!r.gatewayOrderId)')
  })

  it('bounds the scan so an unowned collection is never swept without a ceiling', () => {
    expect(recover).toContain('UNATTRIBUTED_REFUND_SCAN_CAP')
    expect(recover).toMatch(/total > UNATTRIBUTED_REFUND_SCAN_CAP\) return \{ records: \[\], complete: false \}/)
  })

  it('reports the recovery in the totals rather than hiding it', () => {
    // RE-ANCHORED (RD-ANALYTICS-12-32): the arithmetic lives in refundTotalsFromRead.
    const s = code.indexOf('export function refundTotalsFromRead')
    const fn = code.slice(s, code.indexOf('\n}', s) + 2)
    expect(fn).toContain('recovered: recoveredInRange')
    expect(code).toContain('recovered: number | null')
  })

  it('de-duplicates by refund id even though the two pools cannot overlap', () => {
    const s = shared.indexOf('export async function listOrganizerRefunds')
    const fn = shared.slice(s, shared.indexOf('\n}', s) + 2)
    expect(fn).toContain('const seen  = new Set(')
    expect(fn).toContain('!seen.has(')
  })

  it('still applies the date window to recovered refunds', () => {
    // RE-ANCHORED (RD-ANALYTICS-12-32): the arithmetic lives in refundTotalsFromRead.
    const s = code.indexOf('export function refundTotalsFromRead')
    const fn = code.slice(s, code.indexOf('\n}', s) + 2)
    expect(fn).toContain('withinRange(r.createdAt, scope.from, scope.to)')
  })

  it('is the SAME reader the reports use — one definition, not two', () => {
    // The whole point of the move: a refund cannot be visible on the dashboard and missing
    // from an export, because both call this function.
    expect(code).toContain("from '@/lib/refunds/registrationRefunds'")
    expect(src('lib/reports/builders.ts')).toContain('listOrganizerRefunds')
  })
})

describe('the gateway coverage index is declared in the shape Firestore requires', () => {
  // RD-FIN-13: the first declaration listed the aggregated fields in authoring order. An
  // aggregation index must list them ALPHABETICALLY after the filter/orderBy fields — the
  // deployed index was therefore unusable and the reader kept falling back to the estimate.
  const indexes = JSON.parse(src('firestore.indexes.json')) as {
    indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order?: string }> }>
  }
  const gateway = indexes.indexes.filter(i =>
    i.collectionGroup === 'platformTransactions' &&
    i.fields.some(f => f.fieldPath === 'gatewayFeeActualPaise'))

  // RD-RACEOPS-02C · the Firestore index reconciliation (2026-09-12) recovered production's
  // two ORIGINAL gateway indexes — the authoring-order shape RD-FIN-13 replaced — so the
  // file now declares the canonical pair AND the legacy pair. The canonical pair is what
  // this suite guards; the legacy pair is tolerated only in its exact known shape, so a
  // third ordering or a lost canonical index still fails here.
  const AGG_CANONICAL = ['gatewayFeeActualPaise', 'gatewayFeeEstimatePaise', 'gatewayTaxPaise']
  const AGG_LEGACY    = ['gatewayFeeActualPaise', 'gatewayTaxPaise', 'gatewayFeeEstimatePaise']
  const aggOf = (idx: (typeof gateway)[number]) => idx.fields.map(f => f.fieldPath).filter(p => p.startsWith('gateway'))
  const canonical = gateway.filter(idx => aggOf(idx).join() === AGG_CANONICAL.join())
  const legacy    = gateway.filter(idx => aggOf(idx).join() === AGG_LEGACY.join())

  it('declares both the workspace and event-scoped canonical shapes', () => {
    expect(canonical).toHaveLength(2)
    expect(canonical.some(i => i.fields.some(f => f.fieldPath === 'entityId'))).toBe(true)
    expect(canonical.some(i => !i.fields.some(f => f.fieldPath === 'entityId'))).toBe(true)
  })

  it('lists the aggregated fields alphabetically on the canonical pair', () => {
    for (const idx of canonical) {
      const agg = aggOf(idx)
      expect(agg).toEqual([...agg].sort())
      expect(agg).toEqual(AGG_CANONICAL)
    }
  })

  it('carries no gateway index beyond the canonical pair and the two recovered legacy ones', () => {
    expect(legacy.length).toBeLessThanOrEqual(2)
    expect(gateway).toHaveLength(canonical.length + legacy.length)
  })

  it('keeps the equality filters ahead of the aggregated fields', () => {
    for (const idx of gateway) {
      const names = idx.fields.map(f => f.fieldPath)
      expect(names.indexOf('organizerUid')).toBeLessThan(names.indexOf('gatewayFeeActualPaise'))
      if (names.includes('entityId')) {
        expect(names.indexOf('entityId')).toBeLessThan(names.indexOf('gatewayFeeActualPaise'))
      }
    }
  })
})

describe('settlements and reversals are not revenue', () => {
  const code = src('lib/finance/financeAnalytics.ts')

  it('the finance reader has no settlement or reversal money source at all', () => {
    // Settlement is a bank transfer of money already counted; a reversal returns a refund
    // FEE. Neither is a payment, so neither may enter a revenue or transaction total.
    expect(code).not.toContain('settlementAmount')
    expect(code).not.toContain("collection('settlements')")
    expect(code).not.toContain('reversalPaise')
  })

  it('organizerPayable is documented as the settlement BASIS, not a payout', () => {
    expect(code).toContain('the settlement basis')
  })
})
