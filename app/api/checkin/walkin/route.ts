// Walk-in / on-site staff-assisted registration (Phase C).
//
//   POST /api/checkin/walkin  — register an attendee at the gate and check them in
//   GET  /api/checkin/walkin?slug=<eventSlug>  — passes + remaining capacity
//
// This is NOT attendee self-registration. A staff member (owner/admin/manager/
// checkin_staff — anyone with the `checkin` permission) registers the attendee.
//
// Reuses the existing createRegistration() transaction, so capacity, duplicate
// (limitPerEmail/limitPerMobile), ticket-code uniqueness and counter increments
// are enforced atomically exactly like online registration. NO Razorpay, no
// payment intents, no refunds, no settlements — gate registration only.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getEventBySlug }            from '@/lib/firebase/firestore/events'
import { isEventOpenForCheckin }     from '@/lib/checkin/readiness'
import { isEventSlugInScope }        from '@/lib/team/eventScope'
import { appendCheckinHistorySafe }  from '@/lib/checkin/history'
import { adminDb }                   from '@/lib/firebase/admin'
import {
  createRegistration, writeAuditEntry,
  CapacityExceededError, DuplicateRegistrationError,
} from '@/lib/firebase/firestore/registrations'
import { autoAssignIfEnabled, consumeIdentifier } from '@/lib/identifiers/engine'

const PAYMENT_MODES = ['free', 'cash', 'upi', 'complimentary'] as const
type PaymentMode = typeof PAYMENT_MODES[number]
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface LivePass { id: string; name: string; price: number; unlimited: boolean; quantity: number | null; status?: string }

type LoadedEvent = { ok: true; passes: LivePass[]; eventName: string; rules?: { limitPerEmail?: boolean; limitPerMobile?: boolean } }
type LoadResult  = { ok: false; error: NextResponse } | LoadedEvent

/** Loads an event the caller's workspace owns, or returns an error response. */
async function loadOwnedEvent(slug: string, workspaceUid: string): Promise<LoadResult> {
  const event = await getEventBySlug(slug)
  if (!event) return { ok: false, error: NextResponse.json({ error: 'Event not found' }, { status: 404 }) }
  // Authorization: the event must belong to the caller's workspace.
  if ((event as { uid?: string }).uid !== workspaceUid) {
    return { ok: false, error: NextResponse.json({ error: 'Event not found' }, { status: 404 }) }
  }
  const rawPricing = event.pricing as Record<string, unknown> | null
  const rawPasses  = Array.isArray(rawPricing?.passes) ? (rawPricing!.passes as Record<string, unknown>[]) : []
  const passes: LivePass[] = rawPasses.map(p => ({
    id:        String(p.id ?? ''),
    name:      typeof p.name === 'string' ? p.name : 'Pass',
    price:     typeof p.price === 'number' ? p.price : 0,
    unlimited: p.unlimited === true,
    quantity:  typeof p.quantity === 'number' ? p.quantity : null,
    status:    typeof p.status === 'string' ? p.status : undefined,
  }))
  const details   = event.eventDetails as Record<string, unknown> | undefined
  const info      = details?.info as Record<string, unknown> | undefined
  const eventName = typeof info?.name === 'string' ? info.name : 'Event'
  const rules     = (event.registrationForm as { registrationRules?: { limitPerEmail?: boolean; limitPerMobile?: boolean } } | null)?.registrationRules
  return { ok: true, passes, eventName, rules }
}

