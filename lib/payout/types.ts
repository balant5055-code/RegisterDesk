export type PayoutMethod = 'bank' | 'upi'

export interface OrganizerPayoutProfileDoc {
  uid:               string
  accountHolderName: string
  payoutMethod:      PayoutMethod
  bankName:          string | null
  accountNumber:     string | null
  ifscCode:          string | null
  upiId:             string | null
  panNumber:         string
  gstNumber:         string | null
  isVerified:        boolean
  verifiedAt:        unknown | null  // Firestore Timestamp or null
  verifiedBy:        string | null   // admin UID or null
  /**
   * RD-PHASE4-S4 · D5 — the version (profile updatedAt, ms) of the details the admin verified.
   * Dropped by every organizer PUT (a full replace), so an edit always un-binds. See lib/payout/binding.ts.
   */
  verifiedVersion?:  number | null
  rejectionNote:     string | null
  createdAt:         unknown  // Firestore Timestamp
  updatedAt:         unknown  // Firestore Timestamp

  // ── Cashfree vendor preparation (Phase C) ─────────────────────────────────
  //
  // ALL OPTIONAL and absent on every existing document. Nothing here duplicates a bank
  // detail, a PAN or a GSTIN — those stay encrypted in the fields above and are never
  // copied into vendor metadata.
  //
  // `isVerified` above is RegisterDesk's own payout check and is unrelated to Cashfree.
  // An organizer can be `isVerified: true` and have no Cashfree vendor at all.

  /**
   * The vendor id Cashfree issued, once a vendor genuinely exists there.
   *
   * Written ONLY by a future onboarding integration that received it from Cashfree. It is
   * never generated, never placeholdered and never derived from the uid — a fabricated id
   * looks identical to a real one and would fail only at settlement.
   */
  cashfreeVendorId?:   string | null
  /** RegisterDesk's LOCAL preparation workflow. Not a Cashfree status. */
  vendorStatus?:       import('./vendorStatus').VendorPreparationStatus
  /**
   * Cashfree's KYC verdict. Only ever `unknown` today — the real status set is not a
   * verified contract in this repository, so it cannot be represented yet, let alone set
   * by a local admin review.
   */
  vendorKycStatus?:    import('./vendorStatus').VendorKycStatus
  /** When the vendor was created AT CASHFREE. Absent until that actually happens. */
  vendorCreatedAt?:    unknown | null
  /** When vendor state was last read back FROM Cashfree. Absent until we have asked. */
  vendorLastSyncedAt?: unknown | null
  /** Who performed the last LOCAL review, and why. Admin-only, like `verifiedBy`. */
  vendorReviewedBy?:   string | null
  vendorReviewedAt?:   unknown | null
  vendorReviewNote?:   string | null
}

/**
 * The organizer-facing payout profile.
 *
 * ═══ RD-PAYMENT-ONBOARDING-03 · WHO SEES THE REAL NUMBERS ════════════════════
 * The plaintext identifiers exist for ONE reason: the owner's own edit form has to be
 * pre-filled with what is already stored, or saving would silently blank fields the
 * organizer never touched.
 *
 * Everyone else — a delegated `finance` team member holding the `transactions`
 * permission — gets `null` for those and reads the `*Masked` fields instead. The read
 * route used to decrypt unconditionally, so a finance delegate received the owner's full
 * PAN, account number and IFSC while being forbidden (owner-only PUT) from changing any
 * of them. Read and write now agree about who the secrets belong to.
 *
 * `secretsVisible` says which of the two shapes this is, so a client never has to infer
 * "is this null because I lack permission, or because the field is genuinely empty?".
 */
export interface PayoutProfileSummary {
  uid:               string
  accountHolderName: string
  payoutMethod:      PayoutMethod
  bankName:          string | null
  /** PLAINTEXT — owner only. `null` for every other caller; use `accountNumberMasked`. */
  accountNumber:     string | null
  /** PLAINTEXT — owner only. `null` for every other caller; use `ifscMasked`. */
  ifscCode:          string | null
  upiId:             string | null
  /** PLAINTEXT — owner only. `''` for every other caller; use `panMasked`. */
  panNumber:         string
  gstNumber:         string | null

  // ── Always present, for every caller. Safe to render anywhere. ──
  accountNumberMasked: string | null
  ifscMasked:          string | null
  panMasked:           string | null
  upiMasked:           string | null

  /** true ⇒ the plaintext fields above are populated (owner). false ⇒ masked only. */
  secretsVisible:    boolean

  isVerified:        boolean
  verifiedAt:        string | null
  verifiedBy:        string | null
  rejectionNote:     string | null
  createdAt:         string | null
  updatedAt:         string | null
}

export interface PayoutProfileGetResponse {
  profile: PayoutProfileSummary | null
}

export interface PayoutProfilePutResponse {
  profile: PayoutProfileSummary
}

// ─── Admin-facing types ───────────────────────────────────────────────────────

export interface AdminPayoutProfileSummary {
  uid:                  string
  organizerName:        string
  organizerEmail:       string
  accountHolderName:    string
  payoutMethod:         PayoutMethod
  bankName:             string | null
  accountNumberMasked:  string | null   // e.g. "•••• 1234"
  ifscCode:             string | null
  upiId:                string | null
  panNumberMasked:      string | null   // e.g. "ABCDE****F"
  gstNumber:            string | null
  isVerified:           boolean
  verifiedAt:           string | null
  verifiedBy:           string | null
  rejectionNote:        string | null
  /**
   * Phase C — RegisterDesk's LOCAL vendor-preparation status. Never a Cashfree status.
   * `isVerified` above is a separate, unrelated check.
   */
  vendorStatus:         import('./vendorStatus').VendorPreparationStatus
  /** Whether a Cashfree vendor exists — the id itself is not sent to a list view. */
  hasCashfreeVendor:    boolean
  vendorReviewedAt:     string | null
  createdAt:            string | null
  updatedAt:            string | null
}

export interface AdminPayoutProfilesResponse {
  profiles:    AdminPayoutProfileSummary[]
  total:       number
  page:        number
  pageSize:    number
}

export interface AdminPayoutProfilePatchResponse {
  uid:        string
  isVerified: boolean
}
