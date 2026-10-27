// RD-COMMS-ANALYTICS-02 · the pure half of Communication Analytics: periods, outcome
// classification, aggregation, template ranking, insights and CSV. No I/O — the server module
// (read.ts) feeds it projected emailLogs rows and campaign metadata; tests feed it fixtures.
//
// Dates are CALENDAR DAYS IN THE EVENT'S TIMEZONE, half-open [start, next day start), resolved
// through zonedDayRange (the same helper broadcasts use) — never UTC slicing of ISO strings.

import { zonedDayRange, shiftISODate, isValidISODate } from '@/lib/registrations/zonedDayRange'
import { isWalletSkippedWhatsAppLog } from '@/lib/email-logs/types'
import {
  OUTCOMES, RANGE_PRESETS, MAX_RANGE_DAYS, emptyCounts, handedToProvider, describeTemplateKey,
  TYPE_CATEGORY_LABEL,
  type AnalyticsChannel, type ChannelFilter, type Outcome, type OutcomeCounts, type RangePreset, type PeriodSummary,
  type ChannelSummary, type TrendBucket, type TypeRow, type TypeCategory, type TemplateRow, type Insight,
  type CapacitySummary, type CommunicationAnalyticsResponse, type TemplateKind,
} from './types'

// ─── Periods ────────────────────────────────────────────────────────────────

export interface ResolvedPeriod { from: string; to: string; days: number; startUtc: Date; endUtcExclusive: Date }
export type PeriodResult =
  | { ok: true; current: ResolvedPeriod; previous: ResolvedPeriod; bucket: 'day' | 'week' }
  | { ok: false; error: string }

/** The calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function isoDateInTz(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

function period(from: string, to: string, tz: string): ResolvedPeriod | null {
  const r = zonedDayRange(from, to, tz)
  return r.ok ? { from, to, days: dayDiff(from, to) + 1, startUtc: r.range.startUtc, endUtcExclusive: r.range.endUtcExclusive } : null
}

/**
 * Presets end TODAY (in the event's zone) and include it. The previous period is the same number
 * of days immediately before. Custom ranges are inclusive, at most MAX_RANGE_DAYS, not in the future.
 */
export function resolvePeriods(p: { range: RangePreset; from?: string | null; to?: string | null }, tz: string, now: Date): PeriodResult {
  const today = isoDateInTz(now, tz)
  let from: string, to: string
  if (p.range === 'custom') {
    if (!p.from || !p.to || !isValidISODate(p.from) || !isValidISODate(p.to)) return { ok: false, error: 'Choose a start and end date.' }
    if (p.from > p.to) return { ok: false, error: 'The start date is after the end date.' }
    if (p.to > today) return { ok: false, error: 'The end date is in the future.' }
    if (dayDiff(p.from, p.to) + 1 > MAX_RANGE_DAYS) return { ok: false, error: `Choose a range of at most ${MAX_RANGE_DAYS} days.` }
    from = p.from; to = p.to
  } else {
    const preset = RANGE_PRESETS.find(r => r.id === p.range)
    if (!preset) return { ok: false, error: 'Unknown range.' }
    to = today; from = shiftISODate(today, -(preset.days - 1))
  }
  const days = dayDiff(from, to) + 1
  const current = period(from, to, tz)
  const previous = period(shiftISODate(from, -days), shiftISODate(from, -1), tz)
  if (!current || !previous) return { ok: false, error: 'Invalid date range.' }
  return { ok: true, current, previous, bucket: days > 31 ? 'week' : 'day' }
}

// ─── Rows → outcomes ────────────────────────────────────────────────────────

/** The projected emailLogs fields analytics reads. No recipient data. */
export interface LogRow {
  createdAtMs: number
  status:      string
  channel:     AnalyticsChannel
  deliveryUnknown: boolean
  waStatus:    string | null
  templateKey: string
  campaignId:  string | null
  /** Only used to recognise a capacity / wallet skip; never returned. */
  error:       string | null
}

/** One row's outcome. Mirrors lib/communications/messageStatus (unknown wins over failed). */
export function outcomeOf(r: Pick<LogRow, 'status' | 'deliveryUnknown'>): Outcome {
  if (r.deliveryUnknown && r.status !== 'sent' && r.status !== 'delivered') return 'unknown'
  switch (r.status) {
    case 'delivered': return 'delivered'
    case 'sent':      return 'accepted'
    case 'failed':    return 'failed'
    case 'skipped':   return 'skipped'
    default:          return 'queued'
  }
}

function add(c: OutcomeCounts, r: LogRow) {
  c.attempts++
  c[outcomeOf(r)]++
  if (r.waStatus === 'read') c.read++
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null)

