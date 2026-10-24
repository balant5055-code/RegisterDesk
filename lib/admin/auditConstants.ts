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
  // Phase 3 · G9 — a refund attempt with an unknown gateway outcome, resolved by a Super Admin
  'donation.refund_attempt_resolved_none',
  'donation.refund_attempt_linked',
  // Phase 3.3 · E — a refund in accounting needs_review, resolved by a Super Admin on fresh gateway evidence
  'donation.refund_review_accounting_retried',
  'donation.refund_review_recorded_failed',
  'donation.refund_review_attempt_linked',
  // Phase 3.4 — a contradictory refund outcome closed on agreeing evidence / a discrepancy recorded / a compensating entry
  'donation.refund_conflict_resolved',
  'donation.refund_conflict_discrepancy',
  'donation.refund_reversal_compensated',
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
  // RD-PRINT-BILL-P3 — ID badge purchase coupons (badgeCoupons/*), Super Admin only, reason required.
  'badge_coupon.created',
  'badge_coupon.updated',
  'badge_coupon.cloned',
  'badge_coupon.paused',
  'badge_coupon.resumed',
  'badge_coupon.archived',
  // RD-PRINT-BILL-P4 — a FULL refund of a badge purchase releases the organizer's count once.
  'badge_coupon.organizer_usage_released',
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
  // RD-COUPON-SWITCH-01 — a Super Admin switched an event's coupons off / back on.
  'event.coupons_disabled',
  'event.coupons_enabled',
  // RD-EVENT-COMMERCE-04 — per-event capacity commercial terms (events/{slug}.commercial).
  // Also recorded in licenseHistory; mirrored here so it appears in the admin audit log.
  'commercial_terms.set',
  'commercial_terms.cleared',
  // RD-PRINT-BILL-P2 — per-event print badge billing (events/{slug}.printBadgeCommercial; also in
  // licenseHistory) and the GLOBAL badge settings (Business Configuration), audited with a reason.
  'print_badge_commercial.set',
  'print_badge_commercial.cleared',
  'print_badge_settings.updated',
  // RD-PRINT-BILL-P4 — the RECORDED accountant approval of the badge GST rate + tax treatment.
  'print_badge_tax.approval_recorded',
  'print_badge_tax.approval_revoked',
  // RD-PRINT-BILL-P7 — Super Admin READS of badge billing evidence (order detail, one event's billing).
  // Lists are not audited; these two detail views are, with only the ids that were viewed.
  'print_badge_billing.order_viewed',
  'print_badge_billing.event_billing_viewed',
  // RD-PHASE4-S4 — financial controls & audit logging.
  'settlement.requested',                 // organizer request (destination snapshot)
  // F1 follow-up — Super Admin review of settlement holds caused by refunds (lib/settlements/refundHoldReview).
  'settlement.refund_hold_reviewed',      // review note recorded; the hold stays
  'settlement.refund_hold_lifted',        // hold lifted on verified evidence that no refund money left
  'settlement.refund_hold_closed',        // M1 — payment fully refunded + settlement reversed: hold closed (system)
  // M1 (payout/refund integrity) — a payout request the wallet can no longer back is held for review (system),
  // then resolved by a Super Admin. A rejection uses 'settlement.rejected'; a transfer that DID complete is
  // recorded with 'settlement.paid' (metadata.reviewResolution); a re-check is audited per request it opens.
  'settlement.review_opened',
  'settlement.review_resumed',
  // M1.2 — the changed-destination exception for a transfer that already completed (approval → 'settlement.paid')
  'settlement.transfer_exception_requested',
  'settlement.transfer_exception_declined',
  'finance.auto_release',                 // the automatic (cron) fund release run
  'failed_refund.review_resolved',        // a 'review' hold closed (resolved / ignored) with a reason
  'failed_refund.review_refund_approved', // a 'review' hold approved for an explicit Super Admin refund
  'registration.refunded',                // a Super Admin registration refund (gateway id + amount)
  'registration.refund_initiated',        // RD-REFUND-STATUS-01 — accepted by Razorpay, not yet processed
  // RD-REFUND-MANUAL-01 — a MANUAL attendee refund (money returned outside the gateway): maker requests,
  // a different Super Admin records the completed transfer (reference) — or the request is cancelled.
  'registration.manual_refund_requested',
  'registration.manual_refund_completed',
  'registration.manual_refund_cancelled',
  'license.refund_audit_recovered',
  // RD-SA-COMMERCE-P1 — licence refund review state + refund-hold release.
  'license.refund_review_required',
  'license.refund_hold_released',
  // RD-SA-COMMERCE-P1 (P1-1/P1-4) — a refund whose gateway outcome could not be established (held for
  // reconciliation), and the audited completion of a refund whose money had already moved.
  'license.refund_outcome_unknown',
  'license.refund_completed',
  // M2 — a licence refund the gateway accepted then reported FAILED (system), and its acknowledgement.
  'license.refund_failed_at_gateway',
  'license.refund_failure_acknowledged',
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
  'badge_coupon',
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
  'license', 'license_coupon', 'badge_coupon', 'platform_settings', 'media_credit_refund', 'media_credit_grant',
  'audit_failure', 'wallet_topup', 'wallet_service_request',
]
const FINANCIAL_ACTION_PREFIXES = ['registration.refunded', 'registration.refund_initiated', 'registration.manual_refund_', 'commercial_terms.', 'pricing_override.', 'settlement.', 'finance.', 'license.', 'license_coupon.', 'badge_coupon.', 'print_badge_', 'clawback.', 'donation.', 'media_credit']

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
