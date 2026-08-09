// RD-MEDIA-01 · Media asset persistence — SERVER ONLY.
//
// Stores ONLY metadata. Image bytes live exclusively in object storage, reached through
// `@/features/platform-storage`. No document here ever holds a data URL or a base64 blob.
//
// Counter updates (gallery + album assetCount / bytesStored) happen in the SAME transaction
// as the asset write, so a dashboard total can never drift from what is actually stored.

import crypto from 'crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  MEDIA_ALBUMS, MEDIA_ASSETS, MEDIA_GALLERIES, MEDIA_SCHEMA_VERSION, RECLAIMABLE_STATUSES,
  type AssignableVisibility, type MediaAssetDoc, type MediaAssetStatus, type MediaAssetView, type MediaRendition,
  type RenditionRecord,
} from '@/features/media-studio/types'
import type { ExistingAssetRef } from '@/features/media-studio/utils/duplicates'

const assets    = () => adminDb.collection(MEDIA_ASSETS)
const galleries = () => adminDb.collection(MEDIA_GALLERIES)
const albums    = () => adminDb.collection(MEDIA_ALBUMS)

export const newAssetId = () => `med_${crypto.randomBytes(12).toString('hex')}`

function toIso(v: unknown): string | null {
  if (!v) return null
  if (typeof v === 'object' && v !== null && 'toDate' in v) {
    return (v as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

/**
 * RD-PHOTO-08: `previewUrl` is OPTIONAL and defaults to null, so the three existing callers
 * (list, patch, upload-complete) are unchanged and no consumer sees different data than before.
 */
export function serializeAsset(
  a: MediaAssetDoc,
  thumbnailUrl: string | null,
  previewUrl: string | null = null,
): MediaAssetView {
  return {
    assetId: a.assetId, galleryId: a.galleryId, albumId: a.albumId,
    checksum: a.checksum, originalFilename: a.originalFilename,
    bytesStored: a.bytesStored, mimeType: a.mimeType,
    width: a.width, height: a.height, status: a.status,
    visibility: a.visibility,
    uploadedAt: toIso(a.uploadedAt), thumbnailUrl, previewUrl,
    // RD-MS-CLOSURE-01 · metadata for the photo detail drawer. Read straight off the
    // document this function was already handed — no extra read, no derivation.
    profileId: a.profileId,
    bytesOriginalSource: a.bytesOriginalSource,
    downloadCount: a.downloadCount ?? 0,
    // Only the renditions that actually exist. An import that skipped `medium` should show
    // two entries, not three with one silently empty.
    renditionNames: (Object.keys(a.renditions) as MediaRendition[])
      .filter(r => a.renditions[r] != null),
  }
}

// ─── Duplicate lookup ─────────────────────────────────────────────────────────

/**
 * Existing assets matching any of the given checksums, within ONE event.
 *
 * Firestore caps an `in` filter at 30 values, so the caller's batch is chunked here rather
 * than at the call site — a 5,000-photo folder must not become 5,000 queries.
 */
export async function findByChecksums(
  organizerUid: string,
  eventId:      string,
  checksums:    readonly string[],
): Promise<ExistingAssetRef[]> {
  const unique = [...new Set(checksums)].filter(c => c.length === 64)
  if (unique.length === 0) return []

  const CHUNK = 30
  const out: ExistingAssetRef[] = []

  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK)
    const snap = await assets()
      .where('organizerUid', '==', organizerUid)
      .where('eventId', '==', eventId)
      .where('checksum', 'in', slice)
      .get()

    for (const d of snap.docs) {
      const doc = d.data() as MediaAssetDoc
      // A deleted asset must not block a re-upload of the same photo.
      if (doc.status === 'deleted') continue
      out.push({
        assetId: doc.assetId, checksum: doc.checksum,
        galleryId: doc.galleryId, albumId: doc.albumId,
        // MS-FINAL-01 · already on the document this query fetched.
        originalFilename: doc.originalFilename ?? null,
        uploadedAtMs: doc.uploadedAt && typeof doc.uploadedAt === 'object' && 'toMillis' in doc.uploadedAt
          ? (doc.uploadedAt as { toMillis(): number }).toMillis()
          : 0,
      })
    }
  }

  return out
}

// ─── Reserve (RD-MEDIA-04) ────────────────────────────────────────────────────

/**
 * Records an upload the server has just AUTHORIZED, before any byte exists.
 *
 * ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 * `/uploads/prepare` used to mint signed PUT URLs and write nothing. If the browser then
 * PUT some bytes and the tab closed, the objects sat in the bucket with NO record anywhere —
 * invisible to the dashboard, invisible to the organizer, and billable forever. There was no
 * query that could find them, because nothing knew their keys.
 *
 * Writing a `pending` record first makes an abandoned upload a FACT rather than a ghost:
 * the reclamation sweep can find it by status and delete exactly the objects it authorized.
 * `pending` was already in `MediaAssetStatus` and had never been used — this is the case it
 * was designed for.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * It moves NO counter. A reservation is not a photo, and a gallery total must never include
 * bytes that may never arrive.
 */
export async function reserveAsset(input: {
  assetId:      string
  organizerUid: string
  eventId:      string
  eventSlug:    string
  galleryId:    string
  albumId:      string | null
  renditions:   Partial<Record<MediaRendition, RenditionRecord>>
  visibility:   AssignableVisibility
  uploadedBy:   string
}): Promise<void> {
  await assets().doc(input.assetId).set({
    assetId:       input.assetId,
    schemaVersion: MEDIA_SCHEMA_VERSION,
    organizerUid:  input.organizerUid,
    eventId:       input.eventId,
    eventSlug:     input.eventSlug,
    galleryId:     input.galleryId,
    albumId:       input.albumId,
    // Not known until the browser has hashed the original; `complete` supplies it.
    checksum:      '',
    originalFilename: null,
    // The KEYS this upload was authorized to write. This is the whole point: it is what
    // lets the sweep delete the right objects and nothing else.
    renditions:    input.renditions,
    bytesStored:   0,
    bytesOriginalSource: 0,
    mimeType:      'application/octet-stream',
    width:  null,
    height: null,
    profileId:  'unknown',
    status:     'pending',
    visibility: input.visibility,
    uploadedBy: input.uploadedBy,
    uploadedAt: FieldValue.serverTimestamp(),
    updatedAt:  FieldValue.serverTimestamp(),
  })
}

// ─── Create / finalise ────────────────────────────────────────────────────────

export interface RegisterAssetInput {
  assetId:      string
  organizerUid: string
  eventId:      string
  eventSlug:    string
  galleryId:    string
  albumId:      string | null
  checksum:     string
  originalFilename: string | null
  renditions:   Partial<Record<MediaRendition, RenditionRecord>>
  bytesStored:  number
  bytesOriginalSource: number
  mimeType:     string
  width:        number | null
  height:       number | null
  profileId:    string
  visibility:   'PUBLIC' | 'PRIVATE' | 'SIGNED_URL'
  uploadedBy:   string
  /** When replacing a duplicate, the previous record's stored bytes, so counters net out. */
  replacesBytes?: number
}

/**
 * Writes the asset record and moves every counter in ONE transaction.
 *
 * `set` with a caller-supplied id makes this idempotent: a retried "complete" call after a
 * dropped response overwrites the identical record. The counter delta is computed from the
 * PREVIOUS document inside the transaction, so a retry cannot double-count.
 */
/**
 * MC-03 · Optional hook that runs INSIDE this function's transaction, just before commit.
 *
 * Firestore cannot join two independent `runTransaction` calls, so anything that must commit
 * atomically with an asset registration has to be enrolled into THIS transaction. Media
 * Credits uses it to consume a reservation, debit the wallet and append the ledger entry, so
 * money and artefact commit together or not at all.
 *
 * The hook is issued only WRITES-safe work: by the time it runs, this function has already
 * performed every read it needs, and Firestore forbids a read after a write in the same
 * transaction. A hook that reads is therefore the caller's responsibility to order — which
 * is why `consumeInTx` does its reads first and is passed as the whole hook body.
 */
export interface RegisterAssetOptions {
  beforeCommit?: (tx: FirebaseFirestore.Transaction) => Promise<void>
}

/**
 * @param options MC-03, OPTIONAL. Omitted ⇒ byte-identical to the pre-MC-03 behaviour;
 *                every existing caller is unaffected.
 */
export async function registerAsset(
  input: RegisterAssetInput,
  options?: RegisterAssetOptions,
): Promise<MediaAssetDoc> {
  const ref = assets().doc(input.assetId)

  await adminDb.runTransaction(async tx => {
    const existing    = await tx.get(ref)
    const galleryRef  = galleries().doc(input.galleryId)
    const gallerySnap = await tx.get(galleryRef)
    if (!gallerySnap.exists) throw new Error('Gallery not found')

    const albumRef = input.albumId ? albums().doc(input.albumId) : null
    if (albumRef) {
      const albumSnap = await tx.get(albumRef)
      if (!albumSnap.exists) throw new Error('Album not found')
    }

    const previous = existing.exists ? (existing.data() as MediaAssetDoc) : null
    // Idempotency: a re-run nets out against whatever this record already contributed.
    const priorBytes  = previous?.status === 'ready' ? previous.bytesStored : 0
    const priorSource = previous?.status === 'ready' ? previous.bytesOriginalSource : 0
    const priorCount  = previous?.status === 'ready' ? 1 : 0

    const doc: MediaAssetDoc = {
      assetId:       input.assetId,
      schemaVersion: MEDIA_SCHEMA_VERSION,
      organizerUid:  input.organizerUid,
      eventId:       input.eventId,
      eventSlug:     input.eventSlug,
      galleryId:     input.galleryId,
      albumId:       input.albumId,
      checksum:      input.checksum,
      originalFilename: input.originalFilename,
      renditions:    input.renditions,
      bytesStored:   input.bytesStored,
      bytesOriginalSource: input.bytesOriginalSource,
      mimeType:      input.mimeType,
      width:         input.width,
      height:        input.height,
      profileId:     input.profileId,
      status:        'ready',
      visibility:    input.visibility,
      uploadedBy:    input.uploadedBy,
      uploadedAt:    previous?.uploadedAt ?? FieldValue.serverTimestamp(),
      updatedAt:     FieldValue.serverTimestamp(),
    }

    // MC-03 — enrol the caller's work into THIS transaction.
    //
    // Placed after every read this function performs and BEFORE its first write, because
    // Firestore rejects a read that follows a write within one transaction and the hook
    // needs to read (a reservation and a wallet). It is still "before commit" — nothing has
    // been committed yet — but the position is load-bearing, not cosmetic.
    //
    // Throwing here rolls back the asset write and both counter updates along with it, which
    // is the entire point: a credit debit and the photo it paid for cannot diverge.
    if (options?.beforeCommit) await options.beforeCommit(tx)

    tx.set(ref, doc)

    const deltaBytes  = input.bytesStored - priorBytes
    const deltaSource = input.bytesOriginalSource - priorSource
    const deltaCount  = 1 - priorCount

    tx.update(galleryRef, {
      assetCount:  FieldValue.increment(deltaCount),
      bytesStored: FieldValue.increment(deltaBytes),
      bytesOriginalSource: FieldValue.increment(deltaSource),
      updatedAt:   FieldValue.serverTimestamp(),
      ...(gallerySnap.get('coverAssetId') ? {} : { coverAssetId: input.assetId }),
    })

    if (albumRef) {
      tx.update(albumRef, {
        assetCount:  FieldValue.increment(deltaCount),
        bytesStored: FieldValue.increment(deltaBytes),
        bytesOriginalSource: FieldValue.increment(deltaSource),
        updatedAt:   FieldValue.serverTimestamp(),
      })
    }

  })

  return (await ref.get()).data() as MediaAssetDoc
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export interface AssetPage {
  assets:     MediaAssetDoc[]
  nextCursor: string | null
}

/**
 * A page of assets for a gallery (optionally one album), newest first.
 *
 * Cursor-paginated on assetId after ordering by uploadedAt — never an offset, so page N of
 * a 50,000-photo gallery costs what page 1 costs.
 */
export async function listAssets(params: {
  organizerUid: string
  galleryId:    string
  albumId?:     string | null
  limit?:       number
  cursor?:      string | null
  /**
   * RD-MS-CLOSURE-01 · narrow to one visibility. Server-side, in the query.
   *
   * Both values it can take are already leading fields of declared indexes
   * (`organizerUid, galleryId[, albumId], visibility, status, uploadedAt`), which is why
   * this needs no new index — the public gallery has used that shape since RD-PUBGAL-01.
   */
  visibility?:  AssignableVisibility | null
  /**
   * RD-MS-CLOSURE-01 · oldest-first instead of newest-first.
   *
   * A direction flip on the SAME index. Firestore serves an index in both directions, so
   * this costs nothing and adds no deployment artifact.
   */
  sort?:        'newest' | 'oldest'
}): Promise<AssetPage> {
  const limit = Math.min(Math.max(1, params.limit ?? 60), 200)

  let q = assets()
    .where('organizerUid', '==', params.organizerUid)
    .where('galleryId', '==', params.galleryId)

  if (params.albumId) q = q.where('albumId', '==', params.albumId)
  if (params.visibility) q = q.where('visibility', '==', params.visibility)

  // RD-MEDIA-06 — READY only, filtered IN THE QUERY.
  //
  // This used to return every status. It did not matter while nothing rendered assets, and
  // it became wrong the moment RD-MEDIA-04 made `/uploads/prepare` write a `pending`
  // reservation: an abandoned upload has a document and NO stored bytes, so a browser would
  // paint a broken tile for a photo that does not exist. Soft-deleted records would do the
  // same. Neither is counted in `assetCount`, so they would also make the grid disagree with
  // the number printed above it.
  //
  // Filtering here rather than after the fetch keeps the page size honest — 60 requested is
  // 60 real photos, not 60 rows of which some vanish.
  q = q
    .where('status', '==', 'ready')
    .orderBy('uploadedAt', params.sort === 'oldest' ? 'asc' : 'desc')
    .limit(limit)

  if (params.cursor) {
    const cursorSnap = await assets().doc(params.cursor).get()
    // A cursor naming another workspace's document must not seek this query.
    if (cursorSnap.exists && cursorSnap.get('organizerUid') === params.organizerUid) {
      q = q.startAfter(cursorSnap)
    }
  }

  const snap = await q.get()
  const docs = snap.docs.map(d => d.data() as MediaAssetDoc)

  return {
    assets: docs,
    nextCursor: snap.size === limit && docs.length > 0 ? docs[docs.length - 1].assetId : null,
  }
}

/**
 * RD-RUNNER-01 — many assets in ONE round trip.
 *
 * Additive and read-only. It exists so the runner gallery can turn a page of photo links
 * into photos without a per-photo `get()`: 24 links would otherwise be 24 sequential reads,
 * which is the N+1 the performance budget forbids.
 *
 * Tenant-checked like its single-document sibling — an asset belonging to another workspace
 * is simply absent from the result, never an error.
 */
export async function getAssetsByIds(
  assetIds: readonly string[], organizerUid: string,
): Promise<Map<string, MediaAssetDoc>> {
  const unique = [...new Set(assetIds)].filter(id => typeof id === 'string' && id !== '')
  const found = new Map<string, MediaAssetDoc>()
  if (unique.length === 0) return found

  // getAll is one round trip regardless of count, and takes document refs, so there is no
  // `in` clause and therefore no 30-value chunking to get wrong.
  const snaps = await adminDb.getAll(...unique.map(id => assets().doc(id)))
  for (const snap of snaps) {
    if (!snap.exists) continue
    const doc = snap.data() as MediaAssetDoc
    if (doc.organizerUid !== organizerUid) continue
    found.set(doc.assetId, doc)
  }
  return found
}

export async function getOwnedAsset(assetId: string, organizerUid: string): Promise<MediaAssetDoc | null> {
  const snap = await assets().doc(assetId).get()
  if (!snap.exists) return null
  const doc = snap.data() as MediaAssetDoc
  if (doc.organizerUid !== organizerUid) return null
  return doc
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Marks an asset deleted and reverses its counters, transactionally.
 *
 * SOFT by design: the record survives for audit, and the caller removes the bytes from
 * object storage separately. Deleting the record first would strand the objects with no
 * way to find them.
 */
export async function markAssetDeleted(assetId: string): Promise<{ ok: boolean; paths: string[] }> {
  const ref = assets().doc(assetId)

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false, paths: [] }

    const doc = snap.data() as MediaAssetDoc
    if (doc.status === 'deleted') {
      // Idempotent: already gone, nothing to reverse.
      return { ok: true, paths: [] }
    }

    // RD-MEDIA-04: a cover pointing at a deleted photo renders a broken tile forever.
    // Both parents are read INSIDE the transaction and BEFORE any write, because Firestore
    // forbids a read after a write in the same transaction.
    const galleryRef = galleries().doc(doc.galleryId)
    const albumRef   = doc.albumId ? albums().doc(doc.albumId) : null
    const gallerySnap = await tx.get(galleryRef)
    const albumSnap   = albumRef ? await tx.get(albumRef) : null

    tx.update(ref, { status: 'deleted', updatedAt: FieldValue.serverTimestamp() })
    tx.update(galleryRef, {
      assetCount:  FieldValue.increment(-1),
      bytesStored: FieldValue.increment(-doc.bytesStored),
      bytesOriginalSource: FieldValue.increment(-doc.bytesOriginalSource),
      // Cleared rather than re-pointed: choosing a replacement needs a query the
      // transaction cannot run, and an empty cover falls back to a placeholder cleanly.
      ...(gallerySnap.get('coverAssetId') === assetId ? { coverAssetId: null } : {}),
      updatedAt:   FieldValue.serverTimestamp(),
    })
    if (albumRef) {
      tx.update(albumRef, {
        assetCount:  FieldValue.increment(-1),
        bytesStored: FieldValue.increment(-doc.bytesStored),
        bytesOriginalSource: FieldValue.increment(-doc.bytesOriginalSource),
        ...(albumSnap && albumSnap.get('coverAssetId') === assetId ? { coverAssetId: null } : {}),
        updatedAt:   FieldValue.serverTimestamp(),
      })
    }

    const paths = Object.values(doc.renditions).map(r => r.path)
    return { ok: true, paths }
  })
}

