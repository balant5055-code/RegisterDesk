// Print Template preview (PA-3) — renders a template's design to a preview
// document on-the-fly. NOTHING is persisted (no storage, no jobs, no download
// record). Security: workspace auth + template ownership.
//
//   GET  ?format=svg|pdf         → preview with sample variable values
//   POST { variables?, format? } → preview with caller-resolved variables
//
// Default format is SVG: it comes from the SAME DrawTarget pipeline as the PDF,
// so it is pixel-faithful, embeds inline, and the browser can rasterize it to a
// PNG client-side. `format=pdf` returns the identical layout as a PDF.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintTemplate } from '@/lib/printAssets/firestore'
import { validateDesign } from '@/lib/printAssets/validation'
import { resolvePublicBranding } from '@/lib/branding/service'
import {
  normalizeDesign, validateRenderDocument, renderToPdf, renderToSvg, RenderError,
  loadPrintAssets, sampleVariableSources, type PrintVariableSources,
} from '@/lib/printAssets/render'

type Format = 'svg' | 'pdf'

async function render(
  req: NextRequest, id: string, format: Format, variables: PrintVariableSources, liveDesign?: unknown,
): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const template = await getPrintTemplate(id)
  if (!template || template.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  }

  // Live preview (PA-9): when the designer sends its current (unsaved) design, render
  // THAT — sanitized by the existing validateDesign — instead of the saved design.
  // Nothing is persisted; the physical canvas + ownership still come from the template.
  let design = template.design
  if (liveDesign !== undefined) {
    const vd = validateDesign(liveDesign)
    if (!vd.ok) return NextResponse.json({ success: false, error: vd.error }, { status: 422 })
    design = vd.value
  }

  const document = normalizeDesign(template.canvas, design, {
    templateId: template.id, name: template.name, assetType: template.assetType,
  })
  const validated = validateRenderDocument(document)
  if (!validated.ok) return NextResponse.json({ success: false, error: validated.error }, { status: 422 })

  // Fold white-label branding into the variables (logo/colors/company) unless the
  // caller already supplied a branding block, then prefetch images (real preview).
  if (!variables.branding) {
    const b = await resolvePublicBranding(authz.workspaceUid).catch(() => null)
    if (b) variables = { ...variables, branding: { logo: b.logoUrl, primaryColor: b.primaryColor, secondaryColor: b.secondaryColor, company: b.companyName } }
  }
  const assets = await loadPrintAssets(validated.document, variables, authz.workspaceUid)

  try {
    if (format === 'pdf') {
      const bytes = await renderToPdf({ document: validated.document, variables, assets })
      return new NextResponse(Buffer.from(bytes), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' },
      })
    }
    const svg = await renderToSvg({ document: validated.document, variables, assets })
    return new NextResponse(svg, {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    const message = err instanceof RenderError ? err.message : 'Render failed'
    return NextResponse.json({ success: false, error: message }, { status: 422 })
  }
}

function parseFormat(raw: string | null): Format {
  return raw === 'pdf' ? 'pdf' : 'svg'
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params
  return render(req, id, parseFormat(req.nextUrl.searchParams.get('format')), sampleVariableSources())
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params
  let body: { variables?: PrintVariableSources; format?: string; design?: unknown } = {}
  try { body = await req.json() } catch { /* empty body → sample vars */ }
  const variables = body.variables ?? sampleVariableSources()
  return render(req, id, parseFormat(body.format ?? req.nextUrl.searchParams.get('format')), variables, body.design)
}
