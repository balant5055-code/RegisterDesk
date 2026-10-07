// RD-REPORT-05 · Certificate reporting — the pure view model.
//
// This file's real subject is RESTRAINT. The certificate store carries a rich status
// union and several timestamps, and it would be easy to render a metric for each.
// Three of them would be lies:
//
//   ISSUED      no issuance state exists distinct from generation
//   VERIFIED    nothing records a verification event
//   DOWNLOADED  is real, but its count needs an index that is not deployed —
//               so it arrives null and must print "—", never 0
//
// The rest pins what "generated" actually means: standing certificates only. A
// revoked certificate has been invalidated and a failed one was never produced;
// counting either as coverage reports work that did not happen.

import { describe, it, expect } from 'vitest'
import {
  buildCertificateReport, buildCertificateOverview, cellText, coverageText, fromCount,
  CERTIFICATES_DISABLED_REASON, DOWNLOADS_UNAVAILABLE_REASON, ELIGIBLE_DESCRIPTION,
} from '@/lib/certificates/report'

const base = {
  enabled: true,
  total: 1024, generated: 725, emailed: 280, revoked: 12, failed: 7,
  downloaded: 520, eligible: 1064, refunded: 16,
}
const build = (over: Partial<typeof base> = {}) => buildCertificateReport({ ...base, ...over })
const ready = (over: Partial<typeof base> = {}) => {
  const r = build(over)
  if (!r.applicable) throw new Error('expected an applicable report')
  return r
}

// ════════════════════════════════════════════════════════════════════════════
// 1 — APPLICABILITY
// ════════════════════════════════════════════════════════════════════════════

