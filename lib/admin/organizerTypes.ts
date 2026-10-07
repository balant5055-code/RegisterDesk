// Shared types for organizer account moderation (Phase 0 + Organizer Management).
// Backward compatible: an organizer doc with NO accountStatus field is treated
// as 'active' everywhere (see lib/admin/organizerStatus.ts).
//
// ═══ RD-ORGANIZER-SIGNUP-02 · 'pending' ══════════════════════════════════════
// A signup writes users/{uid} (role: organizer) BEFORE the email OTP is verified,
// because the profile carries form data the verification round-trip does not, and
// because orphan recovery decides "incomplete signup vs real duplicate" by asking
// whether that profile exists. The row therefore has to be there — but it is not yet
// an organizer anyone should see. `pending` is what that row is: created, not
// activated. `verify-otp` flips it to `active` inside its existing transaction.
//
// The other three values keep their exact meanings. `pending` is NOT a moderation
// state: nobody suspends or bans their way into it, and no admin action produces it
// (ACTION_CONFIG maps suspend/reactivate/ban only).

export type AccountStatus = 'active' | 'pending' | 'suspended' | 'banned'

/**
 * The ONE place a stored `accountStatus` becomes an effective one.
 *
 * ═══ WHY THIS EXISTS ════════════════════════════════════════════════════════
 * Three copies of this rule had been written independently — in the admin list
 * route, in organizer360Service and in organizerStatus — each spelled
 * `s === 'suspended' || s === 'banned' ? s : 'active'`. That shape is correct for
 * three values and silently WRONG for a fourth: it coerces anything it does not
 * recognise to `active`, so adding `pending` to the union would have published every
 * unverified signup as an active organizer through all three readers at once. The
 * rule now lives beside the type it interprets, and the fallback is explicit.
 *
 * A missing field still means `active` — that is the backward-compatibility contract
 * for every organizer created before this field existed, and it is deliberately NOT
 * changed here. Only a document that explicitly says `pending` reads as pending.
 */
export function resolveAccountStatus(stored: unknown): AccountStatus {
  return stored === 'pending' || stored === 'suspended' || stored === 'banned'
    ? stored
    : 'active'
}

/**
 * Moderation fields layered onto the existing users/{uid} document.
 * All optional — absent fields mean the organizer has never been moderated
 * (effective status: 'active').
 */
export interface OrganizerModerationFields {
  accountStatus?:   AccountStatus
  statusReason?:    string
  statusUpdatedAt?: unknown   // Firestore Timestamp
  statusUpdatedBy?: string    // admin uid
}

// ─── API shapes ──────────────────────────────────────────────────────────────

/** Row in the admin organizer list. Kept lightweight (no aggregates). */
export interface AdminOrganizerSummary {
  uid:              string
  name:             string
  email:            string
  organizationName: string
  accountStatus:    AccountStatus   // effective (missing → 'active')
  statusReason:     string | null
  createdAt:        string | null   // ISO 8601
}

export interface AdminOrganizersListResponse {
  items:      AdminOrganizerSummary[]
  nextCursor: string | null
}

/** Lightweight payout-profile summary for the detail view. */
export interface AdminOrganizerPayoutSummary {
  exists:       boolean
  isVerified:   boolean
  payoutMethod: 'bank' | 'upi' | null
  verifiedAt:   string | null
}

/** Lightweight wallet summary for the detail view. */
export interface AdminOrganizerWalletSummary {
  exists:         boolean
  pendingPaise:   number
  availablePaise: number
  inTransitPaise: number
  settledPaise:   number
}

export interface AdminOrganizerSettlementSummary {
  id:          string
  amountPaise: number
  status:      string
  requestedAt: string | null
}

export interface AdminOrganizerDetail {
  profile: {
    uid:              string
    name:             string
    email:            string
    organizationName: string
    role:             string
    accountStatus:    AccountStatus
    statusReason:     string | null
    statusUpdatedAt:  string | null
    statusUpdatedBy:  string | null
    createdAt:        string | null
  }
  wallet:        AdminOrganizerWalletSummary
  payoutProfile: AdminOrganizerPayoutSummary
  settlements:   AdminOrganizerSettlementSummary[]
  eventCount:    number
  campaignCount: number
}

/** Mutation payload + response. */
export type AdminOrganizerAction = 'suspend' | 'reactivate' | 'ban'

export interface AdminOrganizerPatchResponse {
  uid:           string
  accountStatus: AccountStatus
}
