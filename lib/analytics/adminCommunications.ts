// Platform communications analytics — server-only. Aggregation-based (count()/sum()
// + one bounded recent scan for top lists). Reuses the existing collections
// (emailLogs, broadcastCampaigns, scheduledReminders, communicationUsage) — no new
// storage, no full-platform load.

import { AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

export interface Point { label: string; value: number }

export interface AdminCommunications {
  /**
   * RD-INTEG — status counts with ONE meaning each:
   *   accepted  — status 'sent': accepted by the provider, no delivery confirmation (yet)
   *   sent      — accepted + delivered: everything SUBMITTED to a provider (a delivered message was sent)
   *   delivered — confirmed by the provider (email webhooks AND WhatsApp receipts)
   *   failed    — rejected / bounced, EXCLUDING timeouts
   *   unknown   — timed out: the provider never answered (delivery unknown, not failed)
   * `unavailable` names every figure whose aggregate could not be read (shown as "—", never 0).
   */
  messages:   { total: number; sent: number; accepted: number; delivered: number; failed: number; unknown: number; skipped: number; queued: number; whatsapp: number; unavailable: string[] }
  broadcasts: { total: number; sent: number; scheduled: number; costPaise: number }
  reminders:  { total: number; scheduled: number; sent: number; failed: number; cancelled: number }
  spend:      { totalPaise: number; byChannel: Point[] }
  topOrganizers: { uid: string; name: string; count: number; costPaise: number }[]
  topEvents:     { eventId: string; name: string; count: number; costPaise: number }[]
}

type Query = FirebaseFirestore.Query
async function countOf(q: Query): Promise<number> { try { return (await q.count().get()).data().count } catch { return 0 } }
/** RD-INTEG — a count that may not have been measured (null), so it is never reported as 0. */
async function countOrNull(q: Query): Promise<number | null> { try { return (await q.count().get()).data().count } catch { return null } }
async function sumOf(q: Query, field: string): Promise<number> { try { return (await q.aggregate({ s: AggregateField.sum(field) }).get()).data().s ?? 0 } catch { return 0 } }

export async function getAdminCommunications(): Promise<AdminCommunications> {
  const emailLogs  = adminDb.collection('emailLogs')
  const broadcasts = adminDb.collection('broadcastCampaigns')
  const reminders  = adminDb.collection('scheduledReminders')
  const usageCol   = adminDb.collection('communicationUsage')

  const [
    totalM, acceptedM, deliveredM, failedAllM, unknownM, skippedM, queuedM, whatsappM,
    bTotal, bSent, bScheduled, bCost,
    rTotal, rScheduled, rSent, rFailed, rCancelled,
    spendTotal,
  ] = await Promise.all([
    countOrNull(emailLogs), countOrNull(emailLogs.where('status', '==', 'sent')), countOrNull(emailLogs.where('status', '==', 'delivered')),
    countOrNull(emailLogs.where('status', '==', 'failed')),
    countOrNull(emailLogs.where('status', '==', 'failed').where('deliveryUnknown', '==', true)),
    countOrNull(emailLogs.where('status', '==', 'skipped')),
    countOrNull(emailLogs.where('status', '==', 'queued')), countOrNull(emailLogs.where('channel', '==', 'whatsapp')),
    countOf(broadcasts), countOf(broadcasts.where('status', '==', 'sent')), countOf(broadcasts.where('status', '==', 'scheduled')),
    sumOf(broadcasts, 'actualCostPaise'),
    countOf(reminders), countOf(reminders.where('status', '==', 'scheduled')), countOf(reminders.where('status', '==', 'sent')),
    countOf(reminders.where('status', '==', 'failed')), countOf(reminders.where('status', '==', 'cancelled')),
    sumOf(usageCol, 'costPaise'),
  ])

  const measured = { total: totalM, accepted: acceptedM, delivered: deliveredM, failed: failedAllM, unknown: unknownM, skipped: skippedM, queued: queuedM, whatsapp: whatsappM }
  const unavailable = Object.entries(measured).filter(([, v]) => v === null).map(([k]) => k)
  const v = (x: number | null) => x ?? 0
  const accepted = v(acceptedM), delivered = v(deliveredM), unknown = v(unknownM)
  const messages: AdminCommunications['messages'] = {
    total: v(totalM), accepted, delivered,
    sent: accepted + delivered,
    failed: Math.max(0, v(failedAllM) - unknown), unknown,
    skipped: v(skippedM), queued: v(queuedM), whatsapp: v(whatsappM),
    unavailable: [...unavailable, ...(acceptedM === null || deliveredM === null ? ['sent'] : [])],
  }

  // ── Spend by channel + top organizers/events (one bounded recent scan) ──
  const byChannel = new Map<string, number>()
  const orgAgg = new Map<string, { count: number; cost: number }>()
  const evAgg  = new Map<string, { count: number; cost: number }>()
  try {
    const snap = await usageCol.orderBy('createdAt', 'desc').limit(3000).get()
    for (const d of snap.docs) {
      const u = d.data() as Record<string, unknown>
      const cost = typeof u.costPaise === 'number' ? u.costPaise : 0
      const ch = String(u.channel ?? 'email'); byChannel.set(ch, (byChannel.get(ch) ?? 0) + cost)
      const org = String(u.organizerUid ?? ''); if (org) { const a = orgAgg.get(org) ?? { count: 0, cost: 0 }; a.count++; a.cost += cost; orgAgg.set(org, a) }
      const ev = String(u.eventSlug ?? u.eventId ?? ''); if (ev) { const a = evAgg.get(ev) ?? { count: 0, cost: 0 }; a.count++; a.cost += cost; evAgg.set(ev, a) }
    }
  } catch { /* index — spend-by-channel + top lists degrade to empty */ }

  const topOrgUids = [...orgAgg.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10)
  const topEvIds   = [...evAgg.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10)
  const [orgDocs, evDocs] = await Promise.all([
    topOrgUids.length ? adminDb.getAll(...topOrgUids.map(([u]) => adminDb.doc(`users/${u}`))) : Promise.resolve([]),
    topEvIds.length ? adminDb.getAll(...topEvIds.map(([e]) => adminDb.doc(`events/${e}`))) : Promise.resolve([]),
  ])
  const orgName = new Map<string, string>()
  orgDocs.forEach((d, i) => { if (d.exists) orgName.set(topOrgUids[i][0], (d.data() as { name?: string; organizationName?: string }).name || (d.data() as { organizationName?: string }).organizationName || topOrgUids[i][0]) })
  const evName = new Map<string, string>()
  evDocs.forEach((d, i) => { if (d.exists) evName.set(topEvIds[i][0], (((d.data() as Record<string, unknown>).eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined)?.name as string || topEvIds[i][0]) })

  return {
    messages,
    broadcasts: { total: bTotal, sent: bSent, scheduled: bScheduled, costPaise: bCost },
    reminders:  { total: rTotal, scheduled: rScheduled, sent: rSent, failed: rFailed, cancelled: rCancelled },
    spend:      { totalPaise: spendTotal, byChannel: [...byChannel.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value) },
    topOrganizers: topOrgUids.map(([uid, a]) => ({ uid, name: orgName.get(uid) || uid, count: a.count, costPaise: a.cost })),
    topEvents:     topEvIds.map(([eventId, a]) => ({ eventId, name: evName.get(eventId) || eventId, count: a.count, costPaise: a.cost })),
  }
}
