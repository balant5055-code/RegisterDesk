// Server-side Firebase Storage uploads via the Admin SDK. Server-only.
// Never import from client components or pages.
//
// Used for files produced on the server (e.g. generated certificates). The Admin
// SDK bypasses Storage security rules, so no rule is needed for these paths. To
// serve the file we attach a Firebase download token in the object metadata and
// build the same token-bearing URL the client SDK's getDownloadURL() produces —
// this avoids changing bucket ACLs / public access.

import crypto from 'crypto'
import { getStorage } from 'firebase-admin/storage'
import { adminApp } from '@/lib/firebase/admin'
import { FIREBASE_STORAGE_BUCKET } from '@/lib/env'

/**
 * Ceiling for `signedReadUrl`. Five minutes, matching `ARTIFACT_SIGNED_URL_TTL_S` and the
 * gallery's `DOWNLOAD_URL_TTL_SECONDS` — the TTL the rest of the product already uses for a
 * download capability handed to a browser.
 */
export const SIGNED_URL_MAX_SECONDS = 300

function bucket() {
  if (!FIREBASE_STORAGE_BUCKET) {
    throw new Error(
      '[storage/admin] NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set; ' +
      'cannot upload server-generated files.',
    )
  }
  return getStorage(adminApp).bucket(FIREBASE_STORAGE_BUCKET)
}

/**
 * Uploads bytes to the given storage path and returns a token-bearing download
 * URL. Overwrites any existing object at the same path.
 */
export async function uploadServerFile(
  path:        string,
  bytes:       Uint8Array,
  contentType: string,
): Promise<{ url: string; path: string }> {
  const token = crypto.randomUUID()
  const file  = bucket().file(path)

  await file.save(Buffer.from(bytes), {
    resumable: false,
    metadata: {
      contentType,
      metadata: { firebaseStorageDownloadTokens: token },
    },
  })

  const url =
    `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_STORAGE_BUCKET}` +
    `/o/${encodeURIComponent(path)}?alt=media&token=${token}`
  return { url, path }
}

/**
 * RD-ANALYTICS-12-04 · a SHORT-LIVED, signed read URL for a private stored object.
 *
 * ═══ WHY THIS EXISTS RATHER THAN `storage.generateSignedUrl` ═════════════════
 * `@/features/platform-storage` is the repository's signed-URL infrastructure and is used at
 * ten-plus sites — but its only provider is Cloudflare R2, and `generateSignedUrl` presigns an
 * S3 `GetObjectCommand` against the R2 bucket. Report exports are written by
 * `uploadServerFile` into FIREBASE STORAGE. Handing an R2 presigner a GCS object path would
 * produce a confidently-signed URL for a key that does not exist in that bucket.
 *
 * So this is not a second signing architecture competing with that one; it is the same
 * capability for the other substrate, and it deliberately mirrors the R2 provider's semantics:
 * a clamped TTL, and `Content-Disposition` folded into the SIGNATURE so a recipient cannot
 * rewrite an attachment into an inline render.
 *
 * ═══ WHAT IT REPLACES ════════════════════════════════════════════════════════
 * `uploadServerFile` mints a `firebaseStorageDownloadTokens` capability URL: permanent,
 * unauthenticated, exempt from Storage rules, and — because it was persisted on the job —
 * outliving the application's own 24-hour expiry by the six days of object retention. A
 * caller who captured it kept access after cancellation, after expiry, and after losing the
 * permission. This URL expires on its own.
 *
 * ═══ SIGNING CREDENTIAL ══════════════════════════════════════════════════════
 * V4 signing is a local HMAC over the service-account private key — no network call, so it
 * costs nothing under concurrency. Production initialises the Admin SDK with
 * `cert(serviceAccount)`, which carries that key. THE EMULATOR DOES NOT: it initialises with a
 * project id alone, so this throws there. Callers must treat a signing failure as a failure
 * (503), never as a reason to fall back to a capability URL.
 */
export async function signedReadUrl(
  path: string,
  opts: { expiresInSeconds: number; filename?: string; contentType?: string },
): Promise<string> {
  // Clamped exactly like the R2 provider: at least 1s, never more than the 5-minute ceiling
  // this phase adopts for report artifacts.
  const ttl = Math.min(Math.max(1, Math.floor(opts.expiresInSeconds)), SIGNED_URL_MAX_SECONDS)

  const [url] = await bucket().file(path).getSignedUrl({
    version: 'v4',
    action:  'read',
    expires: Date.now() + ttl * 1000,
    // Folded into the signature, not sent as a header we would have to echo.
    ...(opts.filename ? { responseDisposition: `attachment; filename="${opts.filename}"` } : {}),
    ...(opts.contentType ? { responseType: opts.contentType } : {}),
  })
  return url
}

