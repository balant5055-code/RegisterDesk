// POST /api/events/[slug]/tickets/lookup
//
// PUBLIC endpoint behind "Download your ticket". An attendee proves who they are with TWO
// identifiers — a ticket code or registration id, AND the mobile number they registered
// with — and receives a short-lived link to their own ticket PDF.
//
// ═══ WHAT COUNTS AS PROOF ════════════════════════════════════════════════════
// EITHER identifier is accepted, and they are not equally strong:
//
//   • Ticket ID / registration id — unguessable. A ticket code is 8 characters of
//     crypto-random from a 29-symbol alphabet (~5x10^11 combinations, lib/registrations/
//     ticketCode.ts) and a registration id is a uuid. Possession IS the proof, which is the
//     same property the signed PDF link already relies on.
//
//   • Mobile number — NOT a secret. Anyone who knows an attendee's number can obtain that
//     attendee's ticket for this event. This is a deliberate product decision: attendees
//     lose the code far more often than they lose their phone number, and the certificate
//     centre already resolves identity the same way. Rate limiting bounds enumeration; it
//     does not make a known number private.
//
// When BOTH are supplied they must resolve to the SAME registration — the strictest mode,
// and the one the UI nudges toward when a number is shared.
//
// ═══ EVENT SCOPING ═══════════════════════════════════════════════════════════
// The slug comes from the URL and is an equality filter on every query. A ticket code from
// another event cannot be redeemed here even with the correct mobile, and there is no code
// path that reads a registration without the eventSlug filter.
//
// ═══ WHAT IS RETURNED ════════════════════════════════════════════════════════
// ALWAYS a LIST of tickets, even when there is one. A shared family number legitimately
// maps to several registrations, and a single-ticket response shape would force this
// route to pick one of them — so the shape itself removes the possibility. Each entry
// carries its own capability, so a family downloads three tickets rather than three
// copies of whichever happened to sort first.
//
// Each entry is a deliberately tiny projection: attendee name, ticket code, pass name,
// event name, and a freshly minted download capability. Email, phone, uid, organizerUid,
// amount, payment status, coupon and the raw document never leave the server — a correct
// guess must not become a way to read somebody's contact details.
//
// ═══ ENUMERATION ═════════════════════════════════════════════════════════════
// Every miss returns the SAME payload. "No such ticket code", "that code belongs to another
// event" and "right code, wrong mobile" are indistinguishable. The one place a specific
// answer IS given is after BOTH identifiers matched — at that point the caller has proved
// who they are, and telling them their registration is cancelled is help, not a leak.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { getClientIp }               from '@/lib/rateLimit'
import { RATE_POLICY, checkPolicy }  from '@/lib/rateLimit/policies'
import { normalizePhoneNumber }      from '@/lib/communication/phone'
import { signTicketToken }           from '@/lib/tickets/generate'
import type { RegistrationDocument } from '@/lib/registrations/types'

export const dynamic = 'force-dynamic'

/** Firestore caps an `in` filter at 10 values. */
const IN_CHUNK = 10

type Params = { params: Promise<{ slug: string }> }

export interface TicketLookupResult {
  attendeeName: string
  ticketCode:   string
  passName:     string
  eventName:    string
  eventSlug:    string
  /** Relative URL of the EXISTING ticket PDF route, carrying a signed capability. */
  downloadUrl:  string
}

export type TicketLookupResponse =
  /** One entry per CONFIRMED registration matched. Never empty on success. */
  | { success: true;  tickets: TicketLookupResult[] }
  /** Identity proved, but nothing matched is confirmed, so there is no ticket. */
  | { success: false; found: true;  reason: string }
  /** Uniform miss — deliberately says nothing about which identifier was wrong. */
  | { success: false; found: false; reason: string }

/**
 * The single sentence every miss returns.
 *
 * It must stay identical for "unknown code", "wrong event" and "wrong mobile", because the
 * moment those differ the endpoint becomes an oracle for which ticket codes exist.
 */
const NO_MATCH = 'We could not find a ticket matching those details for this event. Check your ticket ID, or the mobile number you registered with.'

/**
 * Plausible spellings of a mobile number, as `attendee.phone` is stored AS TYPED.
 *
 * The same person may appear as "+91 99168 03664", "9916803664" or "919916803664" depending
 * on the form they filled. Comparing in-memory against this small set avoids both a data
 * migration and a second query. Mirrors the certificate lookup, deliberately.
 */
function phoneVariants(raw: string): string[] {
  const e164 = normalizePhoneNumber(raw)
  if (!e164) return []
  const national = e164.length > 10 ? e164.slice(-10) : e164
  return [...new Set([raw.trim(), e164, `+${e164}`, national, `+91${national}`, `91${national}`])]
    .filter(v => v.length > 0)
    .slice(0, IN_CHUNK)
}

/** True when the registration's stored phone is any plausible spelling of the supplied one. */
function phoneMatches(stored: string | undefined, supplied: string): boolean {
  if (!stored) return false
  const storedE164 = normalizePhoneNumber(stored)
  const variants   = phoneVariants(supplied)
  if (!variants.length) return false
  // Compare on the canonical form first, then on the raw spellings, so "+91 99168 03664"
  // and "9916803664" are the same person without either side being migrated.
  if (storedE164 && variants.some(v => normalizePhoneNumber(v) === storedE164)) return true
  return variants.includes(stored.trim())
}

