// POST /api/dev/whatsapp-test — DEVELOPMENT-ONLY WhatsApp provider smoke test.
//
// Directly exercises the Meta provider (getMetaProvider().sendTestMessage / health)
// to validate configuration and delivery. It BYPASSES the Notification Engine and
// all business logic — this is a provider verification tool, not a product feature.
//
// Hard-disabled in production. Not wired to any UI. Delete once WhatsApp is
// integrated through the engine.
//
//   GET  /api/dev/whatsapp-test                      → provider health check
//   POST /api/dev/whatsapp-test  { to, templateName?, languageCode? }
//        → sends a template (defaults to Meta's "hello_world") to `to`

import { NextRequest, NextResponse } from 'next/server'
import { getMetaProvider } from '@/lib/whatsapp'
import { resolveSuperAdminUid } from '@/lib/admin/auth'

export const dynamic = 'force-dynamic'

// RD-SEC-01 · Fail-closed in EVERY production build — previews included. The old
// `(VERCEL_ENV ?? NODE_ENV) === 'production'` left Vercel previews (VERCEL_ENV='preview',
// NODE_ENV='production') open to unauthenticated paid template sends. Same test as dev/reset.
function isDisabled(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production'
}

// RD-SEC-01 · and even in development only a Super Admin (ADMIN_UIDS) may use it.
async function refused(req: NextRequest): Promise<NextResponse | null> {
  if (isDisabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!(await resolveSuperAdminUid(req.headers.get('authorization')))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = await refused(req)
  if (denied) return denied

  const provider = await getMetaProvider()
  if (!provider) return NextResponse.json({ error: 'WhatsApp is not configured' }, { status: 503 })

  const health = await provider.healthCheck()
  return NextResponse.json(health)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = await refused(req)
  if (denied) return denied

  const provider = await getMetaProvider()
  if (!provider) return NextResponse.json({ error: 'WhatsApp is not configured' }, { status: 503 })

  const body = await req.json().catch(() => null) as
    | { to?: string; templateName?: string; languageCode?: string }
    | null
  const to = body?.to?.trim()
  if (!to) return NextResponse.json({ error: 'Missing "to" (recipient phone in international format)' }, { status: 400 })

  const result = await provider.sendTestMessage(to, body?.templateName, body?.languageCode)
  return NextResponse.json(result, { status: result.success ? 200 : 502 })
}
