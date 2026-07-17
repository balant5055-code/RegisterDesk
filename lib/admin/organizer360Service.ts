// Organizer 360 aggregation service (GA-2 S2). Server-only.
//
// Thin READ aggregation over EXISTING data + services. Resolves one organizer
// (users/{uid}) and reuses:
//   • getWorkspaceEntitlements  → effective tier / features / limits / overrides
//   • listTeam                  → members + invites
//   • organizerRevenueWallets   → wallet / revenue summary (O(1))
//   • organizerPayoutProfiles   → payout verification (O(1))
//   • registrationCounters      → O(1) per-event registration/revenue rollup
//   • eventLicenses / orders    → license + coupon rollup
//   • adminAuditLogs            → governance + timeline
// Bounded everywhere (no unbounded scans); every best-effort read is guarded so a
// missing index/field degrades to a neutral signal instead of failing the request.

import { adminDb } from '@/lib/firebase/admin'
import { getAttendanceShardSums } from '@/lib/firebase/firestore/registrationCounters'
import { getWorkspaceEntitlements } from '@/lib/licensing/workspaceEntitlements'
import { listTeam } from '@/lib/team/service'
import type {
  Organizer360Overview, Organizer360Operations, Organizer360Business,
  Organizer360Governance, Organizer360Timeline, Organizer360Event,
  Organizer360License, Organizer360Job, Organizer360TimelineEntry,
  HealthIndicator, HealthLevel, OrgTimelineSource,
} from '@/lib/admin/organizer360Types'
import type { AccountStatus } from '@/lib/admin/organizerTypes'

const EVENTS_CAP     = 60    // bounded per-organizer event fan-out
const LICENSES_CAP   = 200
const AUDIT_CAP      = 200
const JOB_SAMPLE     = 25

const JOB_COLLECTIONS: [string, string][] = [
  ['printGenerationJobs',   'print_generation'],
  ['printPackageJobs',      'print_package'],
  ['registrationBulkJobs',  'bulk'],
  ['reportExportJobs',      'report_export'],
  ['registrationImportJobs', 'import'],
]

