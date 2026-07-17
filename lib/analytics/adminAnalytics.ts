// Platform analytics — server-only. Uses Firestore AGGREGATION (count()/sum()) and
// bounded orderBy-limit queries so it NEVER loads all registrations/transactions.
// Revenue comes from the materialized organizerRevenueWallets rollups; counts come
// from aggregate queries; top lists from indexed orderBy+limit.

import { AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

export interface Point { label: string; value: number }

export interface AdminAnalytics {
  platform: {
    organizers: number; publishedEvents: number; campaigns: number; totalRegistrations: number
    lifetimeGrossPaise: number; lifetimeFeesPaise: number; lifetimeNetPaise: number; pendingSettlementPaise: number
  }
  topOrganizers: { uid: string; name: string; grossPaise: number; netPaise: number }[]
  topEvents:     { eventId: string; name: string; registrations: number }[]
  licenseSales:  {
    paidCount: number; refundedCount: number; revenuePaise: number; byTier: Point[]
    // EA-4 S2 — license-coupon metrics
    discountGivenPaise: number   // revenue "lost" to coupons
    couponRedemptions:  number   // paid orders that used a coupon
    topCoupons:         Point[]   // code → redemptions
    byCampaign:         Point[]   // campaign → redemptions
  }
  communication: { totalSent: number; totalFailed: number }
  reminders:     { total: number; sent: number; failed: number }
  growth:        { eventsByDay: Point[] }
}

type Query = FirebaseFirestore.Query

async function countOf(q: Query): Promise<number> {
  try { return (await q.count().get()).data().count } catch { return 0 }
}
async function sumOf(q: Query, field: string): Promise<number> {
  try { return (await q.aggregate({ s: AggregateField.sum(field) }).get()).data().s ?? 0 } catch { return 0 }
}

function lastNDays(n: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i)
    out.push({ key: d.toISOString().slice(0, 10), label: `${d.getMonth() + 1}/${d.getDate()}` })
  }
  return out
}
const tsMs = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : null

