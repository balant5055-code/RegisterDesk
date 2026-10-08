// RD-ANALYTICS-12-28 · Communication Intelligence.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// The audit approved a narrow set of metrics on the condition that each one is an aggregate
// over a PERSISTED field, windowed in IST, compared through the one comparison model, and
// unmeasured — never zero — when its read did not answer. Every group below pins one of
// those conditions, and the source-level cases pin the reads themselves: the campaign count
// comes from campaign documents, the windowed reads never touch `deliveryUnknown`, every
// new query names its workspace, and nothing new fetches a document page.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildCommunicationIntelligence, communicationVelocity, channelMix, windowedTotals,
  unmeasuredCommunicationIntelligence,
} from '@/lib/analytics/communicationIntelligence'
import {
  campaignRows, compositionRows, signalRows, windowChannelRows, displayCommunicationVelocity,
} from '@/lib/analytics/communicationsModel'
import { istRangeBounds } from '@/lib/analytics/revenueIntelligence'
import { dayKey } from '@/lib/dashboard/dailyStats'
import { presetRange, type AnalyticsDateRange } from '@/lib/analytics/dateRange'
import { normalizeEventAnalytics } from '@/lib/analytics/normalize'
import type { AnalyticsModuleContext } from '@/lib/analytics/modules'
import type { EventAnalytics } from '@/lib/analytics/eventAnalytics'
import type {
  CampaignCounts, CommunicationSignals, WindowedCommunicationCounts, WindowedChannelCounts,
} from '@/lib/analytics/communicationsSources'
import type { ChannelDelivery } from '@/lib/analytics/contract'

/** Source with comments stripped — prose about a rule must not satisfy its own guard. */
const code = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const SOURCES = code('lib/analytics/communicationsSources.ts')
const ENGINE  = code('lib/analytics/eventAnalytics.ts')
const PURE    = code('lib/analytics/communicationIntelligence.ts')
const CONTRACT = code('lib/analytics/contract.ts')
const UI      = code('components/analytics/communications/CommunicationsAnalytics.tsx')

const RANGE: AnalyticsDateRange = presetRange('30d', Date.parse('2026-06-15T12:00:00Z'))

const win = (o: Partial<WindowedChannelCounts> = {}): WindowedChannelCounts => ({
  attempted: 100, delivered: 80, notDelivered: 15, queued: 2, skipped: 3, ...o,
})
const both = (e?: Partial<WindowedChannelCounts>, w?: Partial<WindowedChannelCounts>): WindowedCommunicationCounts =>
  ({ email: win(e), whatsapp: win(w) })

const campaigns = (o: Partial<CampaignCounts> = {}): CampaignCounts => ({
  created: 6, completed: 4, scheduled: 1, period: 2, baseline: 1, ...o,
})
const signals = (o: Partial<CommunicationSignals> = {}): CommunicationSignals => ({
  broadcast: 5_000, automatic: 1_200, bounces: 12, complaints: 1, read: 300, walletSkipped: 7, ...o,
})
const ch = (o: Partial<ChannelDelivery> = {}): ChannelDelivery => ({
  sent: 1_000, delivered: 900, failed: 20, unknown: 80, queued: 0, skipped: 5, ...o,
})

const build = (o: Partial<Parameters<typeof buildCommunicationIntelligence>[0]> = {}) =>
  buildCommunicationIntelligence({
    range: RANGE, campaigns: campaigns(), signals: signals(),
    period: both(), baseline: both({ attempted: 50, delivered: 40, notDelivered: 5 }, { attempted: 50, delivered: 40, notDelivered: 5 }),
    baselineReason: 'no_baseline',
    lifetimeEmail: ch(), lifetimeWhatsapp: ch({ sent: 500, delivered: 400 }),
    ...o,
  })

// ─── Core: zero, positive, read failure, unsupported, partial ────────────────