// ═══════════════ RD-MEDIA-04 · Move ═══════════════

export type AssetMutationOutcome =
  | { ok: true;  asset: MediaAssetDoc }
  | { ok: false; status: number; error: string }

/**
 * Moves a photo to another gallery and/or album, transferring its counters.
 *
 * ─── No bytes move ───────────────────────────────────────────────────────────
 * An object key is `events/{eventSlug}/photos/{rendition}/{objectId}` — it carries no
 * gallery or album segment. So a move is METADATA ONLY: nothing is copied, nothing can fail
 * halfway through a 40 MB transfer, and a moved photo's existing URLs keep working. That is
 * a property of the storage layout chosen in RD-STORAGE-01, not a shortcut taken here.
 *
 * ─── Why one transaction ─────────────────────────────────────────────────────
 * Up to four counters change together (source gallery, source album, destination gallery,
 * destination album). Any split would let a crash leave a photo counted twice or not at all
 * — and the storage dashboard reads counters rather than scanning, so a drift there is
 * permanent and invisible.
 *
 * The destination must be in the SAME EVENT: the key is event-scoped, so moving across
 * events would file a photo under an event whose prefix it does not live in.
 */
export async function moveAsset(params: {
  assetId:      string
  organizerUid: string
  toGalleryId:  string
  toAlbumId:    string | null
}): Promise<AssetMutationOutcome> {
  const ref = assets().doc(params.assetId)

  return adminDb.runTransaction(async tx => {
    // ── every read first: Firestore forbids a read after a write ──
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false as const, status: 404, error: 'Photo not found' }

    const doc = snap.data() as MediaAssetDoc
    if (doc.organizerUid !== params.organizerUid) {
      return { ok: false as const, status: 404, error: 'Photo not found' }
    }
    if (doc.status !== 'ready') {
      return { ok: false as const, status: 409, error: 'Only a fully uploaded photo can be moved.' }
    }

    const sameGallery = doc.galleryId === params.toGalleryId
    const sameAlbum   = (doc.albumId ?? null) === params.toAlbumId
    if (sameGallery && sameAlbum) return { ok: true as const, asset: doc }

    const destGalleryRef  = galleries().doc(params.toGalleryId)
    const destGallerySnap = await tx.get(destGalleryRef)
    if (!destGallerySnap.exists) {
      return { ok: false as const, status: 404, error: 'Destination gallery not found' }
    }
    const destGallery = destGallerySnap.data() as { organizerUid: string; eventId: string }
    if (destGallery.organizerUid !== params.organizerUid) {
      return { ok: false as const, status: 404, error: 'Destination gallery not found' }
    }
    if (destGallery.eventId !== doc.eventId) {
      return {
        ok: false as const, status: 409,
        error: 'A photo can only be moved within the event it was uploaded to.',
      }
    }

    let destAlbumRef: FirebaseFirestore.DocumentReference | null = null
    if (params.toAlbumId) {
      destAlbumRef = albums().doc(params.toAlbumId)
      const destAlbumSnap = await tx.get(destAlbumRef)
      if (!destAlbumSnap.exists) {
        return { ok: false as const, status: 404, error: 'Destination album not found' }
      }
      const destAlbum = destAlbumSnap.data() as { organizerUid: string; galleryId: string }
      if (destAlbum.organizerUid !== params.organizerUid || destAlbum.galleryId !== params.toGalleryId) {
        return { ok: false as const, status: 404, error: 'Destination album is not in that gallery' }
      }
    }

    const srcGalleryRef  = galleries().doc(doc.galleryId)
    const srcAlbumRef    = doc.albumId ? albums().doc(doc.albumId) : null
    const srcGallerySnap = sameGallery ? destGallerySnap : await tx.get(srcGalleryRef)
    const srcAlbumSnap   = srcAlbumRef ? await tx.get(srcAlbumRef) : null

    // ── writes ──
    const count  = 1
    const bytes  = doc.bytesStored
    const source = doc.bytesOriginalSource
    const stamp  = FieldValue.serverTimestamp()

    if (!sameGallery) {
      tx.update(srcGalleryRef, {
        assetCount:  FieldValue.increment(-count),
        bytesStored: FieldValue.increment(-bytes),
        bytesOriginalSource: FieldValue.increment(-source),
        ...(srcGallerySnap.get('coverAssetId') === params.assetId ? { coverAssetId: null } : {}),
        updatedAt: stamp,
      })
      tx.update(destGalleryRef, {
        assetCount:  FieldValue.increment(count),
        bytesStored: FieldValue.increment(bytes),
        bytesOriginalSource: FieldValue.increment(source),
        ...(destGallerySnap.get('coverAssetId') ? {} : { coverAssetId: params.assetId }),
        updatedAt: stamp,
      })
    }

    if (srcAlbumRef && !sameAlbum) {
      tx.update(srcAlbumRef, {
        assetCount:  FieldValue.increment(-count),
        bytesStored: FieldValue.increment(-bytes),
        bytesOriginalSource: FieldValue.increment(-source),
        ...(srcAlbumSnap && srcAlbumSnap.get('coverAssetId') === params.assetId ? { coverAssetId: null } : {}),
        updatedAt: stamp,
      })
    }
    if (destAlbumRef && !sameAlbum) {
      tx.update(destAlbumRef, {
        assetCount:  FieldValue.increment(count),
        bytesStored: FieldValue.increment(bytes),
        bytesOriginalSource: FieldValue.increment(source),
        updatedAt: stamp,
      })
    }

    tx.update(ref, {
      galleryId: params.toGalleryId,
      albumId:   params.toAlbumId,
      updatedAt: stamp,
    })

    return {
      ok: true as const,
      asset: { ...doc, galleryId: params.toGalleryId, albumId: params.toAlbumId },
    }
  })
}