function channelSummary(channel: AnalyticsChannel, counts: OutcomeCounts): ChannelSummary {
  const handed = handedToProvider(counts)
  const confirmationsRecorded = counts.delivered > 0
  return {
    channel, counts,
    deliveryRate: confirmationsRecorded ? pct(counts.delivered, handed) : null,
    acceptanceRate: pct(counts.accepted + counts.delivered, handed),
    confirmationsRecorded,
  }
}

export function matchesFilters(r: LogRow, f: { channel: ChannelFilter; type: TypeCategory | null }): boolean {
  if (f.channel !== 'all' && r.channel !== f.channel) return false
  if (f.type && describeTemplateKey(r.templateKey).category !== f.type) return false
  return true
}

export function summarize(rows: LogRow[], p: { from: string; to: string; scanned: number; truncated: boolean }): PeriodSummary {
  const counts = emptyCounts()
  const by: Record<AnalyticsChannel, OutcomeCounts> = { email: emptyCounts(), whatsapp: emptyCounts() }
  for (const r of rows) { add(counts, r); add(by[r.channel], r) }
  const channels = { email: channelSummary('email', by.email), whatsapp: channelSummary('whatsapp', by.whatsapp) }
  // The overall rate only counts channels whose provider reports delivery at all.
  const rateChannels = (['email', 'whatsapp'] as const).filter(c => channels[c].confirmationsRecorded)
  const delivered = rateChannels.reduce((s, c) => s + by[c].delivered, 0)
  const handed = rateChannels.reduce((s, c) => s + handedToProvider(by[c]), 0)
  return {
    from: p.from, to: p.to, counts, channels,
    deliveryRate: rateChannels.length ? pct(delivered, handed) : null,
    rateChannels: [...rateChannels], scanned: p.scanned, truncated: p.truncated,
  }
}

// ─── Trend ──────────────────────────────────────────────────────────────────

const WEEKDAY = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()   // 0 = Sunday
const shortLabel = (iso: string) => {
  const [, m, d] = iso.split('-')
  return `${Number(d)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]}`
}

/** Every day (or Monday-started week) of the period, including empty ones. */
export function buildTrend(rows: LogRow[], period: { from: string; to: string }, bucket: 'day' | 'week', tz: string): TrendBucket[] {
  const keyOf = (iso: string) => (bucket === 'day' ? iso : shiftISODate(iso, -((WEEKDAY(iso) + 6) % 7)))
  const buckets = new Map<string, TrendBucket>()
  for (let d = period.from; d <= period.to; d = shiftISODate(d, 1)) {
    const k = keyOf(d)
    if (!buckets.has(k)) {
      const first = k < period.from ? period.from : k
      buckets.set(k, { key: k, label: bucket === 'day' ? shortLabel(d) : `Week of ${shortLabel(first)}`, email: emptyCounts(), whatsapp: emptyCounts() })
    }
  }
  for (const r of rows) {
    const b = buckets.get(keyOf(isoDateInTz(new Date(r.createdAtMs), tz)))
    if (b) add(b[r.channel], r)
  }
  return [...buckets.values()]
}

// ─── Types ──────────────────────────────────────────────────────────────────

export function buildTypes(rows: LogRow[]): TypeRow[] {
  const by = new Map<TypeCategory, OutcomeCounts>()
  for (const r of rows) {
    const cat = describeTemplateKey(r.templateKey).category
    if (!by.has(cat)) by.set(cat, emptyCounts())
    add(by.get(cat)!, r)
  }
  return [...by.entries()]
    .map(([category, counts]) => ({ category, label: TYPE_CATEGORY_LABEL[category], counts, deliveryRate: counts.delivered > 0 ? pct(counts.delivered, handedToProvider(counts)) : null }))
    .sort((a, b) => b.counts.attempts - a.counts.attempts)
}

// ─── Templates ──────────────────────────────────────────────────────────────

/** What a broadcast campaign sent with, from broadcastCampaigns/{id} (verified owner). */
export interface CampaignTemplateMeta {
  channel: AnalyticsChannel
  /** RD-WA-TEMPLATES-01 — an organizer template pinned to one version. */
  customTemplate: { templateId: string; version: number } | null
  /** A RegisterDesk (registry) WhatsApp template type. */
  templateType: string | null
  subject: string | null
}

const templateNameFromId = (id: string) => id.replace(/^wt_[a-f0-9]{10}_/, '')

