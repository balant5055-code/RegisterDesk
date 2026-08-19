// RD-CERT-PHOTO-03 · reclaim temporary certificate photos. Server-only.
//
// ─── The gap this closes ─────────────────────────────────────────────────────
// The public Certificate Center writes a TEMPORARY photo under
// `events/{eventSlug}/certificate-photos-tmp/{certificateId}/{objectId}` and points the
// certificatePhotoGrant at it. Replacement and explicit removal delete the old object
// immediately, but the ordinary case — an attendee downloads their PDF and closes the tab —
// leaves the object behind. Nothing reclaimed it: the only storage sweep in the codebase
// (`/api/cron/storage-cleanup` → `deleteOldObjects`) walks FIREBASE STORAGE, while these
// objects live in platform-storage (R2 in production, LocalStorageProvider locally). At
// 10,000 attendees that is 10,000 photographs of identifiable people retained forever.
//
// ─── Why it reads the grant document directly ────────────────────────────────
// It deliberately does NOT call `verifyCertificatePhotoGrant`. That function refuses an
// expired grant — correctly, and we are not weakening it — but every grant this worker
// exists to clean up is expired by definition, so verification would reject all of them.
// The worker therefore reads Firestore directly and does its own `expiresAt < now` check
// against SERVER time.
//
// ─── Ordering, and why it is this way round ──────────────────────────────────
//     delete the OBJECT → then delete the GRANT
// The grant document is the ONLY pointer to the object. Deleting it first would strand the
// bytes permanently: nothing enumerates the R2 prefix, so an unreferenced object can never
// be found again. If object deletion fails we keep the grant untouched, and the next run
// retries. A retained expired grant is harmless — it still fails verification everywhere.

import { adminDb } from '@/lib/firebase/admin'
import { storage, buildPrefix, isStorageError } from '@/features/platform-storage'
import { captureError } from '@/lib/monitoring/sentry'
import { GRANT_PURPOSE } from '@/lib/certificates/photoGrant'

const grantsCol = () => adminDb.collection('certificatePhotoGrants')

/** Bounded per invocation; the caller loops until a short page or its time budget. */
export const CLEANUP_BATCH = 200

export interface TempPhotoCleanupResult {
  /** Expired grants examined this page. */
  processed: number
  /** Objects deleted (including "already absent", which is success). */
  deleted:   number
  /** Grant documents removed. */
  grants:    number
  /** Grants left in place on purpose — malformed key, or object delete failed. */
  skipped:   number
  /** Object deletions that threw. These grants are retained for the next run. */
  failed:    number
}

/**
 * Is this key one of OUR temporary certificate photos?
 *
 * Built from the SAME path builder the upload used, so there is no second, hand-rolled
 * parser to drift: `buildPrefix` yields `events/{eventSlug}/certificate-photos-tmp/`, and
 * the certificate id is appended as the scope segment. A key that does not sit under
 * exactly that prefix is not ours to delete.
 *
 * This is what stops the worker touching a permanent attendee photo
 * (`…/attendee-photos/`), a generated certificate PDF (`…/certificates/`), a template asset,
 * or another certificate's temporary photo — none of which share this prefix.
 *
 * Returns false rather than throwing for a malformed slug/id, so one corrupt grant cannot
 * abort a whole batch.
 */
export function isTempCertificatePhotoKey(
  key: string, eventSlug: string, certificateId: string,
): boolean {
  if (!key || typeof key !== 'string') return false
  let expected: string
  try {
    expected = `${buildPrefix('event-certificate-photo-tmp', eventSlug)}${certificateId}/`
  } catch {
    return false            // unsafe slug — refuse rather than guess at the prefix
  }
  // Must be UNDER the prefix, not merely equal to it: the object id has to follow.
  return key.startsWith(expected) && key.length > expected.length
}

/**
 * Reclaims one bounded page of expired grants.
 *
 * `expiresAt <= now` is a single-field range on an auto-indexed field, so this needs no
 * composite index. Oldest first, so a backlog drains in the order it accumulated.
 */
export async function sweepExpiredCertificatePhotos(
  opts: { batchSize?: number } = {},
): Promise<TempPhotoCleanupResult> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? CLEANUP_BATCH, 1), 500)
  const out: TempPhotoCleanupResult = {
    processed: 0, deleted: 0, grants: 0, skipped: 0, failed: 0,
  }

  // Server time — never a value supplied by a browser.
  const now = new Date()

  const snap = await grantsCol()
    .where('expiresAt', '<=', now)
    .orderBy('expiresAt', 'asc')
    .limit(batchSize)
    .get()

  if (snap.empty) return out

  for (const doc of snap.docs) {
    out.processed++
    const d = doc.data() as Record<string, unknown>

    // Defence in depth: only ever act on documents that are what we think they are.
    if (d.purpose !== GRANT_PURPOSE) { out.skipped++; continue }

    const photoKey      = typeof d.photoKey === 'string' ? d.photoKey : ''
    const eventSlug     = typeof d.eventSlug === 'string' ? d.eventSlug : ''
    const certificateId = typeof d.certificateId === 'string' ? d.certificateId : ''

    // No photo was ever uploaded ("continue without photo") — nothing to reclaim.
    if (!photoKey) {
      await doc.ref.delete().catch(() => { /* next run retries */ })
      out.grants++
      continue
    }

    if (!isTempCertificatePhotoKey(photoKey, eventSlug, certificateId)) {
      // NOT ours. Never delete blindly — report it and leave the grant intact so a human
      // can look. Continuing keeps one bad document from stalling the queue.
      captureError('certificate_temp_photo_key_unexpected', {
        scope: 'certificates.tempPhotoCleanup', area: 'certificate',
        certificateId, eventSlug,
      })
      out.skipped++
      continue
    }

    try {
      // Through the storage ABSTRACTION — identical code path for R2 and the local
      // provider. `delete` is idempotent by contract, so an already-absent object succeeds
      // and the grant is reclaimed on this pass rather than being retried forever.
      await storage.delete(photoKey)
      out.deleted++
    } catch (err) {
      // Keep the grant AND its photoKey — it is the only pointer to these bytes.
      if (!isStorageError(err) || err.code !== 'NOT_FOUND') {
        captureError(err, {
          scope: 'certificates.tempPhotoCleanup', area: 'certificate',
          detail: 'object delete failed; grant retained for retry', certificateId,
        })
        out.failed++
        continue
      }
      out.deleted++   // NOT_FOUND is success: the bytes are gone, which is the goal.
    }

    await doc.ref.delete().catch(() => { /* object is gone; next run clears the doc */ })
    out.grants++
  }

  return out
}

/** Exported for the cron to signal "nothing left" without re-deriving the batch size. */
export function pageWasFull(result: TempPhotoCleanupResult, batchSize = CLEANUP_BATCH): boolean {
  return result.processed >= batchSize
}

