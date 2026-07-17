// Organizer Identifier Pools API.
//
//   GET    → list pools with real statistics (capacity/used/available/next/…)
//   POST   → create or replace a pool
//   PATCH  → update a pool (same as upsert)
//   DELETE → ?poolId=...  (the default pool cannot be deleted)
//
// All writes go through lib/identifiers/config (config persistence) — no
// duplicated logic, no allocation logic, audited via identifierHistory.

import { NextRequest, NextResponse } from 'next/server'
import { getPoolStatistics, upsertPool, deletePool, IdentifierConfigError } from '@/lib/identifiers/config'
import { resolveIdentifierScope } from '@/lib/identifiers/organizerScope'
import type { IdentifierPool } from '@/lib/identifiers/types'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  const stats = await getPoolStatistics(scope.slug)
  return NextResponse.json(stats, { headers: { 'Cache-Control': 'no-store' } })
}

function parsePool(body: unknown): IdentifierPool | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const poolId = typeof b.poolId === 'string' ? b.poolId.trim() : ''
  const label  = typeof b.label === 'string' ? b.label.trim() : ''
  if (!poolId || !label) return null
  return {
    poolId, label,
    prefix:     typeof b.prefix === 'string' ? b.prefix : undefined,
    suffix:     typeof b.suffix === 'string' ? b.suffix : undefined,
    padding:    typeof b.padding === 'number' ? b.padding : undefined,
    rangeStart: typeof b.rangeStart === 'number' ? b.rangeStart : (b.rangeStart === null ? null : undefined),
    rangeEnd:   typeof b.rangeEnd === 'number' ? b.rangeEnd : (b.rangeEnd === null ? null : undefined),
    templateId: typeof b.templateId === 'string' ? b.templateId : (b.templateId === null ? null : undefined),
  }
}

async function upsert(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const pool = parsePool(body)
  if (!pool) return NextResponse.json({ error: 'poolId and label are required' }, { status: 400 })

  try {
    const config = await upsertPool(scope.slug, pool, scope.callerUid)
    return NextResponse.json({ ok: true, pools: config.pools })
  } catch (err) {
    if (err instanceof IdentifierConfigError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }
}

export const POST  = upsert
export const PATCH = upsert

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  const poolId = (req.nextUrl.searchParams.get('poolId') ?? '').trim()
  if (!poolId) return NextResponse.json({ error: 'poolId is required' }, { status: 400 })

  try {
    const config = await deletePool(scope.slug, poolId, scope.callerUid)
    return NextResponse.json({ ok: true, pools: config.pools })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Delete failed' }, { status: 409 })
  }
}
