// CRM backfill / rebuild (server-only, per organizer). Recomputes contacts +
// activities from the source collections (registrations, donations, refunds,
// certificates, broadcasts). Counters are written as ABSOLUTE values computed
// from source, so the rebuild is idempotent + self-healing: re-running corrects
// any drift from the live increment path. Deterministic ids ⇒ no duplicates.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { CRM_CONTACTS, CRM_ACTIVITIES, type CrmActivityType, type CrmLastEvent, type CrmLastDonation } from '@/lib/crm/types'
import { normalizeEmail, contactIdFor, activityIdFor } from '@/lib/crm/identity'
import { toMillis } from '@/lib/reports/format'

interface Agg {
  contactId: string; email: string; name: string; phone: string | null
  firstSeenAt: number; lastSeenAt: number
  totalRegistrations: number; totalCheckIns: number; totalDonations: number; totalDonationAmountPaise: number
  lastEvent: CrmLastEvent | null; lastDonation: CrmLastDonation | null
}
interface ActRec { activityId: string; contactId: string; type: CrmActivityType; entityId: string; metadata: Record<string, unknown>; createdAt: number }

export interface BackfillResult {
  contacts: number; activities: number
  scanned: { registrations: number; donations: number; refunds: number; certificates: number; broadcasts: number }
}

async function pageByOrganizer(
  collection: string, uid: string, cb: (doc: FirebaseFirestore.QueryDocumentSnapshot) => void, pageSize = 500,
): Promise<number> {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
  let n = 0
  for (;;) {
    let q = adminDb.collection(collection).where('organizerUid', '==', uid).orderBy('__name__').limit(pageSize) as FirebaseFirestore.Query
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    if (snap.empty) break
    for (const d of snap.docs) { cb(d); n++ }
    cursor = snap.docs[snap.docs.length - 1]
    if (snap.size < pageSize) break
  }
  return n
}

