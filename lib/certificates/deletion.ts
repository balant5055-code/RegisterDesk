// RD-CERT-DELETE · the ONE canonical certificate deletion service. Server-only.
//
// ═══ WHY A SERVICE AND NOT A ROUTE ═══════════════════════════════════════════
// Deleting a certificate touches four Firestore collections and three classes of R2 object.
// The moment that knowledge is spread across an individual-delete route, a bulk-delete route
// and a UI handler, the three copies drift and one of them starts leaving orphans. So there
// is exactly one implementation here, and "delete one" is "delete many" with a single id.
//
// ═══ WHAT IS DELETED, AND WHAT IS DELIBERATELY NOT ═══════════════════════════
// DELETED — owned by the certificate:
//   • certificates/{certificateId}                         the record itself
//   • certificateRecords/{certificateId}                    the legacy MVP twin, if present
//   • certificateClaims/{hash(eventId,regId,type)}          see RELEASING THE CLAIM below
//   • certificatePhotoGrants where certificateId == id      via the grant module
//   • R2 events/{slug}/certificates/{id}.pdf                the canonical artifact
//   • R2 cert.attendeePhotoKey                              the certificate-scoped photo
//   • R2 grant.photoKey[]                                   temporary photos under those grants
//
// NOT DELETED — owned by something else, and destroying them would be data loss:
//   • registration.attendeePhotoKey — a DIFFERENT key, owned by the registration and set from
//     the attendee portal. A certificate never owned those bytes.
//   • certificateTemplates — shared by every certificate of the event.
//   • certificateJobs / certificateZipJobs / certificateEmailJobs — historical records of runs
//     that really did happen. A job that generated 5 certificates generated 5; deleting two of
//     them later does not rewrite that history.
//   • walletTransactions/certificate_{id} — a financial ledger entry. Immutable by definition.
//   • certificateIssuanceLedger/{id} — monotonic free-allowance usage (see billing.ts). The
//     entire point of that ledger is that deletion does NOT return consumed allowance.
//
// ═══ RELEASING THE CLAIM IS NOT OPTIONAL ═════════════════════════════════════
// `reserveCertificateId` writes a claim keyed by (eventId, registrationId, certificateType)
// and it OUTLIVES generation — the stale-claim sweep only reclaims it after 15 minutes. Delete
// the certificate without the claim and re-issuing inside that window returns `owned:false`
// carrying the DELETED certificate's id, so the attendee can never be re-issued. Releasing the
// claim is what makes "delete, then issue again" work.
//
// ═══ FIRESTORE AND R2 ARE NOT ONE TRANSACTION ════════════════════════════════
// Ordering is Firestore first, then R2, and the failure modes are asymmetric on purpose:
//   • Firestore fails  ⇒ nothing is deleted anywhere. The item reports failure and a retry is
//                        a clean re-run. This is the only failure that can corrupt state, and
//                        it is the one made atomic (one batch).
//   • R2 fails         ⇒ the certificate IS deleted; unreferenced bytes remain. Those bytes
//                        are invisible to every metric and every surface, so correctness is
//                        intact — but they are NEVER silently swallowed: each failed key is
//                        returned to the caller and reported to monitoring.
// The reverse order would be worse: deleting bytes first leaves a live certificate whose
// download 404s, which is a broken certificate rather than an invisible orphan.

import { adminDb }        from '@/lib/firebase/admin'
import { storage }        from '@/features/platform-storage'
import { captureError }   from '@/lib/monitoring/sentry'
import { COLLECTIONS, LEGACY_CERTIFICATE_RECORDS } from './constants'
import { certificateClaimId }        from './id'
import { certificateObjectKey }      from './artifact'
import { deleteGrantsForCertificate } from './photoGrant'
import { isValidCertificateId }      from './id'
import type { Certificate }          from './types'

