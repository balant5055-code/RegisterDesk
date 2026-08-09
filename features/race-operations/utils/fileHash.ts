// RD-RACEOPS-01 Sprint 3 · File fingerprint.
//
// SHA-256 of the file bytes, computed in the browser with the Web Crypto API (no new
// dependency). Stored on the Import Session as provenance: it lets an organizer prove
// which file produced which results, and lets the UI spot "you already uploaded this".
//
// It is NOT a security control — the server never sees the bytes, so the hash is
// self-reported. That is acceptable because the actor is the organizer publishing results
// for their own event; the fields that matter for integrity (event, race, tenant, actor)
// are all server-derived. Documented in docs/RD-RACEOPS-FIRESTORE.md §7.

/** Lower-case hex SHA-256. Returns '' when Web Crypto is unavailable, rather than
 *  throwing — an unhashable file must not block an otherwise valid import. */
export async function hashFile(file: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return ''

  try {
    const digest = await subtle.digest('SHA-256', await file.arrayBuffer())
    return [...new Uint8Array(digest)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return ''
  }
}