// ═══════════════ RD-MEDIA-04 · Visibility (the publish workflow) ═══════════════

/**
 * Changes how a photo may be served.
 *
 * THE publish control. Before this, `visibility` was stamped from workspace settings at
 * upload time and could never change — an organizer who uploaded a gallery as PUBLIC had no
 * way to withdraw it, and one who uploaded as SIGNED_URL had no way to publish. Neither is
 * acceptable for a platform that hosts photographs of named participants.
 *
 * Counters do not move: visibility changes who may look, not what is stored.
 */
export async function setAssetVisibility(params: {
  assetId:      string
  organizerUid: string
  visibility:   AssignableVisibility
}): Promise<AssetMutationOutcome> {
  const ref = assets().doc(params.assetId)

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false as const, status: 404, error: 'Photo not found' }

    const doc = snap.data() as MediaAssetDoc
    if (doc.organizerUid !== params.organizerUid) {
      return { ok: false as const, status: 404, error: 'Photo not found' }
    }
    if (doc.status !== 'ready') {
      return { ok: false as const, status: 409, error: 'Only a fully uploaded photo can be published.' }
    }

    tx.update(ref, { visibility: params.visibility, updatedAt: FieldValue.serverTimestamp() })
    return { ok: true as const, asset: { ...doc, visibility: params.visibility } }
  })
}

