import {
  getStorage, ref,
  uploadBytes, uploadBytesResumable, getDownloadURL,
} from 'firebase/storage'
import { firebaseApp } from '@/lib/firebase/config'

export type AssetType = 'logo' | 'banner' | 'gallery'
// GA-6 S4 adds brand-kit slots (one per type, overwrite-in-place) — additive.
export type OrganizerAssetType =
  | 'logo' | 'cert-signature' | 'email-header'
  | 'brand-logo' | 'brand-secondary-logo' | 'brand-seal' | 'brand-signature'

let _storage: ReturnType<typeof getStorage> | null = null
function store() {
  if (!_storage) _storage = getStorage(firebaseApp)
  return _storage
}

/**
 * Converts a data URL to a Blob using atob() — safe under any CSP because it
 * does NOT make a network request (unlike fetch('data:...')).
 *
 * The original implementation used fetch(dataUrl) which is blocked by strict
 * CSP connect-src directives that don't explicitly list `data:`. atob() is a
 * synchronous browser built-in with no CSP restrictions.
 */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const mime  = dataUrl.slice(5, dataUrl.indexOf(';'))   // 'data:image/jpeg;...'
  const bytes = atob(dataUrl.slice(comma + 1))
  const arr   = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime || 'image/jpeg' })
}

/**
 * Uploads an image (data URL) to Firebase Storage under the event's asset folder.
 * Returns the public download URL.
 *
 * Uses atob() for data URL → Blob conversion (bypasses CSP connect-src restrictions).
 * When onProgress is provided, uses uploadBytesResumable to stream 0–100% progress.
 *
 * Storage path:
 *   event-assets/{uid}/{eventId}/{assetType}/{filename}
 */
export async function uploadEventAsset(
  uid:         string,
  eventId:     string,
  assetType:   AssetType,
  dataUrl:     string,
  filename:    string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const blob       = dataUrlToBlob(dataUrl)
  const storageRef = ref(store(), `event-assets/${uid}/${eventId}/${assetType}/${filename}`)

  if (onProgress) {
    return new Promise<string>((resolve, reject) => {
      const task = uploadBytesResumable(storageRef, blob)
      task.on(
        'state_changed',
        snap => onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
        reject,
        () => getDownloadURL(task.snapshot.ref).then(resolve, reject),
      )
    })
  }

  const snap = await uploadBytes(storageRef, blob)
  return getDownloadURL(snap.ref)
}

/** Returns the storage path prefix for an event's asset folder. */
export function eventAssetPath(uid: string, eventId: string, assetType: AssetType): string {
  return `event-assets/${uid}/${eventId}/${assetType}`
}

/**
 * Uploads a certificate template file (PDF / PNG / JPG) to Firebase Storage and
 * returns the public download URL. The owning uid is encoded in the path so the
 * Storage security rules authorize the write; the API then validates the URL is
 * within the caller's own folder before recording the template.
 *
 * Storage path:
 *   certificates/templates/{uid}/{eventId}/{timestamp}-{filename}
 *
 * Size and content-type limits (PDF 25 MB; PNG/JPG 10 MB) are enforced by the
 * Storage rules; the server re-derives metadata from the uploaded bytes.
 */
export async function uploadCertificateTemplate(
  uid:         string,
  eventId:     string,
  file:        File,
  onProgress?: (pct: number) => void,
): Promise<string> {
  // Sanitize the filename and prefix with a timestamp to avoid collisions.
  const safeName   = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)
  const objectName = `${Date.now()}-${safeName}`
  const storageRef = ref(store(), `certificates/templates/${uid}/${eventId}/${objectName}`)

  if (onProgress) {
    return new Promise<string>((resolve, reject) => {
      const task = uploadBytesResumable(storageRef, file)
      task.on(
        'state_changed',
        snap => onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
        reject,
        () => getDownloadURL(task.snapshot.ref).then(resolve, reject),
      )
    })
  }

  const snap = await uploadBytes(storageRef, file)
  return getDownloadURL(snap.ref)
}

/**
 * Uploads a certificate builder asset (logo / signature / seal / image) and
 * returns the download URL. Stored alongside templates so the same owner-scoped
 * Storage rule applies:
 *   certificates/templates/{uid}/{eventId}/assets/{timestamp}-{filename}
 *
 * The renderer fetches these (SSRF-guarded to this path) when rendering layouts.
 */
export async function uploadCertificateAsset(
  uid:         string,
  eventId:     string,
  file:        File,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const safeName   = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)
  const objectName = `${Date.now()}-${safeName}`
  const storageRef = ref(store(), `certificates/templates/${uid}/${eventId}/assets/${objectName}`)

  if (onProgress) {
    return new Promise<string>((resolve, reject) => {
      const task = uploadBytesResumable(storageRef, file)
      task.on(
        'state_changed',
        snap => onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
        reject,
        () => getDownloadURL(task.snapshot.ref).then(resolve, reject),
      )
    })
  }

  const snap = await uploadBytes(storageRef, file)
  return getDownloadURL(snap.ref)
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

/**
 * Uploads a reusable ASSET-LIBRARY image (GA-6 S4). Reuses the same owner-scoped
 * organizer-assets rule via a FLAT filename (folders/categories are metadata in
 * Firestore, not storage paths — so no new upload engine, no rule change):
 *   organizer-assets/{uid}/library-{timestamp}-{filename}
 */
export async function uploadOrganizerLibraryAsset(
  uid:  string,
  file: File,
): Promise<string> {
  const safeName   = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100)
  const objectName = `library-${Date.now()}-${safeName}`
  const snap = await uploadBytes(ref(store(), `organizer-assets/${uid}/${objectName}`), file)
  return getDownloadURL(snap.ref)
}
