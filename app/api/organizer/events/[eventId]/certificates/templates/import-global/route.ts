// POST /api/organizer/events/[eventId]/certificates/templates/import-global
//
// Imports a PUBLISHED admin global template into the event as a new INACTIVE template
// (GA-6 S5). Reuses the global's stored file (no re-upload — the renderer trusts the
// certificates/global prefix). Records the import for global-usage analytics.
//
// Body: { globalTemplateId: string }. Security: auth + event ownership.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { importGlobalTemplateIntoEvent } from '@/lib/certificates/firestore'
import { serializeCertificateTemplateDoc } from '@/lib/certificates/types'
import { getGlobalTemplate, recordGlobalTemplateImport } from '@/lib/certificates/globalTemplates'

type Params = { params: Promise<{ eventId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  let body: { globalTemplateId?: unknown }
  try { body = await req.json() as typeof body } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const globalTemplateId = typeof body.globalTemplateId === 'string' ? body.globalTemplateId : ''
  if (!globalTemplateId) return NextResponse.json({ error: 'globalTemplateId is required' }, { status: 400 })

  const global = await getGlobalTemplate(globalTemplateId)
  if (!global || global.status !== 'published') {
    return NextResponse.json({ error: 'Global template not available' }, { status: 404 })
  }

  const template = await importGlobalTemplateIntoEvent(eventId, uid, {
    name: global.name, templateType: global.templateType, fileUrl: global.fileUrl,
    fileName: global.fileName, fileSize: global.fileSize,
    dimensions: global.dimensions, pageCount: global.pageCount,
    layout: global.layout, certificateType: global.certificateType,
    description: global.description, category: global.category, tags: global.tags,
    thumbnailUrl: global.thumbnailUrl,
  })
  void recordGlobalTemplateImport(globalTemplateId)

  return NextResponse.json({ success: true, template: serializeCertificateTemplateDoc(template) }, { status: 201 })
}
