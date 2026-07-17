// Organizer Notification Center — inbox types (Phase H.4.3).
//
// This is the ORGANIZER'S INBOX of platform events, NOT the Communication Center
// (which is the outbound delivery log in `emailLogs`). Notifications are persisted
// to a NEW per-workspace subcollection `users/{workspaceUid}/notifications/{id}`,
// written server-side (Admin SDK only) at existing event commit points — no
// duplicate event generation, no duplicate storage.

export type NotificationCategory =
  | 'approval'      // event review: submitted / approved / rejected / changes / resubmitted
  | 'payment'       // successful payment capture
  | 'wallet'        // wallet recharge / balance movement
  | 'registration'  // registration milestones
  | 'certificate'   // certificate job completion
  | 'broadcast'     // broadcast finished sending
  | 'settlement'    // payout request / status change / fund release
  | 'system'        // platform announcements
  | 'alert'         // warning / error notices

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'

// ─── Stored document (users/{workspaceUid}/notifications/{id}) ─────────────────
// createdAt / updatedAt / read are managed by the writer; everything else is the
// classified payload. Rendering is driven by (category, severity) via the catalog.
export interface NotificationDoc {
  category:       NotificationCategory
  type:           string                 // finer key (often a NotificationType value)
  title:          string
  body:           string
  severity:       NotificationSeverity
  actionRequired: boolean
  link:           string | null          // in-app deep-link destination
  eventId:        string | null          // for "filter by event"
  eventName:      string | null
  read:           boolean
}

// ─── Writer input (createdAt / read added by the writer) ──────────────────────
export interface WriteNotificationInput {
  workspaceUid:    string                 // owner uid to scope the subcollection under
  category:        NotificationCategory
  type:            string
  title:           string
  body:            string
  severity?:       NotificationSeverity    // defaults to the category's severity
  actionRequired?: boolean                 // default false
  link?:           string | null
  eventId?:        string | null
  eventName?:      string | null
  // Deterministic id → the same logical event is only ever stored once
  // (e.g. a certificate job that finishes is reported a single time).
  dedupeId?:       string
}

// ─── Client-facing shape (API response; createdAt serialized to ISO) ──────────
export interface NotificationView {
  id:             string
  category:       NotificationCategory
  type:           string
  title:          string
  body:           string
  severity:       NotificationSeverity
  actionRequired: boolean
  link:           string | null
  eventId:        string | null
  eventName:      string | null
  read:           boolean
  createdAt:      string | null
}

export interface NotificationFeedResponse {
  notifications: NotificationView[]
  nextCursor:    string | null
  unreadCount:   number          // unread within the scanned window (capped)
}
