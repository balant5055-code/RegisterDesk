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
  // Phase C — LOCAL Cashfree vendor preparation review. Distinct actions from the two
  // above on purpose: `verified` is RegisterDesk's payout check, these record whether an
  // admin considers the organizer ready to be put forward to Cashfree. Neither creates a
  // vendor nor approves KYC.
  'payout_profile.vendor_reviewed',
  'payout_profile.vendor_changes_requested',
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
  // Event review (admin approve / reject / request changes)
  'event.approved',
  'event.rejected',
  'event.changes_requested',
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
  // RD-PRICING-01B — platform pricing engine settings
  'platform_settings.updated',
  // RD-PRICING-01D — per-event pricing override hierarchy
  'pricing_override.set',
  'pricing_override.cleared',
  // MC-05 — Media Credits refund decisions. `payout_pending` is its own action rather than
  // a field on `approved`, because the credits left the wallet but the money has not yet
  // reached the organizer — a materially different event to audit.
  'media_credit_refund.approved',
  'media_credit_refund.rejected',
  'media_credit_refund.approved_payout_pending',
  // MC-09 — a manual grant creates credits with no counterparty: no payment, no refund
  // request, nothing to reconcile against. It is the one Media Credits action whose only
  // record of WHY it happened is the one an admin typed, which is why it is audited here as
  // well as in its own collection.
  'media_credit_grant.created',
  // RD-EMAIL-PROVIDER — per-event email transport. Audited because it silently changes
  // which third party handles attendee mail for a live event, and the only record of WHY
  // is what the admin recorded here.
  'event.email_provider_changed',
  // RD-EVENT-COMMERCE-04 — per-event capacity commercial terms (events/{slug}.commercial).
  // Also recorded in licenseHistory; mirrored here so it appears in the admin audit log.
  'commercial_terms.set',
  'commercial_terms.cleared',
  // RD-PHASE4-S4 — financial controls & audit logging.
  'settlement.requested',                 // organizer request (destination snapshot)
  'finance.auto_release',                 // the automatic (cron) fund release run
  'failed_refund.review_resolved',        // a 'review' hold closed (resolved / ignored) with a reason
  'failed_refund.review_refund_approved', // a 'review' hold approved for an explicit Super Admin refund
  'registration.refunded',                // a Super Admin registration refund (gateway id + amount)
  'license.refund_audit_recovered',
  // RD-PHASE4-S4 closeout — reconciliation of a recorded audit-write failure (adminAuditFailures).
  'audit_failure.replayed',
  'audit_failure.resolved_present',
  // RD-WALLET-W2.f — Super Admin review of a HELD wallet top-up (reason, evidence, refund reference).
  'wallet_topup.review_credited',         // credited after the exact captured payment was re-verified
  'wallet_topup.review_resolved',         // resolved without credit (a duplicate: refunded externally)
  // RD-WALLET-REQ — Super Admin decisions on organizer refund / carry-forward requests.
  'wallet_service_request.approved',      // units taken out of the ledger (refund) or moved (carry-forward)
  'wallet_service_request.rejected',
  'wallet_service_request.processed',     // refund made OUTSIDE the system; external reference recorded
  // RD-PREPROD · D3 — Super Admin organizer deletion. `requested` is written BEFORE any data is
  // touched (no deletion without its audit row); `result` records the outcome of each run.
  'organizer.deletion_requested',
  'organizer.deletion_result',
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
  'platform_settings',
  // MC-05
  'media_credit_refund',
  // MC-09
  'media_credit_grant',
  // RD-PHASE4-S4 closeout
  'audit_failure',
  // RD-WALLET-W2.f — a walletTopupReconciliation review record
  'wallet_topup',
  // RD-WALLET-REQ — a walletServiceRequests record
  'wallet_service_request',
] as const

export type AdminAuditEntityType = typeof AUDIT_ENTITY_TYPES[number]

/**
 * RD-PHASE4-S4 · D7 — which audit rows are FINANCIAL (readable by a Super Admin only). Classified
 * by entity type, plus the money actions recorded against a non-financial entity (an event's
 * pricing / commercial terms, a registration refund). Pure and client-safe.
 */
export const FINANCIAL_AUDIT_ENTITY_TYPES: readonly AdminAuditEntityType[] = [
  'settlement', 'finance', 'payout_profile', 'failed_refund', 'donation', 'clawback', 'billing',
  'license', 'license_coupon', 'platform_settings', 'media_credit_refund', 'media_credit_grant',
  'audit_failure', 'wallet_topup', 'wallet_service_request',
]
const FINANCIAL_ACTION_PREFIXES = ['registration.refunded', 'commercial_terms.', 'pricing_override.', 'settlement.', 'finance.', 'license.', 'license_coupon.', 'clawback.', 'donation.', 'media_credit']

export function isFinancialAuditEntry(row: { entityType?: unknown; action?: unknown }): boolean {
  if (typeof row.entityType === 'string' && (FINANCIAL_AUDIT_ENTITY_TYPES as readonly string[]).includes(row.entityType)) return true
  return typeof row.action === 'string' && FINANCIAL_ACTION_PREFIXES.some(p => (row.action as string).startsWith(p))
}

/** RD-PHASE4-S4 — who acted, as a first-class field (never inferred from free-form metadata). */
export type AuditActorRole = 'super_admin' | 'admin' | 'organizer' | 'system'

export interface AdminAuditParams {
  adminUid:    string
  action:      AdminAuditAction
  entityType:  AdminAuditEntityType
  entityId:    string
  metadata?:   Record<string, unknown>
  // ── RD-PHASE4-S4 — first-class, all OPTIONAL (existing callers are unchanged) ──
  actorRole?:     AuditActorRole
  reason?:        string
  changedFields?: string[]
  before?:        unknown
  after?:         unknown
  /** Correlation ids: orderId, paymentId, refundId, eventId, settlementId… */
  correlation?:   Record<string, string | number | null | undefined>
}

export interface AdminAuditLog extends AdminAuditParams {
  createdAt: unknown   // FieldValue.serverTimestamp()
}
