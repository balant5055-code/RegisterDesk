// PATCH /api/organizer/events/[eventId]/certificates/templates/[templateId]/meta
//
// Template governance metadata (GA-6 S5): status (draft/published/archived), favorite,
// category, tags, visibility, description, program type. Additive — no rendering change.
// Security: auth + ownership (enforced by patchTemplateMeta → requireOwnedTemplate).

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { patchTemplateMeta }         from '@/lib/certificates/firestore'
import { serializeCertificateTemplateDoc, CERTIFICATE_TEMPLATE_STATUSES, type CertificateTemplateDoc } from '@/lib/certificates/types'
import { isCertificateType }         from '@/lib/certificates/validation'

type Params = { params: Promise<{ eventId: string; templateId: string }> }

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId, templateId } = await params
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const patch: Partial<Pick<CertificateTemplateDoc, 'status' | 'favorite' | 'category' | 'tags' | 'visibility' | 'programDescription' | 'certificateType'>> = {}
  if ('status' in body) {
    if (!CERTIFICATE_TEMPLATE_STATUSES.includes(body.status as never)) return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    patch.status = body.status as CertificateTemplateDoc['status']
  }
  if ('favorite' in body) {
    if (typeof body.favorite !== 'boolean') return NextResponse.json({ error: 'favorite must be a boolean' }, { status: 400 })
    patch.favorite = body.favorite
  }
  if ('visibility' in body) {
    if (body.visibility !== 'private' && body.visibility !== 'shared') return NextResponse.json({ error: 'Invalid visibility' }, { status: 400 })
    patch.visibility = body.visibility
  }
  if ('category' in body && typeof body.category === 'string') patch.category = body.category.slice(0, 60)
  if ('programDescription' in body && typeof body.programDescription === 'string') patch.programDescription = body.programDescription.slice(0, 500)
  if ('certificateType' in body) {
    if (!isCertificateType(body.certificateType)) return NextResponse.json({ error: 'Invalid certificateType' }, { status: 400 })
    patch.certificateType = body.certificateType
  }
  if ('tags' in body) {
    if (!Array.isArray(body.tags)) return NextResponse.json({ error: 'tags must be an array' }, { status: 400 })
    patch.tags = body.tags.filter((t): t is string => typeof t === 'string').map(t => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20)
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })

  try {
    const updated = await patchTemplateMeta(eventId, templateId, uid, patch)
    return NextResponse.json({ success: true, template: serializeCertificateTemplateDoc(updated) })
  } catch {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  }
}