// ─── GET — passes + remaining capacity for the walk-in form ───────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  // RD-CHECKIN-2.0 — walk-in is gated on its OWN permission, `walkin`.
  //
  // ═══ THE MISMATCH THIS RESOLVES ═══════════════════════════════════════════
  // This route required `registrations` while its own header comment said
  // `checkin`, and every surface that offers walk-in calls itself check-in. The
  // consequence was not cosmetic: the only way to let a gate operator register a
  // walk-up was to grant them the ENTIRE registration module — edit, cancel,
  // refund-adjacent state, bulk export. So the product hid the button instead, and
  // gate staff could reach neither it nor the route.
  //
  // `walkin` is strictly narrower than `registrations`: one operation, on an event
  // this caller is assigned to. Owner/admin/manager hold it in the matrix, so
  // nobody who could perform a walk-in before has lost it. The gate role that needs
  // it — `checkin_lead` — now holds it; plain `checkin_staff` still does not. The
  // server check and the UI finally say the same thing.
  //
  // Gated on the GET as well: the pass list and remaining-capacity numbers are
  // exactly the data an operator without this permission should not be reading.
  const authz = await authorizeWorkspace(req, 'walkin')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const slug = req.nextUrl.searchParams.get('slug')?.trim()
  if (!slug) return NextResponse.json({ error: 'MISSING_SLUG' }, { status: 400 })

  // RD-CHECKIN-2.0 — event assignment, which this route never enforced. Without it
  // an operator assigned to Event A could read Event B's pass list and remaining
  // capacity by changing one query parameter — the same hole the offline cache had
  // and closed. Derived from the caller's own team record, so it cannot be
  // sidestepped from the request.
  if (!await isEventSlugInScope(authz, slug)) {
    return NextResponse.json({ error: 'EVENT_NOT_ASSIGNED' }, { status: 403 })
  }

  const loaded = await loadOwnedEvent(slug, uid)
  if (!loaded.ok) return loaded.error

  const counterSnap = await adminDb.collection('registrationCounters').doc(slug).get()
  const passCounts  = (counterSnap.data()?.passCounts ?? {}) as Record<string, number>

  const passes = loaded.passes
    .filter(p => p.id && p.status !== 'inactive')
    .map(p => {
      const sold = passCounts[p.id] ?? 0
      return {
        id:        p.id,
        name:      p.name,
        price:     p.price,
        unlimited: p.unlimited,
        quantity:  p.quantity,
        sold,
        available: p.unlimited || p.quantity === null ? null : Math.max(0, p.quantity - sold),
      }
    })

  return NextResponse.json({ eventName: loaded.eventName, passes }, { headers: { 'Cache-Control': 'no-store' } })
}

