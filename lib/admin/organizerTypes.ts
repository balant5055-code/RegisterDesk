// Shared types for organizer account moderation (Phase 0 + Organizer Management).
// Backward compatible: an organizer doc with NO accountStatus field is treated
// as 'active' everywhere (see lib/admin/organizerStatus.ts).

export type AccountStatus = 'active' | 'suspended' | 'banned'

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
