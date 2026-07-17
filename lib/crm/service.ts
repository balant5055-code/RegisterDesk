// CRM ingestion service (server-only). recordCrmEvent is the single atomic,
// idempotent writer used by every live emit point. Counters increment EXACTLY
// ONCE per source event: each activity has a deterministic id, and the counter
// update only applies when that activity doc didn't already exist (checked inside
// the same transaction). Replays / retries / re-runs are therefore safe.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { CRM_CONTACTS, CRM_ACTIVITIES, type CrmActivityType, type CrmLastEvent, type CrmLastDonation } from '@/lib/crm/types'
import { normalizeEmail, contactIdFor, activityIdFor } from '@/lib/crm/identity'

interface RecordParams {
  organizerUid: string
  email:        string
  name?:        string
  phone?:       string | null
  type:         CrmActivityType
  entityId:     string
  occurredAt:   number                         // epoch ms
  counters?:    Record<string, number>         // field → increment
  metadata?:    Record<string, unknown>
  lastEvent?:   CrmLastEvent
  lastDonation?: CrmLastDonation
}

/** Atomic, idempotent contact upsert + activity append. Never throws to callers
 *  that fire-and-forget; returns false when there is no usable identity. */
export async function recordCrmEvent(p: RecordParams): Promise<boolean> {
  const email = normalizeEmail(p.email)
  if (!email) return false                     // no identity → not a contact

  const contactId = contactIdFor(p.organizerUid, email)
  const activityId = activityIdFor(contactId, p.type, p.entityId)
  const contactRef = adminDb.collection(CRM_CONTACTS).doc(contactId)
  const activityRef = adminDb.collection(CRM_ACTIVITIES).doc(activityId)

  await adminDb.runTransaction(async tx => {
    const [actSnap, contactSnap] = await Promise.all([tx.get(activityRef), tx.get(contactRef)])
    if (actSnap.exists) return                 // already recorded → exactly-once

    const exists = contactSnap.exists
    const c = (contactSnap.data() ?? {}) as Record<string, unknown>
    const prevLastSeen = typeof c.lastSeenAt === 'number' ? c.lastSeenAt : 0
    const isNewest = p.occurredAt >= prevLastSeen

    const update: Record<string, unknown> = {
      organizerUid: p.organizerUid,
      email,
      lastSeenAt: Math.max(prevLastSeen, p.occurredAt),
      updatedAt: FieldValue.serverTimestamp(),
    }
    if (!exists) {
      update.contactId = contactId
      update.createdAt = FieldValue.serverTimestamp()
      update.firstSeenAt = p.occurredAt
      update.tags = []
      update.notes = ''
      update.name = p.name ?? ''
      update.phone = p.phone ?? null
    } else {
      update.firstSeenAt = Math.min(typeof c.firstSeenAt === 'number' ? c.firstSeenAt : p.occurredAt, p.occurredAt)
      // Most recent non-empty name/phone wins; also fill if missing.
      if (p.name && (isNewest || !c.name)) update.name = p.name
      if (p.phone && (isNewest || !c.phone)) update.phone = p.phone
    }

    // Counters — increment treats a missing field as 0, so no init needed.
    for (const [field, by] of Object.entries(p.counters ?? {})) {
      if (by !== 0) update[field] = FieldValue.increment(by)
    }

    // lastEvent / lastDonation only advance forward in time.
    if (p.lastEvent && p.occurredAt >= ((c.lastEvent as CrmLastEvent | undefined)?.at ?? 0)) update.lastEvent = p.lastEvent
    if (p.lastDonation && p.occurredAt >= ((c.lastDonation as CrmLastDonation | undefined)?.at ?? 0)) update.lastDonation = p.lastDonation

    tx.set(contactRef, update, { merge: true })
    tx.set(activityRef, {
      activityId, contactId, organizerUid: p.organizerUid,
      type: p.type, entityId: p.entityId,
      metadata: p.metadata ?? {},
      createdAt: p.occurredAt,
      recordedAt: FieldValue.serverTimestamp(),
    })
  })
  return true
}

