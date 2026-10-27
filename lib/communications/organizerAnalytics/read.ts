// RD-COMMS-ANALYTICS-02 · Communication Analytics — the server read. SERVER-ONLY, READ-ONLY.
//
// Per request: ONE bounded, projected emailLogs query per period (current + previous) on the
// already-deployed composite indexes
//     emailLogs (organizerUid ↑, eventSlug ↑, createdAt ↓)   — one event
//     emailLogs (organizerUid ↑, createdAt ↓)                 — all events
// plus ONE batched getAll for the broadcast campaigns the rows reference, and — for one event —
// the existing authoritative Usage read for WhatsApp capacity. No per-row reads, no new index.
// Channel and type are filtered in memory: a legacy email row has NO `channel` field, so an
// equality filter on channel would silently drop it.
//
// Nothing here writes, sends, charges or re-sends anything.

import { adminDb } from '@/lib/firebase/admin'
import { resolveBroadcastTimezone, FALLBACK_TIMEZONE } from '@/lib/broadcasts/resolveBroadcastTimezone'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'
import { getEventCommunicationUsage } from '@/lib/communications/usage'
import { businessConfig } from '@/lib/config/businessConfigService'
import { isValidTimezone } from '@/lib/registrations/zonedDayRange'
import {
  resolvePeriods, summarize, buildTrend, buildTypes, buildTemplates, buildInsights, matchesFilters, countCapacitySkips,
  type LogRow, type ResolvedPeriod, type CampaignTemplateMeta,
} from './compute'
import { SCAN_CAP, type ChannelFilter, type RangePreset, type TypeCategory, type CommunicationAnalyticsResponse, type CapacitySummary } from './types'

export class AnalyticsError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

const FIELDS = ['createdAt', 'status', 'channel', 'deliveryUnknown', 'waStatus', 'templateKey', 'campaignId', 'error'] as const
const CAMPAIGN_READ_CAP = 300

function toRow(d: FirebaseFirestore.DocumentData): LogRow | null {
  const ts = d.createdAt as { toMillis?: () => number } | undefined
  const createdAtMs = ts && typeof ts.toMillis === 'function' ? ts.toMillis() : NaN
  if (!Number.isFinite(createdAtMs)) return null
  return {
    createdAtMs,
    status: typeof d.status === 'string' ? d.status : 'queued',
    channel: d.channel === 'whatsapp' ? 'whatsapp' : 'email',
    deliveryUnknown: d.deliveryUnknown === true,
    waStatus: typeof d.waStatus === 'string' ? d.waStatus : null,
    templateKey: typeof d.templateKey === 'string' ? d.templateKey : '',
    campaignId: typeof d.campaignId === 'string' && d.campaignId ? d.campaignId : null,
    error: typeof d.error === 'string' ? d.error : null,
  }
}

/** Rows of one period, newest first, at most SCAN_CAP (+1 to detect truncation). */
export async function readPeriodRows(uid: string, slug: string | null, p: Pick<ResolvedPeriod, 'startUtc' | 'endUtcExclusive'>): Promise<{ rows: LogRow[]; scanned: number; truncated: boolean }> {
  let q = adminDb.collection('emailLogs').where('organizerUid', '==', uid) as FirebaseFirestore.Query
  if (slug) q = q.where('eventSlug', '==', slug)
  const snap = await q
    .where('createdAt', '>=', p.startUtc).where('createdAt', '<', p.endUtcExclusive)
    .orderBy('createdAt', 'desc')
    .select(...FIELDS)
    .limit(SCAN_CAP + 1)
    .get()
  const docs = snap.docs.slice(0, SCAN_CAP)
  const rows = docs.map(d => toRow(d.data())).filter((r): r is LogRow => r !== null)
  return { rows, scanned: docs.length, truncated: snap.size > SCAN_CAP }
}

/** Template identity of each referenced campaign — only campaigns owned by `uid`. One getAll. */
export async function readCampaignMeta(uid: string, ids: string[]): Promise<Map<string, CampaignTemplateMeta | null>> {
  const out = new Map<string, CampaignTemplateMeta | null>()
  const wanted = [...new Set(ids)].filter(id => /^[A-Za-z0-9_-]{1,128}$/.test(id)).slice(0, CAMPAIGN_READ_CAP)
  for (const id of ids) out.set(id, null)
  if (!wanted.length) return out
  const snaps = await adminDb.getAll(...wanted.map(id => adminDb.collection('broadcastCampaigns').doc(id)), { fieldMask: ['organizerUid', 'channel', 'customTemplate', 'templateType', 'subject'] })
  for (const s of snaps) {
    const d = s.exists ? s.data()! : null
    if (!d || d.organizerUid !== uid) continue                      // never another workspace's metadata
    const ct = d.customTemplate as { templateId?: unknown; version?: unknown } | undefined
    out.set(s.id, {
      channel: d.channel === 'whatsapp' ? 'whatsapp' : 'email',
      customTemplate: ct && typeof ct.templateId === 'string' && typeof ct.version === 'number' ? { templateId: ct.templateId, version: ct.version } : null,
      templateType: typeof d.templateType === 'string' && d.templateType ? d.templateType : null,
      subject: typeof d.subject === 'string' ? d.subject : null,
    })
  }
  return out
}

