// RD-PRINT-BILL-P4 · The RECORDED accountant approval of the badge GST treatment. Server-only.
//
// RegisterDesk cannot know who an accountant is. This records what a Super Admin SUPPLIES — the
// accountant's name/firm, their approval reference and date — together with WHO recorded it (the
// Super Admin's uid), the approved GST rate and the exact tax treatment (BADGE_TAX_TREATMENT). It
// never presents the Super Admin as the accountant.
//
//   platformApprovals/print_badges_gst                 the CURRENT record (approved | revoked)
//   platformApprovals/print_badges_gst/history/{auto}  append-only, one row per change
//   adminAuditLogs/{auto}                              print_badge_tax.approval_recorded | _revoked,
//                                                      with before/after, in the same transaction
//
// Validity is DERIVED on every quote (badgeTaxApprovalProblem): a change to the configured rate or to
// the code's tax treatment makes the approval stop matching — nothing has to remember to revoke it.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { stageAdminAudit } from '@/lib/admin/audit'
import {
  BADGE_TAX_TREATMENT, isValidGstRate, badgeTaxApprovalProblem,
  type BadgeTaxApprovalRecord, type BadgeTaxApprovalProblem,
} from './pricing'

export const BADGE_TAX_APPROVAL_PATH = 'platformApprovals/print_badges_gst'
const approvalRef = () => adminDb.doc(BADGE_TAX_APPROVAL_PATH)

export class BadgeTaxApprovalError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

export type BadgeTaxApprovalRead = { ok: true; approval: BadgeTaxApprovalRecord | null } | { ok: false }

/** A failed read is never "approved". */
export async function readBadgeTaxApproval(): Promise<BadgeTaxApprovalRead> {
  try {
    const snap = await approvalRef().get()
    return { ok: true, approval: snap.exists ? snap.data() as BadgeTaxApprovalRecord : null }
  } catch {
    return { ok: false }
  }
}

const NAME_RE = /^[\p{L}\p{N} .,&'()/-]{2,120}$/u
const REF_MAX = 200
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface RecordBadgeTaxApprovalInput {
  /** The rate the accountant approved — must equal the rate CONFIGURED now. */
  gstRatePercent:       unknown
  accountantName:       unknown
  accountantReference:  unknown
  accountantApprovedOn: unknown
  /** Must equal BADGE_TAX_TREATMENT.id — the caller confirms which treatment was approved. */
  taxTreatmentId:       unknown
}

export function parseBadgeTaxApprovalInput(input: RecordBadgeTaxApprovalInput, configuredGstRate: number | null, nowMs: number):
  { ok: true; value: { gstRatePercent: number; accountantName: string; accountantReference: string; accountantApprovedOn: string | null } }
  | { ok: false; code: string; message: string } {
  const bad = (code: string, message: string) => ({ ok: false as const, code, message })
  if (!isValidGstRate(configuredGstRate)) return bad('GST_NOT_CONFIGURED', 'Set the badge GST rate in Business Configuration before recording its approval.')
  if (!isValidGstRate(input.gstRatePercent)) return bad('RATE_INVALID', 'Enter the GST rate the accountant approved (0–100%).')
  if (input.gstRatePercent !== configuredGstRate) {
    return bad('RATE_MISMATCH', `The approved rate (${input.gstRatePercent}%) does not match the configured badge GST rate (${configuredGstRate}%).`)
  }
  if (input.taxTreatmentId !== BADGE_TAX_TREATMENT.id) return bad('TREATMENT_MISMATCH', `Confirm the tax treatment being approved (${BADGE_TAX_TREATMENT.id}).`)
  const name = typeof input.accountantName === 'string' ? input.accountantName.trim() : ''
  if (!NAME_RE.test(name)) return bad('ACCOUNTANT_REQUIRED', 'Enter the name of the accountant or firm that approved this (2–120 characters).')
  const ref = typeof input.accountantReference === 'string' ? input.accountantReference.trim() : ''
  if (ref.length < 3 || ref.length > REF_MAX) return bad('REFERENCE_REQUIRED', `Enter the accountant's approval reference (3–${REF_MAX} characters).`)
  let on: string | null = null
  if (input.accountantApprovedOn !== undefined && input.accountantApprovedOn !== null && input.accountantApprovedOn !== '') {
    const s = typeof input.accountantApprovedOn === 'string' ? input.accountantApprovedOn.trim() : ''
    const t = DATE_RE.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) return bad('DATE_INVALID', 'The approval date must be a real date (YYYY-MM-DD).')
    if (t > nowMs) return bad('DATE_INVALID', 'The approval date cannot be in the future.')
    on = s
  }
  return { ok: true, value: { gstRatePercent: input.gstRatePercent, accountantName: name, accountantReference: ref, accountantApprovedOn: on } }
}

