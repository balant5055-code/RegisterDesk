// GET/PUT /api/admin/settings/event-types — RD-EVENT-TYPES-01 · which event types organizers may choose.
//
//   GET → { availability: { [eventTypeId]: boolean }, defaults, names, unavailable }
//   PUT { enabled: { [eventTypeId]: boolean }, reason } → changes those switches, effective at once.
//
// Super Admin only (ADMIN_UIDS). A reason (5–500 characters) is required and the admin audit row is
// staged in the same transaction as the change (lib/events/eventTypeAvailabilityServer.ts). Disabling a
// type never touches events that already exist — see lib/events/eventTypeAvailability.ts.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { getEventTypeAvailability, setEventTypeAvailability } from '@/lib/events/eventTypeAvailabilityServer'
import { DEFAULT_EVENT_TYPE_AVAILABILITY, EVENT_TYPE_IDS, isEventTypeId, type EventTypeId } from '@/lib/events/eventTypeAvailability'
import { EVENT_TYPE_NAMES } from '@/lib/events/taxonomy'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { availability, unavailable } = await getEventTypeAvailability()
  return NextResponse.json({
    availability, unavailable, defaults: DEFAULT_EVENT_TYPE_AVAILABILITY,
    types: EVENT_TYPE_IDS.map(id => ({ id, name: EVENT_TYPE_NAMES[id] ?? id })),
  }, { headers: NO_STORE })
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  let body: { enabled?: unknown; reason?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE }) }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: 'Give a reason for the change (5–500 characters).', code: 'REASON_REQUIRED' }, { status: 400, headers: NO_STORE })
  }
  const enabled = body.enabled && typeof body.enabled === 'object' && !Array.isArray(body.enabled) ? body.enabled as Record<string, unknown> : null
  if (!enabled || Object.keys(enabled).length === 0) {
    return NextResponse.json({ error: 'enabled must map event type ids to true / false.', code: 'INVALID' }, { status: 400, headers: NO_STORE })
  }
  const patch: Partial<Record<EventTypeId, boolean>> = {}
  for (const [k, v] of Object.entries(enabled)) {
    if (!isEventTypeId(k) || typeof v !== 'boolean') {
      return NextResponse.json({ error: `Unknown event type or non-boolean value: ${k}.`, code: 'INVALID' }, { status: 400, headers: NO_STORE })
    }
    patch[k] = v
  }
  try {
    const availability = await setEventTypeAvailability(patch, gate.uid, reason)
    return NextResponse.json({ ok: true, availability }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/settings/event-types] update failed', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not save the change. Nothing was changed.' }, { status: 500, headers: NO_STORE })
  }
}
