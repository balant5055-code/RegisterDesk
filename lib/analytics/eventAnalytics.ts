// Per-event analytics — server-only. Derives everything from EXISTING data
// (registrations, registrationCounters, platformTransactions, emailLogs,
// scheduledReminders, certificates, organizerRevenueWallets). Bounded to a
// SINGLE event (≤ REPORT_ROW_CAP registrations) — no platform-wide scan. Where a
// data source doesn't exist (traffic sources, cert verifications, SMS) the result
// flags it so the UI shows "no data" instead of a fabricated number.

import { adminDb } from '@/lib/firebase/admin'
import { COLLECTIONS as CERT_COLLECTIONS } from '@/lib/certificates/constants'

const CAP = 5000

export interface Point { label: string; value: number }

export interface EventAnalytics {
  eventId:        string
  eventName:      string
  lifecycleStatus: string | null
  publishedAt:    string | null
  kpis: {
    revenuePaise: number; registrations: number; paid: number; free: number; pending: number
    cancelled: number; refunded: number; checkedIn: number
    conversionPct: number; capacity: number | null; capacityUsedPct: number; remaining: number | null
    communicationSpendPaise: number
  }
  registrationsByDay: Point[]
  revenueByDay:       Point[]
  paymentStatus:      Point[]
  passSales:          Point[]
  passRevenue:        Point[]
  couponUsage:        Point[]
  couponDiscountPaise: number
  checkInsByDay:      Point[]
  funnel:             Point[]
  financial: {
    grossPaise: number; platformFeePaise: number; gstPaise: number; gatewayFeePaise: number
    netPaise: number; refundsPaise: number; communicationCostPaise: number; profitEstimatePaise: number
    settlement: { availablePaise: number; pendingPaise: number; settledPaise: number }
  }
  communication: { sent: number; failed: number; delivered: number; costPaise: number; byTemplate: Point[] }
  reminders:     { scheduled: number; sent: number; failed: number; recipients: number }
  certificates:  { issued: number; downloaded: number }
  dataFlags:     { trafficSources: 'no_data'; certificateVerifications: 'no_data'; sms: 'no_data' }
}

const tsMs = (v: unknown): number | null => {
  if (v && typeof (v as { toMillis?: () => number }).toMillis === 'function') return (v as { toMillis: () => number }).toMillis()
  if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') return (v as { toDate: () => Date }).toDate().getTime()
  return null
}
const tsISO = (v: unknown): string | null => { const ms = tsMs(v); return ms == null ? null : new Date(ms).toISOString() }

function lastNDays(n: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i)
    out.push({ key: d.toISOString().slice(0, 10), label: `${d.getMonth() + 1}/${d.getDate()}` })
  }
  return out
}

