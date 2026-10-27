// RD-COMMS-ANALYTICS-02 (unit) — Communication Analytics: outcome model and rate denominators,
// date-range boundaries in the event's timezone, previous-period comparison, duplicate / repeated
// provider status updates, template-version separation, insight thresholds, CSV escaping, the
// route's authorization contract, and accessible chart markup.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  resolvePeriods, isoDateInTz, outcomeOf, summarize, buildTrend, buildTypes, buildTemplates, buildInsights,
  countCapacitySkips, csvCell, analyticsCsv, matchesFilters, MIN_SAMPLE, type LogRow, type CampaignTemplateMeta,
} from '@/lib/communications/organizerAnalytics/compute'
import { describeTemplateKey, handedToProvider, type CommunicationAnalyticsResponse, type CapacitySummary } from '@/lib/communications/organizerAnalytics/types'
import { WHATSAPP_CAPACITY_SKIP_REASON } from '@/lib/email-logs/types'
import { OutcomeTrend, ChannelTrend } from '@/components/communications/analytics/TrendCharts'

const TZ = 'Asia/Kolkata'
const at = (iso: string) => Date.parse(iso)
const row = (o: Partial<LogRow> = {}): LogRow => ({
  createdAtMs: at('2026-10-20T06:00:00Z'), status: 'sent', channel: 'email', deliveryUnknown: false, waStatus: null,
  templateKey: 'registration_submitted', campaignId: null, error: null, ...o,
})
const P = { from: '2026-10-14', to: '2026-10-20', scanned: 0, truncated: false }

describe('outcome model', () => {
  it('maps every stored state; an unanswered send is "unknown", never failed or delivered', () => {
    expect(outcomeOf({ status: 'delivered', deliveryUnknown: false })).toBe('delivered')
    expect(outcomeOf({ status: 'sent', deliveryUnknown: false })).toBe('accepted')
    expect(outcomeOf({ status: 'failed', deliveryUnknown: false })).toBe('failed')
    expect(outcomeOf({ status: 'failed', deliveryUnknown: true })).toBe('unknown')
    expect(outcomeOf({ status: 'sent', deliveryUnknown: true })).toBe('accepted')          // a later acceptance wins
    expect(outcomeOf({ status: 'skipped', deliveryUnknown: false })).toBe('skipped')
    expect(outcomeOf({ status: 'queued', deliveryUnknown: false })).toBe('queued')
    expect(outcomeOf({ status: 'weird', deliveryUnknown: false })).toBe('queued')
  })

  it('one row is one message: repeated status updates (sent → delivered → read) count once, read is extra detail', () => {
    // The webhook only moves a row forward in place, so the final row is what analytics sees.
    const s = summarize([row({ channel: 'whatsapp', status: 'delivered', waStatus: 'read' })], P)
    expect(s.counts).toMatchObject({ attempts: 1, delivered: 1, read: 1, accepted: 0 })
  })
})

describe('KPI denominators', () => {
  const rows = [
    ...Array.from({ length: 6 }, () => row({ channel: 'whatsapp', status: 'delivered' })),
    row({ channel: 'whatsapp', status: 'sent' }),
    row({ channel: 'whatsapp', status: 'failed' }),
    row({ channel: 'whatsapp', status: 'failed', deliveryUnknown: true }),
    row({ channel: 'whatsapp', status: 'skipped' }),
    ...Array.from({ length: 10 }, () => row({ channel: 'email', status: 'sent' })),
    row({ channel: 'email', status: 'skipped' }),
  ]
  const s = summarize(rows, P)

  it('totals are never merged across outcomes', () => {
    expect(s.counts).toMatchObject({ attempts: 21, delivered: 6, accepted: 11, failed: 1, unknown: 1, skipped: 2, queued: 0 })
    expect(handedToProvider(s.counts)).toBe(19)                 // skipped never handed over
  })
  it('delivery rate = delivered ÷ handed over, ONLY for channels that report delivery', () => {
    expect(s.channels.whatsapp.deliveryRate).toBe(66.7)           // 6 / 9
    expect(s.channels.email.deliveryRate).toBeNull()              // accepted, no confirmations ⇒ not 0 %
    expect(s.channels.email.acceptanceRate).toBe(100)
    expect(s.rateChannels).toEqual(['whatsapp'])
    expect(s.deliveryRate).toBe(66.7)                             // email does not deflate it
  })
  it('no confirmations anywhere ⇒ no rate; an empty period ⇒ no rate (never 100 %)', () => {
    expect(summarize([row()], P).deliveryRate).toBeNull()
    const e = summarize([], P)
    expect(e.deliveryRate).toBeNull()
    expect(e.channels.email.acceptanceRate).toBeNull()
  })
  it('channel and type filters; a row with no channel is email', () => {
    expect(matchesFilters(row({ channel: 'email' }), { channel: 'whatsapp', type: null })).toBe(false)
    expect(matchesFilters(row({ templateKey: 'event_reminder' }), { channel: 'all', type: 'reminders' })).toBe(true)
    expect(matchesFilters(row({ templateKey: 'broadcast' }), { channel: 'all', type: 'reminders' })).toBe(false)
  })
})

