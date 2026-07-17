// PATCH  /api/admin/certificate-templates/[id] — governance (feature/status/tier/…)
// DELETE /api/admin/certificate-templates/[id] — remove a global template
//
// Admin-only. Governance actions map to status transitions + the featured flag:
//   approve/publish → status:'published'; hide → 'archived'; retire → 'retired';
//   feature/unfeature → featured. No rendering change.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import {
  patchGlobalTemplate, deleteGlobalTemplate, getGlobalTemplate, serializeGlobalTemplate,
  GLOBAL_TEMPLATE_STATUSES, GLOBAL_TEMPLATE_TIERS,
  type GlobalCertificateTemplate,
} from '@/lib/certificates/globalTemplates'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params

  let b: Record<string, unknown>
  try { b = await req.json() as Record<string, unknown> } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const patch: Partial<Pick<GlobalCertificateTemplate, 'name' | 'description' | 'category' | 'tags' | 'tier' | 'status' | 'featured'>> = {}
  if ('status' in b) {
    if (!GLOBAL_TEMPLATE_STATUSES.includes(b.status as never)) return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    patch.status = b.status as GlobalCertificateTemplate['status']
  }
  if ('featured' in b) {
    if (typeof b.featured !== 'boolean') return NextResponse.json({ error: 'featured must be a boolean' }, { status: 400 })
    patch.featured = b.featured
  }
  if ('tier' in b) {
    if (!GLOBAL_TEMPLATE_TIERS.includes(b.tier as never)) return NextResponse.json({ error: 'Invalid tier' }, { status: 400 })
    patch.tier = b.tier as GlobalCertificateTemplate['tier']
  }
  if ('name' in b && typeof b.name === 'string') patch.name = b.name.trim().slice(0, 120)
  if ('description' in b && typeof b.description === 'string') patch.description = b.description.slice(0, 500)
  if ('category' in b && typeof b.category === 'string') patch.category = b.category.trim().slice(0, 60)
  if ('tags' in b && Array.isArray(b.tags)) patch.tags = b.tags.filter((t): t is string => typeof t === 'string').map(t => t.slice(0, 40)).slice(0, 20)
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })

  const updated = await patchGlobalTemplate(id, patch)
  if (!updated) return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  return NextResponse.json({ success: true, template: serializeGlobalTemplate(updated) })
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  if (!(await getGlobalTemplate(id))) return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  await deleteGlobalTemplate(id)
  return NextResponse.json({ success: true })
}
