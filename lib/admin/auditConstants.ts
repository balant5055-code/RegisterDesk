// lib/admin/auditConstants.ts
// Client-safe audit constants and types — NO firebase-admin import.
//
// The audit writer (logAdminAction) lives in lib/admin/audit.ts and pulls in
// firebase-admin, which must never reach a Client Component bundle. These const
// arrays double as the admin audit-viewer filter dropdowns, so they live here
// where both server and client code can import them safely.

// Const arrays are the single source of truth — the unions are derived from them.
export const AUDIT_ACTIONS = [
  // Finance
  'settlement.approved',
  'settlement.rejected',
  'settlement.paid',
  'finance.release_funds',
  'payout_profile.verified',
  'payout_profile.rejected',
  'failed_refund.retry',
  'failed_refund.resolved',
  'failed_refund.ignored',
  // Organizer moderation
  'organizer.suspended',
  'organizer.reactivated',
  'organizer.banned',
  // Event moderation
  'event.taken_down',
  'event.restored',
  'event.under_review',
  // Campaign moderation
  'campaign.taken_down',
  'campaign.restored',
  'campaign.under_review',
  // Abuse reports
  'report.reviewing',
  'report.actioned',
  'report.dismissed',
  // Donation refunds
  'donation.refund_initiated',
  'donation.refund_processed',
  'donation.refund_failed',
  // Wallet clawbacks (insolvent reversals)
  'clawback.created',
  'clawback.recovered',
  'clawback.partially_recovered',
  'clawback.waived',
  // Billing / plans
  'plan.changed',
  'plan.status_changed',
  // Event license management (RD-LIC-ADMIN-01)
  'license.granted',
  'license.suspended',
  'license.reactivated',
  'license.cancelled',
  'license.upgraded',
  'license.downgraded',
  'license.price_override',
  'license.limit_override',
  'license.feature_override',
  'license.payment_received',
  'license.refunded',
  'license.reissued',
  'license.note_added',
  // EA-4 S1 — governance / expiry / consumption controls
  'license.expiry_extended',
  'license.expiry_reduced',
  'license.expiry_disabled',
  'license.governance_override',
  'license.force_consumed',
  'license.reset',
  // EA-4 S2 — license coupons
  'license_coupon.created',
  'license_coupon.updated',
  'license_coupon.cloned',
  'license_coupon.paused',
  'license_coupon.resumed',
  'license_coupon.archived',
  // GA-2 S4 — Operations Center (NOC): cancel reuses the kernel cancelJob()
  'job.cancelled',
  // GA-7E S1 — admin support workspace (resend on an attendee's behalf)
  'support.ticket_resent',
  'support.certificate_resent',
] as const

export type AdminAuditAction = typeof AUDIT_ACTIONS[number]

export const AUDIT_ENTITY_TYPES = [
  'settlement',
  'finance',
  'payout_profile',
  'failed_refund',
  'organizer',
  'event',
  'campaign',
  'report',
  'donation',
  'clawback',
  'billing',
  'license',
  'license_coupon',
  'job',
  'registration',
  'certificate',
] as const

export type AdminAuditEntityType = typeof AUDIT_ENTITY_TYPES[number]

export interface AdminAuditParams {
  adminUid:    string
  action:      AdminAuditAction
  entityType:  AdminAuditEntityType
  entityId:    string
  metadata?:   Record<string, unknown>
}

export interface AdminAuditLog extends AdminAuditParams {
  createdAt: unknown   // FieldValue.serverTimestamp()
}