// ─── Thin, fire-and-forget helpers used at emit points ─────────────────────────

export function crmRecordRegistration(a: { organizerUid: string; email: string; name?: string; phone?: string | null; registrationId: string; eventSlug: string; eventName: string }): void {
  void recordCrmEvent({
    organizerUid: a.organizerUid, email: a.email, name: a.name, phone: a.phone,
    type: 'registration_created', entityId: a.registrationId, occurredAt: Date.now(),
    counters: { totalRegistrations: 1 },
    metadata: { eventSlug: a.eventSlug, eventName: a.eventName },
    lastEvent: { name: a.eventName, slug: a.eventSlug, at: Date.now() },
  }).catch(() => {})
}

export function crmRecordCheckIn(a: { organizerUid: string; email: string; name?: string; registrationId: string; eventSlug: string; eventName?: string }): void {
  void recordCrmEvent({
    organizerUid: a.organizerUid, email: a.email, name: a.name,
    type: 'checked_in', entityId: a.registrationId, occurredAt: Date.now(),
    counters: { totalCheckIns: 1 },
    metadata: { eventSlug: a.eventSlug, eventName: a.eventName ?? '' },
    lastEvent: a.eventName ? { name: a.eventName, slug: a.eventSlug, at: Date.now() } : undefined,
  }).catch(() => {})
}

export function crmRecordDonation(a: { organizerUid: string; email: string; name?: string; phone?: string | null; donationId: string; campaignSlug: string; campaignTitle: string; amountPaise: number }): void {
  void recordCrmEvent({
    organizerUid: a.organizerUid, email: a.email, name: a.name, phone: a.phone,
    type: 'donation_created', entityId: a.donationId, occurredAt: Date.now(),
    counters: { totalDonations: 1, totalDonationAmountPaise: a.amountPaise },
    metadata: { campaignSlug: a.campaignSlug, campaignTitle: a.campaignTitle, amountPaise: a.amountPaise },
    lastDonation: { campaign: a.campaignTitle, amountPaise: a.amountPaise, at: Date.now() },
  }).catch(() => {})
}

export function crmRecordCertificate(a: { organizerUid: string; email: string; name?: string; certificateId: string; eventSlug: string }): void {
  void recordCrmEvent({
    organizerUid: a.organizerUid, email: a.email, name: a.name,
    type: 'certificate_issued', entityId: a.certificateId, occurredAt: Date.now(),
    metadata: { eventSlug: a.eventSlug },
  }).catch(() => {})
}

/** Refund: resolves the donor email from the donation, then records the activity. */
export function crmRecordRefund(a: { organizerUid: string; donationId: string; refundId: string; amountPaise: number }): void {
  void (async () => {
    const snap = await adminDb.collection('donations').doc(a.donationId).get()
    const d = snap.data() as { donorEmail?: string; donorName?: string } | undefined
    if (!d?.donorEmail) return
    await recordCrmEvent({
      organizerUid: a.organizerUid, email: d.donorEmail, name: d.donorName,
      type: 'donation_refunded', entityId: a.refundId, occurredAt: Date.now(),
      metadata: { donationId: a.donationId, amountPaise: a.amountPaise },
    })
  })().catch(() => {})
}

/** Broadcast: post-send batch (recipients already in memory). No counter — a
 *  timeline activity only. Uses recordCrmEvent per recipient (idempotent). */
export function crmRecordBroadcastBatch(a: { organizerUid: string; campaignId: string; eventSlug: string; eventName: string; recipients: { email: string; name?: string }[] }): void {
  void (async () => {
    for (const r of a.recipients) {
      await recordCrmEvent({
        organizerUid: a.organizerUid, email: r.email, name: r.name,
        type: 'broadcast_sent', entityId: a.campaignId, occurredAt: Date.now(),
        metadata: { campaignId: a.campaignId, eventSlug: a.eventSlug, eventName: a.eventName },
      }).catch(() => {})
    }
  })().catch(() => {})
}