// ═══════════════ RD-MEDIA-04 · Reclamation ═══════════════

export interface ReclaimableAsset {
  assetId: string
  paths:   string[]
}

/**
 * Assets whose OBJECTS are reclaimable: uploads that were authorized and never finished,
 * and deleted records whose best-effort object removal may not have succeeded.
 *
 * Bounded by AGE so a live upload is never swept out from under a slow connection, and by
 * COUNT so one tick cannot run away.
 */
export async function listReclaimable(
  olderThanMs: number, limitN = 200,
): Promise<ReclaimableAsset[]> {
  const cutoff = Timestamp.fromMillis(Date.now() - olderThanMs)

  const snap = await assets()
    .where('status', 'in', RECLAIMABLE_STATUSES as string[])
    .where('updatedAt', '<=', cutoff)
    .orderBy('updatedAt', 'asc')
    .limit(limitN)
    .get()

  return snap.docs.map(d => {
    const doc = d.data() as MediaAssetDoc
    return {
      assetId: doc.assetId,
      paths:   Object.values(doc.renditions ?? {}).map(r => r.path).filter(Boolean),
    }
  })
}

/**
 * Removes the record once its objects are gone.
 *
 * The status is RE-CHECKED inside the transaction: a `pending` record that completed between
 * the sweep's read and this write is now `ready`, and deleting it would erase a real photo
 * whose bytes are already counted.
 */
