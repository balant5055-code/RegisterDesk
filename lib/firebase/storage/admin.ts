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