describe('1 — an event that does not issue certificates', () => {
  it('produces no figures at all', () => {
    const r = build({ enabled: false })
    expect(r.applicable).toBe(false)
    expect(r).not.toHaveProperty('eligible')
  })

  it('says why', () => {
    const r = build({ enabled: false })
    expect(r.applicable === false && r.reason).toBe(CERTIFICATES_DISABLED_REASON)
  })

  it('stays inapplicable even when certificates exist in the data', () => {
    // Applicability is the stored template flag — never inferred from documents.
    expect(build({ enabled: false, total: 900, generated: 900 }).applicable).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — WHAT "GENERATED" COUNTS
// ════════════════════════════════════════════════════════════════════════════

describe('2 — only STANDING certificates count as coverage', () => {
  it('is total minus the states that are not a standing certificate', () => {
    // RD-CERT-01 · 1,024 documents − 12 revoked − 7 failed = 1,005. Derived from the
    // total rather than by adding statuses, because the modern send path never sets
    // `status: 'emailed'` — see buildCertificateReport.
    expect(cellText(ready().issuedTotal)).toBe('1,005')
  })

  it('a revoked certificate is NOT coverage', () => {
    const r = ready()
    expect(cellText(r.revoked)).toBe('12')
    expect(r.issuedTotal.value).toBe(1005)
  })

  it('a failed certificate is NOT coverage, and raises a warning', () => {
    const r = ready()
    expect(cellText(r.failed)).toBe('7')
    expect(r.issuedTotal.value).toBe(1005)
    expect(r.hasIntegrityWarning).toBe(true)
  })

  it('an event with no failures raises no warning', () => {
    expect(ready({ failed: 0 }).hasIntegrityWarning).toBe(false)
  })

  it('the document total is larger than coverage, and stays separate', () => {
    // 1,024 documents = 1,005 standing + 12 revoked + 7 failed.
    expect(base.total).toBe(1005 + 12 + 7)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — ELIGIBILITY EXCLUDES REFUNDS
// ════════════════════════════════════════════════════════════════════════════

describe('3 — the eligible population', () => {
  it('is confirmed minus refunded, and says so', () => {
    expect(cellText(ready().eligible)).toBe('1,064')
    expect(ready().eligibleDescription).toBe(ELIGIBLE_DESCRIPTION)
  })

  it('reports the refunded exclusion rather than hiding it', () => {
    expect(cellText(ready().refundedExcluded)).toBe('16')
  })

  it('pending is eligible minus standing certificates', () => {
    expect(cellText(ready().pending)).toBe('59')
    expect(coverageText(ready().coverage)).toBe('94.5%')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — EDGE STATES
// ════════════════════════════════════════════════════════════════════════════

describe('4 — zero, all, none, unknown', () => {
  it('zero eligible is N/A completion, not 0%', () => {
    const r = ready({ eligible: 0, generated: 0, emailed: 0, total: 0, revoked: 0, failed: 0, refunded: 0 })
    expect(cellText(r.eligible)).toBe('0')
    expect(coverageText(r.coverage)).toBe('N/A')
  })

  it('eligible but none generated IS an exact 0 and 0%', () => {
    const r = ready({ generated: 0, emailed: 0, total: 0, revoked: 0, failed: 0 })
    expect(cellText(r.issuedTotal)).toBe('0')
    expect(coverageText(r.coverage)).toBe('0.0%')
    expect(cellText(r.pending)).toBe('1,064')
  })

  // RD-CERT-01 re-anchored the three tests below. The INVARIANTS are unchanged —
  // standing excludes revoked and failed, and an unknown input stays unknown. What
  // changed is the derivation: standing is now `total − revoked − failed` rather
  // than `generated + emailed`, because the modern send path never sets
  // `status: 'emailed'` and the old form would have double-counted a legacy-shaped
  // document. These now drive the inputs that derivation actually reads.
  it('all generated is exactly 100%', () => {
    const r = ready({ total: 1064, generated: 1064, emailed: 0, revoked: 0, failed: 0 })
    expect(coverageText(r.coverage)).toBe('100.0%')
    expect(cellText(r.pending)).toBe('0')
  })

  it('an unreadable aggregate is "—", never 0', () => {
    const r = ready({ eligible: null, total: null, generated: null, emailed: null })
    expect(cellText(r.eligible)).toBe('—')
    expect(cellText(r.issuedTotal)).toBe('—')
    expect(cellText(r.pending)).toBe('—')
    expect(coverageText(r.coverage)).toBe('—')
  })

  it('one unknown state makes the whole standing count unknown', () => {
    // A partial answer is a guess: if the revoked count could not be read, the
    // number of certificates that still stand cannot be stated.
    expect(cellText(ready({ revoked: null }).issuedTotal)).toBe('—')
    expect(cellText(ready({ failed: null }).issuedTotal)).toBe('—')
  })

  it('a null count is unknown while a zero count is a measurement', () => {
    expect(fromCount(null).state).toBe('unknown')
    expect(cellText(fromCount(0))).toBe('0')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5 — METRICS THE SYSTEM DOES NOT SUPPORT
// ════════════════════════════════════════════════════════════════════════════

describe('5 — nothing is invented', () => {
  it('there is no Verified metric, because nothing records verification', () => {
    const r = ready()
    expect(r).not.toHaveProperty('verified')
    expect(JSON.stringify(r)).not.toMatch(/verified/i)
  })

  it('there is no Issued metric distinct from Generated', () => {
    const r = ready()
    expect(r).not.toHaveProperty('issued')
    // The standing count is named `issuedTotal` internally but the store has no
    // issuance state; the UI label is "Generated".
    expect(r).toHaveProperty('generated')
  })

  it('an unavailable download count says why, and prints a dash', () => {
    const r = ready({ downloaded: null })
    expect(cellText(r.downloaded)).toBe('—')
    expect(r.downloaded.reason).toBe(DOWNLOADS_UNAVAILABLE_REASON)
  })

  it('a real download count is shown as counted', () => {
    expect(cellText(ready().downloaded)).toBe('520')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6 — INTEGRITY
// ════════════════════════════════════════════════════════════════════════════

describe('6 — more certificates than people', () => {
  it('is reported, not clamped', () => {
    const r = ready({ eligible: 500, generated: 600, emailed: 0 })
    expect(r.coverage.exceedsEligible).toBe(true)
    expect(r.coverage.percent).toBeGreaterThan(100)
    expect(r.hasIntegrityWarning).toBe(true)
  })

  it('and the impossible subtraction refuses to print a negative', () => {
    const r = ready({ eligible: 500, generated: 600, emailed: 0 })
    expect(cellText(r.pending)).toBe('—')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7 — RD-CERT-01 · THE CERTIFICATE OVERVIEW
// ════════════════════════════════════════════════════════════════════════════

describe('7 — the workspace Overview', () => {
  const ov = (over: Partial<Parameters<typeof buildCertificateOverview>[0]> = {}) =>
    buildCertificateOverview({
      total: 200, generated: 200, emailed: 0,
      emailedSent: 190, emailedDelivered: 8,
      revoked: 0, failed: 0, downloadsTotal: 118,
      ...over,
    })

  it('§19 · reports the whole event, and the five cards reconcile', () => {
    const o = ov()
    expect(cellText(o.total)).toBe('200')
    expect(cellText(o.generated)).toBe('200')
    expect(cellText(o.emailed)).toBe('198')     // 190 sent + 8 delivered
    expect(cellText(o.revoked)).toBe('0')
    expect(cellText(o.downloads)).toBe('118')
  })

  it('a FAILED certificate is not a generated one', () => {
    // The previous client-side form was `total − revoked`, which counted failures
    // as successful certificates.
    const o = ov({ total: 200, failed: 7 })
    expect(cellText(o.generated)).toBe('193')
    expect(cellText(o.failed)).toBe('7')
  })

  it('a REVOKED certificate is not a generated one, but is still a record', () => {
    const o = ov({ total: 200, revoked: 12 })
    expect(cellText(o.total)).toBe('200')
    expect(cellText(o.generated)).toBe('188')
    expect(cellText(o.revoked)).toBe('12')
  })

  it('generated never goes negative even on contradictory input', () => {
    expect(cellText(ov({ total: 5, revoked: 10, failed: 10 }).generated)).toBe('0')
  })

  it('emailed counts DELIVERY, not the legacy status', () => {
    // The modern send path sets emailStatus and leaves `status` as 'generated'.
    const modernOnly = ov({ emailed: 0, emailedSent: 150, emailedDelivered: 0 })
    expect(cellText(modernOnly.emailed)).toBe('150')
    // A legacy-shaped document carries `status: 'emailed'` and no emailStatus, so it
    // is added rather than dropped.
    const withLegacy = ov({ emailed: 20, emailedSent: 150, emailedDelivered: 0 })
    expect(cellText(withLegacy.emailed)).toBe('170')
  })

  it('an unreadable state renders "—" on every affected card, never 0', () => {
    const o = ov({ total: null, revoked: null, downloadsTotal: null, emailedSent: null })
    expect(cellText(o.total)).toBe('—')
    expect(cellText(o.generated)).toBe('—')
    expect(cellText(o.emailed)).toBe('—')
    expect(cellText(o.downloads)).toBe('—')
  })

  it('zero certificates is a real zero, not unknown', () => {
    const o = ov({ total: 0, generated: 0, emailed: 0, emailedSent: 0, emailedDelivered: 0, revoked: 0, failed: 0, downloadsTotal: 0 })
    expect(cellText(o.total)).toBe('0')
    expect(cellText(o.generated)).toBe('0')
    expect(cellText(o.downloads)).toBe('0')
  })

  it('§18 · the Overview and Reports derive standing identically', () => {
    // One derivation, two surfaces — they cannot drift.
    const input = { total: 200, generated: 200, emailed: 0, emailedSent: 190,
                    emailedDelivered: 8, revoked: 12, failed: 7, downloadsTotal: 118 }
    const overview = buildCertificateOverview(input)
    const report   = buildCertificateReport({ ...input, enabled: true, downloaded: null, eligible: 1000, refunded: 0 })
    if (!report.applicable) throw new Error('expected applicable')
    expect(cellText(report.issuedTotal)).toBe(cellText(overview.generated))
    expect(cellText(report.emailed)).toBe(cellText(overview.emailed))
  })
})