/** One certificate's outcome. `ok` describes the DELETION, not the storage cleanup. */
export interface CertificateDeletionOutcome {
  certificateId: string
  ok:            boolean
  /** Present when ok:false — why the certificate was not deleted. */
  error?:        string
  /** ok:true and the record was already gone. The caller asked for a state that now holds. */
  alreadyDeleted?: boolean
  /**
   * ok:true, but these R2 keys survived. Reported rather than swallowed; they are
   * unreferenced bytes, not a correctness fault.
   */
  orphanedKeys?: string[]
}

export interface CertificateDeletionResult {
  succeeded: number
  failed:    number
  /** Total R2 keys that could not be removed across the whole batch. */
  orphanedKeys: number
  results:   CertificateDeletionOutcome[]
}

/** Hard ceiling on one request, matching the bulk pattern used elsewhere in the module. */
export const MAX_DELETE_BATCH = 200

/**
 * Deletes one or more certificates owned by `uid` and belonging to `eventId`.
 *
 * IDS ARE NEVER TRUSTED. Every id is re-read server-side and re-checked against the caller's
 * uid AND the event in the URL, so a certificate from another organizer or another event is
 * rejected on its own row rather than deleted. Duplicates in the input collapse to one
 * attempt; an id that does not exist is a SUCCESS, because deletion is idempotent and a
 * caller retrying after a dropped connection must not see a spurious failure.
 *
 * Never throws for a per-item outcome — a failed id is reported in `results`, so one bad id
 * can never abort the rest of the batch.
 */
export async function deleteCertificates(
  eventId:        string,
  certificateIds: string[],
  uid:            string,
): Promise<CertificateDeletionResult> {
  // Duplicates collapse here, before any I/O: deleting the same id twice in one request would
  // otherwise report one success and one "already deleted" for a single certificate.
  const ids = [...new Set(certificateIds)]

  const results: CertificateDeletionOutcome[] = []
  for (const certificateId of ids) {
    results.push(await deleteOne(eventId, certificateId, uid))
  }

  return {
    succeeded:    results.filter(r => r.ok).length,
    failed:       results.filter(r => !r.ok).length,
    orphanedKeys: results.reduce((n, r) => n + (r.orphanedKeys?.length ?? 0), 0),
    results,
  }
}

/**
 * The whole lifecycle for ONE certificate: authorize → manifest → Firestore → R2.
 *
 * Sequential rather than parallel across ids by design. Each certificate is a handful of
 * small operations, and a bulk delete that fanned out would multiply write pressure on the
 * same event's documents for no wall-clock benefit an organizer would notice.
 */
