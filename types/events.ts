// Shared event types used across client, server, and API routes.

// ─── Event Lifecycle ──────────────────────────────────────────────────────────

export type EventLifecycleStatus =
  | 'draft'
  | 'pending_review'          // submitted, awaiting admin approval (manual-approval mode)
  | 'changes_requested'       // admin asked for changes; organizer edits and resubmits
  | 'published'
  | 'registration_closed'
  | 'completed'
  | 'cancelled'
  | 'archived'
  | 'unpublished'             // RECOGNITION ONLY (Phase L2): a previously-published event
                              // taken offline. Recognized across the type system + UI so a
                              // future phase can emit it safely — nothing writes it yet, and
                              // it participates in NO lifecycle transition.

export type LifecycleAction =
  | 'close_registrations'
  | 'reopen_registrations'
  | 'complete'
  | 'cancel'
  | 'archive'
  | 'unpublish'
  | 'approve'                 // admin: pending_review → published
  | 'reject'                  // admin: pending_review → draft (with reason)
  | 'request_changes'         // admin: pending_review → changes_requested (with comment)
  | 'resubmit'                // organizer: changes_requested / rejected-draft → pending_review
  | 'republish'               // organizer: unpublished → pending_review (reuses the existing paid license; no payment)
  | 'restore'                 // organizer: archived → unpublished (stays private; reuses license; re-launch via republish)

// Outcome of the last admin review, surfaced to the organizer.
export type EventReviewStatus = 'rejected' | 'changes_requested'

export interface EventReviewMeta {
  rejectionReason?:   string
  rejectionCategory?: string
  rejectionNotes?:    string
  changesComment?:    string
}

export interface StatusChangeResponse {
  success:          boolean
  lifecycleStatus?: EventLifecycleStatus
  error?:           string
}

export interface DuplicateEventResponse {
  success:  boolean
  draftId?: string
  error?:   string
}

export interface EventEditPayload {
  // Basic info
  name?:      string
  tagline?:   string
  shortDesc?: string
  fullDesc?:  string
  bannerUrl?: string
  logoUrl?:   string
  // Schedule — impactful: triggers change record
  startDate?: string
  startTime?: string
  endDate?:   string
  endTime?:   string
  timezone?:  string
  // Venue — impactful: triggers change record
  venueType?:        string
  venueName?:        string
  venueCity?:        string
  venueAddress?:     string
  venueState?:       string
  venueCountry?:     string
  venuePincode?:     string
  venueMapsLink?:    string
  onlinePlatform?:   string
  onlineMeetingUrl?: string
  // Organizer contact
  organizerName?:    string
  organizerEmail?:   string
  organizerPhone?:   string
  organizerWebsite?: string
  // Content arrays (full replacement)
  speakers?: Array<{
    id: string; name: string; title: string; company: string
    bio: string; photoUrl: string; order: number
  }>
  sponsors?: Array<{
    id: string; name: string; logoUrl: string
    website: string; tier: string; order: number
  }>
  galleryImages?: string[]
  // SEO — slug excluded (locked)
  metaTitle?:       string
  metaDescription?: string
  keywords?:        string[]
  // Pass capacity updates
  passCapacityUpdates?: Array<{ passId: string; newCapacity: number | null }>
}

export interface EventEditResponse {
  success: boolean
  error?:  string
}

// Written to events/{slug}/changeLog when impactful fields (schedule/venue) change
export interface EventChangeRecord {
  changedFields: string[]
  changedAt:     unknown   // Firestore Timestamp
  changedBy:     string    // organizer UID
}



export interface EventCommunication {
  emailEnabled:        boolean
  whatsappEnabled:     boolean
  smsEnabled:          boolean
  certificatesEnabled: boolean
}

export interface CommunicationBilling {
  required:    boolean
  amount:      number        // in paise (₹1 = 100 paise)
  status:      CommunicationBillingStatus
  paymentId:   string | null
  purchasedAt: unknown       // Firestore Timestamp (server) | null (client)
}

export type CommunicationBillingStatus = 'not_required' | 'pending' | 'paid'

export interface CommunicationCostResult {
  estimatedMessages: number
  whatsappCost:      number   // in rupees
  smsCost:           number   // in rupees
  totalCost:         number   // in rupees
  totalPaise:        number   // for Razorpay (minimum currency unit)
}

// Structured, renderable publish blocker (Phase 5). Mirrors PublishBlocker in
// lib/events/publishRequirements (kept local to avoid a lib→types import cycle).
export interface PublishBlockerInfo {
  id:          string
  title:       string
  description: string
  step:        string
}

export type PublishValidationResult =
  | { canPublish: true }
  | { canPublish: false; reason: PublishBlockReason; blockers?: PublishBlockerInfo[] }

export type PublishBlockReason =
  | 'COMMUNICATION_PAYMENT_REQUIRED'   // deprecated — kept for backward compat
  | 'WALLET_INSUFFICIENT'
  | 'INCOMPLETE_REQUIRED_FIELDS'
  | 'EVENT_ALREADY_PUBLISHED'
  | 'DRAFT_NOT_FOUND'
  | 'SLUG_CONFLICT'
  | 'INVALID_TIMEZONE'
  | 'WRONG_FLOW'
  // EA-4 S1 — Publish Governance
  | 'IDENTITY_CHANGED'                 // major identity drift → block, offer Duplicate
  | 'IDENTITY_CONFIRMATION_REQUIRED'   // moderate drift → confirm to proceed
  | 'LICENSE_EXPIRED'                  // license expired before consumption

// EA-4 S1 — publish-governance detail attached to a governed block/warn response.
export interface PublishGovernanceInfo {
  decision:             'block' | 'warn'
  level:                'none' | 'minor' | 'moderate' | 'major'
  changedFields:        string[]
  requiresConfirmation: boolean
  suggestDuplicate:     boolean
}

// API response shapes

export interface PublishApiResponse {
  canPublish:      boolean
  publishedAt?:    string
  slug?:           string   // resolved public slug — present on successful publish
  lifecycleStatus?: EventLifecycleStatus  // 'published' (auto) or 'pending_review' (manual approval)
  reason?:         PublishBlockReason
  // Structured, renderable blockers — present when reason is INCOMPLETE_REQUIRED_FIELDS
  // so the client shows the REAL missing fields rather than a generic message.
  blockers?:       PublishBlockerInfo[]
  error?:          string
  governance?:     PublishGovernanceInfo   // present on a governed block/warn
}

export interface CreateOrderApiResponse {
  orderId:    string
  amount:     number   // paise
  currency:   string
  draftId:    string
  breakdown:  CommunicationCostResult
}

// ─── Organizer Wallet ─────────────────────────────────────────────────────────

export interface OrganizerWallet {
  balancePaise: number   // ₹1 = 100 paise
  currency:     'INR'
  updatedAt:    unknown  // Firestore Timestamp
}

export interface WalletBalanceResponse {
  balancePaise:  number
  balanceRupees: number
}

export interface WalletTopupOrderResponse {
  orderId:  string
  amount:   number   // paise
  currency: string
  keyId:    string   // Razorpay public key id — needed to open checkout
}

export interface WalletTopupVerifyResponse {
  success:     boolean
  newBalance?: number   // paise
  error?:      string
  pending?:    boolean  // payment captured but credit deferred to reconciliation
}