export async function purgeReclaimedAsset(assetId: string): Promise<boolean> {
  const ref = assets().doc(assetId)

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return false

    const doc = snap.data() as MediaAssetDoc
    if (!(RECLAIMABLE_STATUSES as readonly string[]).includes(doc.status)) return false

    tx.delete(ref)
    return true
  })
}

// ═══════════════ RD-PUBGAL-01 · Public reads ═══════════════
//
// Additive and READ-ONLY. They live here, in the module that owns `mediaAssets`, rather
// than in a second repository — a parallel query layer is how two places end up disagreeing
// about what "public" means.
//
// The visibility filter is IN THE QUERY, not applied afterwards. Filtering a fetched page
// would make the page size a lie (24 requested, 6 public) and would read documents the
// visitor is not entitled to.

/**
 * A page of PUBLIC photos for a gallery, optionally narrowed to one album.
 *
 * Cursor-paginated on `uploadedAt`, never an offset — page 40 of a 100,000-photo gallery
 * costs what page 1 costs.
 */
export async function listPublicAssets(params: {
  organizerUid: string
  galleryId:    string
  albumId?:     string | null
  limit?:       number
  cursor?:      string | null
}): Promise<AssetPage> {
  const limit = Math.min(Math.max(1, params.limit ?? 36), 72)

  let q = assets()
    .where('organizerUid', '==', params.organizerUid)
    .where('galleryId', '==', params.galleryId)

  if (params.albumId) q = q.where('albumId', '==', params.albumId)

  q = q
    .where('visibility', '==', 'PUBLIC')
    .where('status', '==', 'ready')
    .orderBy('uploadedAt', 'desc')
    .limit(limit)

  if (params.cursor) {
    const cursorSnap = await assets().doc(params.cursor).get()
    // A cursor for another tenant's document must not seek this query. It reads as absent,
    // so paging restarts rather than leaking a position in someone else's gallery.
    if (cursorSnap.exists && cursorSnap.get('organizerUid') === params.organizerUid) {
      q = q.startAfter(cursorSnap)
    }
  }

  const snap = await q.get()
  const docs = snap.docs.map(d => d.data() as MediaAssetDoc)

  return {
    assets: docs,
    nextCursor: snap.size === limit && docs.length > 0 ? docs[docs.length - 1].assetId : null,
  }
}

