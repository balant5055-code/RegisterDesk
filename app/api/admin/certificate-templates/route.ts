// GET  /api/admin/certificate-templates — list the global template library (any status)
// POST /api/admin/certificate-templates — create a global template (admin-curated)
//
// Admin-only. Files must already be hosted under the trusted certificates/global/ path
// (validated). Reuses the Certificate Engine — no new designer/render/storage engine.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { validateGlobalTemplateUrl } from '@/lib/certificates/urlGuard'
import {
  listGlobalTemplatesAdmin, createGlobalTemplate, serializeGlobalTemplate,
  GLOBAL_TEMPLATE_TIERS, type GlobalTemplateTier,
} from '@/lib/certificates/globalTemplates'
import { isCertificateType } from '@/lib/certificates/validation'
import { TEMPLATE_TYPES } from '@/lib/certificates/constants'
import type { TemplateType, CertificateType } from '@/lib/certificates/types'

async function admin(req: NextRequest): Promise<string | null> {
  return resolveAdminUid(req.headers.get('authorization'))
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await admin(req)
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const templates = (await listGlobalTemplatesAdmin()).map(serializeGlobalTemplate)
  return NextResponse.json({ templates })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const adminUid = await admin(req)
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let b: Record<string, unknown>
  try { b = await req.json() as Record<string, unknown> } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  const category = typeof b.category === 'string' && b.category.trim() ? b.category.trim().slice(0, 60) : 'custom'
  if (!(TEMPLATE_TYPES as string[]).includes(b.templateType as string)) return NextResponse.json({ error: 'Invalid templateType' }, { status: 400 })
  if (typeof b.fileUrl !== 'string' || !validateGlobalTemplateUrl(b.fileUrl).ok) {
    return NextResponse.json({ error: 'fileUrl must be a certificates/global storage URL' }, { status: 400 })
  }
  const tier: GlobalTemplateTier = GLOBAL_TEMPLATE_TIERS.includes(b.tier as GlobalTemplateTier) ? b.tier as GlobalTemplateTier : 'starter'

  const template = await createGlobalTemplate({
    name,
    description: typeof b.description === 'string' ? b.description.slice(0, 500) : '',
    category,
    tags: Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === 'string').map(t => t.slice(0, 40)).slice(0, 20) : [],
    tier,
    templateType: b.templateType as TemplateType,
    fileUrl: b.fileUrl,
    fileName: typeof b.fileName === 'string' ? b.fileName : name,
    fileSize: typeof b.fileSize === 'number' ? b.fileSize : 0,
    dimensions: (b.dimensions ?? null) as never,
    pageCount: typeof b.pageCount === 'number' ? b.pageCount : null,
    layout: b.layout as never,
    certificateType: isCertificateType(b.certificateType) ? b.certificateType as CertificateType : undefined,
    thumbnailUrl: typeof b.thumbnailUrl === 'string' ? b.thumbnailUrl : undefined,
  }, adminUid)

  return NextResponse.json({ success: true, template: serializeGlobalTemplate(template) }, { status: 201 })
}
