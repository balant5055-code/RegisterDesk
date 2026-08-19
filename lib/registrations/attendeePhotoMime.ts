// RD-CERT-PHOTO-01 — image content sniffing. PURE: no Firebase, no storage, no DOM.
//
// Split out of attendeePhoto.ts deliberately. That module imports `adminDb`, which boots
// the Admin SDK at module load, so anything importing it is untestable in the repo's
// `node`-environment vitest run. The same split exists for the same reason in
// lib/certificates/placeholders.ts and shared/registration/passBenefits.ts.
//
// WHY SNIFF AT ALL: a request's Content-Type is attacker-controlled. The storage layer
// allow-lists the DECLARED type, which stops the careless cases, but a `.jpg` label on an
// HTML or SVG payload passes that check. Magic bytes are the only statement the file makes
// about itself, so the declared type must agree with them before anything is stored.

/** The only three formats an attendee photo may be. SVG is deliberately absent: it is an
 *  executable document, not a photograph. */
export type AttendeePhotoMime = 'image/jpeg' | 'image/png' | 'image/webp'

/** Real image type from magic bytes, or null for anything not accepted. Never throws. */
export function sniffImageMime(b: Uint8Array): AttendeePhotoMime | null {
  // JPEG — FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'

  // PNG — the full 8-byte signature, not just the first four.
  if (b.length >= 8
      && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'

  // WebP — "RIFF" .... "WEBP"
  if (b.length >= 12
      && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'

  return null
}