describe('periods in the event timezone', () => {
  const now = new Date('2026-10-26T20:00:00Z')                    // 01:30 on 27 Oct in Kolkata
  it('presets end today IN THE EVENT ZONE and include it; the previous period is the same length just before', () => {
    const r = resolvePeriods({ range: '7d' }, TZ, now)
    if (!r.ok) throw new Error(r.error)
    expect([r.current.from, r.current.to, r.current.days]).toEqual(['2026-10-21', '2026-10-27', 7])
    expect([r.previous.from, r.previous.to, r.previous.days]).toEqual(['2026-10-14', '2026-10-20', 7])
    expect(r.current.startUtc.toISOString()).toBe('2026-10-20T18:30:00.000Z')          // 21 Oct 00:00 IST
    expect(r.current.endUtcExclusive.toISOString()).toBe('2026-10-27T18:30:00.000Z')   // half-open
    expect(r.previous.endUtcExclusive.getTime()).toBe(r.current.startUtc.getTime())   // no gap, no overlap
    expect(r.bucket).toBe('day')
    expect((resolvePeriods({ range: '90d' }, TZ, now) as { bucket: string }).bucket).toBe('week')
  })
  it('custom ranges are validated', () => {
    expect(resolvePeriods({ range: 'custom', from: '2026-10-10', to: '2026-10-01' }, TZ, now)).toMatchObject({ ok: false })
    expect(resolvePeriods({ range: 'custom', from: '2026-10-10', to: '2026-10-30' }, TZ, now)).toMatchObject({ ok: false, error: 'The end date is in the future.' })
    expect(resolvePeriods({ range: 'custom', from: '2026-01-01', to: '2026-10-01' }, TZ, now)).toMatchObject({ ok: false })
    expect(resolvePeriods({ range: 'custom', from: 'x', to: '2026-10-01' }, TZ, now)).toMatchObject({ ok: false })
    const ok = resolvePeriods({ range: 'custom', from: '2026-10-01', to: '2026-10-01' }, TZ, now)
    expect(ok).toMatchObject({ ok: true, current: { days: 1 }, previous: { from: '2026-09-30', to: '2026-09-30' } })
  })
  it('a message at 23:59 IST and one at 00:00 IST fall on different days', () => {
    expect(isoDateInTz(new Date('2026-10-20T18:29:59Z'), TZ)).toBe('2026-10-20')
    expect(isoDateInTz(new Date('2026-10-20T18:30:00Z'), TZ)).toBe('2026-10-21')
    const t = buildTrend([row({ createdAtMs: at('2026-10-20T18:29:59Z') }), row({ createdAtMs: at('2026-10-20T18:30:00Z') })], { from: '2026-10-20', to: '2026-10-21' }, 'day', TZ)
    expect(t.map(b => [b.key, b.email.attempts])).toEqual([['2026-10-20', 1], ['2026-10-21', 1]])
  })
  it('every day is present (empty ones too); weeks start Monday and are labelled from the period start', () => {
    expect(buildTrend([], { from: '2026-10-14', to: '2026-10-20' }, 'day', TZ)).toHaveLength(7)
    const w = buildTrend([], { from: '2026-10-01', to: '2026-10-31' }, 'week', TZ)   // Thu 1 Oct … Sat 31 Oct
    expect(w[0]).toMatchObject({ key: '2026-09-28', label: 'Week of 1 Oct' })
    expect(w.map(b => b.key)).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'])
  })
})

