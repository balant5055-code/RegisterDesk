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