/**
 * How many PUBLIC photos a gallery holds.
 *
 * An aggregate `count()` — no document reads — so a landing page listing twenty galleries
 * costs twenty counts rather than twenty scans, and the number is exact rather than
 * `assetCount` (which includes photos the visitor may not see).
 */
export async function countPublicAssets(
  organizerUid: string, galleryId: string, albumId?: string | null,
): Promise<number> {
  let q = assets()
    .where('organizerUid', '==', organizerUid)
    .where('galleryId', '==', galleryId)

  if (albumId) q = q.where('albumId', '==', albumId)

  const agg = await q
    .where('visibility', '==', 'PUBLIC')
    .where('status', '==', 'ready')
    .count()
    .get()

  return agg.data().count
}

/**
 * A public asset by id, re-checked against its gallery.
 *
 * Used by the download route. `assetId` is not a capability: the caller supplies one, and
 * every property that decides whether it may be served — tenant, event, status, visibility —
 * is read from the document and re-verified by the service.
 */
export async function getPublicAsset(assetId: string): Promise<MediaAssetDoc | null> {
  if (!assetId || assetId.includes('/') || assetId.length > 200) return null
  const snap = await assets().doc(assetId).get()
  if (!snap.exists) return null
  const doc = snap.data() as MediaAssetDoc
  return doc.schemaVersion === MEDIA_SCHEMA_VERSION ? doc : null
}