export async function getEventAnalytics(eventId: string): Promise<{ analytics: EventAnalytics; organizerUid: string } | null> {
  const evSnap = await adminDb.doc(`events/${eventId}`).get()
  if (!evSnap.exists) return null
  const ev = evSnap.data() as Record<string, unknown>
  const organizerUid = (typeof ev.uid === 'string' ? ev.uid : (typeof ev.organizerUid === 'string' ? ev.organizerUid : '')) as string
  const eventName = (((ev.eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined)?.name as string) || eventId
  const capacity = typeof ev.totalCapacity === 'number' ? ev.totalCapacity : null

  // ── Registrations (bounded to this event) ──
  const regSnap = await adminDb.collection('registrations').where('eventSlug', '==', eventId).limit(CAP).get()

  const days = lastNDays(30)
  const regByDay = new Map<string, number>(days.map(d => [d.key, 0]))
  const revByDay = new Map<string, number>(days.map(d => [d.key, 0]))
  const checkByDay = new Map<string, number>(days.map(d => [d.key, 0]))
  const passCount = new Map<string, number>()
  const passRev   = new Map<string, number>()
  const couponCount = new Map<string, number>()
  const payStatus = new Map<string, number>()

  let revenuePaise = 0, paid = 0, free = 0, pending = 0, cancelled = 0, refunded = 0, confirmed = 0, checkedIn = 0
  let refundsPaise = 0, couponDiscountPaise = 0

  for (const d of regSnap.docs) {
    const r = d.data() as Record<string, unknown>
    const status = String(r.status ?? '')
    const pay = String(r.paymentStatus ?? '')
    const amount = typeof r.amount === 'number' ? r.amount : 0
    const passName = (r.passName as string) || 'General'

    if (status === 'cancelled') cancelled++
    if (status === 'confirmed') confirmed++
    payStatus.set(pay || 'unknown', (payStatus.get(pay || 'unknown') ?? 0) + 1)

    if (pay === 'paid') { paid++; revenuePaise += amount; passRev.set(passName, (passRev.get(passName) ?? 0) + amount) }
    else if (pay === 'not_required' || amount === 0) free++
    else if (pay === 'pending') pending++
    if (pay === 'refunded' || pay === 'refund_pending') { refunded++; refundsPaise += (typeof r.refundAmount === 'number' ? r.refundAmount : amount) }

    passCount.set(passName, (passCount.get(passName) ?? 0) + 1)
    if (typeof r.couponCode === 'string' && r.couponCode) {
      couponCount.set(r.couponCode, (couponCount.get(r.couponCode) ?? 0) + 1)
      couponDiscountPaise += typeof r.discountAmount === 'number' ? r.discountAmount : 0
    }

    const regMs = tsMs(r.registeredAt) ?? tsMs(r.createdAt)
    if (regMs != null) {
      const key = new Date(regMs).toISOString().slice(0, 10)
      if (regByDay.has(key)) regByDay.set(key, (regByDay.get(key) ?? 0) + 1)
      if (pay === 'paid' && revByDay.has(key)) revByDay.set(key, (revByDay.get(key) ?? 0) + amount)
    }
    if (r.checkedIn === true) {
      checkedIn++
      const ci = tsMs(r.checkedInAt)
      if (ci != null) { const k = new Date(ci).toISOString().slice(0, 10); if (checkByDay.has(k)) checkByDay.set(k, (checkByDay.get(k) ?? 0) + 1) }
    }
  }

  const registrations = regSnap.size
  const conversionPct = registrations > 0 ? Math.round((paid / registrations) * 100) : 0
  const capacityUsedPct = capacity ? Math.min(100, Math.round((confirmed / capacity) * 100)) : 0
  const remaining = capacity ? Math.max(0, capacity - confirmed) : null

  // ── Financial (platformTransactions for this event) — resilient to schema/index ──
  let grossPaise = revenuePaise, platformFeePaise = 0, gstPaise = 0, gatewayFeePaise = 0, netPaise = revenuePaise
  try {
    const ptx = await adminDb.collection('platformTransactions').where('entityId', '==', eventId).limit(CAP).get()
    if (!ptx.empty) {
      let g = 0, pf = 0, gst = 0, gw = 0, net = 0
      for (const t of ptx.docs) {
        const x = t.data() as Record<string, number>
        g   += x.grossAmountPaise ?? 0
        pf  += x.platformFeeBasePaise ?? 0
        gst += x.platformFeeGstPaise ?? 0
        gw  += x.gatewayFeeActualPaise ?? x.gatewayFeeEstimatePaise ?? 0
        net += x.netSettlementPaise ?? 0
      }
      grossPaise = g || revenuePaise; platformFeePaise = pf; gstPaise = gst; gatewayFeePaise = gw; netPaise = net || revenuePaise
    }
  } catch { /* missing index / schema — keep registration-derived gross */ }

  // ── Communication (emailLogs for this event) ──
  let commSent = 0, commFailed = 0, commDelivered = 0, commCostPaise = 0
  const commByTemplate = new Map<string, number>()
  try {
    const logs = await adminDb.collection('emailLogs').where('eventId', '==', eventId).limit(CAP).get()
    for (const l of logs.docs) {
      const x = l.data() as Record<string, unknown>
      const st = String(x.status ?? '')
      if (st === 'sent') commSent++; else if (st === 'delivered') { commSent++; commDelivered++ } else if (st === 'failed') commFailed++
      commCostPaise += typeof x.costPaise === 'number' ? x.costPaise : 0
      const tk = String(x.templateKey ?? 'other')
      commByTemplate.set(tk, (commByTemplate.get(tk) ?? 0) + 1)
    }
  } catch { /* index */ }

  // ── Reminders (scheduledReminders for this event) ──
  let remScheduled = 0, remSent = 0, remFailed = 0, remRecipients = 0
  try {
    const rem = await adminDb.collection('scheduledReminders').where('eventId', '==', eventId).limit(500).get()
    for (const d of rem.docs) {
      const x = d.data() as Record<string, unknown>
      const st = String(x.status ?? '')
      if (st === 'scheduled' || st === 'sending') remScheduled++
      else if (st === 'sent' || st === 'partial') remSent++
      else if (st === 'failed') remFailed++
      const c = x.counts as { recipients?: number } | undefined
      remRecipients += c?.recipients ?? 0
    }
  } catch { /* index */ }

  // ── Certificates (the live `certificates` collection — the generation pipeline
  //    writes ONLY here; the legacy `certificateRecords` is never populated) ──
  let certIssued = 0, certDownloaded = 0
  try {
    const certs = await adminDb.collection(CERT_COLLECTIONS.CERTIFICATES).where('eventId', '==', eventId).limit(CAP).get()
    for (const d of certs.docs) {
      certIssued++
      // Count DISTINCT certificates downloaded at least once (people), not total
      // download events — so the funnel stage stays monotonic (never exceeds
      // "Checked in").
      const dc = (d.data() as { downloadCount?: number }).downloadCount
      if (typeof dc === 'number' && dc > 0) certDownloaded++
    }
  } catch { /* index */ }

  // ── Settlement rollup (workspace revenue wallet) ──
  let settlement = { availablePaise: 0, pendingPaise: 0, settledPaise: 0 }
  try {
    const rw = await adminDb.doc(`organizerRevenueWallets/${organizerUid}`).get()
    if (rw.exists) {
      const x = rw.data() as Record<string, number>
      settlement = { availablePaise: x.availablePaise ?? 0, pendingPaise: x.pendingPaise ?? 0, settledPaise: x.settledPaise ?? 0 }
    }
  } catch { /* ignore */ }

  const profitEstimatePaise = netPaise - commCostPaise - refundsPaise

  const toPoints = (m: Map<string, number>, sortDesc = true): Point[] => {
    const arr = [...m.entries()].map(([label, value]) => ({ label, value }))
    if (sortDesc) arr.sort((a, b) => b.value - a.value)
    return arr
  }

  const analytics: EventAnalytics = {
    eventId, eventName,
    lifecycleStatus: typeof ev.lifecycleStatus === 'string' ? ev.lifecycleStatus : null,
    publishedAt: tsISO(ev.publishedAt),
    kpis: {
      revenuePaise, registrations, paid, free, pending, cancelled, refunded, checkedIn,
      conversionPct, capacity, capacityUsedPct, remaining,
      communicationSpendPaise: commCostPaise,
    },
    registrationsByDay: days.map(d => ({ label: d.label, value: regByDay.get(d.key) ?? 0 })),
    revenueByDay:       days.map(d => ({ label: d.label, value: revByDay.get(d.key) ?? 0 })),
    paymentStatus:      toPoints(payStatus),
    passSales:          toPoints(passCount).slice(0, 8),
    passRevenue:        toPoints(passRev).slice(0, 8),
    couponUsage:        toPoints(couponCount).slice(0, 8),
    couponDiscountPaise,
    checkInsByDay:      days.map(d => ({ label: d.label, value: checkByDay.get(d.key) ?? 0 })),
    funnel: [
      { label: 'Registered', value: registrations },
      { label: 'Confirmed',  value: confirmed },
      { label: 'Paid',       value: paid },
      { label: 'Checked in', value: checkedIn },
      { label: 'Certificate downloaded', value: certDownloaded },
    ],
    financial: {
      grossPaise, platformFeePaise, gstPaise, gatewayFeePaise, netPaise, refundsPaise,
      communicationCostPaise: commCostPaise, profitEstimatePaise, settlement,
    },
    communication: { sent: commSent, failed: commFailed, delivered: commDelivered, costPaise: commCostPaise, byTemplate: toPoints(commByTemplate).slice(0, 8) },
    reminders: { scheduled: remScheduled, sent: remSent, failed: remFailed, recipients: remRecipients },
    certificates: { issued: certIssued, downloaded: certDownloaded },
    dataFlags: { trafficSources: 'no_data', certificateVerifications: 'no_data', sms: 'no_data' },
  }

  return { analytics, organizerUid }
}
