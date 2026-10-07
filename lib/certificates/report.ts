// RD-REPORT-05 — Certificate reporting: the PURE view model.
//
// No I/O, no SDK, no React. Reuses the cell vocabulary RD-REPORT-03 established
// (`known` / `unknown` / `notApplicable`) so BIB, Timing and Certificate sections
// answer with one grammar.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  WHAT THIS MODULE REFUSES TO INVENT                                       ║
// ║                                                                           ║
// ║  ISSUED      the store has no issuance state distinct from generation.    ║
// ║              `status` is generated | emailed | revoked | failed | pending, ║
// ║              and the timestamp is `generatedAt`. So this reports           ║
// ║              GENERATED, and never relabels it "Issued".                    ║
// ║                                                                           ║
// ║  VERIFIED    nothing anywhere records a verification event. There is a     ║
// ║              verificationToken, which is a capability to verify — not      ║
// ║              evidence that anyone did. No Verified metric exists here.     ║
// ║                                                                           ║
// ║  DOWNLOADED  is real: `downloadCount` is incremented on download. But the  ║
// ║              count needs an index that is not deployed, so it arrives NULL ║
// ║              and prints "—". Never 0.                                      ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import {
  knownCell, unknownCell, calculateCoverage, cellText, coverageText,
  type BibCell, type BibCoverage,
} from '@/lib/identifiers/bibReport'

export { cellText, coverageText }
export type { BibCell as CertCell, BibCoverage as CertCoverage }

export function fromCount(n: number | null | undefined, reason = 'This figure could not be read.'): BibCell {
  return typeof n === 'number' ? knownCell(n) : unknownCell(reason)
}

export const CERTIFICATES_DISABLED_REASON =
  'Certificates are not enabled for this event.'

export const DOWNLOADS_UNAVAILABLE_REASON =
  'Download counts require a Firestore index that is not deployed yet.'

// ─── Input, exactly as the stats route serves it ────────────────────────────

export interface CertificateReportInput {
  enabled:    boolean
  total:      number | null
  generated:  number | null
  /** `status == 'emailed'` — legacy-shaped, 0 on modern data. See `emailedSent`. */
  emailed:    number | null
  /** RD-CERT-01 · the authoritative delivery signals. */
  emailedSent?:      number | null
  emailedDelivered?: number | null
  revoked:    number | null
  failed:     number | null
  downloaded: number | null
  eligible:   number | null
  refunded:   number | null
}

export type CertificateReport =
  | { applicable: false; reason: string }
  | {
      applicable: true
      eligible:   BibCell
      /** Certificates that currently stand — generated or emailed. NOT revoked/failed. */
      issuedTotal: BibCell
      generated:  BibCell
      emailed:    BibCell
      revoked:    BibCell
      failed:     BibCell
      downloaded: BibCell
      /** Eligible participants with no standing certificate. */
      pending:    BibCell
      coverage:   BibCoverage
      /** Confirmed participants excluded because their payment was refunded. */
      refundedExcluded: BibCell
      hasIntegrityWarning: boolean
      eligibleDescription: string
    }

/** The eligible population, stated once, in the engine's own terms. */
export const ELIGIBLE_DESCRIPTION = 'confirmed registrations, excluding refunded payments'

/** Subtraction only where both sides are known and the result is not absurd. */
function difference(a: BibCell, b: BibCell): BibCell {
  if (a.state !== 'known' || b.state !== 'known') {
    return unknownCell(a.reason ?? b.reason ?? 'Not measured.')
  }
  const d = (a.value ?? 0) - (b.value ?? 0)
  return d < 0 ? unknownCell('More certificates exist than the eligible population contains.') : knownCell(d)
}

