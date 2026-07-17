// Asset Library persistence (GA-6 S4). Server-only. Collection `organizerAssets`,
// scoped by organizerUid. Reuses Firebase Admin — the image bytes live in Storage
// (uploaded via the existing organizer-asset flow); this only stores metadata.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import type { OrganizerAsset, OrganizerAssetInput, SerializedOrganizerAsset } from './types'

const COLLECTION = 'organizerAssets'
const col = () => adminDb.collection(COLLECTION)

function tsToIso(v: unknown): string | null {
  if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') {
    try { return (v as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  return null
}

export function serializeAsset(a: OrganizerAsset): SerializedOrganizerAsset {
  const { createdAt, ...rest } = a
  return { ...rest, createdAt: tsToIso(createdAt) }
}

export async function createAsset(organizerUid: string, input: OrganizerAssetInput, actorUid: string): Promise<OrganizerAsset> {
  const ref = col().doc()
  const doc: Omit<OrganizerAsset, 'createdAt'> & { createdAt: unknown } = {
    id: ref.id, organizerUid,
    category: input.category, name: input.name, url: input.url,
    folder: input.folder ?? '', contentType: input.contentType ?? '',
    createdBy: actorUid, createdAt: FieldValue.serverTimestamp(),
  }
  await ref.set(doc)
  return (await ref.get()).data() as OrganizerAsset
}

/** All of an organizer's assets, newest first. Category/folder/search filters are
 *  applied in-memory (the library is bounded per organizer — no composite index). */
export async function listAssets(
  organizerUid: string,
  filter?: { category?: string; folder?: string; q?: string },
): Promise<OrganizerAsset[]> {
  const snap = await col().where('organizerUid', '==', organizerUid).limit(2000).get()
  let assets = snap.docs.map(d => d.data() as OrganizerAsset)
  if (filter?.category) assets = assets.filter(a => a.category === filter.category)
  if (filter?.folder)   assets = assets.filter(a => (a.folder || '') === filter.folder)
  if (filter?.q) {
    const q = filter.q.toLowerCase()
    assets = assets.filter(a => a.name.toLowerCase().includes(q) || (a.folder || '').toLowerCase().includes(q))
  }
  return assets.sort((a, b) => (tsToIso(b.createdAt) ?? '').localeCompare(tsToIso(a.createdAt) ?? ''))
}

export async function getAsset(assetId: string): Promise<OrganizerAsset | null> {
  const snap = await col().doc(assetId).get()
  return snap.exists ? (snap.data() as OrganizerAsset) : null
}

export async function deleteAsset(assetId: string): Promise<void> {
  await col().doc(assetId).delete()
}