/**
 * RD-MEDIA-05 — how many assets are in one status, platform-wide.
 *
 * An aggregate `count()`: no document reads, so the maintenance panel costs the same on an
 * empty platform as on one holding a million photos. Uses the automatic single-field index
 * on `status`, so it adds no composite index.
 *
 * Deliberately NOT tenant-scoped. Maintenance is a platform operation (see
 * `services/maintenanceService.ts` for why), and its routes are platform-admin only.
 */
export async function countByStatus(status: MediaAssetStatus): Promise<number> {
  try {
    const agg = await assets().where('status', '==', status).count().get()
    return agg.data().count
  } catch {
    // A count is diagnostic, not load-bearing. A failure reports zero rather than taking
    // down the panel that exists to tell an operator what is going on.
    return 0
  }
}

/**
 * RD-MEDIA-08 — how many READY photos an event holds, across every gallery.
 *
 * The number `maxPhotosPerEvent` is enforced against. An aggregate `count()`, so it reads
 * no documents and costs the same whether the event holds 50 photos or 50,000.
 *
 * RD-MS-CLOSURE-01 · served by the DECLARED (organizerUid, eventId, status) index.
 *
 * The previous note here claimed it reused the (organizerUid, eventId, checksum) prefix "plus
 * the automatic single-field index on status". That was wrong to rely on: Firestore can
 * sometimes merge single-field indexes for an equality-only query, but it is a planner
 * decision, not a guarantee — and the `catch` below returns 0 on failure, which errs toward
 * ALLOWING the upload. A missing index here would therefore not surface as an error; it would
 * silently stop enforcing the photo cap. The index is now declared explicitly so the
 * behaviour does not depend on a query plan.
 */