// ─── helpers ──────────────────────────────────────────────────────────────────

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    try { return (ts as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  if (typeof ts === 'string' && ts) return ts
  return null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const numOf = (v: unknown): number => (typeof v === 'number' ? v : 0)
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

function eventName(ev: Record<string, unknown>): string {
  const info = rec(rec(ev.eventDetails).info)
  return str(info.name) ?? '(untitled event)'
}
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}
function effectiveStatus(s: unknown): AccountStatus {
  return s === 'suspended' || s === 'banned' ? s : 'active'
}
function payoutMethodOf(v: unknown): 'bank' | 'upi' | null {
  return v === 'bank' ? 'bank' : v === 'upi' ? 'upi' : null
}

// Fetch the organizer's events (bounded) once, joined with O(1) counters.
async function loadEventsWithCounters(uid: string): Promise<{ events: Organizer360Event[]; truncated: boolean }> {
  const snap = await adminDb.collection('events').where('uid', '==', uid).limit(EVENTS_CAP + 1).get()
  const docs = snap.docs.slice(0, EVENTS_CAP)
  const truncated = snap.docs.length > EVENTS_CAP
  if (!docs.length) return { events: [], truncated }

  const ids = docs.map(d => d.id)
  const [counterSnaps, licenseSnaps] = await Promise.all([
    adminDb.getAll(...ids.map(id => adminDb.doc(`registrationCounters/${id}`))),
    adminDb.getAll(...ids.map(id => adminDb.doc(`eventLicenses/${id}`))),
  ])
  const counterMap = new Map<string, Record<string, unknown>>()
  counterSnaps.forEach((s, i) => { if (s.exists) counterMap.set(ids[i], s.data() as Record<string, unknown>) })
  const licMap = new Map<string, Record<string, unknown>>()
  licenseSnaps.forEach((s, i) => { if (s.exists) licMap.set(ids[i], s.data() as Record<string, unknown>) })

  // GA-5 S3: fold the distributed attendance shards into each event's check-in count.
  const shardSums = await Promise.all(ids.map(id => getAttendanceShardSums(id)))
  const shardCheckedIn = new Map<string, number>()
  ids.forEach((id, i) => shardCheckedIn.set(id, shardSums[i].checkedInCount))

  const events: Organizer360Event[] = docs.map(d => {
    const ev = d.data() as Record<string, unknown>
    const c  = counterMap.get(d.id) ?? {}
    const l  = licMap.get(d.id)
    return {
      slug:             d.id,
      name:             eventName(ev),
      lifecycleStatus:  str(ev.lifecycleStatus),
      reviewStatus:     str(ev.reviewStatus),
      moderationStatus: str(ev.moderationStatus),
      licenseTier:      l ? str(l.tier) : null,
      licenseStatus:    l ? str(l.status) : null,
      registrations:    numOf(c.totalCount),
      checkedIn:        numOf(c.checkedInCount) + (shardCheckedIn.get(d.id) ?? 0),
      revenuePaise:     numOf(c.revenuePaise),
    }
  })
  return { events, truncated }
}

// ─── Overview (/360) ────────────────────────────────────────────────────────

export async function getOrganizer360Overview(uid: string): Promise<Organizer360Overview | null> {
  const userSnap = await adminDb.doc(`users/${uid}`).get()
  if (!userSnap.exists) return null
  const u = userSnap.data() as Record<string, unknown>

  const [walletSnap, payoutSnap, eventsCount, pubCount, campaignsCount, entitlements, team, eventsRollup, licRollup] =
    await Promise.all([
      adminDb.doc(`organizerRevenueWallets/${uid}`).get(),
      adminDb.doc(`organizerPayoutProfiles/${uid}`).get(),
      adminDb.collection('events').where('uid', '==', uid).count().get().catch(() => null),
      adminDb.collection('events').where('uid', '==', uid).where('lifecycleStatus', '==', 'published').count().get().catch(() => null),
      adminDb.collection('donationCampaigns').where('uid', '==', uid).count().get().catch(() => null),
      getWorkspaceEntitlements(uid).catch(() => null),
      listTeam(uid).catch(() => ({ members: [], invites: [] })),
      loadEventsWithCounters(uid),
      loadLicenseRollup(uid),
    ])

  const w = walletSnap.exists ? walletSnap.data() as Record<string, number> : null
  const p = payoutSnap.exists ? payoutSnap.data() as Record<string, unknown> : null

  const regTotal   = eventsRollup.events.reduce((a, e) => a + e.registrations, 0)
  const checkedIn  = eventsRollup.events.reduce((a, e) => a + e.checkedIn, 0)

  const account = {
    status:          effectiveStatus(u.accountStatus),
    statusReason:    str(u.statusReason),
    statusUpdatedAt: tsToISO(u.statusUpdatedAt),
    statusUpdatedBy: str(u.statusUpdatedBy),
  }
  const verification = {
    emailVerified:  u.emailVerified === true,
    payoutExists:   payoutSnap.exists,
    payoutVerified: p?.isVerified === true,
    payoutMethod:   payoutMethodOf(p?.payoutMethod),
  }
  const overrideTier = entitlements?.source === 'admin_override' ? entitlements.effectiveTier : null

  // ── Health ──
  const health: HealthIndicator[] = []
  const push = (key: HealthIndicator['key'], label: string, level: HealthLevel, detail: string) => health.push({ key, label, level, detail })

  push('account', 'Account',
    account.status === 'active' ? 'green' : account.status === 'suspended' ? 'yellow' : 'red',
    account.status)

  const vLevel: HealthLevel = verification.emailVerified && verification.payoutVerified ? 'green'
    : verification.emailVerified || verification.payoutVerified ? 'yellow' : 'red'
  push('verification', 'Verification', vLevel,
    `${verification.emailVerified ? 'email✓' : 'email✗'} · ${verification.payoutVerified ? 'payout✓' : 'payout✗'}`)

  push('licenses', 'Licenses',
    licRollup.active > 0 ? 'green' : licRollup.total > 0 ? 'yellow' : 'neutral',
    licRollup.total > 0 ? `${licRollup.active} active / ${licRollup.total}` : 'No licenses')

  const pub = pubCount?.data().count ?? 0
  const totEvents = eventsCount?.data().count ?? eventsRollup.events.length
  push('events', 'Events',
    pub > 0 ? 'green' : totEvents > 0 ? 'yellow' : 'neutral',
    `${pub} published / ${totEvents}`)

  const hasRevenue = !!w && (numOf(w.availablePaise) + numOf(w.settledPaise) + numOf(w.pendingPaise)) > 0
  const pLevel: HealthLevel = hasRevenue && verification.payoutVerified ? 'green'
    : hasRevenue && !verification.payoutVerified ? 'yellow' : 'neutral'
  push('payments', 'Payments', pLevel,
    verification.payoutVerified ? 'Payout verified' : verification.payoutExists ? 'Payout unverified' : 'No payout')

  // Deferred — upgraded client-side once Operations loads.
  push('communications', 'Communications', 'neutral', 'Open Operations')
  push('jobs', 'Background Jobs', 'neutral', 'Open Operations')
  push('storage', 'Storage', 'neutral', 'n/a')

  return {
    uid,
    profile: {
      name:             str(u.name) ?? '',
      email:            str(u.email) ?? '',
      organizationName: str(u.organizationName) ?? '',
      role:             str(u.role) ?? 'organizer',
      phone:            str(u.phone),
      createdAt:        tsToISO(u.createdAt),
    },
    account,
    verification,
    team: { memberCount: team.members.length, inviteCount: team.invites.length },
    entitlements: {
      effectiveTier:        entitlements?.effectiveTier ?? 'starter',
      source:               entitlements?.source ?? 'fallback',
      activeLicensedEvents: entitlements?.activeEventCount ?? licRollup.active,
      overrideTier,
    },
    events: { total: totEvents, published: pub, campaigns: campaignsCount?.data().count ?? 0 },
    registrations: { total: regTotal, checkedIn, sampledEvents: eventsRollup.events.length, truncated: eventsRollup.truncated },
    revenue: {
      walletExists:   walletSnap.exists,
      availablePaise: numOf(w?.availablePaise),
      pendingPaise:   numOf(w?.pendingPaise),
      inTransitPaise: numOf(w?.inTransitPaise),
      settledPaise:   numOf(w?.settledPaise),
    },
    licenses: { total: licRollup.total, active: licRollup.active, revenuePaise: licRollup.revenuePaise },
    health,
  }
}

// ─── License rollup (shared by overview + business) ──────────────────────────

async function loadLicenseRollup(uid: string): Promise<{ total: number; active: number; revenuePaise: number; docs: { id: string; data: Record<string, unknown> }[] }> {
  try {
    const snap = await adminDb.collection('eventLicenses').where('organizerUid', '==', uid).limit(LICENSES_CAP).get()
    let active = 0, revenuePaise = 0
    const docs = snap.docs.map(d => {
      const data = d.data() as Record<string, unknown>
      const admin = rec(data.admin)
      const suspended = admin.lifecycle === 'suspended' || admin.lifecycle === 'cancelled'
      if (data.status === 'active' && !suspended) active++
      revenuePaise += numOf(data.amountPaise)
      return { id: d.id, data }
    })
    return { total: docs.length, active, revenuePaise, docs }
  } catch {
    return { total: 0, active: 0, revenuePaise: 0, docs: [] }
  }
}

// ─── Operations (/operations) ─────────────────────────────────────────────────

export async function getOrganizer360Operations(uid: string): Promise<Organizer360Operations | null> {
  const userSnap = await adminDb.doc(`users/${uid}`).get()
  if (!userSnap.exists) return null

  const { events, truncated } = await loadEventsWithCounters(uid)
  const eventIds = events.map(e => e.slug)

  const [certs, comms, jobs] = await Promise.all([
    countByEventId('certificates', eventIds),
    countCommunications(eventIds),
    loadJobs(uid),
  ])

  return {
    events, truncated,
    certificates:   { issued: certs, approxOfEvents: eventIds.length },
    communications: { sent: comms.sent, failed: comms.failed, approxOfEvents: eventIds.length },
    jobs,
  }
}

async function countByEventId(collection: string, eventIds: string[]): Promise<number> {
  if (!eventIds.length) return 0
  let total = 0
  for (const c of chunk(eventIds, 30)) {
    try {
      const agg = await adminDb.collection(collection).where('eventId', 'in', c).count().get()
      total += agg.data().count
    } catch { /* missing index/field — skip chunk */ }
  }
  return total
}

async function countCommunications(eventIds: string[]): Promise<{ sent: number; failed: number }> {
  if (!eventIds.length) return { sent: 0, failed: 0 }
  let sent = 0, failed = 0
  for (const c of chunk(eventIds, 30)) {
    try {
      const snap = await adminDb.collection('emailLogs').where('eventId', 'in', c).limit(500).get()
      for (const d of snap.docs) {
        const st = String((d.data() as { status?: unknown }).status ?? '')
        if (st === 'failed') failed++; else sent++
      }
    } catch { /* skip chunk */ }
  }
  return { sent, failed }
}

async function loadJobs(uid: string): Promise<Organizer360Operations['jobs']> {
  const recent: Organizer360Job[] = []
  let total = 0, running = 0, failed = 0
  for (const [collection, kind] of JOB_COLLECTIONS) {
    try {
      const snap = await adminDb.collection(collection).where('organizerUid', '==', uid).limit(JOB_SAMPLE).get()
      for (const d of snap.docs) {
        const data = d.data() as Record<string, unknown>
        const status = String(data.status ?? 'unknown')
        total++
        if (status === 'running' || status === 'processing' || status === 'pending') running++
        if (status === 'failed' || status === 'error') failed++
        recent.push({ id: d.id, collection, kind, status, createdAt: tsToISO(data.createdAt) })
      }
    } catch { /* skip collection */ }
  }
  recent.sort((a, b) => (b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0))
  return { total, running, failed, recent: recent.slice(0, 20) }
}

// ─── Business (/business) ─────────────────────────────────────────────────────

export async function getOrganizer360Business(uid: string): Promise<Organizer360Business | null> {
  const userSnap = await adminDb.doc(`users/${uid}`).get()
  if (!userSnap.exists) return null

  const [walletSnap, payoutSnap, settlementsSnap, entitlements, licRollup, eventsRollup] = await Promise.all([
    adminDb.doc(`organizerRevenueWallets/${uid}`).get(),
    adminDb.doc(`organizerPayoutProfiles/${uid}`).get(),
    adminDb.collection('settlementRequests').where('organizerUid', '==', uid).orderBy('requestedAt', 'desc').limit(10).get().catch(() => null),
    getWorkspaceEntitlements(uid).catch(() => null),
    loadLicenseRollup(uid),
    loadEventsWithCounters(uid),
  ])

  // Join license orders for coupon + payment status (bounded getAll).
  const orderIds = licRollup.docs.map(d => str(d.data.orderId)).filter((o): o is string => !!o)
  const orderSnaps = orderIds.length ? await adminDb.getAll(...orderIds.map(o => adminDb.doc(`licenseOrders/${o}`))) : []
  const orderMap = new Map<string, Record<string, unknown>>()
  orderSnaps.forEach(s => { if (s.exists) orderMap.set(s.id, s.data() as Record<string, unknown>) })

  const couponAgg = new Map<string, { count: number; discountPaise: number }>()
  const licenses: Organizer360License[] = licRollup.docs.slice(0, 100).map(({ id, data }) => {
    const admin = rec(data.admin)
    const order = str(data.orderId) ? orderMap.get(str(data.orderId) as string) : undefined
    const couponCode = order ? str(order.couponCode) : null
    if (couponCode) {
      const cur = couponAgg.get(couponCode) ?? { count: 0, discountPaise: 0 }
      cur.count++; cur.discountPaise += numOf(order?.discountPaise)
      couponAgg.set(couponCode, cur)
    }
    const suspended = admin.lifecycle === 'suspended' || admin.lifecycle === 'cancelled'
    const displayStatus = suspended ? String(admin.lifecycle) : String(data.status ?? 'pending')
    return {
      eventId:         id,
      eventName:       str(rec(order).eventName) ?? id,
      tier:            str(data.tier) ?? '—',
      displayStatus,
      paymentStatus:   order ? String(order.status ?? 'unknown') : (numOf(data.amountPaise) > 0 ? 'paid' : 'free'),
      amountPaidPaise: numOf(data.amountPaise),
      couponCode,
      purchaseDate:    tsToISO(data.createdAt),
    }
  })

  const w = walletSnap.exists ? walletSnap.data() as Record<string, number> : null
  const p = payoutSnap.exists ? payoutSnap.data() as Record<string, unknown> : null
  const eventRevenuePaise = eventsRollup.events.reduce((a, e) => a + e.revenuePaise, 0)

  return {
    licenses, truncated: licRollup.total > 100,
    coupons: [...couponAgg.entries()].map(([code, v]) => ({ code, count: v.count, discountPaise: v.discountPaise })).sort((a, b) => b.count - a.count),
    wallet: {
      walletExists:   walletSnap.exists,
      availablePaise: numOf(w?.availablePaise),
      pendingPaise:   numOf(w?.pendingPaise),
      inTransitPaise: numOf(w?.inTransitPaise),
      settledPaise:   numOf(w?.settledPaise),
    },
    payout: {
      exists:     payoutSnap.exists,
      verified:   p?.isVerified === true,
      method:     payoutMethodOf(p?.payoutMethod),
      verifiedAt: tsToISO(p?.verifiedAt),
    },
    settlements: (settlementsSnap?.docs ?? []).map(d => {
      const s = d.data() as Record<string, unknown>
      return { id: d.id, amountPaise: numOf(s.amountPaise), status: String(s.status ?? 'unknown'), requestedAt: tsToISO(s.requestedAt) }
    }),
    revenue: { licenseRevenuePaise: licRollup.revenuePaise, eventRevenuePaise },
    entitlements: {
      effectiveTier:        entitlements?.effectiveTier ?? 'starter',
      source:               entitlements?.source ?? 'fallback',
      activeLicensedEvents: entitlements?.activeEventCount ?? licRollup.active,
      features:             entitlements ? Object.entries(entitlements.features).map(([key, enabled]) => ({ key, enabled: enabled === true })) : [],
      limits:               entitlements ? Object.entries(entitlements.limits).map(([key, value]) => ({ key, value: numOf(value) })) : [],
    },
  }
}

// ─── Governance (/governance) ─────────────────────────────────────────────────

export async function getOrganizer360Governance(uid: string): Promise<Organizer360Governance | null> {
  const userSnap = await adminDb.doc(`users/${uid}`).get()
  if (!userSnap.exists) return null

  const [auditSnap, entitlements, team] = await Promise.all([
    adminDb.collection('adminAuditLogs').where('entityId', '==', uid).limit(AUDIT_CAP).get().catch(() => null),
    getWorkspaceEntitlements(uid).catch(() => null),
    listTeam(uid).catch(() => ({ members: [], invites: [] })),
  ])

  const audit = (auditSnap?.docs ?? []).map(d => {
    const x = d.data() as Record<string, unknown>
    const meta = rec(x.metadata)
    return {
      id:         d.id,
      action:     String(x.action ?? 'admin.action'),
      entityType: String(x.entityType ?? ''),
      detail:     str(meta.reason) ?? str(meta.note) ?? String(x.action ?? '').replace(/[._]/g, ' '),
      actor:      str(x.adminUid),
      at:         tsToISO(x.createdAt),
    }
  }).sort((a, b) => (b.at ? Date.parse(b.at) : 0) - (a.at ? Date.parse(a.at) : 0))

  const overrideTier = entitlements?.source === 'admin_override' ? entitlements.effectiveTier : null

  const teamView = [...team.members, ...team.invites].map(m => {
    const anyM = m as unknown as Record<string, unknown>
    const perms = anyM.permissions
    return {
      id:          String(anyM.id ?? anyM.memberId ?? anyM.email ?? ''),
      name:        str(anyM.name) ?? '',
      email:       str(anyM.email) ?? '',
      role:        str(anyM.role) ?? 'member',
      status:      str(anyM.status) ?? 'active',
      permissions: Array.isArray(perms) ? perms.length : 0,
    }
  })

  return {
    audit,
    overrides: {
      entitlementOverrideTier: overrideTier,
      source:                  entitlements?.source ?? 'fallback',
      effectiveTier:           entitlements?.effectiveTier ?? 'starter',
    },
    features: entitlements ? Object.entries(entitlements.features).map(([key, enabled]) => ({ key, enabled: enabled === true })) : [],
    team: teamView,
  }
}

// ─── Timeline (/timeline) ─────────────────────────────────────────────────────

export async function getOrganizer360Timeline(uid: string): Promise<Organizer360Timeline | null> {
  const userSnap = await adminDb.doc(`users/${uid}`).get()
  if (!userSnap.exists) return null
  const u = userSnap.data() as Record<string, unknown>

  const [auditSnap, licRollup, eventsRollup] = await Promise.all([
    adminDb.collection('adminAuditLogs').where('entityId', '==', uid).limit(AUDIT_CAP).get().catch(() => null),
    loadLicenseRollup(uid),
    loadEventsWithCounters(uid),
  ])

  const entries: Organizer360TimelineEntry[] = []
  const add = (id: string, source: OrgTimelineSource, action: string, detail: string, at: string | null, actor: string | null = null) => {
    if (at || source === 'account') entries.push({ id, source, action, detail, actor, at })
  }

  // Account created + verification
  add('account:created', 'account', 'account_created', u.email ? String(u.email) : 'Organizer account created', tsToISO(u.createdAt))
  if (u.emailVerified === true) add('verification:email', 'verification', 'email_verified', 'Email verified', tsToISO(u.emailVerifiedAt) ?? tsToISO(u.updatedAt))

  // License purchases + coupon usage
  for (const { id, data } of licRollup.docs) {
    add(`license:${id}`, 'license', 'license_purchased', `${str(data.tier) ?? '—'} license · ${id}`, tsToISO(data.createdAt))
  }

  // Event publications
  for (const e of eventsRollup.events) {
    if (e.lifecycleStatus === 'published') add(`event:${e.slug}`, 'event', 'event_published', e.name, null)
  }

  // Admin actions / overrides / payments (from audit)
  for (const d of auditSnap?.docs ?? []) {
    const x = d.data() as Record<string, unknown>
    const action = String(x.action ?? 'admin.action')
    const entityType = String(x.entityType ?? '')
    const source: OrgTimelineSource = action.startsWith('plan') || entityType === 'billing' ? 'override'
      : action.startsWith('payment') || entityType === 'payment' ? 'payment' : 'audit'
    const meta = rec(x.metadata)
    add(`audit:${d.id}`, source, action, str(meta.reason) ?? action.replace(/[._]/g, ' '), tsToISO(x.createdAt), str(x.adminUid))
  }

  entries.sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : -Infinity
    const tb = b.at ? Date.parse(b.at) : -Infinity
    return tb - ta
  })

  return { entries }
}