const publicView = (a: BadgeTaxApprovalRecord | null) => a ? {
  status: a.status, approvalId: a.approvalId, gstRatePercent: a.gstRatePercent, taxTreatmentId: a.taxTreatment?.id ?? null,
  accountantName: a.accountantName, accountantReference: a.accountantReference, accountantApprovedOn: a.accountantApprovedOn,
  recordedByUid: a.recordedByUid, version: a.version,
} : null

/** Records (or re-records) the approval. One transaction: record + history + audit. */
export async function recordBadgeTaxApproval(args: {
  adminUid: string; reason: string; configuredGstRate: number | null; input: RecordBadgeTaxApprovalInput; nowMs?: number
}): Promise<BadgeTaxApprovalRecord> {
  const parsed = parseBadgeTaxApprovalInput(args.input, args.configuredGstRate, args.nowMs ?? Date.now())
  if (!parsed.ok) throw new BadgeTaxApprovalError(400, parsed.code, parsed.message)
  return adminDb.runTransaction(async txn => {
    const ref = approvalRef()
    const snap = await txn.get(ref)
    const before = snap.exists ? snap.data() as BadgeTaxApprovalRecord : null
    const version = (typeof before?.version === 'number' ? before.version : 0) + 1
    const after: BadgeTaxApprovalRecord = {
      status: 'approved', approvalId: `gst_v${version}`,
      gstRatePercent: parsed.value.gstRatePercent, taxTreatment: { ...BADGE_TAX_TREATMENT },
      accountantName: parsed.value.accountantName, accountantReference: parsed.value.accountantReference,
      accountantApprovedOn: parsed.value.accountantApprovedOn,
      recordedByUid: args.adminUid, reason: args.reason, version,
    }
    txn.set(ref, { ...after, recordedAt: FieldValue.serverTimestamp(), revokedByUid: null, revokedAt: null, revokeReason: null })
    txn.create(ref.collection('history').doc(), { action: 'recorded', ...after, at: FieldValue.serverTimestamp() })
    stageAdminAudit(txn, {
      adminUid: args.adminUid, actorRole: 'super_admin', action: 'print_badge_tax.approval_recorded',
      entityType: 'platform_settings', entityId: 'licensing.print_badges.gst_approval', reason: args.reason,
      metadata: { approvalId: after.approvalId, version, gstRatePercent: after.gstRatePercent, taxTreatmentId: BADGE_TAX_TREATMENT.id },
      before: publicView(before), after: publicView(after),
    })
    return after
  })
}

export async function revokeBadgeTaxApproval(args: { adminUid: string; reason: string }): Promise<BadgeTaxApprovalRecord> {
  return adminDb.runTransaction(async txn => {
    const ref = approvalRef()
    const snap = await txn.get(ref)
    const before = snap.exists ? snap.data() as BadgeTaxApprovalRecord : null
    if (!before || before.status !== 'approved') throw new BadgeTaxApprovalError(409, 'NOT_APPROVED', 'There is no recorded approval to revoke.')
    const version = before.version + 1
    const after: BadgeTaxApprovalRecord = { ...before, status: 'revoked', version }
    txn.set(ref, { status: 'revoked', version, revokedByUid: args.adminUid, revokedAt: FieldValue.serverTimestamp(), revokeReason: args.reason }, { merge: true })
    txn.create(ref.collection('history').doc(), { action: 'revoked', ...after, revokedByUid: args.adminUid, revokeReason: args.reason, at: FieldValue.serverTimestamp() })
    stageAdminAudit(txn, {
      adminUid: args.adminUid, actorRole: 'super_admin', action: 'print_badge_tax.approval_revoked',
      entityType: 'platform_settings', entityId: 'licensing.print_badges.gst_approval', reason: args.reason,
      metadata: { approvalId: before.approvalId, version },
      before: publicView(before), after: publicView(after),
    })
    return after
  })
}

/** The Super Admin view: the record plus whether it matches what is configured now. */
export async function getBadgeTaxApprovalStatus(configuredGstRate: number | null): Promise<{
  approval: ReturnType<typeof publicView>; configuredGstRate: number | null; problem: BadgeTaxApprovalProblem | 'UNREADABLE' | null
  taxTreatment: typeof BADGE_TAX_TREATMENT
}> {
  const read = await readBadgeTaxApproval()
  if (!read.ok) return { approval: null, configuredGstRate, problem: 'UNREADABLE', taxTreatment: BADGE_TAX_TREATMENT }
  return { approval: publicView(read.approval), configuredGstRate, problem: badgeTaxApprovalProblem(read.approval, configuredGstRate), taxTreatment: BADGE_TAX_TREATMENT }
}
