// GET  /api/organizer/events/[eventId]/certificates/templates — list templates
// POST /api/organizer/events/[eventId]/certificates/templates — register an
//      already-uploaded template file and extract its metadata.
//
// Upload model (RD-CERT-TPL-R2): the client asks ../templates/prepare for a signed PUT url,
// uploads the bytes DIRECTLY to object storage under
//   events/{eventId}/certificates/templates/{uid}/{templateId}/{file}
// and then POSTs the resulting `fileKey` here. A 25 MB template cannot pass through a
// serverless request body, which is why the bytes never transit this function.
//
// The LEGACY shape — a Firebase Storage `fileUrl` uploaded by the browser — is still
// accepted, unchanged and still SSRF-guarded, because live events hold templates recorded
// that way. Only one of the two is ever stored on a record; see templateAsset.ts.
//
// Either way the server RE-READS the stored bytes here to verify the magic bytes and extract
// dimensions / page count authoritatively, so a record can never claim a type or size the
// stored object does not have.
//
// Security: auth required; organizer must own the event; a client-supplied `fileKey` is
// re-validated against the prefix recomputed from the AUTHENTICATED uid.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { listTemplates, createTemplate } from '@/lib/certificates/firestore'
import { validateTemplateCreate }    from '@/lib/certificates/validation'
import { inspectTemplate }           from '@/lib/certificates/metadata'
import { TEMPLATE_SIZE_LIMITS, MAX_TEMPLATE_BYTES } from '@/lib/certificates/constants'
import { validateEventTemplateUrl, safeFetchBytes } from '@/lib/certificates/urlGuard'
import { storage }                    from '@/features/platform-storage'
import { buildTemplateKeyPrefix }     from '@/lib/certificates/templateAsset'
import { serializeCertificateTemplateDoc } from '@/lib/certificates/types'
import type { SerializedCertificateTemplateDoc, TemplateType } from '@/lib/certificates/types'

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

  // RD-CERT-TPL-R2 — TWO accepted shapes, and the server decides which store it reads:
  //   • fileKey  — the object the browser just PUT to the signed URL this API issued
  //   • fileUrl  — the LEGACY Firebase flow, still accepted so an older client keeps working
  // Either way the bytes are re-read HERE and inspected, so the record can never claim a
  // type, size or dimension the stored object does not actually have.
  const rawKey = (body as Record<string, unknown>)?.fileKey
  const fileKey = typeof rawKey === 'string' && rawKey ? rawKey : null

  let name: string
  let templateType: TemplateType
  let fileName: string
  let fileUrl = ''
  let bytes: Uint8Array

  if (fileKey) {
    const b = body as Record<string, unknown>
    name         = typeof b.name === 'string' ? b.name.trim() : ''
    fileName     = typeof b.fileName === 'string' ? b.fileName.trim() : ''
    const t      = b.templateType
    if (!name || !fileName) {
      return NextResponse.json({ error: 'name and fileName are required' }, { status: 400 })
    }
    if (t !== 'pdf' && t !== 'png' && t !== 'jpg') {
      return NextResponse.json({ error: 'templateType must be pdf, png or jpg' }, { status: 400 })
    }
    templateType = t

    // OWNERSHIP OF THE KEY. The key must be exactly the one this event+organizer would
    // produce — a client cannot present a key belonging to another workspace, because the
    // prefix is recomputed here rather than trusted.
    if (!fileKey.startsWith(buildTemplateKeyPrefix({ organizerUid: auth.uid, eventId }))) {
      return NextResponse.json({ error: 'fileKey does not belong to this event' }, { status: 403 })
    }

    // The object must actually exist before a record points at it — the invariant the
    // generated-artifact pipeline already holds: a record implies its bytes.
    try {
      await storage.getMetadata(fileKey)
    } catch {
      return NextResponse.json(
        { error: 'The uploaded template could not be found in storage. Please upload again.' },
        { status: 400 },
      )
    }

    try {
      const got = await storage.download(fileKey)
      bytes = got.body
    } catch {
      return NextResponse.json({ error: 'Could not read the uploaded file' }, { status: 502 })
    }
  } else {
    const parsed = validateTemplateCreate(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    ;({ name, templateType, fileName } = parsed.value)
    fileUrl = parsed.value.fileUrl

    // SSRF: fileUrl must be a Storage object inside the caller's own event folder.
    const urlCheck = validateEventTemplateUrl(fileUrl, auth.uid, eventId)
    if (!urlCheck.ok) {
      return NextResponse.json(
        { error: 'fileUrl must point to your uploaded template for this event' },
        { status: 400 },
      )
    }

    // Fetch the uploaded bytes (validated, no redirects) to verify + extract metadata.
    try {
      bytes = await safeFetchBytes(fileUrl, urlCheck, { maxBytes: MAX_TEMPLATE_BYTES })
    } catch {
      return NextResponse.json({ error: 'Could not read the uploaded file' }, { status: 502 })
    }
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
      ...(fileKey ? { fileKey } : { fileUrl }),
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
