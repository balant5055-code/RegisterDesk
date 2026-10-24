// RD-CERT-CAPACITY-UX-01 / RD-CERT-JOB-CAPACITY-01 · certificate capacity, read for display and for
// the bulk-job pre-check. Server only.
//
// The AUTHORITY is unchanged: generateCertificate reserves one unit per NEW certificate inside a
// transaction (reserveServiceUnits) and refuses with 402 when none is left. Everything here is a
// read that mirrors that decision, so the workspace and the job route can refuse EARLY — never a
// substitute for the reservation, and never a reason to refuse work that needs no capacity.
//
// Only creating a certificate that does not exist yet uses capacity. A certificate is "existing"
// per (eventId, registrationId, certificateType) — generateCertificate's fast path — whatever its
// status, so re-runs, emails, downloads, regeneration and verification never need capacity.

import { adminDb } from '@/lib/firebase/admin'
import { readServiceAllowances, decideReserve, ledgerLine, availableUnits, heldRefundUnits } from '@/lib/licensing/serviceAllowanceLedger'
import { increaseLimitHref, certificatesTabHrefFor } from '@/lib/wallet/purchaseIntent'
import { COLLECTIONS } from './constants'
import type { CertificateJob, CertificateType } from './types'

/**
 * The event's prepaid certificate capacity (License & Services → `eventServiceAllowances`).
 * `state` is decideReserve(…, 'certificates', 1) — the decision generateCertificate makes.
 */
export interface CertificateCapacityStatus {
  state:      'available' | 'none' | 'exhausted'
  /** Units bought for (or carried into) this event. */
  purchased:  number
  used:       number
  /** Units a new certificate may take now (after any refund hold). */
  available:  number
  /** The existing License & Services purchase path for certificates. */
  manageHref: string
}

/** Reads the ledger for a draft the caller has already proven it owns. Throws on a read failure. */
export async function readCertificateCapacity(draftId: string): Promise<CertificateCapacityStatus> {
  const ledger = await readServiceAllowances(draftId)
  const l = ledgerLine(ledger, 'certificates')
  const mode = decideReserve(ledger, false, 'certificates', 1).mode
  return {
    state:      mode === 'allowance' ? 'available' : l.purchased + l.carriedIn <= 0 ? 'none' : 'exhausted',
    purchased:  l.purchased + l.carriedIn,
    used:       l.consumed,
    available:  Math.max(0, availableUnits(l) - heldRefundUnits(ledger, 'certificates')),
    // RD-PURCHASE-RETURN-01 — after the purchase, back to this event's Certificates tab.
    manageHref: increaseLimitHref(draftId, 'certificates', certificatesTabHrefFor(draftId)),
  }
}

/** Above this many explicit ids the exact pre-count is skipped (the reservation still guards). */
export const EXACT_ID_PRECHECK_MAX = 30

const countOf = async (q: FirebaseFirestore.Query) => (await q.count().get()).data().count

/**
 * A LOWER BOUND on the new certificates a bulk job will create — `null` when no bound can be
 * given cheaply. Lower bound because the refusal it feeds must be certain:
 *   • scope all / checked_in: eligible targets (confirmed, minus refunded — those are refused as
 *     ineligible and take no unit) minus EVERY certificate of this type already on the event
 *     (some may be outside the scope, which only lowers the bound);
 *   • explicit ids (≤ EXACT_ID_PRECHECK_MAX): exact — eligible registrations of this event without
 *     a certificate of this type;
 *   • a program filter, or more explicit ids: null (the filter can shrink the target set to zero).
 */
export async function newCertificatesAtLeast(args: {
  organizerUid: string; eventId: string; eventSlug: string; certificateType: CertificateType
  scope: CertificateJob['scope']; registrationIds: string[] | null; programFilter: boolean
}): Promise<number | null> {
  if (args.programFilter) return null
  const certs = adminDb.collection(COLLECTIONS.CERTIFICATES)
    .where('eventId', '==', args.eventId)
    .where('organizerUid', '==', args.organizerUid)
    .where('certificateType', '==', args.certificateType)

  if (args.registrationIds) {
    const ids = [...new Set(args.registrationIds)]
    if (ids.length > EXACT_ID_PRECHECK_MAX) return null
    const [regs, have] = await Promise.all([
      adminDb.getAll(...ids.map(id => adminDb.collection('registrations').doc(id))),
      certs.where('registrationId', 'in', ids).get(),
    ])
    const issued = new Set(have.docs.map(d => d.get('registrationId') as string))
    return regs.filter(s => {
      const r = s.data() as { organizerUid?: string; eventSlug?: string; status?: string; paymentStatus?: string } | undefined
      return !!r && r.organizerUid === args.organizerUid && r.eventSlug === args.eventSlug
        && r.status === 'confirmed' && r.paymentStatus !== 'refunded' && !issued.has(s.id)
    }).length
  }

  let roster = adminDb.collection('registrations')
    .where('organizerUid', '==', args.organizerUid)
    .where('eventSlug', '==', args.eventSlug)
    .where('status', '==', 'confirmed')
  if (args.scope === 'checked_in') roster = roster.where('checkedIn', '==', true)
  const [confirmed, refunded, existing] = await Promise.all([
    countOf(roster), countOf(roster.where('paymentStatus', '==', 'refunded')), countOf(certs),
  ])
  return Math.max(0, confirmed - refunded - existing)
}

export interface CertificateCapacityRequired {
  error:    string
  code:     'CERTIFICATE_CAPACITY_REQUIRED'
  capacity: CertificateCapacityStatus & { required: number; shortfall: number }
}

/**
 * The bulk-job pre-check. Refuses ONLY when the job certainly needs more new certificates than the
 * event can fund now; everything else is accepted and left to the per-certificate reservation —
 * which also settles concurrent jobs that each passed this check.
 */
export function certificateJobCapacityDecision(
  capacity: CertificateCapacityStatus, needAtLeast: number | null,
): { ok: true } | { ok: false; body: CertificateCapacityRequired } {
  if (needAtLeast === null || needAtLeast <= 0 || needAtLeast <= capacity.available) return { ok: true }
  const shortfall = needAtLeast - capacity.available
  return {
    ok: false,
    body: {
      error: capacity.available === 0
        ? 'Certificate capacity is required. Purchase certificate capacity in License & Services.'
        : `This job needs at least ${needAtLeast.toLocaleString('en-IN')} new certificates; only ${capacity.available.toLocaleString('en-IN')} can be issued. Purchase ${shortfall.toLocaleString('en-IN')} more in License & Services.`,
      code: 'CERTIFICATE_CAPACITY_REQUIRED',
      capacity: { ...capacity, required: needAtLeast, shortfall },
    },
  }
}
