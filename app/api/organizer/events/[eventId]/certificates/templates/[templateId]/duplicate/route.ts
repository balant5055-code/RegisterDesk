// POST /api/organizer/events/[eventId]/certificates/templates/[templateId]/duplicate
//
// Duplicates a certificate template as a new INACTIVE program (GA-6 S4). Reuses the
// source's stored file + copies its design/program metadata. Security: auth + ownership.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { duplicateCertificateTemplate } from '@/lib/certificates/firestore'
import { serializeCertificateTemplateDoc } from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string; templateId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId, templateId } = await params
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const copy = await duplicateCertificateTemplate(eventId, templateId, uid)
  if (!copy) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

  return NextResponse.json({ success: true, template: serializeCertificateTemplateDoc(copy) }, { status: 201 })
}
