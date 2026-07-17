// PUT /api/organizer/events/[eventId]/certificates/templates/[templateId]/layout
//
// Saves the builder layout onto a template. Body: a CertificateLayout.
// Validated by validateLayout. Does not affect already-issued certificates.
//
// Security: auth + the template must belong to the caller and this event
// (re-checked inside the service).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { saveTemplateLayout, CertificateServiceError } from '@/lib/certificates/firestore'
import { validateLayout }            from '@/lib/certificates/validation'
import { validateEventTemplateUrl }  from '@/lib/certificates/urlGuard'
import { serializeCertificateTemplateDoc } from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string; templateId: string }> }

async function authUid(req: NextRequest): Promise<{ uid: string } | { error: NextResponse }> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return { error: NextResponse.json({ error: authz.error }, { status: authz.status }) }
  return { uid: authz.workspaceUid }
}

export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, templateId } = await params
  const auth = await authUid(req)
  if ('error' in auth) return auth.error

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = validateLayout(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  // SSRF (save-time): every image asset must be a Storage object in this event's
  // own folder — reject foreign / non-Storage URLs before they're ever fetched.
  for (const el of parsed.value.elements) {
    if (el.type === 'image' && !validateEventTemplateUrl(el.assetUrl, auth.uid, eventId).ok) {
      return NextResponse.json(
        { error: 'Image assets must be uploaded to this event' },
        { status: 400 },
      )
    }
  }

  try {
    const template = await saveTemplateLayout(eventId, templateId, auth.uid, parsed.value)
    return NextResponse.json({ success: true, template: serializeCertificateTemplateDoc(template) })
  } catch (err) {
    if (err instanceof CertificateServiceError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 409
      return NextResponse.json({ error: err.message }, { status })
    }
    throw err
  }
}