export function buildTemplates(rows: LogRow[], campaigns: ReadonlyMap<string, CampaignTemplateMeta | null>, links: { eventId: string | null }): TemplateRow[] {
  const map = new Map<string, TemplateRow & { lastMs: number }>()
  const ev = links.eventId ? `&eventId=${encodeURIComponent(links.eventId)}` : ''
  for (const r of rows) {
    let key: string, label: string, kind: TemplateKind, category: string | null = null, version: number | null = null, href: string | null = null
    if (r.campaignId) {
      const c = campaigns.get(r.campaignId)
      if (c?.customTemplate) {
        // Versions are NEVER merged: each version is its own Meta template and its own row.
        key = `wa:custom:${c.customTemplate.templateId}:v${c.customTemplate.version}`
        label = templateNameFromId(c.customTemplate.templateId); version = c.customTemplate.version; kind = 'whatsapp_custom'
        href = `/dashboard/communications?tab=templates&template=${encodeURIComponent(c.customTemplate.templateId)}${ev}`
      } else if (c?.templateType) {
        key = `wa:platform:${c.templateType}`; label = describeTemplateKey(c.templateType).label; kind = 'whatsapp_platform'
        category = 'Broadcast'
      } else if (c && c.channel === 'email') {
        key = `email:campaign:${r.campaignId}`; label = c.subject ? `Email · ${c.subject.slice(0, 80)}` : 'Email broadcast'; kind = 'email_broadcast'
        category = 'Broadcast'
      } else {
        key = `broadcast:unknown:${r.channel}`; label = 'Broadcast (details unavailable)'; kind = 'broadcast_unknown'
      }
      href = href ?? `/dashboard/communications?tab=broadcasts${ev}`
    } else {
      const d = describeTemplateKey(r.templateKey)
      key = `tx:${r.channel}:${r.templateKey || 'unlabelled'}`; label = d.label; kind = 'transactional'; category = TYPE_CATEGORY_LABEL[d.category]
      href = `/dashboard/communications?tab=messages${ev}&msgType=${encodeURIComponent(r.templateKey)}&msgChannel=${r.channel}`
    }
    let row = map.get(key)
    if (!row) {
      row = { key, label, kind, channel: r.channel, category, version, counts: emptyCounts(), deliveryRate: null, failureRate: null, lastActivity: null, href, lastMs: 0 }
      map.set(key, row)
    }
    add(row.counts, r)
    if (r.createdAtMs > row.lastMs) row.lastMs = r.createdAtMs
  }
  return [...map.values()].map(({ lastMs, ...row }) => {
    const handed = handedToProvider(row.counts)
    return {
      ...row,
      deliveryRate: row.counts.delivered > 0 ? pct(row.counts.delivered, handed) : null,
      failureRate: pct(row.counts.failed, handed),
      lastActivity: lastMs ? new Date(lastMs).toISOString() : null,
    }
  }).sort((a, b) => b.counts.attempts - a.counts.attempts || a.label.localeCompare(b.label))
}

/** Historical WhatsApp skips caused by missing capacity / balance (never re-sent from here). */
export const countCapacitySkips = (rows: LogRow[]) =>
  rows.filter(r => r.channel === 'whatsapp' && isWalletSkippedWhatsAppLog({ status: r.status, error: r.error })).length

// ─── Insights ───────────────────────────────────────────────────────────────

/** Below this many messages handed to a provider, rates are too noisy to act on. */
export const MIN_SAMPLE = 20