export async function getAdminAnalytics(): Promise<AdminAnalytics> {
  const events        = adminDb.collection('events')
  const revenueWallets = adminDb.collection('organizerRevenueWallets')

  // ── Platform totals (aggregation only) ──
  const [organizers, publishedEvents, campaigns, totalRegistrations,
    lifetimeGrossPaise, lifetimeFeesPaise, lifetimeNetPaise, pendingSettlementPaise] = await Promise.all([
    // Organizers = accounts with role 'organizer' (excludes admins / other roles).
    countOf(adminDb.collection('users').where('role', '==', 'organizer')),
    countOf(events.where('lifecycleStatus', '==', 'published')),
    countOf(adminDb.collection('donationCampaigns')),
    countOf(adminDb.collection('registrations')),
    sumOf(revenueWallets, 'lifetimeGrossPaise'),
    sumOf(revenueWallets, 'lifetimeFeesPaise'),
    sumOf(revenueWallets, 'lifetimeNetPaise'),
    sumOf(revenueWallets, 'pendingPaise'),
  ])

  // ── Top organizers by lifetime revenue (bounded) ──
  let topOrganizers: AdminAnalytics['topOrganizers'] = []
  try {
    const snap = await revenueWallets.orderBy('lifetimeGrossPaise', 'desc').limit(10).get()
    const uids = snap.docs.map(d => d.id)
    const users = uids.length ? await adminDb.getAll(...uids.map(u => adminDb.doc(`users/${u}`))) : []
    const nameMap = new Map<string, string>()
    users.forEach((u, i) => { if (u.exists) nameMap.set(uids[i], (u.data() as { name?: string; organizationName?: string }).name || (u.data() as { organizationName?: string }).organizationName || uids[i]) })
    topOrganizers = snap.docs.map(d => {
      const x = d.data() as Record<string, number>
      return { uid: d.id, name: nameMap.get(d.id) || d.id, grossPaise: x.lifetimeGrossPaise ?? 0, netPaise: x.lifetimeNetPaise ?? 0 }
    })
  } catch { /* index */ }

  // ── Top events by registrations (bounded — from counters) ──
  let topEvents: AdminAnalytics['topEvents'] = []
  try {
    const snap = await adminDb.collection('registrationCounters').orderBy('totalCount', 'desc').limit(10).get()
    const ids = snap.docs.map(d => d.id)
    const evs = ids.length ? await adminDb.getAll(...ids.map(id => adminDb.doc(`events/${id}`))) : []
    const nameMap = new Map<string, string>()
    evs.forEach((e, i) => { if (e.exists) nameMap.set(ids[i], (((e.data() as Record<string, unknown>).eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined)?.name as string || ids[i]) })
    topEvents = snap.docs.map(d => ({ eventId: d.id, name: nameMap.get(d.id) || d.id, registrations: (d.data() as { totalCount?: number }).totalCount ?? 0 }))
  } catch { /* index */ }

  // ── License sales ──
  const licenseOrders = adminDb.collection('licenseOrders')
  const [paidCount, refundedCount, revenuePaise, discountGivenPaise] = await Promise.all([
    countOf(licenseOrders.where('status', '==', 'paid')),
    countOf(licenseOrders.where('status', '==', 'refunded')),
    sumOf(licenseOrders.where('status', '==', 'paid'), 'amountPaise'),
    sumOf(licenseOrders.where('status', '==', 'paid'), 'discountPaise'),   // EA-4 S2 revenue lost
  ])
  const byTier    = new Map<string, number>()
  const byCoupon  = new Map<string, number>()
  const byCampaign = new Map<string, number>()
  let couponRedemptions = 0
  try {
    const paid = await licenseOrders.where('status', '==', 'paid').limit(2000).get()
    for (const d of paid.docs) {
      const o = d.data() as { tier?: string; couponCode?: string | null; campaign?: string | null }
      byTier.set(String(o.tier ?? 'unknown'), (byTier.get(String(o.tier ?? 'unknown')) ?? 0) + 1)
      if (o.couponCode) {
        couponRedemptions++
        byCoupon.set(o.couponCode, (byCoupon.get(o.couponCode) ?? 0) + 1)
        const camp = o.campaign || 'none'
        byCampaign.set(camp, (byCampaign.get(camp) ?? 0) + 1)
      }
    }
  } catch { /* index */ }
  const toPoints = (m: Map<string, number>): Point[] =>
    [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)

  // ── Communication + reminder usage (counts only) ──
  const emailLogs = adminDb.collection('emailLogs')
  const reminders = adminDb.collection('scheduledReminders')
  const [totalSent, totalFailed, remTotal, remSent, remFailed] = await Promise.all([
    countOf(emailLogs.where('status', '==', 'sent')),
    countOf(emailLogs.where('status', '==', 'failed')),
    countOf(reminders),
    countOf(reminders.where('status', '==', 'sent')),
    countOf(reminders.where('status', '==', 'failed')),
  ])

  // ── Growth: published events per day (bounded) ──
  const days = lastNDays(30)
  const byDay = new Map<string, number>(days.map(d => [d.key, 0]))
  try {
    const snap = await events.where('lifecycleStatus', '==', 'published').orderBy('publishedAt', 'desc').limit(500).get()
    for (const d of snap.docs) {
      const ms = tsMs((d.data() as Record<string, unknown>).publishedAt)
      if (ms == null) continue
      const key = new Date(ms).toISOString().slice(0, 10)
      if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + 1)
    }
  } catch { /* index */ }

  return {
    platform: { organizers, publishedEvents, campaigns, totalRegistrations, lifetimeGrossPaise, lifetimeFeesPaise, lifetimeNetPaise, pendingSettlementPaise },
    topOrganizers, topEvents,
    licenseSales: {
      paidCount, refundedCount, revenuePaise, byTier: toPoints(byTier),
      discountGivenPaise, couponRedemptions,
      topCoupons: toPoints(byCoupon).slice(0, 10), byCampaign: toPoints(byCampaign),
    },
    communication: { totalSent, totalFailed },
    reminders: { total: remTotal, sent: remSent, failed: remFailed },
    growth: { eventsByDay: days.map(d => ({ label: d.label, value: byDay.get(d.key) ?? 0 })) },
  }
}
