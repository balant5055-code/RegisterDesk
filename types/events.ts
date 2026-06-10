// Shared event types used across client, server, and API routes.

// ─── Event Lifecycle ──────────────────────────────────────────────────────────

export type EventLifecycleStatus =
  | 'draft'
  | 'published'
  | 'registration_closed'
  | 'completed'
  | 'cancelled'
  | 'archived'

export type LifecycleAction =
  | 'close_registrations'
  | 'reopen_registrations'
  | 'complete'
  | 'cancel'
  | 'archive'
  | 'unpublish'

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

export type PublishValidationResult =
  | { canPublish: true }
  | { canPublish: false; reason: PublishBlockReason }

export type PublishBlockReason =
  | 'COMMUNICATION_PAYMENT_REQUIRED'   // deprecated — kept for backward compat
  | 'WALLET_INSUFFICIENT'
  | 'INCOMPLETE_REQUIRED_FIELDS'
  | 'EVENT_ALREADY_PUBLISHED'
  | 'DRAFT_NOT_FOUND'
  | 'SLUG_CONFLICT'
  | 'INVALID_TIMEZONE'

// API response shapes

export interface PublishApiResponse {
  canPublish:   boolean
  publishedAt?: string
  slug?:        string   // resolved public slug — present on successful publish
  reason?:      PublishBlockReason
  error?:       string
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
}

export interface WalletTopupVerifyResponse {
  success:     boolean
  newBalance?: number   // paise
  error?:      string
}