// ─── POST — register + check in at the gate ───────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // See the GET above — walk-in is registration creation and requires `walkin`.
  const authz = await authorizeWorkspace(req, 'walkin')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid       = authz.workspaceUid    // authorization / ownership scope
  const callerUid = authz.callerUid       // attribution: the registering operator

  let body: { slug?: unknown; passId?: unknown; name?: unknown; email?: unknown; phone?: unknown; paymentMode?: unknown; referenceNumber?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const slug  = typeof body.slug === 'string' ? body.slug.trim() : ''
  const passId = typeof body.passId === 'string' ? body.passId.trim() : ''
  const name  = typeof body.name === 'string' ? body.name.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const paymentMode = body.paymentMode as PaymentMode
  const referenceNumber = typeof body.referenceNumber === 'string' ? body.referenceNumber.trim() : ''

  if (!slug || !passId)            return NextResponse.json({ error: 'slug and passId are required' }, { status: 400 })
  if (!name)                        return NextResponse.json({ error: 'Attendee name is required' }, { status: 400 })
  if (!EMAIL_RE.test(email))        return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 })
  if (!PAYMENT_MODES.includes(paymentMode)) return NextResponse.json({ error: 'Invalid payment mode' }, { status: 400 })

  // ── Load + authorize event ─────────────────────────────────────────────────
  // Event assignment first, before the event is loaded at all — the same rule the
  // GET applies, so neither verb can be used to reach an unassigned event.
  if (!await isEventSlugInScope(authz, slug)) {
    return NextResponse.json({ error: 'EVENT_NOT_ASSIGNED' }, { status: 403 })
  }

  const loaded = await loadOwnedEvent(slug, uid)
  if (!loaded.ok) return loaded.error

  // Event must currently accept check-ins — the ONE readiness rule (RD-CHECKIN-2.0),
  // identical to the QR gate's.
  if (!await isEventOpenForCheckin(slug)) {
    return NextResponse.json({ error: 'This event is not currently accepting check-ins.' }, { status: 422 })
  }

  const pass = loaded.passes.find(p => p.id === passId)
  if (!pass || pass.status === 'inactive') {
    return NextResponse.json({ error: 'Selected pass is not available' }, { status: 404 })
  }

  // Duplicate rule: when phone-uniqueness is on, a phone number is mandatory.
  if (loaded.rules?.limitPerMobile && !phone) {
    return NextResponse.json({ error: 'A phone number is required for this event.' }, { status: 400 })
  }

  // ── Derive payment fields from the mode (no Razorpay) ──────────────────────
  const pricePaise = Math.round((pass.price || 0) * 100)
  const collected  = paymentMode === 'cash' || paymentMode === 'upi'   // collected at the gate
  const amountPaise           = collected ? pricePaise : 0
  const paymentStatusOverride = collected ? 'paid' as const : 'not_required' as const
  const paymentMethod = paymentMode === 'free' ? undefined : paymentMode

  // ── Create (atomic: capacity + duplicate + ticket + check-in counter) ──────
  try {
    const result = await createRegistration({
      eventSlug:    slug,
      passId,
      passName:     pass.name,
      passCapacity: pass.unlimited ? null : pass.quantity,
      eventName:    loaded.eventName,
      organizerUid: uid,
      attendee: { name, email, phone: phone || undefined },
      limitPerEmail:  loaded.rules?.limitPerEmail  ?? false,
      limitPerMobile: loaded.rules?.limitPerMobile ?? false,
      approvalMode:   'auto',                       // walk-in is staff-confirmed immediately
      registrationSource:    'walkin',
      paymentMethod,
      referenceNumber:       referenceNumber || undefined,
      amountPaise,
      paymentStatusOverride,
      checkInOnCreate: { byUid: callerUid, workspaceUid: uid },
    })

    // Audit: attribute to the operator (callerUid) + record the workspace.
    void writeAuditEntry(result.registrationId, 'walkin_created', callerUid, 'organizer', uid)
      .catch(err => console.error('[walkin] audit failed:', err))

    // RD-CHECKIN-2.0 — a walk-in IS an admission, so it appends the same
    // CHECK_IN history entry a scanned ticket does. `createRegistration` performed
    // the check-in inside its own transaction via `checkInOnCreate`, which is why
    // this is recorded here rather than in the shared check-in helper: there is
    // exactly one admission and exactly one history entry for it.
    // Awaited, like every other history append: the entry is the evidence, and the
    // response must not describe an admission whose record has not been written.
    await appendCheckinHistorySafe({
      registrationId: result.registrationId,
      action:         'CHECK_IN',
      eventSlug:      slug,
      organizerUid:   uid,
      operatorUid:    callerUid,
      workspaceUid:   uid,
      method:         'walkin',
    })

    // Identity engine: walk-ins flow through the SAME allocateIdentifier path —
    // no duplicate assignment logic. No-op unless the event opted into auto
    // assignment, so events without identifier setup are unaffected. The walk-in
    // is already checked in, so consume the identifier immediately too.
    let identifier: string | null = null
    try {
      const assigned = await autoAssignIfEnabled({
        eventSlug: slug, registrationId: result.registrationId,
        actor: callerUid, source: 'walkin', passId,
      })
      if (assigned) {
        identifier = assigned.value
        void consumeIdentifier(result.registrationId, callerUid)
          .catch(err => console.error('[walkin] consumeIdentifier failed:', err))
      }
    } catch (err) {
      console.error('[walkin] identifier allocation failed (non-fatal):', err)
    }

    return NextResponse.json({
      success:        true,
      registrationId: result.registrationId,
      ticketCode:     result.ticketCode,
      ...(identifier ? { identifier } : {}),
    }, { status: 201 })
  } catch (err) {
    if (err instanceof DuplicateRegistrationError) {
      const msg = err.reason === 'DUPLICATE_EMAIL'
        ? 'A registration with this email already exists for this event.'
        : 'A registration with this phone number already exists for this event.'
      return NextResponse.json({ error: msg, reason: err.reason }, { status: 409 })
    }
    if (err instanceof CapacityExceededError) {
      const msg = err.reason === 'EVENT_CAPACITY_FULL' ? 'This event is sold out.'
        : err.reason === 'PASS_CAPACITY_FULL'           ? 'This pass is sold out.'
        : 'This pass is no longer available.'
      return NextResponse.json({ error: msg, reason: err.reason }, { status: 409 })
    }
    console.error('[walkin] registration failed:', err)
    return NextResponse.json({ error: 'Registration failed. Please try again.' }, { status: 500 })
  }
}