export async function countEventAssets(organizerUid: string, eventId: string): Promise<number> {
  try {
    const agg = await assets()
      .where('organizerUid', '==', organizerUid)
      .where('eventId', '==', eventId)
      .where('status', '==', 'ready')
      .count()
      .get()
    return agg.data().count
  } catch {
    // A failed count must not block an upload. Reporting zero errs toward ALLOWING the
    // upload, which is the right direction: a limit check that fails closed on an
    // infrastructure hiccup would stop an event mid-import.
    return 0
  }
}

/**
 * MC-07 · Every ready photo in a workspace, across all its events.
 *
 * Mirrors `countEventAssets` exactly, minus the event filter — same collection, same
 * `ready` status, same server-side aggregation rather than reading documents.
 *
 * Unlike the per-event count this is a DASHBOARD figure, not a limit check, so a failure
 * returns null rather than 0: showing "0 photos" to an organizer who has uploaded thousands
 * is worse than showing nothing at all, and the caller can render an empty state instead of
 * a confident lie.
 */
export async function countWorkspaceAssets(organizerUid: string): Promise<number | null> {
  try {
    const agg = await assets()
      .where('organizerUid', '==', organizerUid)
      .where('status', '==', 'ready')
      .count()
      .get()
    return agg.data().count
  } catch {
    return null
  }
}

/**
 * RD-MS-CLOSURE-01 · Records that a photo was downloaded.
 *
 * ═══ BEST EFFORT, BY DESIGN ══════════════════════════════════════════════════
 * Never awaited by a download route and never allowed to throw. A counter is an analytic;
 * a download is the product. If Firestore is slow or unavailable the participant still gets
 * their photo and the platform loses one tick — the opposite trade would let a metrics
 * failure break the thing being measured.
 *
 * `FieldValue.increment` rather than read-modify-write: a popular finisher photo can be
 * downloaded by many people at once, and a read-then-set would silently lose counts. The
 * increment is a server-side atomic operation and needs no transaction.
 *
 * `update`, not `set`: a download can only happen for a photo that exists, so a missing
 * document means the asset was deleted mid-download and there is nothing to count.
 */
export async function recordDownload(assetId: string): Promise<void> {
  try {
    await assets().doc(assetId).update({ downloadCount: FieldValue.increment(1) })
  } catch {
    // Deleted mid-download, or the datastore is unavailable. Neither is worth a log line on
    // a path that runs once per photo per visitor.
  }
}
