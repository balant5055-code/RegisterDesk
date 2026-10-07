// GET  /api/organizer/wallet/service-requests?event=<draftId>   — one event: what can be requested + its requests
// GET  /api/organizer/wallet/service-requests?cursor=           — the workspace's request history (paged)
// POST /api/organizer/wallet/service-requests                   — submit a refund / carry-forward request
//
// RD-WALLET-REQ (lib/wallet/serviceRequests.ts). Reads need the `wallet` permission; SUBMITTING a
// request is the organizer's own decision, so it needs the workspace OWNER (team members cannot).
// The body carries only { kind, draftId, service | services: 'all', destinationDraftId?, note? } — the quantity, the
// refund upper bound and every eligibility rule are derived on the server from the workspace's own
// records. Nothing here moves money or units: a request waits for a Super Admin decision.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { captureError } from '@/lib/monitoring/sentry'
import { getEventRequests, listOrganizerRequests, submitServiceRequests, toOrganizerView, ServiceRequestError } from '@/lib/wallet/serviceRequests'
import { isRequestableService, isServiceRequestKind, parseOrganizerNote, type RequestableService } from '@/lib/wallet/serviceRequestRules'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
const ID = /^[A-Za-z0-9_-]{1,128}$/
const bad = (error: string, code: string, status = 400) => NextResponse.json({ error, code }, { status, headers: NO_STORE })

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status, headers: NO_STORE })
  const event = req.nextUrl.searchParams.get('event')
  try {
    if (event !== null) {
      const view = ID.test(event) ? await getEventRequests(authz.workspaceUid, event) : null
      if (!view) return NextResponse.json({ error: 'Event not found.' }, { status: 404, headers: NO_STORE })
      return NextResponse.json({ ...view, canSubmit: authz.isOwner }, { headers: NO_STORE })
    }
    return NextResponse.json(await listOrganizerRequests(authz.workspaceUid, { cursor: req.nextUrl.searchParams.get('cursor') }), { headers: NO_STORE })
  } catch (err) {
    captureError(err, { scope: 'organizer.wallet_service_requests.get' })
    return NextResponse.json({ error: 'Could not load requests. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status, headers: NO_STORE })
  if (!authz.isOwner) return bad('Only the organizer account owner can submit refund or carry-forward requests.', 'OWNER_REQUIRED', 403)
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return bad('Invalid JSON', 'INVALID_JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Invalid JSON', 'INVALID_JSON')

  if (!isServiceRequestKind(body.kind)) return bad("kind must be 'refund' or 'carry_forward'", 'INVALID_KIND')
  if (typeof body.draftId !== 'string' || !ID.test(body.draftId)) return bad('A valid event is required.', 'INVALID_EVENT')
  // One service, or (refunds only) `services: 'all'` — every service of the event whose refund is eligible.
  const all = body.services === 'all'
  if (all && body.kind !== 'refund') return bad('"All services" is available for refunds only.', 'ALL_REFUND_ONLY')
  if (!all && !isRequestableService(body.service)) return bad('Choose a service: registrations, whatsapp, certificates or media.', 'SERVICE_NOT_SUPPORTED')
  if (all && body.service !== undefined) return bad('Send either service or services, not both.', 'INVALID_SERVICES')
  const dest = body.destinationDraftId
  if (body.kind === 'carry_forward' && (typeof dest !== 'string' || !ID.test(dest))) return bad('Choose one of your events to carry the units into.', 'DESTINATION_REQUIRED')
  if (body.kind === 'refund' && dest !== undefined && dest !== null) return bad('A refund has no destination event.', 'DESTINATION_NOT_ALLOWED')
  // Anything money-, quantity- or owner-shaped from the client is refused outright, never silently used.
  for (const k of ['quantity', 'amountPaise', 'approvedAmountPaise', 'refundUpperBoundPaise', 'refundedAmountPaise', 'window', 'capacity', 'organizerUid', 'status']) {
    if (k in body) return bad(`${k} is decided by the server.`, 'FIELD_NOT_ALLOWED')
  }
  try {
    const requests = await submitServiceRequests({
      uid: authz.workspaceUid, callerUid: authz.callerUid, kind: body.kind, draftId: body.draftId,
      services: all ? 'all' : [body.service as RequestableService],
      destinationDraftId: body.kind === 'carry_forward' ? dest as string : null, note: parseOrganizerNote(body.note),
    })
    const own = requests.map(toOrganizerView)
    return NextResponse.json({ request: own[0], requests: own }, { status: 201, headers: NO_STORE })
  } catch (err) {
    if (err instanceof ServiceRequestError) return bad(err.message, err.code, err.status)
    captureError(err, { scope: 'organizer.wallet_service_requests.submit' })
    return NextResponse.json({ error: 'Could not submit the request. Reload to check whether it was recorded before trying again.' }, { status: 500, headers: NO_STORE })
  }
}
