// Brand Kit persistence (GA-6 S4). Server-only. One doc per organizer:
// `organizerBrandKit/{uid}`. Reuses Firebase Admin + the existing storage upload flow
// (assets are uploaded client-side to organizer-assets/{uid}/... and their URLs saved
// here) — no new storage system.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { defaultBrandKit, type BrandKit, type BrandKitInput } from './types'

const COLLECTION = 'organizerBrandKit'

/** The organizer's brand kit, or defaults when none has been saved yet. */
export async function getBrandKit(organizerUid: string): Promise<BrandKit> {
  const snap = await adminDb.collection(COLLECTION).doc(organizerUid).get()
  if (!snap.exists) return { organizerUid, ...defaultBrandKit() }
  return { organizerUid, ...defaultBrandKit(), ...(snap.data() as Partial<BrandKit>) }
}

/** Upserts the organizer's brand kit. */
export async function saveBrandKit(organizerUid: string, input: BrandKitInput, actorUid: string): Promise<BrandKit> {
  const ref = adminDb.collection(COLLECTION).doc(organizerUid)
  await ref.set(
    { organizerUid, ...input, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid },
    { merge: true },
  )
  return getBrandKit(organizerUid)
}
