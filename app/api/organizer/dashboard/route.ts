// GET /api/organizer/dashboard
//
// Single aggregation endpoint for the organizer dashboard.
// Runs all Firestore reads in parallel and returns a structured payload.
// Called once on page load; the page derives all sections from this response.

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb }        from '@/lib/firebase/admin'
import { deriveLifecycleStatus }     from '@/lib/events/lifecycle'
import type { RegistrationDocument } from '@/lib/registrations/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const PLATFORM_FEE_RATE = 0.02   // 2 % of gross revenue

// ─── Utilities ────────────────────────────────────────────────────────────────

function tsToDate(ts: unknown): Date | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate()
  }
  return null
}

function isToday(ts: unknown): boolean {
  const d = tsToDate(ts)
  if (!d) return false
  const n = new Date()
  return d.getFullYear() === n.getFullYear() &&
         d.getMonth()    === n.getMonth()    &&
         d.getDate()     === n.getDate()
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ─── Response types (exported for the page to import) ─────────────────────────

export interface DashboardAlert {
  type:      'nearly_full' | 'comm_payment_pending' | 'cert_missing' | 'reg_closing_soon'
  severity:  'critical' | 'warning'
  title:     string
  meta:      string
  eventSlug: string | null
}

export interface DashboardEvent {
  draftId:         string
  name:            string
  slug:            string | null
  registered:      number
  capacity:        number | null
  fillPct:         number
  startDate:       string | null
  lifecycleStatus: string
}

export interface DashboardActivity {
  type:          'registration' | 'checkin'
  attendeeName:  string
  attendeeEmail: string
  eventName:     string
  passName:      string
  timestamp:     string   // ISO 8601
}

export interface DashboardData {
  organizer: {
    name:    string
    orgName: string
    logoUrl: string | null
  }
  overview: {
    activeEvents:       number
    totalRegistrations: number
    totalRevenuePaise:  number
    todayRegistrations: number
    todayCheckins:      number
  }
  alerts:     DashboardAlert[]
  settlement: {
    grossRevenuePaise:       number
    platformFeePaise:        number
    communicationCostPaise:  number
    netPayoutPaise:          number
  }
  activity:   DashboardActivity[]
  events:     DashboardEvent[]
  trendDays:  { date: string; count: number }[]   // 90 entries, oldest → newest
  communications: {
    emailsSent:   number
    smsSent:      number
    whatsappSent: number
    costPaise:    number
  }
  healthScore: {
    score: number
    items: { label: string; done: boolean }[]
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  // ── Batch 1: three parallel root fetches ───────────────────────────────────
  const [draftsSnap, regsSnap, profileSnap] = await Promise.all([
    adminDb.collection(`users/${uid}/eventDrafts`).orderBy('updatedAt', 'desc').get(),
    adminDb.collection('registrations').where('organizerUid', '==', uid).get(),
    adminDb.collection('users').doc(uid).get(),
  ])

  const profile = profileSnap.exists ? (profileSnap.data() ?? {}) : {}
  const drafts  = draftsSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
  const regs    = regsSnap.docs.map(d => d.data() as RegistrationDocument)

  // ── Collect slugs + draft IDs for batch 2 ─────────────────────────────────
  const publishedDrafts = drafts.filter(d => d.status === 'published')
  const slugList:    string[] = []
  const draftIdList: string[] = []

  publishedDrafts.forEach(d => {
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const seo     = (details.seo    as Record<string, unknown>) ?? {}
    const slug    = typeof seo.urlSlug === 'string' ? seo.urlSlug : null
    if (slug) slugList.push(slug)
    draftIdList.push(d.id as string)
  })

  // ── Batch 2: counters + cert templates ────────────────────────────────────
  const [counterSnaps, certSnaps] = await Promise.all([
    Promise.all(slugList.map(s  => adminDb.collection('registrationCounters').doc(s).get())),
    Promise.all(draftIdList.map(id => adminDb.collection('certificateTemplates').doc(id).get())),
  ])

  const counterMap = new Map<string, number>()
  counterSnaps.forEach((snap, i) => {
    if (!snap.exists) return
    const d = snap.data() as { totalCount?: number }
    counterMap.set(slugList[i], d.totalCount ?? 0)
  })
  const certTemplateSet = new Set<string>()
  certSnaps.forEach((snap, i) => {
    if (snap.exists) certTemplateSet.add(draftIdList[i])
  })

  // ── Overview ───────────────────────────────────────────────────────────────

  const activeLifecycles = new Set(['published', 'registration_closed'])
  const activeEvents = publishedDrafts.filter(d =>
    activeLifecycles.has(deriveLifecycleStatus(d)),
  ).length

  const confirmedRegs    = regs.filter(r => r.status === 'confirmed')
  const totalRegs        = confirmedRegs.length
  const totalRevPaise    = confirmedRegs.reduce((s, r) => s + (r.amount ?? 0), 0)
  const todayRegs        = confirmedRegs.filter(r => isToday(r.registeredAt)).length
  const todayCheckins    = regs.filter(r => r.checkedIn && isToday(r.checkedInAt)).length

  // ── Alerts ─────────────────────────────────────────────────────────────────

  const alerts: DashboardAlert[] = []

  publishedDrafts.forEach(d => {
    if (deriveLifecycleStatus(d) !== 'published') return

    const details   = (d.eventDetails as Record<string, unknown>) ?? {}
    const info      = (details.info     as Record<string, unknown>) ?? {}
    const seo       = (details.seo      as Record<string, unknown>) ?? {}
    const sched     = (details.schedule as Record<string, unknown>) ?? {}
    const name      = typeof info.name    === 'string' ? info.name    : 'Untitled Event'
    const slug      = typeof seo.urlSlug  === 'string' ? seo.urlSlug  : null
    const draftId   = d.id as string

    const isFree   = (d.pricing as Record<string, unknown>)?.eventType === 'free'
    const capacity = isFree ? 100 : null
    const regCount = slug ? (counterMap.get(slug) ?? 0) : 0

    // Nearly full
    if (capacity !== null && capacity > 0) {
      const pct = regCount / capacity
      if (pct >= 0.9) {
        alerts.push({
          type: 'nearly_full', severity: 'critical',
          title: `${name} is almost full`,
          meta:  `${regCount}/${capacity} seats · ${Math.round(pct * 100)}% filled`,
          eventSlug: slug,
        })
      } else if (pct >= 0.8) {
        alerts.push({
          type: 'nearly_full', severity: 'warning',
          title: `${name} is filling fast`,
          meta:  `${regCount}/${capacity} seats · ${Math.round(pct * 100)}% filled`,
          eventSlug: slug,
        })
      }
    }

    // Certificate template missing
    if (!certTemplateSet.has(draftId)) {
      alerts.push({
        type: 'cert_missing', severity: 'warning',
        title: 'Certificate template missing',
        meta:  `Set up certificates for ${name}`,
        eventSlug: slug,
      })
    }

    // Registration closing soon (event starts within 48 h)
    const startStr = typeof sched.startDate === 'string' ? sched.startDate : null
    if (startStr) {
      const hoursUntil = (new Date(startStr).getTime() - Date.now()) / 3_600_000
      if (hoursUntil > 0 && hoursUntil <= 48) {
        alerts.push({
          type:     'reg_closing_soon',
          severity: hoursUntil <= 24 ? 'critical' : 'warning',
          title:    'Registration closing soon',
          meta:     `${name} starts in ${Math.round(hoursUntil)}h`,
          eventSlug: slug,
        })
      }
    }
  })

  // Communication payment pending
  drafts.forEach(d => {
    const billing = d.communicationBilling as Record<string, unknown> | null | undefined
    if (billing?.status !== 'pending') return
    const details = (d.eventDetails as Record<string, unknown>) ?? {}
    const info    = (details.info    as Record<string, unknown>) ?? {}
    const name    = typeof info.name === 'string' ? info.name : 'an event'
    alerts.push({
      type: 'comm_payment_pending', severity: 'warning',
      title: 'Communication payment required',
      meta:  `Complete payment to publish ${name}`,
      eventSlug: null,
    })
  })

  // ── Settlement ─────────────────────────────────────────────────────────────

  const grossPaise = confirmedRegs.reduce(
    (s, r) => (r.paymentStatus === 'paid' ? s + (r.amount ?? 0) : s), 0,
  )
  const platformFeePaise       = Math.round(grossPaise * PLATFORM_FEE_RATE)
  const communicationCostPaise = drafts.reduce((s, d) => {
    const b = d.communicationBilling as Record<string, unknown> | null | undefined
    return (b?.status === 'paid' && typeof b.amount === 'number') ? s + b.amount : s
  }, 0)
  const netPayoutPaise = Math.max(0, grossPaise - platformFeePaise - communicationCostPaise)

  // ── Activity Feed ──────────────────────────────────────────────────────────

  type ActivityWithTs = DashboardActivity & { _ms: number }
  const activityRaw: ActivityWithTs[] = []

  // Recent registrations (newest 15)
  const sortedByReg = [...regs].sort((a, b) => {
    const at = tsToDate(a.registeredAt)?.getTime() ?? 0
    const bt = tsToDate(b.registeredAt)?.getTime() ?? 0
    return bt - at
  })
  sortedByReg.slice(0, 15).forEach(r => {
    const d = tsToDate(r.registeredAt)
    if (!d) return
    activityRaw.push({
      type: 'registration',
      attendeeName:  r.attendee.name,
      attendeeEmail: r.attendee.email,
      eventName:     r.eventName ?? '',
      passName:      r.passName  ?? '',
      timestamp:     d.toISOString(),
      _ms:           d.getTime(),
    })
  })

  // Recent check-ins (newest 10)
  const sortedByCheckin = regs
    .filter(r => r.checkedIn && r.checkedInAt)
    .sort((a, b) => {
      const at = tsToDate(a.checkedInAt)?.getTime() ?? 0
      const bt = tsToDate(b.checkedInAt)?.getTime() ?? 0
      return bt - at
    })
    .slice(0, 10)

  sortedByCheckin.forEach(r => {
    const d = tsToDate(r.checkedInAt)
    if (!d) return
    activityRaw.push({
      type: 'checkin',
      attendeeName:  r.attendee.name,
      attendeeEmail: r.attendee.email,
      eventName:     r.eventName ?? '',
      passName:      r.passName  ?? '',
      timestamp:     d.toISOString(),
      _ms:           d.getTime(),
    })
  })

  const activity: DashboardActivity[] = activityRaw
    .sort((a, b) => b._ms - a._ms)
    .slice(0, 20)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ _ms, ...rest }) => rest)

  // ── Event Health (published + registration_closed + completed) ─────────────

  const visibleStatuses = new Set(['published', 'registration_closed', 'completed'])
  const events: DashboardEvent[] = drafts
    .filter(d => visibleStatuses.has(deriveLifecycleStatus(d)))
    .map(d => {
      const details  = (d.eventDetails as Record<string, unknown>) ?? {}
      const info     = (details.info    as Record<string, unknown>) ?? {}
      const seo      = (details.seo     as Record<string, unknown>) ?? {}
      const sched    = (details.schedule as Record<string, unknown>) ?? {}
      const slug     = typeof seo.urlSlug === 'string' ? seo.urlSlug : null
      const isFree   = (d.pricing as Record<string, unknown>)?.eventType === 'free'
      const capacity = isFree ? 100 : null
      const regCount = slug ? (counterMap.get(slug) ?? 0) : 0
      const fillPct  = capacity ? Math.round((regCount / capacity) * 100) : 0

      return {
        draftId:         d.id as string,
        name:            typeof info.name      === 'string' ? info.name      : 'Untitled Event',
        slug,
        registered:      regCount,
        capacity,
        fillPct,
        startDate:       typeof sched.startDate === 'string' ? sched.startDate : null,
        lifecycleStatus: deriveLifecycleStatus(d),
      }
    })

  // ── Trend Data (90-day daily buckets) ──────────────────────────────────────

  const trendMap = new Map<string, number>()
  const cutoff90 = new Date(Date.now() - 90 * 86_400_000)

  // Seed all 90 days with 0 (oldest → newest)
  for (let i = 89; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    trendMap.set(ymd(d), 0)
  }

  confirmedRegs.forEach(r => {
    const d = tsToDate(r.registeredAt)
    if (!d || d < cutoff90) return
    const k = ymd(d)
    if (trendMap.has(k)) trendMap.set(k, (trendMap.get(k) ?? 0) + 1)
  })

  const trendDays = Array.from(trendMap.entries()).map(([date, count]) => ({ date, count }))

  // ── Communications ─────────────────────────────────────────────────────────

  const emailsSent = regs.filter(r => r.emailStatus === 'sent').length
  const communications = {
    emailsSent,
    smsSent:      0,   // not tracked in current schema
    whatsappSent: 0,
    costPaise:    communicationCostPaise,
  }

  // ── Organizer Health Score ─────────────────────────────────────────────────

  const branding    = (profile.branding            as Record<string, unknown>) ?? {}
  const orgProfile  = (profile.organizationProfile as Record<string, unknown>) ?? {}
  const commsConfig = (profile.communications       as Record<string, boolean>) ?? {}

  const healthItems: { label: string; done: boolean }[] = [
    {
      label: 'Organization name',
      done:  typeof profile.organizationName === 'string' &&
             (profile.organizationName as string).trim().length > 0,
    },
    {
      label: 'Support email address',
      done:  typeof orgProfile.supportEmail === 'string' &&
             (orgProfile.supportEmail as string).trim().length > 0,
    },
    {
      label: 'Organization logo',
      done:  typeof branding.logoUrl === 'string' && (branding.logoUrl as string).length > 0,
    },
    {
      label: 'Certificate signature',
      done:  typeof branding.certSignatureUrl === 'string' &&
             (branding.certSignatureUrl as string).length > 0,
    },
    {
      label: 'Event published',
      done:  publishedDrafts.length > 0,
    },
    {
      label: 'Email communications on',
      done:  commsConfig.sendRegistrationConfirmation ?? false,
    },
  ]

  const doneCount = healthItems.filter(i => i.done).length
  const healthScore = {
    score: Math.round((doneCount / healthItems.length) * 100),
    items: healthItems,
  }

  // ── Assemble and return ────────────────────────────────────────────────────

  const data: DashboardData = {
    organizer: {
      name:    typeof profile.name             === 'string' ? (profile.name             as string) : '',
      orgName: typeof profile.organizationName === 'string' ? (profile.organizationName as string) : '',
      logoUrl: typeof branding.logoUrl         === 'string' ? (branding.logoUrl         as string) : null,
    },
    overview: {
      activeEvents:       activeEvents,
      totalRegistrations: totalRegs,
      totalRevenuePaise:  totalRevPaise,
      todayRegistrations: todayRegs,
      todayCheckins:      todayCheckins,
    },
    alerts,
    settlement: {
      grossRevenuePaise:      grossPaise,
      platformFeePaise,
      communicationCostPaise,
      netPayoutPaise,
    },
    activity,
    events,
    trendDays,
    communications,
    healthScore,
  }

  return NextResponse.json(data)
}