describe('RD-ANALYTICS-12-28 · core absence discipline', () => {
  it('1 · a measured zero is 0 on every figure — a silent event is not an unread one', () => {
    const z = build({
      campaigns: campaigns({ created: 0, completed: 0, scheduled: 0, period: 0, baseline: 0 }),
      signals: signals({ broadcast: 0, automatic: 0, bounces: 0, complaints: 0, read: 0, walletSkipped: 0 }),
      period: both({ attempted: 0, delivered: 0, notDelivered: 0, queued: 0, skipped: 0 },
                   { attempted: 0, delivered: 0, notDelivered: 0, queued: 0, skipped: 0 }),
      baseline: both({ attempted: 0, delivered: 0, notDelivered: 0 }, { attempted: 0, delivered: 0, notDelivered: 0 }),
      lifetimeEmail: ch({ sent: 0 }), lifetimeWhatsapp: ch({ sent: 0 }),
    })
    expect(z.campaigns.created).toBe(0)
    expect(z.composition.broadcast).toBe(0)
    expect(z.email.bounces).toBe(0)
    expect(z.whatsapp.walletSkipped).toBe(0)
    expect(z.window.attempted.value).toBe(0)
    expect(z.window.velocity.perDay).toBe(0)
    // Two zeros are not a mix: nothing was attempted, so there is no share to draw.
    expect(z.channelMix).toBeNull()
  })

  it('2 · measured positives come through untouched', () => {
    const b = build()
    expect(b.campaigns.created).toBe(6)
    expect(b.composition.automatic).toBe(1_200)
    expect(b.email.complaints).toBe(1)
    expect(b.whatsapp.read).toBe(300)
    expect(b.window.attempted.value).toBe(200)
  })

  it('3 · a failed read is null on that figure, and stays null through every derivation', () => {
    const b = build({
      signals: signals({ bounces: null }),
      period: both({ attempted: null }, {}),
    })
    expect(b.email.bounces).toBeNull()
    expect(b.window.attempted.value).toBeNull()
    expect(b.window.attempted.unavailable).toBe('not_measured')
    expect(b.window.velocity.perDay).toBeNull()
    expect(b.window.period.whatsapp.attempted).toBe(100)   // the other channel still answered
  })

  it('4 · the fully unmeasured shape is nulls and disabled comparisons, never zeros', () => {
    const u = unmeasuredCommunicationIntelligence(RANGE)
    const figures = [u.campaigns.created, u.campaigns.completed, u.campaigns.scheduled,
      u.composition.broadcast, u.composition.automatic, u.email.bounces, u.email.complaints,
      u.whatsapp.read, u.whatsapp.walletSkipped, u.window.attempted.value,
      u.window.delivered.value, u.window.notDelivered.value, u.window.velocity.perDay, u.channelMix]
    for (const f of figures) expect(f).toBeNull()
    expect(u.window.attempted.unavailable).toBe('not_measured')
    expect(u.campaigns.period.unavailable).toBe('not_measured')
    expect(JSON.stringify(u)).not.toMatch(/:0[,}]/)
  })

  it('5 · SMS and Push are not inputs to the mix — a channel with no transport has no share', () => {
    const mix = channelMix(ch({ sent: 300 }), ch({ sent: 100 }))
    expect(mix?.map(m => m.key)).toEqual(['email', 'whatsapp'])
    expect(mix?.map(m => m.sharePct)).toEqual([75, 25])
    expect(PURE).not.toMatch(/['"]sms['"]|['"]push['"]/)
  })

  it('6 · an unmeasured channel yields NO mix rather than a share of an unknown total', () => {
    expect(channelMix(ch({ sent: null }), ch())).toBeNull()
    expect(channelMix(null, ch())).toBeNull()
  })
})

// ─── Status semantics: unknown ≠ failed, windowed raw is named for what it is ─

describe('RD-ANALYTICS-12-28 · unknown vs failed', () => {
  it('7 · the windowed contract has NO unknown and its raw failed field is not called failed', () => {
    const block = CONTRACT.slice(CONTRACT.indexOf('interface WindowedChannelDelivery'))
      .split('}')[0]
    expect(block).toContain('notDelivered')
    expect(block).not.toMatch(/\bunknown\b/)
    expect(block).not.toMatch(/\bfailed\s*:/)
  })

  it('8 · the windowed read never touches deliveryUnknown — no index carries it beside createdAt', () => {
    const fn = SOURCES.slice(SOURCES.indexOf('export async function readWindowedCommunicationCounts'))
    expect(fn).not.toContain('deliveryUnknown')
    expect(fn).not.toContain('unknown')
  })

  it('9 · the lifetime subtraction (failed = raw − unknown) is untouched', () => {
    expect(SOURCES).toContain('Math.max(0, failedRaw - unknown)')
  })

  it('10 · the screen prints the windowed column as "Not delivered", never "Failed"', () => {
    const windowSection = UI.slice(UI.indexOf('title={`Messages in the'), UI.indexOf('title="Campaigns"'))
    expect(windowSection).toContain('Not delivered')
    expect(windowSection).not.toMatch(/label="Failed"|>Failed</)
  })

  it('11 · windowed attempted = sent + delivered + raw failed, mirroring the lifetime population rule', () => {
    expect(SOURCES).toMatch(/attempted:\s+sent === null \|\| delivered === null \|\| failed === null \? null : sent \+ delivered \+ failed/)
  })
})

// ─── Email: bounce, complaint, and failed ≠ bounce ───────────────────────────

describe('RD-ANALYTICS-12-28 · bounce and complaint', () => {
  it('12 · bounces and complaints are equality counts on the error the webhook wrote', () => {
    expect(SOURCES).toContain("where('error', '==', 'bounce')")
    expect(SOURCES).toContain("where('error', '==', 'complaint')")
  })

  it('13 · no hard/soft bounce split exists anywhere in the intelligence path', () => {
    for (const src of [SOURCES, PURE, CONTRACT, UI]) {
      expect(src).not.toMatch(/hardBounce|softBounce|bounceType|bounceSubType/)
    }
  })

  it('14 · the bounce definition on screen says "any type"', () => {
    expect(signalRows({ intelligence: build() } as never).find(r => r.key === 'bounces')?.definition)
      .toMatch(/any type/)
  })

  it('15 · a failed row is not a bounce: the two are separate figures with separate sources', () => {
    const b = build({ signals: signals({ bounces: 3 }) })
    expect(b.email.bounces).toBe(3)
    // The lifetime failed count lives on the channel delivery, not here, and is not derived
    // from bounces (nor bounces from it).
    expect(PURE).not.toMatch(/bounces\s*[-+]\s*|failed\s*[-+]\s*bounces/)
  })
})

// ─── WhatsApp: read, wallet-held ─────────────────────────────────────────────

describe('RD-ANALYTICS-12-28 · WhatsApp signals', () => {
  it('16 · read is Meta\'s persisted waStatus on WhatsApp rows only, never inferred from delivered', () => {
    expect(SOURCES).toContain("where('waStatus', '==', 'read')")
    const fn = SOURCES.slice(SOURCES.indexOf('readCommunicationSignals'))
    expect(fn).toMatch(/const wa\s+=\s+base\.where\('channel', '==', 'whatsapp'\)/)
    expect(PURE).not.toMatch(/read\s*=\s*.*delivered/)
  })

  it('17 · wallet-held rows are matched by the ONE declared reason constant, on skipped rows only', () => {
    expect(SOURCES).toContain("where('status', '==', 'skipped').where('error', '==', WHATSAPP_WALLET_SKIP_REASON)")
    // RD-COMMS-P1 — the capacity-skip reason is the second declared constant, counted the same way.
    expect(SOURCES).toContain("where('status', '==', 'skipped').where('error', '==', WHATSAPP_CAPACITY_SKIP_REASON)")
    expect(SOURCES).toContain("import { BROADCAST_TEMPLATE_KEY, WHATSAPP_WALLET_SKIP_REASON, WHATSAPP_CAPACITY_SKIP_REASON } from '@/lib/email-logs/types'")
  })

  it('18 · the screen defines wallet-held as "not a failure" and read as "not an email open"', () => {
    const rows = signalRows({ intelligence: build() } as never)
    expect(rows.find(r => r.key === 'walletSkipped')?.definition).toMatch(/not a failure/)
    expect(rows.find(r => r.key === 'read')?.definition).toMatch(/not an email open/)
  })
})

// ─── Campaigns: durable documents, never distinct rows ──────────────────────

describe('RD-ANALYTICS-12-28 · campaign count', () => {
  it('19 · campaigns are counted from broadcastCampaigns documents', () => {
    expect(SOURCES).toContain("adminDb.collection('broadcastCampaigns')")
    const fn = SOURCES.slice(SOURCES.indexOf('export async function readCampaignCounts'),
                             SOURCES.indexOf('export interface CommunicationSignals'))
    expect(fn).toContain("where('eventSlug', '==', eventSlug)")
    expect(fn).toContain("where('organizerUid', '==', organizerUid)")
    expect(fn).not.toContain('campaignId')
    expect(fn).not.toContain('emailLogs')
  })

  it('20 · no document page is fetched anywhere in the new reads — count() only', () => {
    const newReads = SOURCES.slice(SOURCES.indexOf('const campaigns = ()'))
    // every `.get()` in the new section is a `.count().get()` via countOf
    expect(newReads.match(/\.get\(\)/g) ?? []).toHaveLength(0)
    expect(newReads).not.toMatch(/\.limit\(/)
  })

  it('21 · completed = sent + partial, null when either is unmeasured', () => {
    expect(SOURCES).toMatch(/completed: sent === null \|\| partial === null \? null : sent \+ partial/)
  })

  it('22 · campaigns created in the window are compared through compareMetric', () => {
    const b = build({ campaigns: campaigns({ period: 4, baseline: 2 }) })
    expect(b.campaigns.period).toEqual({ value: 4, baseline: 2, delta: { pct: 100, direction: 'up' } })
    expect(campaignRows({ intelligence: b } as never).map(r => r.key)).toEqual(['created', 'completed', 'scheduled'])
  })
})

// ─── Broadcast vs automatic ──────────────────────────────────────────────────

describe('RD-ANALYTICS-12-28 · composition', () => {
  it('23 · broadcast is the persisted templateKey discriminator, imported not retyped', () => {
    expect(SOURCES).toContain("where('templateKey', '==', BROADCAST_TEMPLATE_KEY)")
    expect(SOURCES).not.toMatch(/templateKey', '==', 'broadcast'/)
  })

  it('24 · automatic = total − broadcast: the two sum to every logged message, nothing double-counted', () => {
    expect(SOURCES).toMatch(/automatic: total === null \|\| broadcast === null \? null : Math\.max\(0, total - broadcast\)/)
  })

  it('25 · the automatic definition admits the organizer-directed alerts it contains', () => {
    expect(compositionRows({ intelligence: build() } as never).find(r => r.key === 'automatic')?.definition)
      .toMatch(/alerts sent to you/)
  })
})

// ─── Date: IST window, boundaries ───────────────────────────────────────────

describe('RD-ANALYTICS-12-28 · IST window', () => {
  it('26 · the producer windows the log on the IST instants of the analytics range', () => {
    expect(ENGINE).toContain('const commWindow      = istRangeBounds(activeRange)')
    expect(ENGINE).not.toMatch(/rangeBounds\(f\.from|lib\/reports\/format/)
  })

  it('27 · 23:45 UTC belongs to the NEXT IST day, and the window bounds agree with dayKey', () => {
    const instant = Date.parse('2026-09-10T23:45:00.000Z')
    expect(dayKey(instant)).toBe('2026-09-11')
    const day = { from: '2026-09-11', to: '2026-09-11', preset: 'custom' as const }
    const b = istRangeBounds(day)
    expect(b.from.getTime()).toBeLessThanOrEqual(instant)
    expect(b.to.getTime()).toBeGreaterThanOrEqual(instant)
    const prev = istRangeBounds({ from: '2026-09-10', to: '2026-09-10', preset: 'custom' })
    expect(prev.to.getTime()).toBeLessThan(instant)
  })

  it('28 · range start and end are inclusive at IST midnight boundaries', () => {
    const b = istRangeBounds({ from: '2026-09-01', to: '2026-09-07', preset: '7d' })
    expect(b.from.toISOString()).toBe('2026-08-31T18:30:00.000Z')
    expect(b.to.toISOString()).toBe('2026-09-07T18:29:59.999Z')
  })

  it('29 · the windowed read uses the declared (organizerUid, [channel,] eventSlug, status, createdAt) shape', () => {
    const fn = SOURCES.slice(SOURCES.indexOf('export async function readWindowedCommunicationCounts'))
    expect(fn).toContain("where('organizerUid', '==', organizerUid)")
    expect(fn).toContain("where('eventSlug', '==', eventSlug)")
    expect(fn).toContain("where('createdAt', '>=', window.from).where('createdAt', '<=', window.to)")
    expect(fn).toContain("where('channel', '==', 'whatsapp').where('status', '==', status)")
  })
})

// ─── Comparison ─────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-28 · previous period', () => {
  it('30 · a valid delta from two measured windows', () => {
    const b = build()
    expect(b.window.attempted).toEqual({ value: 200, baseline: 100, delta: { pct: 100, direction: 'up' } })
  })

  it('31 · a zero baseline yields no percentage — "up from nothing" is not a rate', () => {
    const b = build({ baseline: both({ attempted: 0 }, { attempted: 0 }) })
    expect(b.window.attempted.delta).toEqual({ pct: null, direction: 'up' })
  })

  it('32 · no baseline read ⇒ the reason travels, no delta is manufactured', () => {
    const b = build({ baseline: null, baselineReason: 'no_baseline', campaigns: campaigns({ baseline: null }) })
    expect(b.window.attempted.delta).toBeNull()
    expect(b.window.attempted.unavailable).toBe('no_baseline')
    expect(b.campaigns.period.unavailable).toBe('no_baseline')
  })

  it('33 · a baseline that predates the event says outside_coverage on every compared metric', () => {
    const b = build({ baseline: null, baselineReason: 'outside_coverage', campaigns: campaigns({ baseline: null }) })
    for (const m of [b.window.attempted, b.window.delivered, b.window.notDelivered, b.campaigns.period]) {
      expect(m.unavailable).toBe('outside_coverage')
    }
    expect(ENGINE).toMatch(/commBaselineOutsideCoverage = Boolean\(\s*priorRange && publishedDayKey && priorRange\.to < publishedDayKey\)/)
  })

  it('34 · a partially unmeasured baseline is unmeasured, not the measured half', () => {
    const b = build({ baseline: both({ attempted: null }, { attempted: 60 }) })
    expect(b.window.attempted.baseline).toBeNull()
    expect(b.window.attempted.delta).toBeNull()
  })

  it('35 · the producer reads the baseline window only when comparison is on and inside coverage', () => {
    expect(ENGINE).toContain('const commPriorWindow = priorRange && !commBaselineOutsideCoverage ? istRangeBounds(priorRange) : null')
  })
})

// ─── Velocity ───────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-28 · velocity', () => {
  it('36 · attempted ÷ days of the selected range, truncated', () => {
    const v = communicationVelocity(95, { from: '2026-06-01', to: '2026-06-30', preset: '30d' })
    expect(v).toEqual({ perDay: 3, windowDays: 30, basis: 'attempted_in_window_per_day' })
    expect(displayCommunicationVelocity(v)).toBe('3/day')
  })

  it('37 · an invalid or inverted range yields null, never NaN or Infinity', () => {
    const v = communicationVelocity(95, { from: '2026-06-30', to: '2026-06-01', preset: 'custom' })
    expect(v.perDay).toBeNull()
    expect(v.windowDays).toBeNull()
    expect(displayCommunicationVelocity(v)).toBeNull()
    const bad = communicationVelocity(95, { from: 'x', to: 'y', preset: 'custom' })
    expect(bad.perDay).toBeNull()
    expect(JSON.stringify(bad)).not.toMatch(/NaN|Infinity/)
  })

  it('38 · an unmeasured numerator yields null, not 0/day', () => {
    expect(communicationVelocity(null, RANGE).perDay).toBeNull()
  })

  it('39 · the velocity is its own basis — not the revenue or registration one', () => {
    expect(build().window.velocity.basis).toBe('attempted_in_window_per_day')
    expect(PURE).not.toMatch(/revenueVelocity|period_rollup/)
  })
})

