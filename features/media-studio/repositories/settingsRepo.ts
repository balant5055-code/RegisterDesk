// RD-MEDIA-01 · Media settings + storage statistics — SERVER ONLY.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  DEFAULT_MEDIA_SETTINGS, MEDIA_GALLERIES, MEDIA_SCHEMA_VERSION, MEDIA_SETTINGS,
  type MediaSettingsDoc, type StorageUsageView,
} from '@/features/media-studio/types'
import type { GalleryDoc } from '@/features/media-studio/types'
// RD-MEDIA-09 — the shape an event override may carry. Defined by the config engine, so the
// override editor and the resolver can never disagree about which fields exist.
import type { MediaOverridableConfig } from '@/lib/config/businessConfig'

const settings = () => adminDb.collection(MEDIA_SETTINGS)

/** Settings for a workspace, falling back to the documented defaults. Never throws for a
 *  first-time organizer — an absent document IS the default. */
export async function getSettings(organizerUid: string): Promise<MediaSettingsDoc> {
  const snap = await settings().doc(organizerUid).get()
  if (!snap.exists) {
    return { organizerUid, ...DEFAULT_MEDIA_SETTINGS, updatedAt: null }
  }
  const doc = snap.data() as MediaSettingsDoc
  if (doc.schemaVersion !== MEDIA_SCHEMA_VERSION) {
    return { organizerUid, ...DEFAULT_MEDIA_SETTINGS, updatedAt: null }
  }
  return doc
}

export type SettingsPatch = Partial<Omit<MediaSettingsDoc, 'organizerUid' | 'schemaVersion' | 'updatedAt'>>

export async function saveSettings(organizerUid: string, patch: SettingsPatch): Promise<MediaSettingsDoc> {
  const ref = settings().doc(organizerUid)
  await ref.set({
    ...DEFAULT_MEDIA_SETTINGS,   // supplies schemaVersion + every default
    ...patch,                    // caller's changes win over the defaults…
    organizerUid,                // …but identity and version are never caller-controlled
    schemaVersion: MEDIA_SCHEMA_VERSION,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
  return (await ref.get()).data() as MediaSettingsDoc
}

// ─── Storage dashboard ────────────────────────────────────────────────────────

/**
 * Usage for one event, computed from the GALLERY counters rather than by scanning assets.
 *
 * That is the whole reason the counters are maintained transactionally: a 50,000-photo
 * event's dashboard costs a handful of reads instead of 50,000. The trade is that a counter
 * bug shows up here as a wrong number — which is why every counter change is transactional
 * and idempotent (see assetRepo.registerAsset).
 */
export async function computeUsage(organizerUid: string, eventId: string): Promise<StorageUsageView> {
  const gallerySnap = await adminDb.collection(MEDIA_GALLERIES)
    .where('organizerUid', '==', organizerUid)
    .where('eventId', '==', eventId)
    .limit(200)
    .get()

  const galleries = gallerySnap.docs.map(d => d.data() as GalleryDoc)

  const bytesStored = galleries.reduce((n, g) => n + (g.bytesStored ?? 0), 0)
  const photoCount  = galleries.reduce((n, g) => n + (g.assetCount ?? 0), 0)
  const albumCount  = galleries.reduce((n, g) => n + (g.albumCount ?? 0), 0)

  // The pre-compression total is a real counter, incremented in the same transaction as
  // bytesStored (assetRepo.registerAsset), so "space saved" is measured rather than guessed.
  const bytesOriginalSource = galleries.reduce((n, g) => n + (g.bytesOriginalSource ?? 0), 0)

  // Saved can only be positive: a profile never inflates a photo, and an `original` profile
  // stores exactly the source, giving a genuine zero.
  const bytesSaved = Math.max(0, bytesOriginalSource - bytesStored)

  return {
    bytesStored,
    bytesOriginalSource,
    bytesSaved,
    savingsPercent: bytesOriginalSource > 0
      ? Math.round((bytesSaved / bytesOriginalSource) * 100)
      : 0,
    photoCount,
    averageFileSize: photoCount > 0 ? Math.round(bytesStored / photoCount) : 0,
    galleryCount:    galleries.length,
    albumCount,
  }
}

// ─── RD-MEDIA-09 · Per-event limit overrides ──────────────────────────────────
//
// The TOP layer of the limit hierarchy. Stored as a map on THIS document rather than in a
// new collection because the upload path already reads it, so an override costs the hot
// path no extra read (RD-MEDIA-08).

/** One event's override deltas. `{}` means "inherit everything". */
export async function getEventOverride(
  organizerUid: string, eventId: string,
): Promise<Partial<MediaOverridableConfig>> {
  const snap = await settings().doc(organizerUid).get()
  if (!snap.exists) return {}
  const map = snap.get('eventLimitOverrides') as
    Record<string, Partial<MediaOverridableConfig>> | undefined
  return map?.[eventId] ?? {}
}

/**
 * Replaces ONE event's deltas, leaving every other event's untouched.
 *
 * A targeted field path, not a whole-map write: a stale browser tab saving the full map
 * would otherwise wipe every override made elsewhere since it loaded. An empty object
 * DELETES the entry rather than storing `{}` — "inherit everything" should leave no trace
 * for the resolver to walk.
 */
export async function saveEventOverride(
  organizerUid: string,
  eventId: string,
  overrides: Partial<MediaOverridableConfig>,
): Promise<void> {
  const ref  = settings().doc(organizerUid)
  const path = `eventLimitOverrides.${eventId}`

  // `set` with merge rather than `update`: the settings document legitimately may not exist
  // yet, and an override should not require the organizer to have saved settings first.
  await ref.set({
    ...DEFAULT_MEDIA_SETTINGS,
    organizerUid,
    schemaVersion: MEDIA_SCHEMA_VERSION,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  await ref.update({
    [path]: Object.keys(overrides).length === 0 ? FieldValue.delete() : overrides,
    updatedAt: FieldValue.serverTimestamp(),
  })
}
