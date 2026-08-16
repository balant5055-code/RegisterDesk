// POST /api/organizer/events/[eventId]/certificates/templates/prepare
//
// RD-CERT-TPL-R2 — issues a short-lived signed PUT URL so the browser can upload a
// certificate template DIRECTLY to object storage.
//
// ═══ WHY THE BYTES DO NOT GO THROUGH THIS FUNCTION ═══════════════════════════
// A PDF template may be 25 MB (TEMPLATE_SIZE_LIMITS), far beyond a serverless request
// body. Proxying would cap templates at a few megabytes — a silent product regression.
// The platform already solves this for media uploads with a server-generated key plus a
// signed URL, and this reuses that exact mechanism rather than inventing a second one.
//
// ═══ THE KEY IS SERVER-GENERATED, ALWAYS ═════════════════════════════════════
// The client sends a filename and a type; it never sends a key. The organizer and event
// are baked into the path here, so a caller cannot aim an upload at another workspace's
// folder — the signature only ever covers a key this route computed.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { storage }                   from '@/features/platform-storage'
import { generateTemplateId }        from '@/lib/certificates/id'
import { buildTemplateObjectKey }    from '@/lib/certificates/templateAsset'
import { ALLOWED_TEMPLATE_MIME, TEMPLATE_SIZE_LIMITS } from '@/lib/certificates/constants'
import type { TemplateType } from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string }> }

/** Signed uploads are short-lived: the URL is a bearer credential for one object. */
const UPLOAD_URL_TTL_S = 300

export interface TemplatePrepareResponse {
  uploadUrl:  string
  fileKey:    string
  templateId: string
  mimeType:   string
  maxBytes:   number
}

function isTemplateType(v: unknown): v is TemplateType {
  return v === 'pdf' || v === 'png' || v === 'jpg'
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params
  // Ownership: the draft only exists under its owner's user document.
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : ''
  if (!fileName) return NextResponse.json({ error: 'fileName is required' }, { status: 400 })

  const templateType = body.templateType
  if (!isTemplateType(templateType)) {
    return NextResponse.json({ error: 'templateType must be pdf, png or jpg' }, { status: 400 })
  }

  const mimeType = ALLOWED_TEMPLATE_MIME[templateType]
  const maxBytes = TEMPLATE_SIZE_LIMITS[templateType]

  // The id is minted here so the key can contain it: the object and the Firestore record
  // that will reference it share one identity from the outset, which is what lets an
  // abandoned upload be recognised later.
  const templateId = generateTemplateId()
  const fileKey    = buildTemplateObjectKey({ organizerUid: uid, eventId, templateId, fileName })

  // generateSignedUrl runs assertSafeKey, so a filename that survived sanitisation but
  // still produced an unsafe key fails here rather than at upload time.
  const uploadUrl = await storage.generateSignedUrl({
    path: fileKey, operation: 'write', mimeType, expiresIn: UPLOAD_URL_TTL_S,
  })

  return NextResponse.json(
    { uploadUrl, fileKey, templateId, mimeType, maxBytes } satisfies TemplatePrepareResponse,
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