/**
 * Resolves the supplied identifier to ONE registration in this event.
 *
 * Accepts a ticket code ("RD-XXXXXXXX", upper-cased because attendees type it off a printed
 * ticket in any case) or a registration id (the Firestore document id). Both are checked
 * against the slug; the document-id path re-verifies `eventSlug` on the loaded document,
 * since a document id is not scoped by the query.
 */
async function findRegistration(
  slug: string, identifier: string,
): Promise<{ id: string; data: RegistrationDocument } | null> {
  const raw = identifier.trim()
  if (!raw) return null

  const byCode = await adminDb.collection('registrations')
    .where('eventSlug', '==', slug)
    .where('ticketCode', '==', raw.toUpperCase())
    .limit(1)
    .get()
  if (!byCode.empty) {
    const d = byCode.docs[0]
    return { id: d.id, data: d.data() as RegistrationDocument }
  }

  const byId = await adminDb.collection('registrations').doc(raw).get()
  if (byId.exists) {
    const data = byId.data() as RegistrationDocument
    // The slug check is the whole point: a document id from another event must not resolve.
    if (data.eventSlug === slug) return { id: byId.id, data }
  }
  return null
}

/**
 * Every registration in this event whose stored phone is a plausible spelling of `raw`.
 *
 * Returns ALL matches rather than the first: a shared family number legitimately maps to
 * several registrations, and silently taking one would hand over the wrong ticket.
 */
async function findByPhone(
  slug: string, raw: string,
): Promise<Array<{ id: string; data: RegistrationDocument }>> {
  const variants = phoneVariants(raw)
  if (!variants.length) return []

  const snap = await adminDb.collection('registrations')
    .where('eventSlug', '==', slug)
    .where('attendee.phone', 'in', variants)
    .limit(IN_CHUNK)
    .get()

  return snap.docs.map(d => ({ id: d.id, data: d.data() as RegistrationDocument }))
}

/**
 * The ONLY shape that leaves this route.
 *
 * Extracted so a multi-result response cannot accidentally acquire a wider projection
 * than a single one — every ticket returned, however many, is built here.
 */
function toResult(id: string, d: RegistrationDocument, slug: string): TicketLookupResult {
  return {
    attendeeName: d.attendee?.name ?? '',
    ticketCode:   d.ticketCode ?? '',
    passName:     d.passName ?? '',
    eventName:    d.eventName ?? '',
    eventSlug:    slug,
    // Reuses the EXISTING ticket PDF route and its HMAC capability — no second ticket
    // renderer, and no new authorization path to get wrong. Each ticket gets its OWN
    // capability, scoped to its own registration id.
    downloadUrl:  `/api/tickets/${encodeURIComponent(id)}/pdf?token=${signTicketToken(id)}`,
  }
}

/** Statuses that legitimately hold an admission ticket. */
const TICKETED_STATUSES = new Set(['confirmed'])

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse<TicketLookupResponse>> {
  const { slug } = await params

  // Enumeration guard. Tight, because a hit mints a download capability.
  const rl = checkPolicy(getClientIp(req), RATE_POLICY.ticketLookup)
  if (rl.limited) {
    return NextResponse.json(
      { success: false, found: false, reason: 'Too many attempts. Please wait a minute and try again.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ success: false, found: false, reason: NO_MATCH }, { status: 400 }) }

  const { ticketId, mobile } = (body ?? {}) as Record<string, unknown>
  const idRaw     = typeof ticketId === 'string' ? ticketId.trim() : ''
  const mobileRaw = typeof mobile   === 'string' ? mobile.trim()   : ''

  // AT LEAST ONE identifier. A form error, not an identity answer — saying so reveals
  // nothing about which tickets exist.
  if (!idRaw && !mobileRaw) {
    return NextResponse.json(
      { success: false, found: false, reason: 'Enter your ticket ID or the mobile number you registered with.' },
      { status: 400 },
    )
  }
  if (!slug) {
    return NextResponse.json({ success: false, found: false, reason: NO_MATCH }, { status: 400 })
  }

  let candidates: Array<{ id: string; data: RegistrationDocument }> = []

  if (idRaw) {
    // The identifier is the strong factor, so it decides WHICH registration — at most one.
    // A mobile supplied alongside it must agree: it can narrow, never redirect.
    const match = await findRegistration(slug, idRaw)
    const agrees = !!match && (!mobileRaw || phoneMatches(match.data.attendee?.phone, mobileRaw))
    if (match && agrees) candidates = [match]
  } else {
    // One number may legitimately cover a family or a team. ALL of them are returned
    // below; nothing here picks a winner.
    candidates = await findByPhone(slug, mobileRaw)
  }

  // ONE response for every failure mode below this line.
  if (!candidates.length) {
    return NextResponse.json({ success: false, found: false, reason: NO_MATCH }, { status: 404 })
  }

  // Only a confirmed registration holds an admission ticket. Filtering here rather than
  // at the query keeps the status message available for the case below.
  const ticketed = candidates.filter(c => TICKETED_STATUSES.has(c.data.status))

  // Identity is proved from here on, so a specific answer is help rather than a leak.
  if (!ticketed.length) {
    return NextResponse.json(
      {
        success: false, found: true,
        reason: candidates.length === 1
          ? `This registration is ${candidates[0].data.status}, so there is no ticket to download. Please contact the organizer.`
          : 'None of the registrations for this mobile number are confirmed, so there is no ticket to download. Please contact the organizer.',
      },
      { status: 409 },
    )
  }

  return NextResponse.json({
    success: true,
    tickets: ticketed.map(c => toResult(c.id, c.data, slug)),
  })
}
