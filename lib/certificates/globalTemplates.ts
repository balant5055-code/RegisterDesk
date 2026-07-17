// Admin-curated GLOBAL certificate template library (GA-6 S5). Server-only.
// Collection `globalCertificateTemplates`. These are platform-owned starter/featured
// templates any organizer can IMPORT into an event (the import creates a normal
// certificate template — reusing the existing Certificate Engine + renderer). This is
// a catalog + governance layer; it introduces NO new designer/render/storage engine.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import type { CertificateType, CertificateLayout, CertificateDimensions, TemplateType } from './types'

export type GlobalTemplateTier   = 'starter' | 'featured' | 'premium' | 'seasonal'
export type GlobalTemplateStatus = 'draft' | 'published' | 'archived' | 'retired'

export const GLOBAL_TEMPLATE_TIERS: readonly GlobalTemplateTier[]     = ['starter', 'featured', 'premium', 'seasonal']
export const GLOBAL_TEMPLATE_STATUSES: readonly GlobalTemplateStatus[] = ['draft', 'published', 'archived', 'retired']
// Curation categories (Part 2). 'custom' + any admin-set string are allowed.
export const GLOBAL_TEMPLATE_CATEGORIES: readonly string[] = [
  'sports', 'conference', 'workshop', 'ngo', 'corporate', 'school', 'college',
  'medical', 'religious', 'government', 'seasonal', 'custom',
]

export interface GlobalCertificateTemplate {
  id:           string
  name:         string
  description:  string
  category:     string
  tags:         string[]
  tier:         GlobalTemplateTier
  status:       GlobalTemplateStatus
  featured:     boolean
  // Base file (admin-hosted under certificates/global/…) + optional builder layout.
  templateType: TemplateType
  fileUrl:      string
  fileName:     string
  fileSize:     number
  dimensions:   CertificateDimensions | null
  pageCount:    number | null
  layout?:      CertificateLayout
  certificateType?: CertificateType
  thumbnailUrl?: string
  usageCount:   number         // imports across all organizers
  createdBy:    string         // admin uid
  createdAt:    unknown
  updatedAt:    unknown
}

export interface SerializedGlobalTemplate extends Omit<GlobalCertificateTemplate, 'createdAt' | 'updatedAt'> {
  createdAt: string | null
  updatedAt: string | null
}

const col = () => adminDb.collection('globalCertificateTemplates')

function tsToIso(v: unknown): string | null {
  if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') {
    try { return (v as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  return null
}

export function serializeGlobalTemplate(t: GlobalCertificateTemplate): SerializedGlobalTemplate {
  const { createdAt, updatedAt, ...rest } = t
  return { ...rest, createdAt: tsToIso(createdAt), updatedAt: tsToIso(updatedAt) }
}

export async function getGlobalTemplate(id: string): Promise<GlobalCertificateTemplate | null> {
  const snap = await col().doc(id).get()
  return snap.exists ? (snap.data() as GlobalCertificateTemplate) : null
}

/** Admin listing — all templates (any status), newest first. */
export async function listGlobalTemplatesAdmin(): Promise<GlobalCertificateTemplate[]> {
  const snap = await col().limit(1000).get()
  return snap.docs.map(d => d.data() as GlobalCertificateTemplate)
    .sort((a, b) => (tsToIso(b.createdAt) ?? '').localeCompare(tsToIso(a.createdAt) ?? ''))
}

/** Organizer-facing listing — only PUBLISHED templates, optional category filter. */
export async function listPublishedGlobalTemplates(filter?: { category?: string; q?: string }): Promise<GlobalCertificateTemplate[]> {
  const snap = await col().where('status', '==', 'published').limit(1000).get()
  let items = snap.docs.map(d => d.data() as GlobalCertificateTemplate)
  if (filter?.category) items = items.filter(t => t.category === filter.category)
  if (filter?.q) {
    const q = filter.q.toLowerCase()
    items = items.filter(t => t.name.toLowerCase().includes(q) || t.tags.some(tag => tag.toLowerCase().includes(q)))
  }
  // Featured first, then by usage.
  return items.sort((a, b) => (Number(b.featured) - Number(a.featured)) || (b.usageCount - a.usageCount))
}

export interface GlobalTemplateCreate {
  name: string; description?: string; category: string; tags?: string[]
  tier?: GlobalTemplateTier; templateType: TemplateType; fileUrl: string
  fileName: string; fileSize: number; dimensions: CertificateDimensions | null
  pageCount: number | null; layout?: CertificateLayout; certificateType?: CertificateType; thumbnailUrl?: string
}

export async function createGlobalTemplate(input: GlobalTemplateCreate, adminUid: string): Promise<GlobalCertificateTemplate> {
  const ref = col().doc()
  const doc: Record<string, unknown> = {
    id: ref.id, name: input.name, description: input.description ?? '',
    category: input.category, tags: input.tags ?? [], tier: input.tier ?? 'starter',
    status: 'draft', featured: false,
    templateType: input.templateType, fileUrl: input.fileUrl, fileName: input.fileName,
    fileSize: input.fileSize, dimensions: input.dimensions ?? null, pageCount: input.pageCount ?? null,
    usageCount: 0, createdBy: adminUid,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  }
  if (input.layout) doc.layout = input.layout
  if (input.certificateType) doc.certificateType = input.certificateType
  if (input.thumbnailUrl) doc.thumbnailUrl = input.thumbnailUrl
  await ref.set(doc)
  return (await ref.get()).data() as GlobalCertificateTemplate
}

export async function patchGlobalTemplate(
  id: string,
  patch: Partial<Pick<GlobalCertificateTemplate, 'name' | 'description' | 'category' | 'tags' | 'tier' | 'status' | 'featured' | 'certificateType' | 'thumbnailUrl'>>,
): Promise<GlobalCertificateTemplate | null> {
  const ref = col().doc(id)
  if (!(await ref.get()).exists) return null
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() })
  return (await ref.get()).data() as GlobalCertificateTemplate
}

export async function deleteGlobalTemplate(id: string): Promise<void> {
  await col().doc(id).delete()
}

export async function recordGlobalTemplateImport(id: string): Promise<void> {
  try { await col().doc(id).update({ usageCount: FieldValue.increment(1) }) } catch { /* best-effort */ }
}
