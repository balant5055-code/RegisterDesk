// Organizer Asset Library (GA-6 S4). Reusable images (backgrounds, logos, signatures,
// icons, sponsor logos, watermarks) an organizer uploads ONCE and reuses across every
// certificate/print project. Pure types + validation; storage is the EXISTING flow.

export type AssetCategory =
  | 'background' | 'logo' | 'signature' | 'icon' | 'sponsor' | 'watermark' | 'image'

export const ASSET_CATEGORIES: readonly AssetCategory[] =
  ['background', 'logo', 'signature', 'icon', 'sponsor', 'watermark', 'image']

export interface OrganizerAsset {
  id:           string
  organizerUid: string
  category:     AssetCategory
  name:         string
  url:          string          // organizer-assets/{uid}/library-… download URL
  folder:       string          // organizer-defined folder ('' = root)
  contentType:  string
  createdAt:    unknown         // Firestore Timestamp
  createdBy:    string
}

export type OrganizerAssetInput = Pick<OrganizerAsset, 'category' | 'name' | 'url'> &
  Partial<Pick<OrganizerAsset, 'folder' | 'contentType'>>

export interface SerializedOrganizerAsset extends Omit<OrganizerAsset, 'createdAt'> {
  createdAt: string | null
}

const isCategory = (v: unknown): v is AssetCategory => ASSET_CATEGORIES.includes(v as AssetCategory)
// Must be a Firebase Storage URL under the organizer's own library path (SSRF-safe).
const isLibraryUrl = (v: unknown): v is string =>
  typeof v === 'string' && /^https:\/\/firebasestorage\.googleapis\.com\//.test(v)

/** Validates an asset-create body into a clean input (no undefined keys). */
export function validateAssetInput(raw: unknown): { ok: true; value: OrganizerAssetInput } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Body must be an object' }
  const r = raw as Record<string, unknown>
  if (!isCategory(r.category)) return { ok: false, error: 'Invalid asset category' }
  if (!isLibraryUrl(r.url))    return { ok: false, error: 'url must be a Firebase Storage URL' }
  const name   = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 120) : 'Untitled'
  const folder = typeof r.folder === 'string' ? r.folder.trim().slice(0, 60) : ''
  const value: OrganizerAssetInput = { category: r.category, name, url: r.url, folder }
  if (typeof r.contentType === 'string') value.contentType = r.contentType.slice(0, 80)
  return { ok: true, value }
}
