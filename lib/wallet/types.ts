// Wallet & communication billing types — shared across API routes and client pages.

// ─── Wallet Transaction ────────────────────────────────────────────────────────

export type WalletTxnType =
  | 'fund_added'
  | 'email_charge'
  | 'sms_charge'
  | 'whatsapp_charge'
  | 'broadcast_sms'        // wallet debit for an SMS broadcast campaign
  | 'broadcast_whatsapp'   // wallet debit for a WhatsApp broadcast campaign
  | 'license_charge'       // wallet debit toward an Event License purchase (F2.2)
  | 'certificate_charge'   // wallet debit for a generated certificate (GA-4 S2)
  // RD-WALLET-W1 · W1.5 — a CREDIT written by the admin licence refund (lib/admin/
  // licenseAdminService.ts → atomicWalletCredit) for the wallet-paid part of a legacy
  // licence. It was written but never declared, so it rendered as a debit with no label.
  | 'license_refund'
  | 'refund'
  | 'adjustment'

export type WalletTxnStatus = 'completed' | 'pending' | 'failed'

export type WalletTxnReferenceType =
  | 'manual'
  | 'razorpay'
  | 'adjustment'
  | 'refund'
  | 'communication'
  | 'license'              // RD-WALLET-W1 — license_refund entries reference the event

export const WALLET_TXN_TYPE_LABELS: Record<WalletTxnType, string> = {
  fund_added:         'Funds Added',
  email_charge:       'Email Charge',
  sms_charge:         'SMS Charge',
  whatsapp_charge:    'WhatsApp Charge',
  broadcast_sms:      'SMS Broadcast',
  broadcast_whatsapp: 'WhatsApp Broadcast',
  license_charge:     'Event License Payment',
  certificate_charge: 'Certificate Charge',
  license_refund:     'Event License Refund',
  refund:             'Refund',
  adjustment:         'Adjustment',
}

export const WALLET_TXN_STATUS_LABELS: Record<WalletTxnStatus, string> = {
  completed: 'Completed',
  pending:   'Pending',
  failed:    'Failed',
}

export interface WalletTxnMetadata {
  campaignId?:    string
  emailLogId?:    string
  eventId?:       string
  eventSlug?:     string
  units?:         number   // number of messages billed (broadcast SMS/WhatsApp)
  channel?:       string   // 'sms' | 'whatsapp' | 'certificate'
  certificateId?: string   // set on certificate_charge ledger entries (GA-4 S2)
}

export interface WalletTransaction {
  id:            string
  organizerUid:  string
  type:          WalletTxnType
  amountPaise:   number           // always positive; sign implied by type
  balancePaise:  number           // balance snapshot after this txn
  status:        WalletTxnStatus
  referenceType: WalletTxnReferenceType
  referenceId:   string
  description:   string
  metadata:      WalletTxnMetadata
  createdAt:     string           // ISO 8601
}

export interface CreateWalletTxnInput {
  organizerUid:  string
  type:          WalletTxnType
  amountPaise:   number
  balancePaise:  number
  status:        WalletTxnStatus
  referenceType: WalletTxnReferenceType
  referenceId:   string
  description:   string
  metadata:      WalletTxnMetadata
}

// ─── Communication Usage ──────────────────────────────────────────────────────

export type CommChannel = 'email' | 'sms' | 'whatsapp'

export const COMM_CHANNEL_LABELS: Record<CommChannel, string> = {
  email:     'Email',
  sms:       'SMS',
  whatsapp:  'WhatsApp',
}

export interface CommunicationUsage {
  id:           string
  organizerUid: string
  eventId:      string            // Firestore draft doc ID
  eventSlug:    string            // public URL slug
  eventName:    string
  channel:      CommChannel
  quantity:     number
  costPaise:    number            // 0 until pricing is configured
  campaignId:   string            // broadcastCampaigns doc ID or ""
  templateKey:  string
  createdAt:    string            // ISO 8601
}

export interface CreateCommUsageInput {
  organizerUid: string
  eventId:      string
  eventSlug:    string
  eventName:    string
  channel:      CommChannel
  quantity:     number
  costPaise:    number
  campaignId:   string
  templateKey:  string
}

// ─── Overview ─────────────────────────────────────────────────────────────────

export interface WalletOverview {
  balancePaise:       number
  emailsSent:         number
  smsSent:            number
  whatsappSent:       number
  thisMonthSpendPaise: number
  /**
   * RD-INTEG — exact server aggregates (count()/sum(), no row cap). Each is null when its
   * aggregate could not be read — shown as "—", never as 0. Months/days are India time.
   */
  lifetimeSpendPaise?:  number | null
  spendByChannelPaise?: { email: number | null; whatsapp: number | null; sms: number | null }
  messageCounts?: {
    pending: number | null; sent: number | null; delivered: number | null
    failed: number | null; unknown: number | null; today: number | null
  }
}