export function buildInsights(a: {
  current: PeriodSummary; templates: TemplateRow[]; capacity: CapacitySummary | null; eventId: string | null
}): Insight[] {
  const out: Insight[] = []
  const ev = a.eventId ? `&eventId=${encodeURIComponent(a.eventId)}` : ''
  const c = a.current.counts
  const handed = handedToProvider(c)
  if (a.current.truncated) {
    out.push({ kind: 'info', id: 'partial', title: 'Figures cover the most recent messages only', detail: `This period has more than ${a.current.scanned.toLocaleString('en-IN')} messages, so totals and rates are partial. Choose a shorter range for complete figures.`, href: null, cta: null })
  }
  if (handed >= MIN_SAMPLE && c.failed >= 5 && c.failed / handed >= 0.1) {
    out.push({ kind: 'action', id: 'failures', title: `${c.failed.toLocaleString('en-IN')} messages failed (${pct(c.failed, handed)}%)`, detail: 'That is above 10% of the messages handed to a provider. Review the failure reasons in Messages.', href: `/dashboard/communications?tab=messages${ev}&msgStatus=failed`, cta: 'Review failed messages' })
  } else if (c.failed > 0) {
    out.push({ kind: 'info', id: 'failures-low', title: `${c.failed.toLocaleString('en-IN')} message${c.failed === 1 ? '' : 's'} failed`, detail: handed < MIN_SAMPLE ? 'Too few messages in this period to judge a trend.' : 'Within the normal range for this period.', href: `/dashboard/communications?tab=messages${ev}&msgStatus=failed`, cta: 'View' })
  }
  for (const t of a.templates) {
    const h = handedToProvider(t.counts)
    if (h >= MIN_SAMPLE && t.counts.failed >= 5 && (t.failureRate ?? 0) >= 15) {
      out.push({ kind: 'action', id: `tpl:${t.key}`, title: `“${t.label}”${t.version ? ` v${t.version}` : ''} fails often (${t.failureRate}%)`, detail: `${t.counts.failed} of ${h} messages failed. Check the template and the recipients’ details.`, href: t.href, cta: 'Inspect' })
    }
  }
  if (c.unknown > 0) {
    out.push({ kind: c.unknown >= 5 ? 'action' : 'info', id: 'unknown', title: `${c.unknown.toLocaleString('en-IN')} message${c.unknown === 1 ? ' has' : 's have'} an unknown outcome`, detail: 'The provider never gave a definite answer. They are not re-sent automatically, to avoid duplicates.', href: `/dashboard/communications?tab=messages${ev}&msgStatus=unknown`, cta: 'Investigate' })
  }
  const email = a.current.channels.email
  if (handedToProvider(email.counts) > 0 && !email.confirmationsRecorded) {
    out.push({ kind: 'info', id: 'email-unconfirmed', title: 'Email delivery is not being confirmed', detail: 'Emails were accepted by the provider, but no delivery reports were recorded in this period, so email shows as “accepted”, not “delivered”.', href: null, cta: null })
  }
  const f = a.capacity?.figures
  if (f && f.purchased > 0 && f.available <= Math.max(1, Math.floor(f.purchased * 0.1))) {
    out.push({ kind: 'action', id: 'capacity-low', title: f.available === 0 ? 'No WhatsApp capacity left' : `Only ${f.available.toLocaleString('en-IN')} WhatsApp messages left`, detail: 'New WhatsApp messages for this event will be skipped once capacity runs out.', href: `/dashboard/communications?tab=usage${ev}`, cta: 'Review capacity' })
  }
  if (a.capacity && a.capacity.capacitySkipped > 0) {
    out.push({ kind: 'info', id: 'capacity-skipped', title: `${a.capacity.capacitySkipped.toLocaleString('en-IN')} WhatsApp message${a.capacity.capacitySkipped === 1 ? ' was' : 's were'} skipped for lack of capacity`, detail: 'They were never sent and are not re-sent automatically. Recovery needs your approval in Messages.', href: `/dashboard/communications?tab=messages${ev}&msgStatus=skipped&msgChannel=whatsapp`, cta: 'View skipped' })
  }
  return out
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/** RFC 4180 quoting + spreadsheet-formula neutralisation (= + - @ tab CR at the start). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const COUNT_COLS = ['attempts', ...OUTCOMES, 'read'] as const

/** Aggregates only — no recipient names, emails or phone numbers. */
export function analyticsCsv(a: CommunicationAnalyticsResponse): string {
  const lines: string[] = []
  const row = (...cells: unknown[]) => lines.push(cells.map(csvCell).join(','))
  const counts = (c: OutcomeCounts) => COUNT_COLS.map(k => c[k as keyof OutcomeCounts])
  row('scope', a.scope.kind === 'event' ? (a.scope.eventName ?? a.scope.eventId) : 'All events', 'timezone', a.scope.timezone, 'period', `${a.current.from} to ${a.current.to}`, 'channel', a.filters.channel, 'type', a.filters.type ?? 'all')
  if (a.current.truncated) row('note', `partial: only the most recent ${a.current.scanned} messages were read`)
  row()
  row('section', 'label', 'channel', 'version', ...COUNT_COLS, 'delivery_rate_pct', 'failure_rate_pct', 'last_activity')
  row('total', 'Current period', a.filters.channel, '', ...counts(a.current.counts), a.current.deliveryRate ?? '', '', '')
  if (a.previous) row('total', 'Previous period', a.filters.channel, '', ...counts(a.previous.counts), a.previous.deliveryRate ?? '', '', '')
  for (const ch of ['email', 'whatsapp'] as const) {
    const s = a.current.channels[ch]
    row('channel', ch, ch, '', ...counts(s.counts), s.deliveryRate ?? '', '', '')
  }
  for (const t of a.types) row('type', t.label, '', '', ...counts(t.counts), t.deliveryRate ?? '', '', '')
  for (const t of a.templates) row('template', t.label, t.channel, t.version ?? '', ...counts(t.counts), t.deliveryRate ?? '', t.failureRate ?? '', t.lastActivity ?? '')
  for (const b of a.trend) for (const ch of ['email', 'whatsapp'] as const) row('trend', b.key, ch, '', ...counts(b[ch]), '', '', '')
  return lines.join('\r\n') + '\r\n'
}