describe('types and templates', () => {
  it('notification types are dynamic: known keys, registry types, and unknown keys kept as Other', () => {
    expect(describeTemplateKey('event_reminder')).toEqual({ label: 'Event reminder', category: 'reminders' })
    expect(describeTemplateKey('CERTIFICATE_READY').category).toBe('certificates')
    expect(describeTemplateKey('something_new')).toEqual({ label: 'Something new', category: 'other' })
    const t = buildTypes([row({ templateKey: 'event_reminder' }), row({ templateKey: 'event_reminder', status: 'failed' }), row({ templateKey: 'zzz' })])
    expect(t.map(x => [x.category, x.counts.attempts, x.counts.failed])).toEqual([['reminders', 2, 1], ['other', 1, 0]])
  })

  it('WhatsApp template versions are never merged; unknown campaigns are labelled, not dropped', () => {
    const campaigns = new Map<string, CampaignTemplateMeta | null>([
      ['c1', { channel: 'whatsapp', customTemplate: { templateId: 'wt_0123456789_kit_pickup', version: 1 }, templateType: null, subject: null }],
      ['c2', { channel: 'whatsapp', customTemplate: { templateId: 'wt_0123456789_kit_pickup', version: 2 }, templateType: null, subject: null }],
      ['c3', { channel: 'whatsapp', customTemplate: null, templateType: 'KIT_COLLECTION', subject: null }],
      ['c4', { channel: 'email', customTemplate: null, templateType: null, subject: '=HYPERLINK("x")' }],
      ['gone', null],
    ])
    const rows = [
      row({ channel: 'whatsapp', templateKey: 'broadcast', campaignId: 'c1', status: 'delivered' }),
      row({ channel: 'whatsapp', templateKey: 'broadcast', campaignId: 'c1', status: 'failed' }),
      row({ channel: 'whatsapp', templateKey: 'broadcast', campaignId: 'c2', status: 'delivered' }),
      row({ channel: 'whatsapp', templateKey: 'broadcast', campaignId: 'c3' }),
      row({ channel: 'email', templateKey: 'broadcast', campaignId: 'c4' }),
      row({ channel: 'whatsapp', templateKey: 'broadcast', campaignId: 'gone' }),
      row({ templateKey: 'registration_submitted', createdAtMs: at('2026-10-21T00:00:00Z') }),
    ]
    const t = buildTemplates(rows, campaigns, { eventId: 'draft-1' })
    const byKey = Object.fromEntries(t.map(x => [x.key, x]))
    expect(byKey['wa:custom:wt_0123456789_kit_pickup:v1']).toMatchObject({ label: 'kit_pickup', version: 1, counts: { attempts: 2, delivered: 1, failed: 1 }, failureRate: 50 })
    expect(byKey['wa:custom:wt_0123456789_kit_pickup:v2']).toMatchObject({ version: 2, counts: { attempts: 1 } })
    expect(byKey['wa:custom:wt_0123456789_kit_pickup:v1'].href).toBe('/dashboard/communications?tab=templates&template=wt_0123456789_kit_pickup&eventId=draft-1')
    expect(byKey['wa:platform:KIT_COLLECTION'].kind).toBe('whatsapp_platform')
    expect(byKey['email:campaign:c4'].label).toBe('Email · =HYPERLINK("x")')
    expect(byKey['broadcast:unknown:whatsapp'].label).toBe('Broadcast (details unavailable)')
    expect(byKey['tx:email:registration_submitted']).toMatchObject({ lastActivity: '2026-10-21T00:00:00.000Z', href: '/dashboard/communications?tab=messages&eventId=draft-1&msgType=registration_submitted&msgChannel=email' })
    expect(t[0].counts.attempts).toBeGreaterThanOrEqual(t[t.length - 1].counts.attempts)   // ranked
  })

  it('capacity skips are recognised from the stored reason (history only)', () => {
    expect(countCapacitySkips([
      row({ channel: 'whatsapp', status: 'skipped', error: WHATSAPP_CAPACITY_SKIP_REASON }),
      row({ channel: 'whatsapp', status: 'skipped', error: 'Recipient opted out' }),
      row({ channel: 'email', status: 'skipped', error: WHATSAPP_CAPACITY_SKIP_REASON }),
    ])).toBe(1)
  })
})

describe('insights only when the data justifies them', () => {
  const cap = (over: Partial<CapacitySummary> = {}): CapacitySummary => ({ figures: { purchased: 100, used: 50, inProgress: 0, returned: 0, refunded: 0, carriedIn: 0, carriedOut: 0, available: 50 }, capacitySkipped: 0, unavailableReason: null, ...over })
  const ids = (rows: LogRow[], c = cap()) => { const current = summarize(rows, P); return buildInsights({ current, templates: buildTemplates(rows, new Map(), { eventId: 'e' }), capacity: c, eventId: 'e' }).map(i => `${i.kind}:${i.id}`) }

  it('a small sample never produces an action', () => {
    const small = [...Array.from({ length: 5 }, () => row({ status: 'failed' })), row({ status: 'delivered' })]
    expect(handedToProvider(summarize(small, P).counts)).toBeLessThan(MIN_SAMPLE)
    expect(ids(small)).toContain('info:failures-low')
    expect(ids(small).some(i => i.startsWith('action:'))).toBe(false)
  })
  it('a high failure rate on enough messages is actionable, as is a failing template', () => {
    const many = [...Array.from({ length: 6 }, () => row({ status: 'failed' })), ...Array.from({ length: 20 }, () => row({ status: 'delivered' }))]
    expect(ids(many)).toEqual(expect.arrayContaining(['action:failures', 'action:tpl:tx:email:registration_submitted']))
  })
  it('unknown outcomes, unconfirmed email, low capacity and capacity skips', () => {
    expect(ids([row({ status: 'failed', deliveryUnknown: true })])).toContain('info:unknown')
    expect(ids([row({ status: 'sent' })])).toContain('info:email-unconfirmed')
    expect(ids([row()], cap({ figures: { purchased: 100, used: 95, inProgress: 0, returned: 0, refunded: 0, carriedIn: 0, carriedOut: 0, available: 5 } }))).toContain('action:capacity-low')
    expect(ids([row()], cap({ capacitySkipped: 3 }))).toContain('info:capacity-skipped')
    expect(ids([row()], cap())).not.toContain('action:capacity-low')
  })
})

