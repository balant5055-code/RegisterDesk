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
import { getIdentifierOverview } from '@/lib/identifiers/config'
import { IdentifierError } from '@/lib/identifiers/types'
import { resolveIdentifierScope, assertRegistrationInScope } from '@/lib/identifiers/organizerScope'
import { resolveEventAssignmentGate, resolveCredentialStage } from '@/lib/identifiers/assignmentDecision'

export const dynamic = 'force-dynamic'

// ─── Error mapping ──────────────────────────────────────────────────────────

function statusForError(err: unknown): { status: number; message: string } {
  if (err instanceof IdentifierError) {
    const map: Record<string, number> = {
      VALUE_CONFLICT: 409, INVALID_STATE_TRANSITION: 409, POOL_EXHAUSTED: 409,
      REGISTRATION_TERMINAL: 409, CONFIG_DISABLED: 409,
      // RD-BIB-TIMING-01 · a number cannot be taken back while a timing device
      // depends on it. 409 — a state conflict the organizer can resolve, not a
      // malformed request.
      IDENTIFIER_HELD_BY_TIMING_TAG: 409,
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

  // RD-EVENT-19B · ONE usage fetch feeds both shapes, so the legacy `pools`/
  // `totals` and the new read model can never disagree — and the config is not
  // resolved twice. Nothing here transfers a registration document: every figure
  // comes from a count() aggregate, so the response carries no attendee PII at
  // any event size.
  const { model, legacy, config } = await getIdentifierOverview(
    scope.slug,
    { passes: scope.passes, passesKnown: scope.passesKnown },
    scope.workspaceUid,
  )

  return NextResponse.json({
    eventSlug:  scope.slug,
    label:      config.label,
    configured: model.configured,
    config,
    // Pre-19B shape, unchanged in name and position (its numbers may now be null).
    pools:      legacy.pools,
    totals:     legacy.totals,
    // RD-EVENT-19B · additive read model. Nothing existing was renamed.
    summary:     model.summary,
    poolStats:   model.pools,
    passScopes:  model.passScopes,
    eligibility: model.eligibility,
    legacyLocks: model.legacyLocks,
    passesKnown: model.passesKnown,
    // RD-EVENT-19C · additive. Whether assignment is open at all, and why not.
    // The UI must never offer an action the POST above will refuse.
    assignmentGate: resolveEventAssignmentGate(scope.lifecycleStatus),
    // RD-BIB-TIMING-03 · additive, and free — the same snapshot field the gate
    // above is already computed from. The gate says whether assignment is ALLOWED;
    // this says where the event is in the workflow, so the workspace can tell the
    // organizer that registration has closed and the roster is now final. It
    // grants nothing: `assignmentGate` remains the only permission on this route.
    credentialStage: resolveCredentialStage(scope.lifecycleStatus),
    // RD-EVENT-19D · additive, and free — these came from the draft snapshot the
    // scope resolver already read. The planning screen needs the event's OWN pass
    // list to offer "all passes" and to name a pool's coverage; deriving it from
    // the pools alone would omit passes no pool covers yet, which is precisely
    // the gap an organizer is trying to find.
    passes: scope.passes,
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

  // RD-EVENT-19C · the lifecycle gate. These routes had NO lifecycle check, so an
  // identifier could be assigned, released or retired on a cancelled or archived
  // event. The rule is the platform's existing read-only rule (isLocked), and an
  // unrecognised lifecycle fails closed. The lifecycle rides on the draft
  // snapshot the scope resolver already read — zero extra reads.
  const gate = resolveEventAssignmentGate(scope.lifecycleStatus)
  if (!gate.open) {
    return NextResponse.json({ error: gate.detail, code: gate.reason }, { status: 409 })
  }

  let body: Body
  try { body = await req.json() as Body } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const { action } = body
  const actor = scope.callerUid

  // Registration-targeting actions: verify ownership + event scope first.
  // RD-EVENT-19A · that same guard read reports the registration's pass, taken
  // from the STORED document. It is forwarded to the engine so a pass-scoped pool
  // is selected automatically, and it costs no additional read.
  let scopedPassId: string | null = null
  if (REG_ACTIONS.has(action)) {
    const guard = await assertRegistrationInScope(body.registrationId ?? '', scope.workspaceUid, scope.slug)
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })
    scopedPassId = guard.passId
  } else if (!body.value?.trim()) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 })
  }

  try {
    switch (action) {
      case 'assign': {
        const r = await allocateIdentifier({
          eventSlug: scope.slug, registrationId: body.registrationId!, actor, source: 'manual',
          explicitValue: body.value, poolId: body.poolId, category: body.category ?? null,
          passId: scopedPassId, reason: body.reason ?? null,
        })
        return NextResponse.json({ ok: true, ...r })
      }
      case 'release':
        await releaseIdentifier(body.registrationId!, actor, body.reason ?? null)
        return NextResponse.json({ ok: true })
      case 'swap': {
        const r = await swapIdentifier({
          registrationId: body.registrationId!, actor,
          explicitValue: body.value, poolId: body.poolId, category: body.category ?? null,
          passId: scopedPassId, reason: body.reason ?? null,
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
