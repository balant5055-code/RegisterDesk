// Organizer Identifier API — assignment + lifecycle + overview.
//
//   GET  /api/organizer/events/[eventId]/identifiers
//        → config + per-pool statistics + state totals (real, read-only)
//   POST /api/organizer/events/[eventId]/identifiers
//        → { action, ... } dispatch to the engine:
//          assign · release · swap · consume · reserve · block · retire · restore
//
// Every action calls the H.1.5 engine — NO allocation logic lives here. Org-scoped
// + `participants` permission + ownership-guarded. Mutations are audited by the
// engine's identifierHistory writes.

import { NextRequest, NextResponse } from 'next/server'
import {
  allocateIdentifier, releaseIdentifier, swapIdentifier, consumeIdentifier,
  reserveIdentifier, blockIdentifier, retireIdentifier, restoreIdentifier,
} from '@/lib/identifiers/engine'
import { resolveIdentifierConfig, getPoolStatistics } from '@/lib/identifiers/config'
import { IdentifierError } from '@/lib/identifiers/types'
import { resolveIdentifierScope, assertRegistrationInScope } from '@/lib/identifiers/organizerScope'

export const dynamic = 'force-dynamic'

// ─── Error mapping ──────────────────────────────────────────────────────────

function statusForError(err: unknown): { status: number; message: string } {
  if (err instanceof IdentifierError) {
    const map: Record<string, number> = {
      VALUE_CONFLICT: 409, INVALID_STATE_TRANSITION: 409, POOL_EXHAUSTED: 409,
      REGISTRATION_TERMINAL: 409, CONFIG_DISABLED: 409,
      MANUAL_OVERRIDE_DISABLED: 403,
      REGISTRATION_NOT_FOUND: 404, POOL_NOT_FOUND: 404, IDENTIFIER_NOT_FOUND: 404,
      OUT_OF_RANGE: 400,
    }
    return { status: map[err.code] ?? 400, message: err.message }
  }
  return { status: 500, message: err instanceof Error ? err.message : 'Operation failed' }
}

// ─── GET — overview ─────────────────────────────────────────────────────────

export async function GET(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  const [{ config, isStored }, stats] = await Promise.all([
    resolveIdentifierConfig(scope.slug),
    getPoolStatistics(scope.slug),
  ])

  return NextResponse.json({
    eventSlug:  scope.slug,
    label:      config.label,
    configured: isStored,
    config,
    pools:      stats.pools,
    totals:     stats.totals,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// ─── POST — action dispatch ─────────────────────────────────────────────────

type Action = 'assign' | 'release' | 'swap' | 'consume' | 'reserve' | 'block' | 'retire' | 'restore'
const REG_ACTIONS = new Set<Action>(['assign', 'release', 'swap', 'consume'])

interface Body {
  action:          Action
  registrationId?: string
  value?:          string
  poolId?:         string
  category?:       string | null
  reason?:         string | null
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  let body: Body
  try { body = await req.json() as Body } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const { action } = body
  const actor = scope.callerUid

  // Registration-targeting actions: verify ownership + event scope first.
  if (REG_ACTIONS.has(action)) {
    const guard = await assertRegistrationInScope(body.registrationId ?? '', scope.workspaceUid, scope.slug)
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })
  } else if (!body.value?.trim()) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 })
  }

  try {
    switch (action) {
      case 'assign': {
        const r = await allocateIdentifier({
          eventSlug: scope.slug, registrationId: body.registrationId!, actor, source: 'manual',
          explicitValue: body.value, poolId: body.poolId, category: body.category ?? null, reason: body.reason ?? null,
        })
        return NextResponse.json({ ok: true, ...r })
      }
      case 'release':
        await releaseIdentifier(body.registrationId!, actor, body.reason ?? null)
        return NextResponse.json({ ok: true })
      case 'swap': {
        const r = await swapIdentifier({
          registrationId: body.registrationId!, actor,
          explicitValue: body.value, poolId: body.poolId, category: body.category ?? null, reason: body.reason ?? null,
        })
        return NextResponse.json({ ok: true, ...r })
      }
      case 'consume':
        await consumeIdentifier(body.registrationId!, actor)
        return NextResponse.json({ ok: true })
      case 'reserve':
        await reserveIdentifier({ eventSlug: scope.slug, value: body.value!.trim(), actor, reason: body.reason ?? null })
        return NextResponse.json({ ok: true })
      case 'block':
        await blockIdentifier({ eventSlug: scope.slug, value: body.value!.trim(), actor, reason: body.reason ?? null })
        return NextResponse.json({ ok: true })
      case 'retire':
        await retireIdentifier({ eventSlug: scope.slug, value: body.value!.trim(), actor, reason: body.reason ?? null })
        return NextResponse.json({ ok: true })
      case 'restore':
        await restoreIdentifier({ eventSlug: scope.slug, value: body.value!.trim(), actor, reason: body.reason ?? null })
        return NextResponse.json({ ok: true })
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
  } catch (err) {
    const { status, message } = statusForError(err)
    if (status === 500) console.error('[identifiers] action failed:', { action, err })
    return NextResponse.json({ error: message }, { status })
  }
}
