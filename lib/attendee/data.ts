// Attendee portal data layer — server-only (Admin SDK).
//
// Every query is scoped to the attendee's normalized email (the session-derived
// owner). There is NO by-id access path here: ownership is enforced by the query
// itself, so an attendee can only ever read their own records. Routes call these
// functions and never re-implement query logic.

import { adminDb }          from '@/lib/firebase/admin'
import { APP_URL }          from '@/lib/env'
import { signTicketToken }  from '@/lib/tickets/generate'
import type { RegistrationDocument } from '@/lib/registrations/types'
import type { DonationDocument }     from '@/lib/donations/types'
import type { Certificate }          from '@/lib/certificates/types'

const DEFAULT_LIMIT = 100
const MAX_LIMIT     = 200

export interface PageOpts { limit?: number; cursor?: string }
export interface Page<T> { items: T[]; nextCursor: string | null }

function clampLimit(n?: number): number {
  return Math.min(MAX_LIMIT, Math.max(1, n ?? DEFAULT_LIMIT))
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

/** Resolves a cursor doc id to a snapshot for startAfter on the given collection. */
async function cursorStart(collection: string, cursor: string | undefined) {
  if (!cursor) return null
  const snap = await adminDb.collection(collection).doc(cursor).get()
  return snap.exists ? snap : null
}

// ─── Registrations ────────────────────────────────────────────────────────────

export interface AttendeeRegistration {
  registrationId: string
  eventName:      string
  eventSlug:      string
  status:         string
  registeredAt:   string | null
  ticketCode:     string
  paymentStatus:  string
  amountPaid:     number   // paise
}

export async function listAttendeeRegistrations(
  normalizedEmail: string,
  opts: PageOpts = {},
): Promise<Page<AttendeeRegistration>> {
  const limit = clampLimit(opts.limit)
  let q = adminDb.collection('registrations')
    .where('attendee.email', '==', normalizedEmail)
    .orderBy('registeredAt', 'desc')
    .limit(limit + 1)
  const start = await cursorStart('registrations', opts.cursor)
  if (start) q = q.startAfter(start) as typeof q

  const snap     = await q.get()
  const hasMore  = snap.docs.length > limit
  const pageDocs = hasMore ? snap.docs.slice(0, limit) : snap.docs

  const items: AttendeeRegistration[] = pageDocs.map(doc => {
    const d = doc.data() as RegistrationDocument
    return {
      registrationId: doc.id,
      eventName:      d.eventName ?? '',
      eventSlug:      d.eventSlug ?? '',
      status:         d.status,
      registeredAt:   tsToISO(d.registeredAt),
      ticketCode:     d.ticketCode ?? '',
      paymentStatus:  d.paymentStatus,
      amountPaid:     typeof d.amount === 'number' ? d.amount : 0,
    }
  })
  return { items, nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null }
}

// ─── Tickets (derived from confirmed registrations) ──────────────────────────

export interface AttendeeTicket {
  registrationId: string
  ticketCode:     string
  eventName:      string
  eventDate:      string | null
  downloadUrl:    string
}

export async function listAttendeeTickets(
  normalizedEmail: string,
  opts: PageOpts = {},
): Promise<Page<AttendeeTicket>> {
  // Reuse the registrations query (same index); a ticket exists for any
  // confirmed registration with a ticket code.
  const page = await listAttendeeRegistrations(normalizedEmail, opts)
  const eligible = page.items.filter(r => r.status === 'confirmed' && r.ticketCode)

  // Batch-load event start dates for the unique slugs on this page.
  const slugs = [...new Set(eligible.map(r => r.eventSlug).filter(Boolean))]
  const dateBySlug = new Map<string, string | null>()
  if (slugs.length > 0) {
    const refs  = slugs.map(s => adminDb.collection('events').doc(s))
    const snaps = await adminDb.getAll(...refs)
    for (const s of snaps) {
      if (!s.exists) continue
      const ed = (s.data() as Record<string, unknown>).eventDetails as Record<string, unknown> | undefined
      const sched = ed?.schedule as Record<string, unknown> | undefined
      dateBySlug.set(s.id, typeof sched?.startDate === 'string' ? sched.startDate : null)
    }
  }

  const items: AttendeeTicket[] = eligible.map(r => ({
    registrationId: r.registrationId,
    ticketCode:     r.ticketCode,
    eventName:      r.eventName,
    eventDate:      dateBySlug.get(r.eventSlug) ?? null,
    downloadUrl:    `${APP_URL}/api/tickets/${r.registrationId}/pdf?token=${encodeURIComponent(signTicketToken(r.registrationId))}`,
  }))
  // nextCursor advances over the raw scan so paging continues despite filtering.
  return { items, nextCursor: page.nextCursor }
}

// ─── Donations ────────────────────────────────────────────────────────────────

export interface AttendeeDonation {
  donationId:    string
  campaignName:  string
  amount:        number   // paise
  status:        string
  donatedAt:     string | null
  receiptNumber: string | null
}

export async function listAttendeeDonations(
  normalizedEmail: string,
  opts: PageOpts = {},
): Promise<Page<AttendeeDonation>> {
  const limit = clampLimit(opts.limit)
  let q = adminDb.collection('donations')
    .where('donorEmail', '==', normalizedEmail)
    .orderBy('createdAt', 'desc')
    .limit(limit + 1)
  const start = await cursorStart('donations', opts.cursor)
  if (start) q = q.startAfter(start) as typeof q

  const snap     = await q.get()
  const hasMore  = snap.docs.length > limit
  const pageDocs = hasMore ? snap.docs.slice(0, limit) : snap.docs

  const items: AttendeeDonation[] = pageDocs.map(doc => {
    const d = doc.data() as DonationDocument
    return {
      donationId:    doc.id,
      campaignName:  d.campaignTitle ?? '',
      amount:        typeof d.amountPaise === 'number' ? d.amountPaise : 0,
      status:        d.status,
      donatedAt:     tsToISO(d.paidAt) ?? tsToISO(d.createdAt),
      receiptNumber: d.receiptNumber ?? null,
    }
  })
  return { items, nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null }
}

// ─── Certificates ─────────────────────────────────────────────────────────────

export interface AttendeeCertificate {
  certificateId:   string
  eventName:       string
  issuedAt:        string | null
  verificationUrl: string
  downloadUrl:     string
}

export async function listAttendeeCertificates(
  normalizedEmail: string,
  opts: PageOpts = {},
): Promise<Page<AttendeeCertificate>> {
  const limit = clampLimit(opts.limit)
  let q = adminDb.collection('certificates')
    .where('attendeeEmail', '==', normalizedEmail)
    .orderBy('generatedAt', 'desc')
    .limit(limit + 1)
  const start = await cursorStart('certificates', opts.cursor)
  if (start) q = q.startAfter(start) as typeof q

  const snap     = await q.get()
  const hasMore  = snap.docs.length > limit
  const pageDocs = hasMore ? snap.docs.slice(0, limit) : snap.docs

  // Revoked certificates aren't downloadable — exclude from the portal list.
  const items: AttendeeCertificate[] = pageDocs
    .map(doc => doc.data() as Certificate)
    .filter(c => c.status !== 'revoked')
    .map(c => ({
      certificateId:   c.certificateId,
      eventName:       c.eventName ?? '',
      issuedAt:        tsToISO(c.generatedAt),
      verificationUrl: `${APP_URL}/verify/certificate/${c.certificateId}`,
      downloadUrl:     c.verificationToken
        ? `${APP_URL}/api/certificates/${c.certificateId}/file?token=${encodeURIComponent(c.verificationToken)}`
        : `${APP_URL}/api/certificates/${c.certificateId}/file`,
    }))
  return { items, nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null }
}
