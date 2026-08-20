// Shared types for the broadcastCampaigns Firestore collection.
// Safe to import from client and server.

export type BroadcastAudience =
  | 'all'
  | 'confirmed'
  | 'pending'
  | 'rejected'
  | 'cancelled'

// Channel a broadcast is sent over. Email is the live channel today; sms/whatsapp
// are billed via the wallet (see lib/communications/pricing) and gated until a
// delivery provider is wired.
export type BroadcastChannel = 'email' | 'sms' | 'whatsapp'

export type BroadcastStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'partial'
  | 'failed'
  | 'cancelled'

export const BROADCAST_AUDIENCE_LABELS: Record<BroadcastAudience, string> = {
  all:       'All Registrations',
  confirmed: 'Confirmed Registrations',
  pending:   'Pending Registrations',
  rejected:  'Rejected Registrations',
  cancelled: 'Cancelled Registrations',
}

export const BROADCAST_STATUS_LABELS: Record<BroadcastStatus, string> = {
  draft:     'Draft',
  scheduled: 'Scheduled',
  sending:   'Sending…',
  sent:      'Sent',
  partial:   'Partial',
  failed:    'Failed',
  cancelled: 'Cancelled',
}

// ─── Client-facing campaign shape ─────────────────────────────────────────────

export interface BroadcastCampaign {
  id:             string
  organizerUid:   string
  createdBy?:     string       // operator who created it (attribution)
  eventId:        string
  eventSlug:      string
  eventName:      string
  channel:        BroadcastChannel
  audience:       BroadcastAudience
  subject:        string
  html:           string       // HTML body fragment stored, NOT the full shell
  recipientCount: number
  /**
   * EMAIL ONLY — "Ignore duplicate email IDs". When true, an address that appears on several
   * registrations receives ONE email.
   *
   * Optional on purpose: absent (every existing campaign) and false both mean the original
   * behaviour, so no migration and no backfill. Persisted on the campaign document rather
   * than passed around, because a SCHEDULED campaign has its recipients resolved later by the
   * cron — the document is the only state that survives from create to send.
   *
   * Has no effect on WhatsApp: `deliverWhatsAppCampaign` never reads it.
   */
  dedupeEmails?:  boolean
  /**
   * 'Ignore duplicate WhatsApp numbers' — WHATSAPP ONLY, and deliberately a SEPARATE field
   * from `dedupeEmails`. One flag for both channels would mean a campaign created on one
   * channel could silently alter the other's recipient resolution; two fields make the
   * channels unable to interfere with each other at all.
   *
   * Persisted on the campaign so a SCHEDULED broadcast — which the cron resolves hours later
   * from this document alone — dedupes exactly like an immediate one. Absent on every
   * existing campaign, which is why adding it changes nothing for them.
   */
  dedupePhones?:  boolean
  successCount:   number
  failCount:      number
  status:         BroadcastStatus
  scheduledFor:   string | null   // ISO — set when status='scheduled'
  estimatedCostPaise: number      // computed at creation from channel + recipients
  actualCostPaise:    number      // charged at send time (0 for email)
  failReason:     string | null   // e.g. 'insufficient_balance'
  createdAt:      string       // ISO
  sentAt:         string | null
}

// ─── Firestore write shape ─────────────────────────────────────────────────────

export interface CreateBroadcastInput {
  organizerUid:   string
  eventId:        string
  eventSlug:      string
  eventName:      string
  audience:       BroadcastAudience
  subject:        string
  html:           string
}
