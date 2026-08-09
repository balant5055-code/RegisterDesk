// RD-FINANCE-TAX-CLEANUP-01 · THE GSTIN validator. PURE.
//
// ═══ WHY THIS MODULE EXISTS ══════════════════════════════════════════════════
// The pattern lived inside `lib/platform/pricing/taxProfile.ts`, which is part of the
// DORMANT organizer-GST engine and imports `adminDb` at module scope. Two consequences:
//
//   1. The one field an organizer can actually fill in today — the GSTIN on their PAYOUT
//      profile — had NO format validation, while a correct validator sat on a field no UI
//      can reach. RD-FINANCE-TAX-01 found exactly that inversion.
//   2. Importing the validator from `taxProfile.ts` would boot Firebase Admin, which makes
//      the payout path untestable without an emulator and couples a live money surface to
//      a dormant engine.
//
// So the pattern MOVED here rather than being copied. `taxProfile.ts` now imports it, which
// is why there is still exactly one GSTIN regex in the repository. Its behaviour is pinned
// by the 18 existing tests in tests/unit/tax.test.ts.
//
// No Firestore, no SDK, no env — importable from anywhere, testable in Node.

/**
 * GSTIN: 2-digit state code + 5 alpha (PAN block) + 4 digit + 1 alpha + 1 alnum entity
 * code + literal 'Z' + 1 alnum checksum character.
 *
 * This is a FORMAT check only. It deliberately does NOT verify the checksum digit or that
 * the state code is one that exists — neither is a claim this codebase is in a position to
 * make, and a wrong claim about a tax identifier is worse than no claim.
 */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

/**
 * True when `value` is a well-formed GSTIN.
 *
 * Case-sensitive by design: a GSTIN is canonically upper-case, and both call sites
 * upper-case before validating. Callers decide whether an ABSENT value is acceptable —
 * this function answers only "is this string a GSTIN", so an empty string is not one.
 */
export function isValidGstin(value: string | null | undefined): boolean {
  return typeof value === 'string' && GSTIN_RE.test(value)
}