async function deleteOne(
  eventId: string, certificateId: string, uid: string,
): Promise<CertificateDeletionOutcome> {
  if (!isValidCertificateId(certificateId)) {
    return { certificateId, ok: false, error: 'Invalid certificate ID' }
  }

  const certRef   = adminDb.collection(COLLECTIONS.CERTIFICATES).doc(certificateId)
  const legacyRef = adminDb.collection(LEGACY_CERTIFICATE_RECORDS).doc(certificateId)

  const [certSnap, legacySnap] = await Promise.all([certRef.get(), legacyRef.get()])

  // ── The legacy-only case ───────────────────────────────────────────────────
  // Two collections hold certificates: the live one and the MVP `certificateRecords`, still
  // written by the two legacy generation paths. A certificate may exist in either or both, so
  // ownership is checked against whichever record is actually present.
  if (!certSnap.exists) {
    if (!legacySnap.exists) {
      // Nothing to delete anywhere. Idempotent success — never a 404 the UI has to explain.
      return { certificateId, ok: true, alreadyDeleted: true }
    }
    const legacy = legacySnap.data() as { organizerUid?: string; eventId?: string }
    if (legacy.organizerUid !== uid || legacy.eventId !== eventId) {
      return { certificateId, ok: false, error: 'Certificate does not belong to this event' }
    }
    try {
      await legacyRef.delete()
    } catch (err) {
      return { certificateId, ok: false, error: message(err) }
    }
    return { certificateId, ok: true }
  }

  const cert = certSnap.data() as Certificate

  // ── Authorization. Both halves matter ──────────────────────────────────────
  // organizerUid alone would let an organizer delete their OWN certificate through another
  // event's endpoint; eventId alone would not stop a different organizer at all.
  if (cert.organizerUid !== uid || cert.eventId !== eventId) {
    return { certificateId, ok: false, error: 'Certificate does not belong to this event' }
  }

  // ── Manifest ───────────────────────────────────────────────────────────────
  // Grants are read and removed by their owning module, which hands back the temporary photo
  // keys they held. This is the one step that both reads and deletes: grant ids are random, so
  // the keys can only be learned from the documents themselves. It is safe to do first because
  // grants are short-lived and `sweepExpiredCertificatePhotos` already reclaims temporary
  // photos by expiry — so a crash here costs bytes that a sweep collects, never correctness.
  let tempPhotoKeys: string[] = []
  try {
    ;({ tempPhotoKeys } = await deleteGrantsForCertificate(certificateId))
  } catch (err) {
    captureError(err, { scope: 'certificate_delete_grants', area: 'certificate', certificateId })
  }

  const storageKeys = objectKeysFor(cert, certificateId, tempPhotoKeys)

  // ── Firestore, atomically ──────────────────────────────────────────────────
  // One batch, so the record, its legacy twin and its claim cannot part company. If this
  // throws, nothing was deleted and re-running is a clean retry.
  try {
    const batch = adminDb.batch()
    batch.delete(certRef)
    if (legacySnap.exists) batch.delete(legacyRef)
    if (cert.registrationId && cert.certificateType) {
      batch.delete(
        adminDb.collection(COLLECTIONS.CLAIMS)
          .doc(certificateClaimId(cert.eventId, cert.registrationId, cert.certificateType)),
      )
    }
    await batch.commit()
  } catch (err) {
    return { certificateId, ok: false, error: message(err) }
  }

  // ── R2, best-effort but never silent ───────────────────────────────────────
  const orphanedKeys = await deleteObjects(storageKeys, certificateId)

  return orphanedKeys.length > 0
    ? { certificateId, ok: true, orphanedKeys }
    : { certificateId, ok: true }
}

/**
 * Every R2 key this certificate owns, de-duplicated.
 *
 * The canonical artifact is added from `fileKey` AND from `certificateObjectKey`, because the
 * key is a pure function of (eventSlug, certificateId): if an upload succeeded but the record
 * update that stores `fileKey` did not, the object exists at the derived key with nothing
 * pointing at it. Deriving as well as reading is what reclaims that object instead of
 * stranding it forever. Deleting a key that was never written is a no-op.
 */
function objectKeysFor(cert: Certificate, certificateId: string, tempPhotoKeys: string[]): string[] {
  const keys = new Set<string>()
  if (cert.fileKey) keys.add(cert.fileKey)
  if (cert.eventSlug) keys.add(certificateObjectKey(cert.eventSlug, certificateId))
  if (cert.attendeePhotoKey) keys.add(cert.attendeePhotoKey)
  for (const k of tempPhotoKeys) keys.add(k)
  return [...keys]
}

/**
 * Deletes each key, returning the ones that survived.
 *
 * Failures are collected rather than thrown: one unreachable object must not prevent the other
 * five from being reclaimed. Each is also reported to monitoring, so the failed key is on
 * record server-side even if nobody reads the API response.
 */
async function deleteObjects(keys: string[], certificateId: string): Promise<string[]> {
  const orphaned: string[] = []
  for (const key of keys) {
    try {
      await storage.delete(key)
    } catch (err) {
      orphaned.push(key)
      captureError(err, { scope: 'certificate_delete_storage', area: 'certificate', certificateId, key })
    }
  }
  return orphaned
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Deletion failed'
}
