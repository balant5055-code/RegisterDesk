// RD-CERT-PHOTO-01 — the attendee's certificate photo. SERVER ONLY.
//
// One optional object per registration, printed by the certificate renderer when the
// template carries an `attendeePhoto` image element. Everything here is deliberately
// narrow: this module owns storing, replacing and removing ONE key on ONE registration,
// and nothing about certificates, delivery, billing or IDs.
//
// ═══ WHY A KEY AND NOT A URL ═════════════════════════════════════════════════
// A photograph of an identifiable person attached to a named registration must never have
// a durable public URL. Firestore therefore holds an object-storage KEY; the renderer
// reads bytes server-side, and the attendee's own UI gets a short-lived signed URL issued
// only after the ownership check below. This is also why the certificate SSRF guard is
// untouched — no attendee photo is ever fetched by URL.
//
// ═══ WHY THE BYTES ARE SNIFFED ═══════════════════════════════════════════════
// The browser declares a Content-Type; a caller can declare anything. The storage layer
// allow-lists the DECLARED type, which stops the obvious cases, but a `.jpg` label on an
// HTML or SVG payload would still pass it. Magic bytes are the only statement the file
// makes about itself, so the declared type must agree with them before anything is stored.

import { adminDb } from '@/lib/firebase/admin'
import { storage } from '@/features/platform-storage'
import type { RegistrationDocument } from '@/lib/registrations/types'
import { sniffImageMime } from '@/lib/registrations/attendeePhotoMime'

// Re-exported so the route keeps a single import site; the implementation is pure and
// lives next door so vitest can exercise it without booting the Admin SDK.
export { sniffImageMime }

/** Storage asset type for this photo — one place, so no caller can mis-file it. */
const PHOTO_ASSET_TYPE = 'event-attendee-photo' as const

/** Upper bound accepted by the API. The browser targets ~150–400 KB; this refuses an
 *  unprocessed phone original outright while leaving generous headroom. */
export const ATTENDEE_PHOTO_MAX_BYTES = 4 * 1024 * 1024

export type AttendeePhotoError =
  | 'unauthorized'      // no attendee session
  | 'not_found'         // registration does not exist
  | 'forbidden'         // session email does not own this registration
  | 'too_large'
  | 'unsupported_type'  // declared type not allowed, or bytes disagree with it
  | 'empty'

export interface AttendeePhotoResult {
  ok:  true
  key: string
}
export interface AttendeePhotoFailure {
  ok:    false
  error: AttendeePhotoError
}

/**
 * Loads a registration and confirms the session owns it.
 *
 * Ownership is the NORMALISED email on the registration matching the one the OTP session
 * was issued for. A registration id alone is not sufficient — ids are guessable enough
 * that treating one as a bearer token would let anyone attach a photo to, or read a photo
 * from, a stranger's registration.
 */
export async function loadOwnedRegistration(
  registrationId: string,
  sessionNormalizedEmail: string,
): Promise<{ ok: true; reg: RegistrationDocument } | AttendeePhotoFailure> {
  const snap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!snap.exists) return { ok: false, error: 'not_found' }
  const reg = snap.data() as RegistrationDocument

  const owner = (reg.attendee?.email ?? '').trim().toLowerCase()
  if (!owner || owner !== sessionNormalizedEmail.trim().toLowerCase()) {
    // Deliberately 'forbidden' rather than 'not_found': the caller proved a session, and
    // the id was valid. Nothing about the other registration is disclosed either way.
    return { ok: false, error: 'forbidden' }
  }
  return { ok: true, reg }
}

/**
 * Loads a registration whose id came from an ALREADY-VERIFIED certificate-photo grant.
 *
 * There is no ownership check here because there is nothing left to check: the grant's
 * registrationId was read off the certificate record server-side at mint time, and the
 * grant itself was minted only against a code sent to that certificate's own email. The
 * browser never supplies the id.
 *
 * This is why it is a distinct function rather than a flag on `loadOwnedRegistration` —
 * the email-session path must keep failing closed, and a shared "skip the check" parameter
 * is exactly the kind of switch that eventually gets passed by the wrong caller.
 */
export async function loadGrantedRegistration(
  registrationId: string,
): Promise<{ ok: true; reg: RegistrationDocument } | AttendeePhotoFailure> {
  const snap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!snap.exists) return { ok: false, error: 'not_found' }
  return { ok: true, reg: snap.data() as RegistrationDocument }
}

/**
 * Stores a new photo and points the registration at it.
 *
 * ORDER IS LOAD-BEARING: upload → update Firestore → delete the previous object. The old
 * photo is removed only once the new key is durably referenced, so a crash anywhere in the
 * middle leaves the attendee with a working photo rather than a dangling key. A failed
 * cleanup is swallowed: an orphaned object costs a fraction of a cent, whereas throwing
 * here would fail a request whose real work already succeeded.
 */
export async function setAttendeePhoto(params: {
  registrationId: string
  reg:            RegistrationDocument
  bytes:          Uint8Array
  declaredMime:   string
  actorEmail:     string
}): Promise<AttendeePhotoResult | AttendeePhotoFailure> {
  const { registrationId, reg, bytes, declaredMime, actorEmail } = params

  if (bytes.byteLength === 0) return { ok: false, error: 'empty' }
  if (bytes.byteLength > ATTENDEE_PHOTO_MAX_BYTES) return { ok: false, error: 'too_large' }

  // The bytes must BE what the request says they are.
  const sniffed = sniffImageMime(bytes)
  if (!sniffed || sniffed !== declaredMime.split(';')[0].trim().toLowerCase()) {
    return { ok: false, error: 'unsupported_type' }
  }

  const previousKey = reg.attendeePhotoKey

  // The storage layer owns key generation, allow-listing and size policy. The uploader's
  // filename never reaches the key, so there is no path-traversal surface here.
  const uploaded = await storage.upload({
    type:       PHOTO_ASSET_TYPE,
    eventSlug:  reg.eventSlug,
    body:       bytes,
    mimeType:   sniffed,
    uploadedBy: actorEmail,
  })
  const key = uploaded.metadata.path

  await adminDb.collection('registrations').doc(registrationId).update({
    attendeePhotoKey: key,
  })

  if (previousKey && previousKey !== key) {
    await storage.delete(previousKey).catch(() => { /* orphan; never fail the request */ })
  }

  return { ok: true, key }
}

/**
 * Clears the reference, then deletes the object.
 *
 * Reference first: after this returns the certificate must behave exactly like one for an
 * attendee who never uploaded anything, and that is true the moment the field is gone. A
 * failed object delete leaves an orphan, not a broken registration.
 */
export async function removeAttendeePhoto(params: {
  registrationId: string
  reg:            RegistrationDocument
}): Promise<{ ok: true }> {
  const { registrationId, reg } = params
  const key = reg.attendeePhotoKey
  if (!key) return { ok: true }   // idempotent — nothing to remove

  const { FieldValue } = await import('firebase-admin/firestore')
  await adminDb.collection('registrations').doc(registrationId).update({
    attendeePhotoKey: FieldValue.delete(),
  })
  await storage.delete(key).catch(() => { /* orphan; never fail the request */ })
  return { ok: true }
}
