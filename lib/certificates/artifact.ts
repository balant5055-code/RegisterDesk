// RD-CERT-ARTIFACT-01 · the canonical certificate PDF in object storage. Server-only.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// Generated PDFs were not persisted: `fileUrl` was null and EVERY download re-rendered the
// certificate through pdf-lib. Measured at ~155 ms of CPU per download, and rendering is
// CPU-bound in a single-threaded runtime (10-way concurrency measured only 1.24× faster),
// so a 10,000-attendee event turned every download burst into a rendering queue. It also
// made a certificate reproducible only for as long as its TEMPLATE still existed and still
// rendered — a stored PDF is evidence, a re-render is a promise.
//
// This module is the ONE place that knows how a certificate becomes bytes at rest. Nothing
// else derives a key, so the key can never drift between the writer, the reader, the ZIP
// builder and the backfill job.
//
// ═══ THE KEY IS DETERMINISTIC, AND THAT IS THE DESIGN ════════════════════════
//   events/{eventSlug}/certificates/{certificateId}.pdf
//
// It is a pure function of (eventSlug, certificateId), which buys three properties that a
// random object id would not:
//
//   • RETRY-SAFE   — a retried upload overwrites the same key. A failed attempt cannot
//                    leave an orphan behind, because the next attempt lands on top of it.
//   • DERIVABLE    — recovery tooling can compute the key without reading Firestore, which
//                    matters precisely when Firestore is the thing that failed.
//   • COLLISION-FREE — certificateIds are already unique and claim-reserved upstream, so
//                    uniqueness is inherited rather than re-invented.
//
// ═══ WHAT IS *NOT* PERSISTED ═════════════════════════════════════════════════
// Only the CANONICAL certificate as issued. A personalised render (the attendee's own photo,
// applied under a short-lived grant) is an override of one render input and must never be
// written here — it is not what was issued, and one attendee's photo must never become the
// artifact another download serves.

import { storage, buildObjectKey } from '@/features/platform-storage'
import { ARTIFACT_SIGNED_URL_TTL_S, CERTIFICATE_TARGET_MAX_BYTES } from './constants'

/** The canonical object key for a certificate's PDF. Pure; no I/O. */
export function certificateObjectKey(eventSlug: string, certificateId: string): string {
  return buildObjectKey({
    type:      'event-certificate',
    eventSlug,
    objectId:  `${certificateId}.pdf`,
  })
}

/**
 * Persists the canonical PDF and returns its key + size.
 *
 * Passing `id` explicitly is what makes the key deterministic — StorageService would
 * otherwise mint a random object id. Everything else is the platform's existing policy:
 * `assertMimeAllowed` (application/pdf), `assertSizeAllowed` (25 MB for this asset type)
 * and `assertVisibilityAllowed` — which REFUSES a PUBLIC certificate outright rather than
 * silently downgrading it. Certificates carry a participant's name and result; they are
 * SIGNED_URL, never PUBLIC, and that rule is enforced by the storage layer, not here.
 *
 * Throws StorageError on failure — the caller must treat that as "the certificate does not
 * exist" and must not create a record.
 */
export async function uploadCertificateArtifact(
  eventSlug:     string,
  certificateId: string,
  bytes:         Uint8Array,
): Promise<{ fileKey: string; fileSize: number }> {
  const result = await storage.upload({
    type:       'event-certificate',
    eventSlug,
    id:         `${certificateId}.pdf`,
    body:       bytes,
    mimeType:   'application/pdf',
    visibility: 'SIGNED_URL',
    uploadedBy: `certificate:${certificateId}`,
  })

  // RD-CERT-SCALE-01 · size observability. OBSERVE ONLY — the upload has already succeeded
  // and the certificate is returned unchanged. Issuance must never fail over a size budget:
  // an attendee denied their certificate because it is 2.1 MB is a worse outcome than a large
  // file, and the remedy (a JPEG template rather than a full-resolution PNG) belongs upstream
  // with the organizer, not in the middle of a 10,000-certificate run.
  //
  // Logged fields are the object key, the byte size and the target. NOT the attendee name,
  // email, registration id, event name or any certificate content — this line can appear
  // thousands of times in one run, and a log that repeats PII at that volume is its own
  // incident. `certificateId` is already in the key, so nothing extra is disclosed.
  if (result.metadata.size > CERTIFICATE_TARGET_MAX_BYTES) {
    console.warn('[certificate-artifact] oversized certificate', {
      fileKey:    result.metadata.path,
      bytes:      result.metadata.size,
      targetBytes: CERTIFICATE_TARGET_MAX_BYTES,
      overBy:     result.metadata.size - CERTIFICATE_TARGET_MAX_BYTES,
    })
  }

  return { fileKey: result.metadata.path, fileSize: result.metadata.size }
}

/**
 * A short-lived signed URL for an already-authorized download.
 *
 * ONLY call this after every gate has passed — revocation, download settings, attendee
 * token / organizer bypass. The URL is a bearer credential: once issued it cannot be
 * withdrawn, so issuing one is equivalent to handing over the bytes.
 *
 * `responseContentDisposition` is signed into the URL so the browser downloads the file
 * instead of rendering it inline, preserving the behaviour the streaming route had.
 */
export function signCertificateArtifact(fileKey: string, certificateId: string): Promise<string> {
  return storage.generateSignedUrl({
    path:      fileKey,
    operation: 'read',
    expiresIn: ARTIFACT_SIGNED_URL_TTL_S,
    // certificateId is validated by isValidCertificateId upstream (/^RDC-\d{4}-[A-Z0-9]{6}$/),
    // so no quote or CRLF can reach this header.
    responseContentDisposition: `attachment; filename="certificate-${certificateId}.pdf"`,
  })
}

/** Best-effort removal of a canonical artifact. Never throws. */
export async function deleteCertificateArtifact(fileKey: string): Promise<void> {
  await storage.delete(fileKey).catch(() => { /* orphan; a retry overwrites the same key */ })
}
