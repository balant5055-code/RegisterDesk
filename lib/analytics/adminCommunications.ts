// Platform communications analytics — server-only. Aggregation-based (count()/sum()
// + one bounded recent scan for top lists). Reuses the existing collections
// (emailLogs, broadcastCampaigns, scheduledReminders, communicationUsage) — no new
// storage, no full-platform load.

import { AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

export interface Point { label: string; value: number }

export interface AdminCommunications {
  messages:   { total: number; sent: number; delivered: number; failed: number; skipped: number; queued: number; whatsapp: number }
  broadcasts: { total: number; sent: number; scheduled: number; costPaise: number }
  reminders:  { total: number; scheduled: number; sent: number; failed: number; cancelled: number }
  spend:      { totalPaise: number; byChannel: Point[] }
  topOrganizers: { uid: string; name: string; count: number; costPaise: number }[]
  topEvents:     { eventId: string; name: string; count: number; costPaise: number }[]
}

type Query = FirebaseFirestore.Query
async function countOf(q: Query): Promise<number> { try { return (await q.count().get()).data().count } catch { return 0 } }
async function sumOf(q: Query, field: string): Promise<number> { try { return (await q.aggregate({ s: AggregateField.sum(field) }).get()).data().s ?? 0 } catch { return 0 } }

export async function getAdminCommunications(): Promise<AdminCommunications> {
  const emailLogs  = adminDb.collection('emailLogs')
  const broadcasts = adminDb.collection('broadcastCampaigns')
  const reminders  = adminDb.collection('scheduledReminders')
  const usageCol   = adminDb.collection('communicationUsage')

  const [
    total, sent, delivered, failed, skipped, queued, whatsapp,
    bTotal, bSent, bScheduled, bCost,
    rTotal, rScheduled, rSent, rFailed, rCancelled,
    spendTotal,
  ] = await Promise.all([
    countOf(emailLogs), countOf(emailLogs.where('status', '==', 'sent')), countOf(emailLogs.where('status', '==', 'delivered')),
    countOf(emailLogs.where('status', '==', 'failed')), countOf(emailLogs.where('status', '==', 'skipped')),
    countOf(emailLogs.where('status', '==', 'queued')), countOf(emailLogs.where('channel', '==', 'whatsapp')),
    countOf(broadcasts), countOf(broadcasts.where('status', '==', 'sent')), countOf(broadcasts.where('status', '==', 'scheduled')),
    sumOf(broadcasts, 'actualCostPaise'),
    countOf(reminders), countOf(reminders.where('status', '==', 'scheduled')), countOf(reminders.where('status', '==', 'sent')),
    countOf(reminders.where('status', '==', 'failed')), countOf(reminders.where('status', '==', 'cancelled')),
    sumOf(usageCol, 'costPaise'),
  ])

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
    messages:   { total, sent, delivered, failed, skipped, queued, whatsapp },
    broadcasts: { total: bTotal, sent: bSent, scheduled: bScheduled, costPaise: bCost },
    reminders:  { total: rTotal, scheduled: rScheduled, sent: rSent, failed: rFailed, cancelled: rCancelled },
    spend:      { totalPaise: spendTotal, byChannel: [...byChannel.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value) },
    topOrganizers: topOrgUids.map(([uid, a]) => ({ uid, name: orgName.get(uid) || uid, count: a.count, costPaise: a.cost })),
    topEvents:     topEvIds.map(([eventId, a]) => ({ eventId, name: evName.get(eventId) || eventId, count: a.count, costPaise: a.cost })),
  }
}
