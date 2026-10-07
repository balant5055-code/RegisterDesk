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
import type { IdentifierPool, IdentifierRange } from '@/lib/identifiers/types'

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
  // ═══ RD-BIB-UX-02 · ABSENT MEANS ABSENT ═══════════════════════════════════
  //
  // Every one of these fields used to be written as `undefined` when the request
  // omitted it. JSON cannot express `undefined`, so the browser never sent it:
  // this parser created it, and Firestore then refused the whole document with
  //
  //   Cannot use "undefined" as a Firestore value (found in field "pools.`1`.prefix")
  //
  // — a 500 on a perfectly valid configuration whose only sin was an empty
  // optional Prefix. An omitted key is now genuinely omitted.
  //
  // `rangeStart`/`rangeEnd`/`templateId` are NULLABLE in the schema, so an
  // explicit null is kept: that is the legacy "unbounded" signal, and it is a
  // different statement from "the request said nothing about this field".
  return {
    poolId, label,
    ...(typeof b.prefix  === 'string' ? { prefix:  b.prefix }  : {}),
    ...(typeof b.suffix  === 'string' ? { suffix:  b.suffix }  : {}),
    ...(typeof b.padding === 'number' ? { padding: b.padding } : {}),
    ...(typeof b.rangeStart === 'number' || b.rangeStart === null ? { rangeStart: b.rangeStart as number | null } : {}),
    ...(typeof b.rangeEnd   === 'number' || b.rangeEnd   === null ? { rangeEnd:   b.rangeEnd   as number | null } : {}),
    ...(typeof b.templateId === 'string' || b.templateId === null ? { templateId: b.templateId as string | null } : {}),
    // RD-EVENT-19A · carried through UNVALIDATED on purpose: this parser only
    // decides what is present, and saveIdentifierConfig → validatePools is the
    // one gate that decides what is legal (overlapping ranges, an empty
    // passIds, a pass claimed by two pools). Dropping them here instead would
    // make the API silently ignore a configuration the organizer sent.
    ...(Array.isArray(b.passIds) ? { passIds: b.passIds as string[] } : {}),
    ...(Array.isArray(b.ranges)  ? { ranges:  b.ranges as IdentifierRange[] } : {}),
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
    // RD-BIB-01 · a range change that would strand issued numbers is REFUSED unless the
    // organizer explicitly says otherwise. The flag is never a default, and the
    // acknowledgement is written into identifierHistory by the config layer.
    const acknowledge = (body as { acknowledgeStranding?: unknown }).acknowledgeStranding === true
    const config = await upsertPool(scope.slug, pool, scope.callerUid, { acknowledgeStranding: acknowledge })
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
