// RD-CERT-PHOTO-02 — the certificate-photo grant. SERVER ONLY.
//
// The public Certificate Center identifies people by email, mobile, registration id or bib
// — all guessable. None of them may authorize a WRITE. This module is the one thing that
// can: a short-lived grant minted only after an OTP sent to the address already on the
// certificate, and scoped to exactly ONE certificate.
//
// ═══ WHY SERVER-SIDE AND NOT A SIGNED STATELESS TOKEN ════════════════════════
// A stateless token would have to carry `registrationId` for the photo write to target the
// right document, and base64 is not encryption — the browser would be able to read it. The
// brief forbids returning registrationId to the client, so the mapping stays server-side:
// the browser holds an opaque, HMAC-signed grant id and nothing else. It also buys
// revocation and single-use semantics that a stateless token cannot.
//
// ═══ WHAT A GRANT IS NOT ═════════════════════════════════════════════════════
// It is not an attendee session. It cannot read the portal, list other certificates, touch
// another registration, issue or delete anything, or outlive its TTL. The existing 30-day
// `attendeeSessions` architecture is untouched and this never mints one.
//
// Signing mirrors lib/attendee/auth.ts exactly (256-bit random id + HMAC), so a forged or
// guessed id is rejected before any Firestore read.

import { randomBytes, createHmac, timingSafeEqual } from 'crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { ATTENDEE_SESSION_SECRET } from '@/lib/env'

/** Long enough to crop and upload a photo without rushing; short enough that a grant left
 *  in a shared browser or a screenshot is worthless by the time anyone finds it. */
export const GRANT_TTL_MS = 20 * 60 * 1_000

/** The ONLY thing a grant is for. Stored and re-checked, so a future grant type can never
 *  be replayed here. */
export const GRANT_PURPOSE = 'certificate_photo' as const

const HEX_64 = /^[0-9a-f]{64}$/
const grantsCol = () => adminDb.collection('certificatePhotoGrants')

function sign(grantId: string): string {
  const sig = createHmac('sha256', ATTENDEE_SESSION_SECRET).update(`certphoto:${grantId}`).digest('hex')
  return `${grantId}.${sig}`
}

/** Verify the HMAC and return the grantId, or null when malformed/forged. */
function unsign(token: string): string | null {
  const dot = (token ?? '').lastIndexOf('.')
  if (dot < 0) return null
  const grantId = token.slice(0, dot)
  const sig     = token.slice(dot + 1)
  if (!HEX_64.test(grantId) || !HEX_64.test(sig)) return null
  const expected = createHmac('sha256', ATTENDEE_SESSION_SECRET).update(`certphoto:${grantId}`).digest()
  const actual   = Buffer.from(sig, 'hex')
  if (expected.length !== actual.length) return null
  return timingSafeEqual(expected, actual) ? grantId : null
}

export interface CertificatePhotoGrant {
  certificateId:  string
  /** Resolved SERVER-SIDE from the certificate at mint time. Never sent to the browser. */
  registrationId: string
  eventSlug:      string
  /**
   * RD-CERT-PHOTO-03 — the TEMPORARY photo for this certificate, under
   * `certificates/tmp/{eventSlug}/{certificateId}/…`.
   *
   * The public Certificate Center writes the photo HERE rather than onto
   * `registration.attendeePhotoKey`, because the public flow is no longer OTP-gated: anyone
   * who can complete a lookup can mint a grant, and a lookup only proves knowledge of a
   * mobile number. Permanently overwriting a stranger's stored photo on that basis would be
   * a real vulnerability; a per-certificate object that dies with the grant is not.
   *
   * Absent for grants that never uploaded (the "continue without photo" path) and for every
   * grant minted before this field existed.
   */
  photoKey?:      string
}

/**
 * Mints a grant for one certificate.
 *
 * `registrationId` must come from the certificate RECORD, never from the request — that is
 * what makes "the photo belongs only to the selected attendee" true even when a family
 * shares one email and one mobile.
 */
export async function createCertificatePhotoGrant(input: CertificatePhotoGrant): Promise<string> {
  const grantId = randomBytes(32).toString('hex')
  await grantsCol().doc(grantId).set({
    ...input,
    purpose:   GRANT_PURPOSE,
    expiresAt: new Date(Date.now() + GRANT_TTL_MS),
    createdAt: FieldValue.serverTimestamp(),
  })
  return sign(grantId)
}

/**
 * Verifies a grant for EXACTLY this certificate in EXACTLY this event.
 *
 * Both are re-checked against the stored record rather than trusted from the request, so a
 * valid grant for certificate A cannot be presented against certificate B, nor against the
 * same certificate id reached through a different event slug.
 */