// ─── Reminders and certificates ─────────────────────────────────────────────

describe('RD-ANALYTICS-12-28 · reminder and certificate coverage', () => {
  it('40 · reminder status counts are equality aggregates on eventId + status', () => {
    expect(ENGINE).toMatch(/collection\('scheduledReminders'\)\s*\.where\('eventId', '==', eventId\)\.where\('status', '==', status\)\s*\.count\(\)\.get\(\)/)
    expect(ENGINE).not.toContain(".where('eventId', '==', eventId).limit(500)")
  })

  it('41 · the reminder recipient page detects overflow and withholds the sum', () => {
    expect(ENGINE).toContain('.limit(REM_PAGE + 1)')
    expect(ENGINE).toMatch(/if \(rem\.docs\.length > REM_PAGE\) \{\s*remComplete = false\s*remRecipients = null/)
    expect(ENGINE).toContain('reminders:      remOk && remComplete')
  })

  it('42 · certificates issued is an aggregate; downloaded is withheld past the cap, not the first CAP rows', () => {
    expect(ENGINE).toMatch(/collection\(CERT_COLLECTIONS\.CERTIFICATES\)\s*\.where\('eventId', '==', eventId\)\.count\(\)\.get\(\)/)
    expect(ENGINE).toContain(".where('eventId', '==', eventId).limit(CAP + 1).get()")
    expect(ENGINE).toMatch(/if \(certs\.docs\.length > CAP\) \{\s*certComplete = false\s*certDownloaded = null/)
    expect(ENGINE).not.toContain(".where('eventId', '==', eventId).limit(CAP).get()")
    expect(ENGINE).toContain('certificates:   certOk && certComplete')
  })

  it('43 · a withheld download count drops the funnel step rather than drawing it at 0', () => {
    expect(ENGINE).toContain("certOk && certDownloaded !== null ? [{ label: 'Certificate downloaded', value: certDownloaded }] : []")
  })

  it('44 · the trust notice names both withheld figures', () => {
    expect(UI).toContain('the reminder recipient total is withheld')
    expect(UI).toContain('the certificate download count is withheld')
  })
})

// ─── Permissions and PII ────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-28 · permissions', () => {
  const RANGE30 = RANGE
  const caps = (over: Partial<AnalyticsModuleContext> = {}): AnalyticsModuleContext => ({
    eventType: 'conference', registrationRules: null, applications: null,
    gate: { flags: { coupons: true, broadcast: true, certificates: true, donations: true },
            has: () => true } as unknown as AnalyticsModuleContext['gate'],
    financeAllowed: true, ...over,
  })
  const producer = (over: Partial<EventAnalytics> = {}): EventAnalytics => ({
    eventId: 'e', eventName: 'E', lifecycleStatus: 'published', publishedAt: null,
    truncated: false,
    limits: { registrations: true, communications: true, reminders: true, certificates: true, ledger: true, passValue: true },
    financialAllowed: true, range: RANGE30,
    period: { confirmed: 10, cancelled: 2, checkedIn: 4 }, baseline: null,
    coverageSince: null, coveragePartial: false, baselineOutsideCoverage: false,
    kpis: { registrations: 100, confirmed: 80, pending: 10, cancelled: 20, rejected: 5, waitlisted: 5, paid: 55,
            free: 20, paymentPending: 15, refunded: 6, refundPending: 4, checkedIn: 40, conversionPct: 60,
            capacity: 200, capacityUsedPct: 40, remaining: 120 },
    registrationsByDay: [], cancellationsByDay: [], checkInsByDay: [],
    paymentStatus: [], passSales: [], couponUsage: [], funnel: [],
    communication: { sent: 1_600, failed: 30, delivered: 1_400 },
    reminders: { scheduled: 5, sent: 4, failed: 1, recipients: 200 },
    certificates: { issued: 30, downloaded: 12 },
    operationalCapabilities: { identifiersEnabled: false, identifierLabel: null, timingEnabled: false, timingLabel: null },
    identifierProgress: null, timingProgress: null,
    communicationCounts: { email: ch(), whatsapp: ch({ sent: 600 }), total: 1_700 },
    communicationSpend: null,
    communicationIntelligence: build(),
    dataFlags: { trafficSources: 'no_data', certificateVerifications: 'no_data', sms: 'no_data' },
    ...over,
  })

  it('45 · the intelligence block is present WITHOUT transactions, and carries no money', () => {
    const r = normalizeEventAnalytics({
      analytics: producer({ financialAllowed: false }), range: RANGE30,
      capabilities: caps({ financeAllowed: false }), eventId: 'draft-A',
    })
    expect(r.communications.spend).toBeUndefined()
    expect(r.communications.intelligence.campaigns.created).toBe(6)
    expect(JSON.stringify(r.communications.intelligence)).not.toMatch(/paise|cost|spend|₹/i)
  })

  it('46 · the producer never issues a money aggregate for the intelligence block', () => {
    const newReads = SOURCES.slice(SOURCES.indexOf('const campaigns = ()'))
    expect(newReads).not.toMatch(/AggregateField|sum\(|costPaise|actualCostPaise/)
  })

  it('47 · no recipient PII field is read or published by the intelligence path', () => {
    for (const src of [SOURCES.slice(SOURCES.indexOf('const campaigns = ()')), PURE, CONTRACT]) {
      expect(src).not.toMatch(/recipientEmail|recipientPhone|recipientName|providerMessageId|subject|html/)
    }
  })

  it('48 · the spend subtitle says what the figure measures — recorded on sent messages, not the ledger', () => {
    expect(UI).toContain('Wallet charges recorded on sent messages')
    expect(readFileSync(resolve(process.cwd(), 'lib/analytics/contract.ts'), 'utf8')).toContain('RECORDED ON SENT ROWS')
  })
})

// ─── Isolation and scale ────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-28 · isolation and scale', () => {
  it('49 · every new read names its workspace AND its event', () => {
    for (const name of ['readCampaignCounts', 'readCommunicationSignals', 'readWindowedCommunicationCounts']) {
      const start = SOURCES.indexOf(`export async function ${name}`)
      const fn = SOURCES.slice(start, SOURCES.indexOf('\nexport', start + 1))
      expect(fn, name).toContain("where('organizerUid', '==', organizerUid)")
      expect(fn, name).toMatch(/where\('(eventSlug|eventId)', '==', (eventSlug|eventId)\)/)
    }
  })

  it('50 · the producer passes the AUTHORIZED organizerUid, not one from the request', () => {
    expect(ENGINE).toContain('readCampaignCounts(organizerUid, eventId, commWindow, commPriorWindow)')
    expect(ENGINE).toContain('readCommunicationSignals(organizerUid, eventId, commCounts?.total ?? null)')
    expect(ENGINE).toContain('readWindowedCommunicationCounts(organizerUid, eventId, commWindow)')
  })

  it('51 · event isolation is structural: no read in the module is unscoped by event', () => {
    const queries = SOURCES.match(/(logs|campaigns)\(\)(\s*\.where\([^)]*\))+/g) ?? []
    expect(queries.length).toBeGreaterThan(0)
    for (const q of queries) expect(q).toMatch(/eventId|eventSlug/)
  })

  it('52 · a 20,000-message event costs the same reads as a 20-message one — aggregates only', () => {
    const newReads = SOURCES.slice(SOURCES.indexOf('const campaigns = ()'))
    const countCalls = (newReads.match(/countOf\(/g) ?? []).length
    expect(countCalls).toBeGreaterThanOrEqual(10)
    expect(newReads).not.toMatch(/\.docs|\.forEach|\.limit\(|\.get\(\)/)
  })

  it('53 · the windowed totals fold both channels with null propagation', () => {
    expect(windowedTotals(both({ attempted: null }, {})).attempted).toBeNull()
    expect(windowedTotals(both()).attempted).toBe(200)
    expect(windowChannelRows({ intelligence: build() } as never).map(r => r.key)).toEqual(['email', 'whatsapp'])
  })
})

// ─── Dead code and deferred findings ────────────────────────────────────────

describe('RD-ANALYTICS-12-28 · housekeeping', () => {
  it('54 · the dead per-template breakdown is gone from the engine', () => {
    expect(ENGINE).not.toContain('byTemplate')
    expect(ENGINE).not.toContain('commByTemplate')
  })

  it('55 · the spend fallback page survives with its overflow detection (RD-11 test 23 still holds)', () => {
    expect(ENGINE).toContain("collection('emailLogs').where('eventId', '==', eventId).limit(CAP + 1)")
  })

  it('56 · no index, rules, billing or webhook file is touched by this phase\'s reads', () => {
    expect(SOURCES).not.toMatch(/walletTransactions|communicationUsage|suppress/)
  })
})