describe('CSV', () => {
  it('escapes quotes, commas and newlines, and neutralises spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    for (const f of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx']) expect(csvCell(f).replace(/^"/, '').startsWith("'")).toBe(true)
    expect(csvCell(null)).toBe('')
    expect(csvCell(42)).toBe('42')
  })
  it('contains aggregates only — no recipient fields — and states partial data', () => {
    const current = { ...summarize([row({ channel: 'whatsapp', status: 'delivered' })], P), truncated: true, scanned: 5000 }
    const data: CommunicationAnalyticsResponse = {
      scope: { kind: 'event', eventId: 'd1', eventName: 'City Run, 2026', timezone: TZ }, filters: { range: '7d', channel: 'all', type: null }, bucket: 'day',
      current, previous: null, comparable: false, trend: buildTrend([], P, 'day', TZ), previousTrend: null, types: [], templates: buildTemplates([row({ templateKey: 'event_reminder' })], new Map(), { eventId: 'd1' }),
      capacity: null, insights: [], generatedAt: '2026-10-26T00:00:00Z',
    }
    const csv = analyticsCsv(data)
    expect(csv).toContain('"City Run, 2026"')
    expect(csv).toContain('partial: only the most recent 5000 messages were read')
    expect(csv).toMatch(/^section,label,channel,version,attempts,delivered,accepted,failed,unknown,skipped,queued,read,/m)
    expect(csv).not.toMatch(/@|recipient|phone/i)
    expect(csv.endsWith('\r\n')).toBe(true)
  })
})

describe('route contract', () => {
  const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  it('one event → authorizeEvent; all events → refused for event-restricted members; workspace uid from auth', () => {
    const src = code('app/api/organizer/communications/analytics/route.ts')
    expect(src).toContain("authorizeEvent(req, 'broadcasts', eventParam)")
    expect(src).toContain("authorizeWorkspace(req, 'broadcasts')")
    expect(src).toContain('if (all && !authz.isOwner && authz.eventIds.length > 0)')
    expect(src).toContain('uid: authz.workspaceUid')
  })
  it('the read is bounded, projected, server-filtered by workspace, and never writes', () => {
    const src = code('lib/communications/organizerAnalytics/read.ts')
    expect(src).toContain(".where('organizerUid', '==', uid)")
    expect(src).toContain('.select(...FIELDS)')
    expect(src).toContain('.limit(SCAN_CAP + 1)')
    expect(src).toContain('d.organizerUid !== uid')                          // campaign metadata ownership
    expect(src).toMatch(/getEventCommunicationUsage\(/)                       // the ONE capacity source
    // No Firestore writes (a Map's .set is not one).
    expect(src).not.toMatch(/runTransaction|\.batch\(|\.(update|add|create|delete)\(|(ref|doc\([^)]*\))\.set\(/)
    expect(src).not.toMatch(/recipientEmail|recipientPhone|recipientName/)
  })
})

describe('charts are accessible', () => {
  const trend = buildTrend([row({ status: 'delivered', createdAtMs: at('2026-10-15T06:00:00Z') })], P, 'day', TZ)
  it('focusable columns announce their breakdown, and a data table carries every number', () => {
    const html = renderToStaticMarkup(createElement(OutcomeTrend, { trend, label: 'Delivery outcomes over time' }))
    expect(html).toContain('aria-label="15 Oct: 1 messages — Delivered: 1"')
    expect(html).toContain('tabindex="0"')
    // sr-only sits on a wrapper: on a <table> itself it does not shrink it (390px overflow, QA).
    expect(html).toContain('<div class="sr-only"><table><caption>Delivery outcomes over time</caption>')
    expect(html).not.toContain('<table class="sr-only"')
    expect(html.match(/<th scope="row">/g)).toHaveLength(7)
  })
  it('an empty period says so instead of drawing nothing', () => {
    const html = renderToStaticMarkup(createElement(ChannelTrend, { trend: buildTrend([], P, 'day', TZ), previous: null, label: 'x' }))
    expect(html).toContain('No messages in this period.')
  })
})
