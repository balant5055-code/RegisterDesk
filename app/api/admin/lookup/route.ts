// GET /api/admin/lookup?q=...
//
// GA-7E S1 — cross-entity SUPPORT lookup. Resolves one query string (registration id,
// ticket code, attendee email, Razorpay payment id, certificate id, or organizer
// uid/email) to the matching records so support can diagnose WITHOUT Firestore-console
// access. Admin-only, READ-ONLY, capped, lean projections (no form responses / PII bulk).
// Reuses existing Firestore reads and getCertificate — NO new search engine.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { adminDb } from '@/lib/firebase/admin'
import { getCertificate } from '@/lib/certificates/firestore'

export const dynamic = 'force-dynamic'
const CAP = 20

interface RegHit {
  id: string; eventSlug: string; eventName: string; attendeeName: string; attendeeEmail: string
  attendeePhone: string; status: string; paymentStatus: string; amount: number; ticketCode: string
  paymentId: string | null; organizerUid: string; registeredAt: string | null
}
interface CertHit { certificateId: string; eventId: string; attendeeName: string; certificateType: string; status: string; organizerUid: string }
interface OrgHit { uid: string; name: string; email: string; organizationName: string; accountStatus: string }

function tsToISO(v: unknown): string | null {
  if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') return (v as { toDate: () => Date }).toDate().toISOString()
  return typeof v === 'string' ? v : null
}
function toRegHit(id: string, d: Record<string, unknown>): RegHit {
  const a = (d.attendee as Record<string, unknown> | undefined) ?? {}
  return {
    id,
    eventSlug: String(d.eventSlug ?? ''), eventName: String(d.eventName ?? ''),
    attendeeName: String(a.name ?? ''), attendeeEmail: String(a.email ?? ''), attendeePhone: String(a.phone ?? ''),
    status: String(d.status ?? ''), paymentStatus: String(d.paymentStatus ?? ''),
    amount: typeof d.amount === 'number' ? d.amount : 0,
    ticketCode: String(d.ticketCode ?? ''), paymentId: (d.paymentId as string) ?? null,
    organizerUid: String(d.organizerUid ?? ''), registeredAt: tsToISO(d.registeredAt),
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (!q) return NextResponse.json({ error: 'q is required' }, { status: 400 })

  const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)
  const regs = adminDb.collection('registrations')
  const mapRegs = (s: FirebaseFirestore.QuerySnapshot) => s.docs.map(d => toRegHit(d.id, d.data() as Record<string, unknown>))

  const [byId, byTicket, byEmail, byPayment, certOne, orgs] = await Promise.all([
    // registration by document id
    regs.doc(q).get().then(s => (s.exists ? [toRegHit(s.id, s.data() as Record<string, unknown>)] : [])).catch(() => [] as RegHit[]),
    // by ticket code (skip when it's an email)
    isEmail ? Promise.resolve([] as RegHit[]) : regs.where('ticketCode', '==', q).limit(CAP).get().then(mapRegs).catch(() => [] as RegHit[]),
    // by attendee email
    isEmail ? regs.where('attendee.email', '==', q.toLowerCase()).limit(CAP).get().then(mapRegs).catch(() => [] as RegHit[]) : Promise.resolve([] as RegHit[]),
    // by Razorpay payment id
    isEmail ? Promise.resolve([] as RegHit[]) : regs.where('paymentId', '==', q).limit(CAP).get().then(mapRegs).catch(() => [] as RegHit[]),
    // certificate by public id
    getCertificate(q).then(c => (c ? [{
      certificateId: c.certificateId, eventId: c.eventId, attendeeName: c.attendeeName,
      certificateType: c.certificateType, status: (c as { status?: string }).status ?? 'active', organizerUid: c.organizerUid,
    } as CertHit] : [])).catch(() => [] as CertHit[]),
    // organizer by uid (doc) or email
    Promise.all([
      adminDb.collection('users').doc(q).get().then(s => (s.exists ? [{ uid: s.id, ...(s.data() as Record<string, unknown>) }] : [])).catch(() => [] as Record<string, unknown>[]),
      isEmail ? adminDb.collection('users').where('email', '==', q).limit(CAP).get().then(s => s.docs.map(d => ({ uid: d.id, ...(d.data() as Record<string, unknown>) }))).catch(() => [] as Record<string, unknown>[]) : Promise.resolve([] as Record<string, unknown>[]),
    ]).then(([a, b]) => [...a, ...b]),
  ])

  // Dedupe registrations by id across the query strategies.
  const regMap = new Map<string, RegHit>()
  for (const r of [...byId, ...byTicket, ...byEmail, ...byPayment]) regMap.set(r.id, r)

  const organizers: OrgHit[] = (orgs as Record<string, unknown>[]).map(o => ({
    uid: String(o.uid ?? ''), name: String(o.name ?? ''), email: String(o.email ?? ''),
    organizationName: String(o.organizationName ?? ''), accountStatus: String(o.accountStatus ?? 'active'),
  }))

  return NextResponse.json({
    query: q,
    registrations: [...regMap.values()].slice(0, CAP),
    certificates:  certOne,
    organizers,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
