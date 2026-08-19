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
  /**
   * True when the send ended in a TRANSPORT failure (timeout / network) rather than a
   * decision by Meta — i.e. RegisterDesk aborted before Meta answered, so delivery is
   * UNKNOWN, not failed. `status` deliberately stays 'failed' so every existing consumer
   * (email logs, broadcast stats, communications timeline) behaves exactly as before;
   * this flag is purely additive and is what lets the WhatsApp surface say 'unknown'
   * instead of asserting non-delivery. Absent on every existing row.
   */
  deliveryUnknown?:  boolean
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
  /** Transport failure (timeout/network) ⇒ delivery UNKNOWN, not failed. See EmailLogDoc. */
  deliveryUnknown?:   boolean
}

// ─── WhatsApp wallet-skip eligibility (RD-WA-LOGS-02) ─────────────────────────

/**
 * The exact `error` string the live confirmation path stores when the organizer's wallet
 * cannot cover a message — see `sendWhatsAppConfirmation()` in
 * lib/registrations/sendWhatsAppConfirmation.ts, which is its ONLY writer.
 *
 * `emailLogs` carries no separate reason CODE for skips, so this string is the canonical
 * stored value. It is declared here, once, rather than re-typed at each read site: a
 * duplicated literal is exactly how a matcher silently stops matching. A source-level test
 * asserts the writer still emits this value.
 */
export const WHATSAPP_WALLET_SKIP_REASON = 'Insufficient wallet balance'

/**
 * Was this row skipped because the wallet could not pay for it?
 *
 * HISTORICAL STATE ONLY, and that separation is the whole point. Why a row was skipped is a
 * fact about the past and never changes. Whether a NEW attempt may proceed is decided later,
 * at send time, from the CURRENT fee and balance. Lowering the fee to ₹0 therefore does not
 * erase the reason an old row was skipped, and it does not need to: the two questions are
 * answered by different code at different times.
 *
 * Case- and whitespace-tolerant so a row written by an older build still matches; the value
 * itself is never rewritten, so no stored document is migrated to gain eligibility.
 */
export function isWalletSkippedWhatsAppLog(
  log: { status?: string | null; error?: string | null },
): boolean {
  return log.status === 'skipped'
    && (log.error ?? '').trim().toLowerCase() === WHATSAPP_WALLET_SKIP_REASON.toLowerCase()
}

// ─── WhatsApp message type (RD-WA-LOGS-03) ───────────────────────────────────

/**
 * The templateKey the broadcast job writes on every row it logs. It is the ONLY
 * discriminator between a broadcast message and a transactional one — broadcast rows also
 * carry a campaignId, transactional rows carry neither.
 *
 * Declared HERE, in the client-safe types module, and not in the logs route: the route
 * imports the Admin SDK, so importing a VALUE from it inside a client component pulls
 * firebase-admin into the browser bundle. A type-only import is erased; a value import is
 * not — which is a build failure, not a type error.
 */
export const BROADCAST_TEMPLATE_KEY = 'broadcast'

/** Broadcast or transactional — derived from templateKey, never stored. */
export type WhatsAppLogType = 'broadcast' | 'transactional'
