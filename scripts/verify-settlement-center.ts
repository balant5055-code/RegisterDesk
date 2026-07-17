// Unit verification for the Settlement Center (Phase H.5.1).
//
// Covers the pure pieces: the metadata-driven status config and the shared
// money/date formatters. The page/components reuse existing endpoints and are
// validated by tsc/eslint/next build + manual QA.
//
// Run: npx tsx scripts/verify-settlement-center.ts   (exits non-zero on failure)

import { SETTLE_STATUS_META, SETTLEMENT_STATUSES, settlementStatusMeta, isSettlementStatus } from '@/lib/settlements/statusMeta'
import { formatCompactINR, formatShortDate } from '@/lib/finance/format'
import type { SettlementTone } from '@/lib/settlements/statusMeta'
import type { SettlementStatus } from '@/lib/settlements/types'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

const EXPECTED: SettlementStatus[] = ['pending', 'approved', 'paid', 'rejected']
const TONES: SettlementTone[] = ['warning', 'info', 'success', 'error']

console.log('── statusMeta: completeness ──')
check('exactly 4 statuses', SETTLEMENT_STATUSES.length === 4)
for (const s of EXPECTED) check(`status '${s}' present`, isSettlementStatus(s))
check('unknown status rejected', !isSettlementStatus('processing'))
check('unknown falls back to safe meta', settlementStatusMeta('zzz').label === 'Unknown')

console.log('── statusMeta: every entry valid ──')
for (const s of EXPECTED) {
  const m = SETTLE_STATUS_META[s]
  check(`'${s}' label non-empty`,   typeof m.label === 'string' && m.label.length > 0)
  check(`'${s}' tone valid`,        TONES.includes(m.tone))
  check(`'${s}' badgeClass set`,    typeof m.badgeClass === 'string' && m.badgeClass.includes('bg-'))
  check(`'${s}' description set`,   typeof m.description === 'string' && m.description.length > 0)
}

console.log('── statusMeta: tones map correctly ──')
check("pending → warning",  SETTLE_STATUS_META.pending.tone === 'warning')
check("approved → info",    SETTLE_STATUS_META.approved.tone === 'info')
check("paid → success",     SETTLE_STATUS_META.paid.tone === 'success')
check("rejected → error",   SETTLE_STATUS_META.rejected.tone === 'error')

console.log('── formatters ──')
check('₹ under 1k exact',    formatCompactINR(50_00)   === '₹50.00')
check('₹ thousands → K',     formatCompactINR(1_500_00) === '₹1.50K')
check('₹ lakhs → L',         formatCompactINR(500_000_000) === '₹5.00L')
check('null date → em dash', formatShortDate(null) === '—')
check('iso date formats',    formatShortDate('2026-07-06T00:00:00Z').length > 0)

console.log('')
if (failures > 0) { console.error(`❌ ${failures} assertion(s) FAILED`); process.exit(1) }
console.log('✅ All Settlement Center assertions passed')
