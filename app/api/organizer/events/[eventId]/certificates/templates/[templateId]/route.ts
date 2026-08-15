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
import { storage }                   from '@/features/platform-storage'
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

export interface TemplateResponse {
  template: SerializedCertificateTemplateDoc
  /**
   * RD-CERT-TPL-R2 — a short-lived signed READ url for an R2-backed template, so the
   * builder can show the artwork behind the canvas.
   *
   * An R2 object has no public url by design; handing the browser a signed one here keeps
   * the bucket private and is issued only after the same ownership check that guards the
   * record itself. Null for legacy templates, which already carry a Firebase `fileUrl`.
   */
  previewUrl: string | null
}

/** Signed preview urls are short-lived: the url is a bearer credential for one object. */
const PREVIEW_URL_TTL_S = 900

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, templateId } = await params
  const auth = await resolveOwner(req, eventId)
  if (auth.error) return auth.error

  const template = await getTemplateById(templateId)
  if (!template || template.eventId !== eventId || template.organizerUid !== auth.uid) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  }

  // A signing failure must not take the whole template down: the builder can still open,
  // report a missing background and let the organizer place elements.
  let previewUrl: string | null = null
  if (template.fileKey) {
    previewUrl = await storage
      .generateSignedUrl({ path: template.fileKey, operation: 'read', expiresIn: PREVIEW_URL_TTL_S })
      .catch(() => null)
  }

  return NextResponse.json(
    { template: serializeCertificateTemplateDoc(template), previewUrl } satisfies TemplateResponse,
    { headers: { 'Cache-Control': 'no-store' } },
  )
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
    // fileUrl is returned so the client can delete the LEGACY Firebase object it owns.
    // An R2 object is deleted server-side instead — the browser holds no R2 credential —
    // so `fileUrl` is null there and the client has nothing to clean up.
    const { fileUrl, deletedKey } = await deleteTemplate(eventId, templateId, auth.uid)
    return NextResponse.json({ success: true, fileUrl, deletedKey })
  } catch (err) {
    return errorResponse(err)
  }
}
