// RD-MEDIA-01 · Gallery + album persistence — SERVER ONLY.
//
// The only module that writes mediaGalleries / mediaAlbums. Every read is tenant-filtered
// on organizerUid, and every counter change is transactional so a gallery's assetCount can
// never drift from reality through a concurrent upload.

import crypto from 'crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  MEDIA_ALBUMS, MEDIA_GALLERIES, MEDIA_SCHEMA_VERSION,
  type AlbumDoc, type AlbumView, type GalleryDoc, type GalleryPreset, type GalleryView,
} from '@/features/media-studio/types'

const galleries = () => adminDb.collection(MEDIA_GALLERIES)
const albums    = () => adminDb.collection(MEDIA_ALBUMS)

const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(10).toString('hex')}`

function toIso(v: unknown): string | null {
  if (!v) return null
  if (typeof v === 'object' && v !== null && 'toDate' in v) {
    return (v as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export function serializeGallery(g: GalleryDoc): GalleryView {
  return {
    galleryId: g.galleryId, name: g.name, slug: g.slug, preset: g.preset,
    description: g.description, assetCount: g.assetCount, albumCount: g.albumCount,
    bytesStored: g.bytesStored, createdAt: toIso(g.createdAt),
  }
}

export function serializeAlbum(a: AlbumDoc): AlbumView {
  return {
    albumId: a.albumId, galleryId: a.galleryId, name: a.name, slug: a.slug,
    description: a.description, assetCount: a.assetCount, bytesStored: a.bytesStored,
    createdAt: toIso(a.createdAt),
  }
}

// ─── Galleries ────────────────────────────────────────────────────────────────

export interface CreateGalleryInput {
  organizerUid: string
  eventId:      string
  eventSlug:    string
  name:         string
  slug:         string
  preset:       GalleryPreset
  description:  string | null
  createdBy:    string
}

export async function createGallery(input: CreateGalleryInput): Promise<GalleryDoc> {
  const galleryId = newId('gal')
  const ref = galleries().doc(galleryId)

  await ref.create({
    ...input,
    galleryId,
    schemaVersion: MEDIA_SCHEMA_VERSION,
    assetCount:  0,
    albumCount:  0,
    bytesStored: 0,
    bytesOriginalSource: 0,
    coverAssetId: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  return (await ref.get()).data() as GalleryDoc
}

export async function listGalleries(organizerUid: string, eventId: string): Promise<GalleryDoc[]> {
  const snap = await galleries()
    .where('organizerUid', '==', organizerUid)
    .where('eventId', '==', eventId)
    .orderBy('createdAt', 'asc')
    .limit(200)
    .get()
  return snap.docs.map(d => d.data() as GalleryDoc)
}

/** Tenant-checked read. A gallery in another workspace reads as absent, never forbidden. */
/**
 * RD-RUNNER-01 — gallery NAMES for a page of photos, in ONE round trip.
 *
 * Additive and read-only. A page of 24 photos usually spans a handful of galleries, and
 * resolving each name with its own `get()` would be the N+1 the performance budget forbids.
 * Tenant-checked: another workspace's gallery is absent, never an error.
 */
export async function getGalleriesByIds(
  galleryIds: readonly string[], organizerUid: string,
): Promise<Map<string, GalleryDoc>> {
  const unique = [...new Set(galleryIds)].filter(id => typeof id === 'string' && id !== '')
  const found = new Map<string, GalleryDoc>()
  if (unique.length === 0) return found

  const snaps = await adminDb.getAll(...unique.map(id => galleries().doc(id)))
  for (const snap of snaps) {
    if (!snap.exists) continue
    const doc = snap.data() as GalleryDoc
    if (doc.organizerUid !== organizerUid) continue
    if (doc.schemaVersion !== MEDIA_SCHEMA_VERSION) continue
    found.set(doc.galleryId, doc)
  }
  return found
}

export async function getOwnedGallery(
  galleryId: string, organizerUid: string,
): Promise<GalleryDoc | null> {
  const snap = await galleries().doc(galleryId).get()
  if (!snap.exists) return null
  const doc = snap.data() as GalleryDoc
  if (doc.organizerUid !== organizerUid) return null
  if (doc.schemaVersion !== MEDIA_SCHEMA_VERSION) return null
  return doc
}

export async function updateGallery(
  galleryId: string,
  patch: Partial<Pick<GalleryDoc, 'name' | 'slug' | 'description' | 'coverAssetId'>>,
): Promise<void> {
  await galleries().doc(galleryId).update({ ...patch, updatedAt: FieldValue.serverTimestamp() })
}

/**
 * Deletes a gallery only when it is EMPTY.
 *
 * Refusing a non-empty delete is deliberate: a cascade would orphan bytes in object storage
 * that this transaction cannot reach, leaving an invisible bill. The caller must empty it
 * first, which keeps Firestore and the bucket in step.
 */
export async function deleteEmptyGallery(galleryId: string): Promise<{ ok: boolean; reason?: string }> {
  return adminDb.runTransaction(async tx => {
    const ref  = galleries().doc(galleryId)
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false, reason: 'Gallery not found' }

    const doc = snap.data() as GalleryDoc
    if (doc.assetCount > 0) {
      return { ok: false, reason: `This gallery still holds ${doc.assetCount.toLocaleString('en-IN')} photos. Delete them first.` }
    }
    if (doc.albumCount > 0) {
      return { ok: false, reason: `This gallery still has ${doc.albumCount} album(s). Delete them first.` }
    }

    tx.delete(ref)
    return { ok: true }
  })
}

// ─── Albums ───────────────────────────────────────────────────────────────────

export interface CreateAlbumInput {
  organizerUid: string
  eventId:      string
  eventSlug:    string
  galleryId:    string
  name:         string
  slug:         string
  description:  string | null
  createdBy:    string
}

/** Creates the album and increments its gallery's albumCount in ONE transaction. */
export async function createAlbum(input: CreateAlbumInput): Promise<AlbumDoc> {
  const albumId = newId('alb')

  await adminDb.runTransaction(async tx => {
    const galleryRef = galleries().doc(input.galleryId)
    const gallerySnap = await tx.get(galleryRef)
    if (!gallerySnap.exists) throw new Error('Gallery not found')

    tx.create(albums().doc(albumId), {
      ...input,
      albumId,
      schemaVersion: MEDIA_SCHEMA_VERSION,
      assetCount: 0,
      bytesStored: 0,
      bytesOriginalSource: 0,
      coverAssetId: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
    tx.update(galleryRef, {
      albumCount: FieldValue.increment(1),
      updatedAt:  FieldValue.serverTimestamp(),
    })
  })

  return (await albums().doc(albumId).get()).data() as AlbumDoc
}

export async function listAlbums(
  organizerUid: string, galleryId: string,
): Promise<AlbumDoc[]> {
  const snap = await albums()
    .where('organizerUid', '==', organizerUid)
    .where('galleryId', '==', galleryId)
    .orderBy('createdAt', 'asc')
    .limit(200)
    .get()
  return snap.docs.map(d => d.data() as AlbumDoc)
}

export async function getOwnedAlbum(albumId: string, organizerUid: string): Promise<AlbumDoc | null> {
  const snap = await albums().doc(albumId).get()
  if (!snap.exists) return null
  const doc = snap.data() as AlbumDoc
  if (doc.organizerUid !== organizerUid) return null
  if (doc.schemaVersion !== MEDIA_SCHEMA_VERSION) return null
  return doc
}

export async function updateAlbum(
  albumId: string,
  patch: Partial<Pick<AlbumDoc, 'name' | 'slug' | 'description' | 'coverAssetId'>>,
): Promise<void> {
  await albums().doc(albumId).update({ ...patch, updatedAt: FieldValue.serverTimestamp() })
}

/** Empty-only, and decrements the gallery counter in the same transaction. */
export async function deleteEmptyAlbum(albumId: string): Promise<{ ok: boolean; reason?: string }> {
  return adminDb.runTransaction(async tx => {
    const ref  = albums().doc(albumId)
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false, reason: 'Album not found' }

    const doc = snap.data() as AlbumDoc
    if (doc.assetCount > 0) {
      return { ok: false, reason: `This album still holds ${doc.assetCount.toLocaleString('en-IN')} photos. Delete them first.` }
    }

    tx.delete(ref)
    tx.update(galleries().doc(doc.galleryId), {
      albumCount: FieldValue.increment(-1),
      updatedAt:  FieldValue.serverTimestamp(),
    })
    return { ok: true }
  })
}

/** Slugs already taken for an event (galleries) or a gallery (albums). */
export async function takenGallerySlugs(organizerUid: string, eventId: string): Promise<Set<string>> {
  const docs = await listGalleries(organizerUid, eventId)
  return new Set(docs.map(d => d.slug))
}

export async function takenAlbumSlugs(organizerUid: string, galleryId: string): Promise<Set<string>> {
  const docs = await listAlbums(organizerUid, galleryId)
  return new Set(docs.map(d => d.slug))
}
