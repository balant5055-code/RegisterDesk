import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { firebaseApp } from '@/lib/firebase/config'

export type AssetType = 'logo' | 'banner' | 'gallery'
export type OrganizerAssetType = 'logo' | 'cert-signature' | 'email-header'

let _storage: ReturnType<typeof getStorage> | null = null
function store() {
  if (!_storage) _storage = getStorage(firebaseApp)
  return _storage
}

/**
 * Uploads an image (data URL) to Firebase Storage under the event's asset folder.
 * Returns the public download URL.
 *
 * Target structure:
 *   event-assets/{uid}/{eventId}/{assetType}/{filename}
 *
 * Firebase Storage rules must allow authenticated write access before calling this.
 */
export async function uploadEventAsset(
  uid: string,
  eventId: string,
  assetType: AssetType,
  dataUrl: string,
  filename: string,
): Promise<string> {
  const res  = await fetch(dataUrl)
  const blob = await res.blob()
  const path = `event-assets/${uid}/${eventId}/${assetType}/${filename}`
  const snap = await uploadBytes(ref(store(), path), blob)
  return getDownloadURL(snap.ref)
}

/** Returns the storage path prefix for an event's asset folder. */
export function eventAssetPath(uid: string, eventId: string, assetType: AssetType): string {
  return `event-assets/${uid}/${eventId}/${assetType}`
}

/**
 * Uploads an organizer branding asset (logo, cert signature, email header) to
 * Firebase Storage under organizer-assets/{uid}/{assetType}.{ext}.
 * Overwrites any existing asset of the same type.
 * Returns the public download URL.
 */
export async function uploadOrganizerAsset(
  uid:       string,
  assetType: OrganizerAssetType,
  file:      File,
): Promise<string> {
  const ext  = file.name.includes('.') ? file.name.split('.').pop()! : 'jpg'
  const path = `organizer-assets/${uid}/${assetType}.${ext}`
  const snap = await uploadBytes(ref(store(), path), file)
  return getDownloadURL(snap.ref)
}
