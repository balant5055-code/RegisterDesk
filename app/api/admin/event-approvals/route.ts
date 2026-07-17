// GET /api/admin/event-approvals — events awaiting approval, enriched for the
// admin approval queue (admin only).
//
// Returns pending_review events with organizer identity, license tier + payment,
// wallet (communication) payment, banner, dates, and registration limit. Reads
// are batched (getAll) over the pending set — never a per-event round trip.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }         from '@/lib/firebase/admin'
import { resolveAdminUid } from '@/lib/admin/auth'

export interface PendingEventRow {
  slug:               string
  name:               string
  bannerUrl:          string | null
  organizerUid:       string
  organizerName:      string | null
  organizerEmail:     string | null
  workspace:          string | null
  eventType:          string | null
  licenseTier:        string | null
  licensePaymentPaise: number
  walletPaymentPaise:  number
  walletPaymentStatus: string | null
  registrationLimit:  number | null   // null = unlimited
  submittedAt:        string | null
  eventDate:          string | null
  status:             string
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function str(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const snap = await adminDb
    .collection('events')
    .where('lifecycleStatus', '==', 'pending_review')
    .limit(100)
    .get()

  if (snap.empty) return NextResponse.json({ events: [] }, { headers: { 'Cache-Control': 'no-store' } })

  // Batch the joins.
  const uids     = Array.from(new Set(snap.docs.map(d => (d.data().uid as string) || '').filter(Boolean)))
  const userRefs = uids.map(u => adminDb.doc(`users/${u}`))
  const licRefs  = snap.docs.map(d => adminDb.doc(`eventLicenses/${d.id}`))
  const draftRefs = snap.docs.map(d => {
    const raw = d.data()
    return adminDb.doc(`users/${raw.uid as string}/eventDrafts/${raw.draftId as string}`)
  })

  const [userSnaps, licSnaps, draftSnaps] = await Promise.all([
    userRefs.length ? adminDb.getAll(...userRefs) : Promise.resolve([]),
    licRefs.length ? adminDb.getAll(...licRefs) : Promise.resolve([]),
    draftRefs.length ? adminDb.getAll(...draftRefs) : Promise.resolve([]),
  ])

  const userMap = new Map<string, Record<string, unknown>>()
  for (const us of userSnaps) if (us.exists) userMap.set(us.id, us.data() as Record<string, unknown>)
  const licMap = new Map<string, Record<string, unknown>>()
  for (const ls of licSnaps) if (ls.exists) licMap.set(ls.id, ls.data() as Record<string, unknown>)
  const draftMap = new Map<string, Record<string, unknown>>()
  draftSnaps.forEach((ds, i) => { if (ds.exists) draftMap.set(snap.docs[i].id, ds.data() as Record<string, unknown>) })

  const events: PendingEventRow[] = snap.docs.map((doc) => {
    const raw = doc.data() as Record<string, unknown>
    const uid = (raw.uid as string) || ''
    const u   = userMap.get(uid)
    const lic = licMap.get(doc.id)
    const drf = draftMap.get(doc.id)
    const comm = (drf?.communicationBilling as Record<string, unknown> | undefined) ?? undefined

    const name = typeof str(raw, 'eventDetails', 'info', 'name') === 'string'
      ? (str(raw, 'eventDetails', 'info', 'name') as string).trim() || 'Untitled Event'
      : 'Untitled Event'

    return {
      slug:                doc.id,
      name,
      bannerUrl:           typeof str(raw, 'eventDetails', 'media', 'coverBanner', 'value') === 'string'
        ? (str(raw, 'eventDetails', 'media', 'coverBanner', 'value') as string) : null,
      organizerUid:        uid,
      organizerName:       typeof u?.name === 'string' ? (u.name as string) : null,
      organizerEmail:      typeof u?.email === 'string' ? (u.email as string) : null,
      workspace:           typeof u?.organizationName === 'string' ? (u.organizationName as string) : null,
      eventType:           typeof raw.eventType === 'string' ? raw.eventType : null,
      licenseTier:         typeof lic?.tier === 'string' ? (lic.tier as string) : null,
      licensePaymentPaise: typeof lic?.amountPaise === 'number' ? (lic.amountPaise as number) : 0,
      walletPaymentPaise:  typeof comm?.amount === 'number' ? (comm.amount as number) : 0,
      walletPaymentStatus: typeof comm?.status === 'string' ? (comm.status as string) : null,
      registrationLimit:   typeof raw.totalCapacity === 'number' ? (raw.totalCapacity as number) : null,
      submittedAt:         tsToISO(raw.publishedAt),
      eventDate:           typeof str(raw, 'eventDetails', 'schedule', 'startDate') === 'string'
        ? (str(raw, 'eventDetails', 'schedule', 'startDate') as string) : null,
      status:              typeof raw.lifecycleStatus === 'string' ? raw.lifecycleStatus : 'pending_review',
    }
  })

  return NextResponse.json({ events }, { headers: { 'Cache-Control': 'no-store' } })
}
