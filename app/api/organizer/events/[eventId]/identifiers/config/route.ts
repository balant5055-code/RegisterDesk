// Organizer Identifier Configuration API.
//
//   GET → resolved config (label, type, prefix/suffix/digits, auto-assign,
//         reuse strategy, ranges, default pool, templates, visibility)
//   PUT → merge-write the config (calls lib/identifiers/config.saveIdentifierConfig)
//
// No allocation logic; config persistence lives once in the config module and is
// audited via identifierHistory.

import { NextRequest, NextResponse } from 'next/server'
import { resolveIdentifierConfig, saveIdentifierConfig, IdentifierConfigError } from '@/lib/identifiers/config'
import { resolveIdentifierScope } from '@/lib/identifiers/organizerScope'
import type { IdentifierConfig } from '@/lib/identifiers/types'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  const { config, isStored } = await resolveIdentifierConfig(scope.slug)
  return NextResponse.json({ configured: isStored, config }, { headers: { 'Cache-Control': 'no-store' } })
}

// Whitelist of fields an organizer may patch (prevents arbitrary doc writes).
const ALLOWED: (keyof IdentifierConfig)[] = [
  'enabled', 'label', 'preset', 'type', 'format', 'reusePolicy', 'assignmentStrategy',
  'autoTrigger', 'allowManualOverride', 'allowDuplicate', 'pools', 'templates',
  'defaultPoolId', 'visibility',
]

export async function PUT(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const patch: Partial<IdentifierConfig> = {}
  for (const key of ALLOWED) {
    if (key in raw) (patch as Record<string, unknown>)[key] = raw[key]
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No editable fields supplied' }, { status: 400 })
  }

  try {
    const config = await saveIdentifierConfig(scope.slug, patch, scope.callerUid)
    return NextResponse.json({ ok: true, config })
  } catch (err) {
    if (err instanceof IdentifierConfigError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }
}
