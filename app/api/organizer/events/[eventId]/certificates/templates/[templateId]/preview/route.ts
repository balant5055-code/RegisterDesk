// POST /api/organizer/events/[eventId]/certificates/templates/[templateId]/preview
//
// Renders a SAMPLE certificate PDF for the builder using the Phase 10A renderer,
// so the preview is byte-for-byte what issuance produces. Body may contain an
// optional `layout` to preview UNSAVED changes; otherwise the template's saved
// layout (or the default layout) is used. Returns application/pdf.
//
// Security: auth + the template must belong to the caller and this event.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getTemplateById }           from '@/lib/certificates/firestore'
import { loadRenderAssets }          from '@/lib/certificates/generate'
import { renderCertificatePdf }      from '@/lib/certificates/render'
import { validateLayout }            from '@/lib/certificates/validation'
import { PLACEHOLDERS }              from '@/lib/certificates/placeholders'
import { APP_URL }                   from '@/lib/env'
import type { PlaceholderContext }   from '@/lib/certificates/placeholders'
import type { CertificateLayout }    from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string; templateId: string }> }

async function authUid(req: NextRequest): Promise<{ uid: string } | { error: NextResponse }> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return { error: NextResponse.json({ error: authz.error }, { status: authz.status }) }
  return { uid: authz.workspaceUid }
}

function sampleContext(): PlaceholderContext {
  const ctx: PlaceholderContext = {}
  for (const p of PLACEHOLDERS) ctx[p.key] = p.example
  return ctx
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, templateId } = await params
  const auth = await authUid(req)
  if ('error' in auth) return auth.error

  const template = await getTemplateById(templateId)
  if (!template || template.eventId !== eventId || template.organizerUid !== auth.uid) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  }

  // Optional unsaved layout in the body; else use the saved layout (may be undefined).
  let layout: CertificateLayout | null = template.layout ?? null
  const raw = await req.json().catch(() => null)
  if (raw && typeof raw === 'object' && 'layout' in raw && (raw as { layout: unknown }).layout != null) {
    const parsed = validateLayout((raw as { layout: unknown }).layout)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    layout = parsed.value
  }

  try {
    const { templateBytes, assets } = await loadRenderAssets(template, layout)
    const pdfBytes = await renderCertificatePdf({
      templateBytes,
      templateType: template.templateType,
      dimensions:   template.dimensions,
      context:      sampleContext(),
      verifyUrl:    `${APP_URL}/verify/certificate/RDC-2026-SAMPLE`,
      layout,
      assets,
    })

    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': 'inline; filename="certificate-preview.pdf"',
        'Cache-Control':       'no-store',
      },
    })
  } catch (err) {
    console.error('[certificates/preview]', err)
    return NextResponse.json({ error: 'Preview generation failed' }, { status: 500 })
  }
}