/**
 * RD-SUPPORT-01 · stores bytes PRIVATELY: unlike `uploadServerFile`, no download token is attached,
 * so no capability URL exists for the object. Storage rules deny every client path not listed in
 * storage.rules, so the only way to read it back is `readServerFile` behind an authorized route.
 * Never overwrites: a second save to the same path fails (`ifGenerationMatch: 0`).
 */
export async function savePrivateServerFile(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  await bucket().file(path).save(Buffer.from(bytes), {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { contentType, cacheControl: 'private, no-store' },
  })
}

/** RD-SUPPORT-01 · reads a stored object's bytes (server-side; the caller authorizes first). Null when missing. */
export async function readServerFile(path: string): Promise<Buffer | null> {
  try {
    const [buf] = await bucket().file(path).download()
    return buf
  } catch (err) {
    if ((err as { code?: number }).code === 404) return null
    throw err
  }
}

/** Deletes an object by storage path. Best-effort — missing objects are ignored. */
export async function deleteServerFile(path: string): Promise<void> {
  try {
    await bucket().file(path).delete({ ignoreNotFound: true })
  } catch {
    /* non-fatal */
  }
}

/**
 * GA-7C S2: deletes objects under `prefix` whose creation time is older than
 * `olderThanMs`. Bounded per call (`maxObjects`, single unpaginated page) so a cron
 * can never run away. A file with no readable `timeCreated` is left ALONE (never
 * deleted without a confirmed age). CALLER CONTRACT: only pass a prefix that holds
 * TRANSIENT artifacts (one-time-download job outputs) — never active/served assets.
 * Best-effort per file; returns how many were scanned and deleted.
 */
export async function deleteOldObjects(
  prefix:      string,
  olderThanMs: number,
  maxObjects   = 500,
): Promise<{ scanned: number; deleted: number }> {
  const [files] = await bucket().getFiles({ prefix, maxResults: maxObjects, autoPaginate: false })
  const cutoff = Date.now() - olderThanMs
  let deleted = 0
  for (const f of files) {
    const raw     = (f.metadata as { timeCreated?: string } | undefined)?.timeCreated
    const created = raw ? Date.parse(raw) : NaN
    if (Number.isNaN(created) || created >= cutoff) continue   // unknown age or too new → keep
    try { await f.delete({ ignoreNotFound: true }); deleted++ } catch { /* best-effort */ }
  }
  return { scanned: files.length, deleted }
}

/**
 * RD-ORGANIZER-REMAINING-ALL · deletes objects under `prefix`, bounded per call.
 *
 * ═══ WHY THIS IS SEPARATE FROM `deleteOldObjects` ════════════════════════════
 * That function refuses to delete anything whose age it cannot confirm, because it exists to
 * expire transient artifacts and a file with no readable `timeCreated` might be live. This one
 * is for a prefix whose ENTIRE contents are being removed on purpose, so age is irrelevant —
 * folding an unconditional mode into the other function would have made its age guard optional,
 * which is precisely the guard that stops a cron eating live assets.
 *
 * ═══ CALLER CONTRACT ════════════════════════════════════════════════════════
 * `prefix` MUST be authoritatively owned by the thing being deleted, and must end in `/` so it
 * cannot match a sibling by string prefix (`organizer-assets/abc` would otherwise also match
 * `organizer-assets/abcdef/`). Both are asserted, not assumed: a prefix that is empty, lacks
 * the trailing slash, or contains a traversal segment throws rather than deleting anything.
 *
 * Bounded and unpaginated (`maxObjects`, `autoPaginate: false`) so one call is one page and a
 * caller drives the loop — the same shape the deletion job uses for Firestore.
 */
export async function deleteByPrefix(
  prefix:    string,
  maxObjects = 200,
): Promise<{ scanned: number; deleted: number; failed: number }> {
  if (!prefix || !prefix.endsWith('/')) {
    throw new Error(`[storage/admin] deleteByPrefix requires a non-empty prefix ending in "/": got "${prefix}"`)
  }
  if (prefix.includes('..') || prefix.startsWith('/')) {
    throw new Error(`[storage/admin] deleteByPrefix refuses a traversing or absolute prefix: "${prefix}"`)
  }

  const [files] = await bucket().getFiles({ prefix, maxResults: maxObjects, autoPaginate: false })
  let deleted = 0, failed = 0
  for (const f of files) {
    // Defence in depth: the bucket already filtered by prefix, but a name that does not start
    // with it is not something to delete on the strength of a library's filter alone.
    if (!f.name.startsWith(prefix)) { failed++; continue }
    try { await f.delete({ ignoreNotFound: true }); deleted++ }
    catch { failed++ }
  }
  return { scanned: files.length, deleted, failed }
}
