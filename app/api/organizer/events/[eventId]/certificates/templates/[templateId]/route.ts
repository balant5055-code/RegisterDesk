// PATCH  /api/organizer/events/[eventId]/certificates/templates/[templateId]
//        — rename and/or activate/deactivate a template.
// DELETE /api/organizer/events/[eventId]/certificates/templates/[templateId]
//        — delete a template record.
//
// Activating enforces the single-active-per-event rule and syncs
// certificateSettings.activeTemplateId (see firestore.activateTemplate).
//
// Security: auth required; organizer must own both the event and the template.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import {
  getTemplateById,
  renameTemplate,
  activateTemplate,
  deactivateTemplate,
  deleteTemplate,
  CertificateServiceError,
} from '@/lib/certificates/firestore'
import { validateTemplatePatch }     from '@/lib/certificates/validation'
import { serializeCertificateTemplateDoc } from '@/lib/certificates/types'
import type { CertificateTemplateDoc, SerializedCertificateTemplateDoc } from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string; templateId: string }> }

// ─── Auth + ownership ──────────────────────────────────────────────────────────

async function resolveOwner(
  req: NextRequest,
  eventId: string,
): Promise<{ uid: string; error?: never } | { uid?: never; error: NextResponse }> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return { error: NextResponse.json({ error: authz.error }, { status: authz.status }) }
  const uid = authz.workspaceUid

  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) {
    return { error: NextResponse.json({ error: 'Event not found' }, { status: 404 }) }
  }
  return { uid }
}

// Maps a service error to the matching HTTP status.
function errorResponse(err: unknown): NextResponse {
  if (err instanceof CertificateServiceError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 409
    return NextResponse.json({ error: err.message }, { status })
  }
  throw err
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export interface TemplateResponse { template: SerializedCertificateTemplateDoc }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, templateId } = await params
  const auth = await resolveOwner(req, eventId)
  if (auth.error) return auth.error

  const template = await getTemplateById(templateId)
  if (!template || template.eventId !== eventId || template.organizerUid !== auth.uid) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  }
  return NextResponse.json({ template: serializeCertificateTemplateDoc(template) } satisfies TemplateResponse)
}

// ─── PATCH ──────────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, templateId } = await params
  const auth = await resolveOwner(req, eventId)
  if (auth.error) return auth.error

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = validateTemplatePatch(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  try {
    let template: CertificateTemplateDoc | null = null

    if (parsed.value.name !== undefined) {
      template = await renameTemplate(eventId, templateId, auth.uid, parsed.value.name)
    }
    if (parsed.value.isActive === true) {
      template = await activateTemplate(eventId, templateId, auth.uid)
    } else if (parsed.value.isActive === false) {
      template = await deactivateTemplate(eventId, templateId, auth.uid)
    }

    return NextResponse.json({
      success:  true,
      template: template ? serializeCertificateTemplateDoc(template) : null,
    })
  } catch (err) {
    return errorResponse(err)
  }
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, templateId } = await params
  const auth = await resolveOwner(req, eventId)
  if (auth.error) return auth.error

  try {
    // fileUrl is returned so the client can delete the Storage object it owns.
    const { fileUrl } = await deleteTemplate(eventId, templateId, auth.uid)
    return NextResponse.json({ success: true, fileUrl })
  } catch (err) {
    return errorResponse(err)
  }
}
