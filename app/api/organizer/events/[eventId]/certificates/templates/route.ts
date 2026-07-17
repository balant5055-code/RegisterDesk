// GET  /api/organizer/events/[eventId]/certificates/templates — list templates
// POST /api/organizer/events/[eventId]/certificates/templates — register an
//      already-uploaded template file and extract its metadata.
//
// Upload model (matches RegisterDesk's existing storage architecture): the
// client uploads the file to Firebase Storage under
//   certificates/templates/{uid}/{eventId}/...
// (size/type enforced by storage.rules), then POSTs the resulting fileUrl here.
// The server confirms the URL is within the caller's own folder, fetches the
// bytes via the download token to verify the magic bytes and extract dimensions
// / page count authoritatively, then writes the Firestore record.
//
// Security: auth required; organizer must own the event.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { listTemplates, createTemplate } from '@/lib/certificates/firestore'
import { validateTemplateCreate }    from '@/lib/certificates/validation'
import { inspectTemplate }           from '@/lib/certificates/metadata'
import { TEMPLATE_SIZE_LIMITS, MAX_TEMPLATE_BYTES } from '@/lib/certificates/constants'
import { validateEventTemplateUrl, safeFetchBytes } from '@/lib/certificates/urlGuard'
import { serializeCertificateTemplateDoc } from '@/lib/certificates/types'
import type { SerializedCertificateTemplateDoc } from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string }> }

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

// ─── GET ────────────────────────────────────────────────────────────────────────

export interface TemplatesListResponse {
  templates: SerializedCertificateTemplateDoc[]
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await resolveOwner(req, eventId)
  if (auth.error) return auth.error

  const templates = (await listTemplates(eventId, auth.uid))
    .map(serializeCertificateTemplateDoc)
  return NextResponse.json({ templates } satisfies TemplatesListResponse)
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await resolveOwner(req, eventId)
  if (auth.error) return auth.error

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = validateTemplateCreate(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { name, templateType, fileUrl, fileName } = parsed.value

  // SSRF: fileUrl must be a Storage object inside the caller's own event folder.
  const urlCheck = validateEventTemplateUrl(fileUrl, auth.uid, eventId)
  if (!urlCheck.ok) {
    return NextResponse.json(
      { error: 'fileUrl must point to your uploaded template for this event' },
      { status: 400 },
    )
  }

  // Fetch the uploaded bytes (validated, no redirects) to verify + extract metadata.
  let bytes: Uint8Array
  try {
    bytes = await safeFetchBytes(fileUrl, urlCheck, { maxBytes: MAX_TEMPLATE_BYTES })
  } catch {
    return NextResponse.json({ error: 'Could not read the uploaded file' }, { status: 502 })
  }

  const inspection = await inspectTemplate(bytes)
  if (!inspection.type) {
    return NextResponse.json({ error: 'Unsupported or unreadable file type' }, { status: 400 })
  }
  if (inspection.type !== templateType) {
    return NextResponse.json(
      { error: `File content is ${inspection.type}, which does not match templateType ${templateType}` },
      { status: 400 },
    )
  }
  if (bytes.length > TEMPLATE_SIZE_LIMITS[inspection.type]) {
    return NextResponse.json(
      { error: `${inspection.type.toUpperCase()} exceeds the ${Math.round(TEMPLATE_SIZE_LIMITS[inspection.type] / (1024 * 1024))} MB limit` },
      { status: 400 },
    )
  }

  const template = await createTemplate(
    {
      eventId,
      name,
      templateType,
      fileUrl,
      fileName,
      fileSize:   bytes.length,
      dimensions: inspection.dimensions,
      pageCount:  inspection.pageCount,
    },
    auth.uid,
  )

  return NextResponse.json(
    { success: true, template: serializeCertificateTemplateDoc(template) },
    { status: 201 },
  )
}
