// Shared types for the emailLogs Firestore collection.
// Safe to import from client and server.

export type EmailLogStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped'

export const EMAIL_LOG_STATUS_LABELS: Record<EmailLogStatus, string> = {
  queued:    'Queued',
  sent:      'Sent',
  delivered: 'Delivered',
  failed:    'Failed',
  skipped:   'Skipped',
}

// ─── Client-facing shape (timestamps serialised to ISO strings) ───────────────

// Delivery channel for a logged communication. Defaults to 'email' when absent
// (every pre-existing log row is email), so this is backward-compatible.
export type CommunicationChannel = 'email' | 'whatsapp'

// Fine-grained WhatsApp delivery lifecycle from the Meta status webhook (WA-2).
// Independent of `status` (EmailLogStatus) which has no 'read' — a read message
// keeps status='delivered' and records waStatus='read'.
export type WhatsAppDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed'

export interface EmailLog {
  id:                string
  organizerUid:      string
  eventId:           string
  eventSlug:         string
  eventName:         string
  templateKey:       string
  recipientEmail:    string
  recipientName:     string
  subject:           string
  status:            EmailLogStatus
  provider:          string
  channel?:          CommunicationChannel   // absent ⇒ 'email'
  recipientPhone?:   string                 // WhatsApp recipient (E.164)
  costPaise?:        number                 // wallet charge for this notification; absent/0 ⇒ free
  providerMessageId?: string
  providerResponse?: string                 // compact provider diagnostics (e.g. "HTTP 400 · code 132000 · …")
  error?:            string
  registrationId:    string
  campaignId?:       string                 // broadcast campaign this log belongs to (WA-2 reporting)
  // WhatsApp delivery tracking (WA-2) — set by the Meta status webhook.
  waStatus?:         WhatsAppDeliveryStatus
  deliveredAt?:      string   // ISO 8601
  readAt?:           string   // ISO 8601
  failedAt?:         string   // ISO 8601
  statusUpdatedAt?:  string   // ISO 8601 — when the latest status event was applied
  createdAt:         string   // ISO 8601
  updatedAt:         string   // ISO 8601
}

// ─── Firestore write shape (used only in server code) ────────────────────────

export interface WriteEmailLogInput {
  organizerUid:       string
  eventId:            string
  eventSlug:          string
  eventName:          string
  templateKey:        string
  recipientEmail:     string
  recipientName:      string
  subject:            string
  status:             EmailLogStatus
  provider:           string
  channel?:           CommunicationChannel   // absent ⇒ 'email'
  recipientPhone?:    string                 // WhatsApp recipient (E.164)
  costPaise?:         number                 // wallet charge; absent/0 ⇒ free
  providerMessageId?: string
  providerResponse?:  string                 // compact provider diagnostics
  error?:             string
  registrationId?:    string
  campaignId?:        string                 // broadcast campaign this log belongs to (WA-2 reporting)
}
