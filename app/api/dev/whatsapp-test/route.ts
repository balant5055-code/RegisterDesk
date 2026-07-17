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

export const dynamic = 'force-dynamic'

// Fail-closed in production (Vercel sets VERCEL_ENV=production only for prod).
function isDisabled(): boolean {
  return (process.env.VERCEL_ENV ?? process.env.NODE_ENV) === 'production'
}

export async function GET(): Promise<NextResponse> {
  if (isDisabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const provider = await getMetaProvider()
  if (!provider) return NextResponse.json({ error: 'WhatsApp is not configured' }, { status: 503 })

  const health = await provider.healthCheck()
  return NextResponse.json(health)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (isDisabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 })

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