export async function verifyCertificatePhotoGrant(
  token:         string,
  certificateId: string,
  eventSlug:     string,
): Promise<CertificatePhotoGrant | null> {
  const grantId = unsign(token)
  if (!grantId) return null

  const snap = await grantsCol().doc(grantId).get()
  if (!snap.exists) return null
  const d = snap.data() as Record<string, unknown>

  if (d.purpose !== GRANT_PURPOSE) return null
  if (d.certificateId !== certificateId) return null
  if (d.eventSlug !== eventSlug) return null

  const expiresMs = (d.expiresAt as { toMillis?(): number })?.toMillis?.() ?? 0
  if (!expiresMs || Date.now() > expiresMs) return null

  const registrationId = typeof d.registrationId === 'string' ? d.registrationId : ''
  if (!registrationId) return null

  const photoKey = typeof d.photoKey === 'string' && d.photoKey ? d.photoKey : undefined
  return { certificateId, registrationId, eventSlug, ...(photoKey ? { photoKey } : {}) }
}

/**
 * Points the grant at a newly uploaded temporary photo and returns the key it replaced, so
 * the caller can delete the old object AFTER the new one is durably referenced. Deleting
 * first would leave a window where the grant names an object that no longer exists.
 *
 * Takes the TOKEN, not a grant id: the HMAC is re-verified here, so this cannot be driven
 * by a forged or malformed value even if a caller skipped verification.
 */
export async function setCertificatePhotoGrantKey(
  token:         string,
  certificateId: string,
  eventSlug:     string,
  photoKey:      string,
): Promise<{ previousKey?: string } | null> {
  const grantId = unsign(token)
  if (!grantId) return null

  const ref  = grantsCol().doc(grantId)
  const snap = await ref.get()
  if (!snap.exists) return null
  const d = snap.data() as Record<string, unknown>

  // Same scope checks as verify — a grant may only ever name a key for its OWN certificate.
  if (d.purpose !== GRANT_PURPOSE) return null
  if (d.certificateId !== certificateId) return null
  if (d.eventSlug !== eventSlug) return null
  const expiresMs = (d.expiresAt as { toMillis?(): number })?.toMillis?.() ?? 0
  if (!expiresMs || Date.now() > expiresMs) return null

  const previousKey = typeof d.photoKey === 'string' && d.photoKey ? d.photoKey : undefined
  await ref.update({ photoKey, photoUpdatedAt: FieldValue.serverTimestamp() })
  return { previousKey }
}

/** Clears the temporary photo reference, returning the key to delete. */
export async function clearCertificatePhotoGrantKey(
  token:         string,
  certificateId: string,
  eventSlug:     string,
): Promise<{ previousKey?: string } | null> {
  const grantId = unsign(token)
  if (!grantId) return null

  const ref  = grantsCol().doc(grantId)
  const snap = await ref.get()
  if (!snap.exists) return null
  const d = snap.data() as Record<string, unknown>

  if (d.purpose !== GRANT_PURPOSE) return null
  if (d.certificateId !== certificateId) return null
  if (d.eventSlug !== eventSlug) return null

  const previousKey = typeof d.photoKey === 'string' && d.photoKey ? d.photoKey : undefined
  if (previousKey) await ref.update({ photoKey: FieldValue.delete() })
  return { previousKey }
}

/** Best-effort revoke. Used when the flow ends; expiry is the real guarantee. */
export async function revokeCertificatePhotoGrant(token: string): Promise<void> {
  const grantId = unsign(token)
  if (!grantId) return
  await grantsCol().doc(grantId).delete().catch(() => { /* expiry still bounds it */ })
}

/**
 * RD-CERT-DELETE — removes EVERY grant minted for one certificate and reports the temporary
 * photo keys those grants owned.
 *
 * WHY IT LIVES HERE. Grant ids are random 32-byte hex, so a grant can only be found by
 * querying `certificateId`. This module owns the collection and the document shape; a caller
 * that re-derived either would fork the schema away from its owner the first time a field
 * moved. So deletion asks for grants by certificate and gets back keys — never a query.
 *
 * THE KEYS ARE RETURNED, NOT DELETED. This module knows Firestore, not object storage. The
 * caller owns R2 cleanup because it is the one that must report a failed key rather than
 * swallow it — `revokeCertificatePhotoGrant` above can be best-effort precisely because
 * expiry still bounds it, and a deletion has no such backstop.
 *
 * Grants carry a TTL, so a grant missed here expires on its own; the value of deleting them
 * is that the temporary photo bytes go with the certificate instead of lingering until the
 * sweep. Unbounded by design: grants per certificate are naturally a handful.
 */
export async function deleteGrantsForCertificate(
  certificateId: string,
): Promise<{ tempPhotoKeys: string[] }> {
  const snap = await grantsCol().where('certificateId', '==', certificateId).get()
  if (snap.empty) return { tempPhotoKeys: [] }

  const tempPhotoKeys: string[] = []
  const batch = adminDb.batch()
  for (const doc of snap.docs) {
    const key = (doc.data() as Record<string, unknown>).photoKey
    if (typeof key === 'string' && key) tempPhotoKeys.push(key)
    batch.delete(doc.ref)
  }
  await batch.commit()

  return { tempPhotoKeys }
}