async function workspaceTimezone(uid: string): Promise<string> {
  const user = await adminDb.collection('users').doc(uid).get().catch(() => null)
  const tz = (user?.data()?.eventDefaults as { timezone?: unknown } | undefined)?.timezone
  if (typeof tz === 'string' && isValidTimezone(tz)) return tz
  const cfg = await businessConfig.getValue('branding', 'defaultTimezone').catch(() => null)
  return typeof cfg === 'string' && isValidTimezone(cfg) ? cfg : FALLBACK_TIMEZONE
}

export interface AnalyticsQuery {
  uid: string
  /** The event's draft id, or null for the whole workspace. */
  eventId: string | null
  range: RangePreset; from?: string | null; to?: string | null
  channel: ChannelFilter
  type: TypeCategory | null
  now?: Date
}

export async function getCommunicationAnalytics(q: AnalyticsQuery): Promise<CommunicationAnalyticsResponse> {
  let slug: string | null = null
  let eventName: string | null = null
  let timezone: string
  if (q.eventId) {
    const draft = await adminDb.doc(`users/${q.uid}/eventDrafts/${q.eventId}`).get()
    if (!draft.exists) throw new AnalyticsError(404, 'Event not found.')
    const data = draft.data() as Record<string, unknown>
    eventName = ((((data.eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined)?.name) as string | undefined) ?? 'Untitled event'
    slug = await resolveOwnedEventSlug(q.uid, q.eventId, data)
    timezone = slug ? await resolveBroadcastTimezone(slug, q.uid) : await workspaceTimezone(q.uid)
  } else {
    timezone = await workspaceTimezone(q.uid)
  }

  const periods = resolvePeriods({ range: q.range, from: q.from, to: q.to }, timezone, q.now ?? new Date())
  if (!periods.ok) throw new AnalyticsError(400, periods.error)

  // An event that was never published has no slug, so nothing can have been sent for it.
  const empty = { rows: [] as LogRow[], scanned: 0, truncated: false }
  const unpublished = q.eventId !== null && slug === null
  const [cur, prev] = await Promise.all([
    unpublished ? empty : readPeriodRows(q.uid, slug, periods.current),
    unpublished ? empty : readPeriodRows(q.uid, slug, periods.previous),
  ])
  const filters = { channel: q.channel, type: q.type }
  const curRows = cur.rows.filter(r => matchesFilters(r, filters))
  const prevRows = prev.rows.filter(r => matchesFilters(r, filters))

  const current = summarize(curRows, { from: periods.current.from, to: periods.current.to, scanned: cur.scanned, truncated: cur.truncated })
  const previous = summarize(prevRows, { from: periods.previous.from, to: periods.previous.to, scanned: prev.scanned, truncated: prev.truncated })
  const campaigns = await readCampaignMeta(q.uid, curRows.map(r => r.campaignId).filter((x): x is string => !!x))
  const templates = buildTemplates(curRows, campaigns, { eventId: q.eventId })

  let capacity: CapacitySummary | null = null
  if (q.eventId) {
    const capacitySkipped = countCapacitySkips(cur.rows)          // unfiltered: a history fact about the event
    try {
      const usage = await getEventCommunicationUsage(q.uid, q.eventId, { includeLegacyBalance: false })
      capacity = { figures: usage ? usage.whatsapp : null, capacitySkipped, unavailableReason: usage ? null : 'Event not found.' }
    } catch (err) {
      console.error('[communications/analytics] capacity read failed', err instanceof Error ? err.message : err)
      capacity = { figures: null, capacitySkipped, unavailableReason: 'WhatsApp capacity could not be loaded right now. Message figures are unaffected.' }
    }
  }

  return {
    scope: { kind: q.eventId ? 'event' : 'all', eventId: q.eventId, eventName, timezone },
    filters: { range: q.range, channel: q.channel, type: q.type },
    bucket: periods.bucket,
    current,
    previous,
    comparable: !current.truncated && !previous.truncated && previous.counts.attempts > 0,
    trend: buildTrend(curRows, periods.current, periods.bucket, timezone),
    previousTrend: periods.bucket === 'day' && !prev.truncated
      ? buildTrend(prevRows, periods.previous, 'day', timezone).map(b => b.email.attempts + b.whatsapp.attempts)
      : null,
    types: buildTypes(curRows),
    templates,
    capacity,
    insights: buildInsights({ current, templates, capacity, eventId: q.eventId }),
    generatedAt: new Date().toISOString(),
  }
}