export function buildCertificateReport(input: CertificateReportInput): CertificateReport {
  if (!input.enabled) {
    return { applicable: false, reason: CERTIFICATES_DISABLED_REASON }
  }

  const eligible   = fromCount(input.eligible)
  const generated  = fromCount(input.generated)
  // RD-CERT-01 · the DISPLAYED "Emailed" is the authoritative delivery signal, not
  // `status == 'emailed'`, which the modern send path never sets. Identical
  // derivation to the Certificate Overview.
  const emailed    = buildCertificateOverview({
    total: input.total, generated: input.generated, emailed: input.emailed,
    emailedSent: input.emailedSent ?? null, emailedDelivered: input.emailedDelivered ?? null,
    revoked: input.revoked, failed: input.failed, downloadsTotal: null,
  }).emailed
  const revoked    = fromCount(input.revoked)
  const failed     = fromCount(input.failed)
  const downloaded = fromCount(input.downloaded, DOWNLOADS_UNAVAILABLE_REASON)

  /**
   * A STANDING certificate is one that was produced and has not been invalidated:
   *
   *     total − revoked − failed
   *
   * ═══ RD-CERT-01 · WHY THIS CHANGED ═══════════════════════════════════════════
   * It was `generated + emailed`, on the belief that a sent certificate moves to
   * `status: 'emailed'`. It does not. Only the LEGACY writer sets that status; the
   * modern send path (`recordCertificateEmail`) updates `emailStatus` and leaves
   * `status` as `generated`. The old form happened to produce the right number on
   * modern data — because the second term was always 0 — but it would have silently
   * double-counted the moment a legacy-shaped document appeared.
   *
   * Deriving from the total is exact under BOTH shapes, and it is the identical
   * derivation the Certificate Overview now uses, so the two surfaces cannot drift.
   */
  const issuedTotal = (() => {
    const t = fromCount(input.total)
    if (t.state !== 'known' || revoked.state !== 'known' || failed.state !== 'known') {
      return unknownCell('Some certificate states could not be read.')
    }
    return knownCell(Math.max(0, (t.value ?? 0) - (revoked.value ?? 0) - (failed.value ?? 0)))
  })()
  const pending     = difference(eligible, issuedTotal)
  const coverage    = calculateCoverage(issuedTotal, eligible)

  return {
    applicable: true,
    eligible, issuedTotal, generated, emailed, revoked, failed, downloaded,
    pending, coverage,
    refundedExcluded: fromCount(input.refunded),
    // More standing certificates than eligible people, or any failure, is worth
    // an organizer's attention before the event closes.
    hasIntegrityWarning:
      coverage.exceedsEligible ||
      (failed.state === 'known' && (failed.value ?? 0) > 0),
    eligibleDescription: ELIGIBLE_DESCRIPTION,
  }
}

// ─── RD-CERT-01 · the Certificate Overview ──────────────────────────────────
//
// The workspace Overview and Reports now derive from ONE aggregate payload, so the
// two surfaces cannot disagree. What differs is only which questions each asks:
// Reports asks about coverage against an eligible population; the Overview asks
// about the certificates themselves.

export interface CertificateOverview {
  /** Every certificate document for the event, in any state. */
  total:     BibCell
  /**
   * Successfully produced certificates that still stand.
   *
   * total − revoked − failed. A FAILED certificate is a record of an attempt, not a
   * certificate; the previous client-side calculation was `total − revoked`, which
   * counted failures as generated. A REVOKED one has been invalidated.
   */
  generated: BibCell
  /**
   * Certificates successfully emailed: `emailStatus` sent or delivered.
   *
   * NOT `status == 'emailed'` — the modern send path never sets that. Not email
   * attempts, queue rows or history entries either: those record that a send was
   * tried, not that it landed.
   */
  emailed:   BibCell
  revoked:   BibCell
  failed:    BibCell
  /** Σ downloadCount — download EVENTS, the card's long-standing meaning. */
  downloads: BibCell
}

export function buildCertificateOverview(input: {
  total: number | null; generated: number | null; emailed: number | null
  emailedSent: number | null; emailedDelivered: number | null
  revoked: number | null; failed: number | null; downloadsTotal: number | null
}): CertificateOverview {
  const total   = fromCount(input.total)
  const revoked = fromCount(input.revoked)
  const failed  = fromCount(input.failed)

  const standing = total.state === 'known' && revoked.state === 'known' && failed.state === 'known'
    ? knownCell(Math.max(0, (total.value ?? 0) - (revoked.value ?? 0) - (failed.value ?? 0)))
    : unknownCell('Some certificate states could not be read.')

  // `sent` and `delivered` are disjoint terminal states, so they add. A legacy
  // document carrying `status: 'emailed'` has no `emailStatus`, so it is included
  // too — otherwise an event with legacy-shaped records would report 0 emailed.
  const emailedParts = [input.emailedSent, input.emailedDelivered, input.emailed]
  const emailed = emailedParts.every(n => typeof n === 'number')
    ? knownCell(emailedParts.reduce<number>((s, n) => s + (n as number), 0))
    : unknownCell('The delivery state could not be read.')

  return {
    total, generated: standing, emailed, revoked, failed,
    downloads: fromCount(input.downloadsTotal),
  }
}