export async function rebuildCrmForOrganizer(uid: string): Promise<BackfillResult> {
  const contacts = new Map<string, Agg>()
  const activities: ActRec[] = []
  const donorByDonationId = new Map<string, { email: string; name: string }>()

  const touch = (email: string, name: string | undefined, phone: string | null | undefined, at: number): Agg | null => {
    const norm = normalizeEmail(email)
    if (!norm) return null
    const id = contactIdFor(uid, norm)
    let a = contacts.get(id)
    if (!a) {
      a = { contactId: id, email: norm, name: '', phone: null, firstSeenAt: at, lastSeenAt: 0, totalRegistrations: 0, totalCheckIns: 0, totalDonations: 0, totalDonationAmountPaise: 0, lastEvent: null, lastDonation: null }
      contacts.set(id, a)
    }
    a.firstSeenAt = Math.min(a.firstSeenAt, at)
    if (at >= a.lastSeenAt) { a.lastSeenAt = at; if (name) a.name = name; if (phone) a.phone = phone }
    else { if (!a.name && name) a.name = name; if (!a.phone && phone) a.phone = phone }
    return a
  }
  const addAct = (contactId: string, type: CrmActivityType, entityId: string, metadata: Record<string, unknown>, at: number) =>
    activities.push({ activityId: activityIdFor(contactId, type, entityId), contactId, type, entityId, metadata, createdAt: at })

  // ── Registrations (+ check-ins) ──
  const nReg = await pageByOrganizer('registrations', uid, doc => {
    const d = doc.data() as { attendee?: { email?: string; name?: string; phone?: string }; eventSlug?: string; eventName?: string; registeredAt?: unknown; checkedIn?: boolean; checkedInAt?: unknown }
    const at = toMillis(d.registeredAt) || 0
    const a = touch(d.attendee?.email ?? '', d.attendee?.name, d.attendee?.phone ?? null, at)
    if (!a) return
    a.totalRegistrations++
    if (d.eventName && at >= (a.lastEvent?.at ?? 0)) a.lastEvent = { name: d.eventName, slug: d.eventSlug ?? '', at }
    addAct(a.contactId, 'registration_created', doc.id, { eventSlug: d.eventSlug ?? '', eventName: d.eventName ?? '' }, at)
    if (d.checkedIn) {
      const ci = toMillis(d.checkedInAt) || at
      a.totalCheckIns++
      a.lastSeenAt = Math.max(a.lastSeenAt, ci)
      addAct(a.contactId, 'checked_in', doc.id, { eventSlug: d.eventSlug ?? '', eventName: d.eventName ?? '' }, ci)
    }
  })

  // ── Donations (paid/successful) ──
  const nDon = await pageByOrganizer('donations', uid, doc => {
    const d = doc.data() as { donorEmail?: string; donorName?: string; donorPhone?: string; amountPaise?: number; campaignSlug?: string; campaignTitle?: string; status?: string; paymentStatus?: string; paidAt?: unknown; createdAt?: unknown }
    const paid = !!d.paidAt || d.paymentStatus === 'paid' || d.status === 'successful'
    if (!paid || !(d.amountPaise && d.amountPaise > 0)) return
    const at = toMillis(d.paidAt ?? d.createdAt) || 0
    const a = touch(d.donorEmail ?? '', d.donorName, d.donorPhone ?? null, at)
    if (!a) return
    donorByDonationId.set(doc.id, { email: a.email, name: a.name })
    a.totalDonations++
    a.totalDonationAmountPaise += d.amountPaise
    if (at >= (a.lastDonation?.at ?? 0)) a.lastDonation = { campaign: d.campaignTitle ?? d.campaignSlug ?? '', amountPaise: d.amountPaise, at }
    addAct(a.contactId, 'donation_created', doc.id, { campaignSlug: d.campaignSlug ?? '', campaignTitle: d.campaignTitle ?? '', amountPaise: d.amountPaise }, at)
  })

  // ── Donation refunds (processed) ──
  const nRef = await pageByOrganizer('donationRefunds', uid, doc => {
    const d = doc.data() as { donationId?: string; amountPaise?: number; status?: string; processedAt?: unknown; createdAt?: unknown }
    if (d.status !== 'processed') return
    const donor = d.donationId ? donorByDonationId.get(d.donationId) : undefined
    if (!donor) return
    const at = toMillis(d.processedAt ?? d.createdAt) || 0
    const a = touch(donor.email, donor.name, null, at)
    if (!a) return
    addAct(a.contactId, 'donation_refunded', doc.id, { donationId: d.donationId ?? '', amountPaise: d.amountPaise ?? 0 }, at)
  })

  // ── Certificates ──
  const nCert = await pageByOrganizer('certificates', uid, doc => {
    const d = doc.data() as { attendeeEmail?: string; attendeeName?: string; eventSlug?: string; generatedAt?: unknown; issuedAt?: unknown; createdAt?: unknown }
    const at = toMillis(d.generatedAt ?? d.issuedAt ?? d.createdAt) || 0
    const a = touch(d.attendeeEmail ?? '', d.attendeeName, null, at)
    if (!a) return
    addAct(a.contactId, 'certificate_issued', doc.id, { eventSlug: d.eventSlug ?? '' }, at)
  })

  // ── Broadcasts (reconstruct recipients from the event's registrations) ──
  let nBroadcast = 0
  const campaignSnap = await adminDb.collection('broadcastCampaigns')
    .where('organizerUid', '==', uid).orderBy('__name__').limit(1000).get()
  for (const cDoc of campaignSnap.docs) {
    const c = cDoc.data() as { eventSlug?: string; eventName?: string; audience?: string; status?: string; sentAt?: unknown; createdAt?: unknown }
    if (c.status !== 'sent' || !c.eventSlug) continue
    nBroadcast++
    const at = toMillis(c.sentAt ?? c.createdAt) || 0
    let rq: FirebaseFirestore.Query = adminDb.collection('registrations').where('organizerUid', '==', uid).where('eventSlug', '==', c.eventSlug)
    if (c.audience && c.audience !== 'all') rq = rq.where('status', '==', c.audience)
    const regs = await rq.get()
    for (const r of regs.docs) {
      const rd = r.data() as { attendee?: { email?: string; name?: string } }
      const a = touch(rd.attendee?.email ?? '', rd.attendee?.name, null, at)
      if (!a) continue
      addAct(a.contactId, 'broadcast_sent', cDoc.id, { eventSlug: c.eventSlug, eventName: c.eventName ?? '' }, at)
    }
  }

  // ── Write contacts (absolute counters; merge preserves tags/notes) ──
  let written = 0
  const contactArr = [...contacts.values()]
  for (let i = 0; i < contactArr.length; i += 400) {
    const batch = adminDb.batch()
    for (const a of contactArr.slice(i, i + 400)) {
      batch.set(adminDb.collection(CRM_CONTACTS).doc(a.contactId), {
        contactId: a.contactId, organizerUid: uid, email: a.email, name: a.name, phone: a.phone,
        firstSeenAt: a.firstSeenAt, lastSeenAt: a.lastSeenAt,
        totalRegistrations: a.totalRegistrations, totalCheckIns: a.totalCheckIns,
        totalDonations: a.totalDonations, totalDonationAmountPaise: a.totalDonationAmountPaise,
        lastEvent: a.lastEvent, lastDonation: a.lastDonation,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      written++
    }
    await batch.commit()
  }

  // ── Write activities (deterministic id; merge = idempotent) ──
  for (let i = 0; i < activities.length; i += 400) {
    const batch = adminDb.batch()
    for (const act of activities.slice(i, i + 400)) {
      batch.set(adminDb.collection(CRM_ACTIVITIES).doc(act.activityId), {
        activityId: act.activityId, contactId: act.contactId, organizerUid: uid,
        type: act.type, entityId: act.entityId, metadata: act.metadata,
        createdAt: act.createdAt, recordedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    }
    await batch.commit()
  }

  return { contacts: written, activities: activities.length, scanned: { registrations: nReg, donations: nDon, refunds: nRef, certificates: nCert, broadcasts: nBroadcast } }
}
