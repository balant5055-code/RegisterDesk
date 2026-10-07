// RD-ANALYTICS-11 — Communications Intelligence.
//
// ═══ WHAT THESE GUARD ════════════════════════════════════════════════════════
// Communication analytics fail by flattering. Every rule below has a failure mode that
// renders as a reassuring number:
//
//   "sent" relabelled as "delivered", so a broken webhook looks like perfect delivery
//   a transport timeout counted as a rejection, asserting non-delivery nobody established
//   a 100% delivery rate computed over four confirmed outcomes out of five thousand sent
//   SMS reported as 0 on a platform that cannot send SMS
//   a truncated 5,000-row page published as the event's totals
//   messaging spend reaching a caller without `transactions`

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  deliveryRate, failureRate, unconfirmedShare, channelRows, channelState,
  reminderRows, certificateRows,
} from '@/lib/analytics/communicationsModel'
import { normalizeEventAnalytics } from '@/lib/analytics/normalize'
import { presetRange } from '@/lib/analytics/dateRange'
import type { AnalyticsModuleContext } from '@/lib/analytics/modules'
import type { ChannelDelivery } from '@/lib/analytics/contract'
import type { EventAnalytics } from '@/lib/analytics/eventAnalytics'
import { unmeasuredCommunicationIntelligence } from '@/lib/analytics/communicationIntelligence'

/** Source with comments stripped — prose about a rule must not satisfy its own guard. */
const code = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const RANGE = presetRange('30d', Date.parse('2026-06-15T12:00:00Z'))

const caps = (over: Partial<AnalyticsModuleContext> = {}): AnalyticsModuleContext => ({
  eventType: 'conference', registrationRules: null, applications: null,
  gate: { flags: { coupons: true, broadcast: true, certificates: true, donations: true },
          has: () => true } as unknown as AnalyticsModuleContext['gate'],
  financeAllowed: true,
  ...over,
})

const ch = (over: Partial<ChannelDelivery> = {}): ChannelDelivery => ({
  sent: 1_000, delivered: 900, failed: 20, unknown: 80, queued: 0, skipped: 5, ...over,
})

const producer = (over: Partial<EventAnalytics> = {}): EventAnalytics => ({
  eventId: 'e', eventName: 'E', lifecycleStatus: 'published', publishedAt: null,
  truncated: false,
  limits: { registrations: true, communications: true, reminders: true,
            certificates: true, ledger: true, passValue: true },
  financialAllowed: true,
  range: RANGE,
  period:   { confirmed: 10, cancelled: 2, checkedIn: 4 },
  baseline: { confirmed: 8,  cancelled: 4, checkedIn: 3 },
  coverageSince: '2026-01-01', coveragePartial: false, baselineOutsideCoverage: false,
  kpis: { registrations: 100, confirmed: 80, pending: 10, cancelled: 20, rejected: 5,
          waitlisted: 5, paid: 55, free: 20, paymentPending: 15, refunded: 6,
          refundPending: 4, checkedIn: 40, conversionPct: 60, capacity: 200,
          capacityUsedPct: 40, remaining: 120 },
  registrationsByDay: [], cancellationsByDay: [], checkInsByDay: [],
  paymentStatus: [], passSales: [], couponUsage: [], funnel: [],
  communication: { sent: 1_600, failed: 30, delivered: 1_400 },
  reminders: { scheduled: 5, sent: 4, failed: 1, recipients: 200 },
  certificates: { issued: 30, downloaded: 12 },
  operationalCapabilities: { identifiersEnabled: false, identifierLabel: null,
                             timingEnabled: false, timingLabel: null },
  identifierProgress: null, timingProgress: null,
  communicationCounts: {
    email:    ch({ sent: 1_000, delivered: 900, failed: 20, unknown: 80 }),
    whatsapp: ch({ sent: 600,  delivered: 500, failed: 25, unknown: 75 }),
    total:    1_700,
  },
  communicationSpend: { ok: true, paise: 45_000 },
  // RD-ANALYTICS-12-28 · assembled by the producer; the unmeasured shape keeps this fixture
  // about the RD-11 figures. The intelligence block has its own suite.
  communicationIntelligence: unmeasuredCommunicationIntelligence(RANGE),
  dataFlags: { trafficSources: 'no_data', certificateVerifications: 'no_data', sms: 'no_data' },
  ...over,
})

const run = (p?: Partial<EventAnalytics>, c?: Partial<AnalyticsModuleContext>) =>
  normalizeEventAnalytics({
    analytics: producer(p), range: RANGE, capabilities: caps(c), eventId: 'draft-A',
  })

// ─── I/J · Rate denominators ──────────────────────────────────────────────────

describe('RD-ANALYTICS-11 · every rate states its denominator', () => {
  it('1 · delivery rate divides by CONFIRMED OUTCOMES, not by everything sent', () => {
    // 900 delivered, 20 failed, 80 unknown of 1,000 sent. Dividing by 1,000 would count the
    // unknowns as failures — asserting non-delivery for messages nobody heard back about.
    const r = deliveryRate(ch())
    expect(r.denominator).toBe(920)
    expect(r.pct).toBe(98)
    expect(r.basis).toMatch(/delivered \+ failed/)
    // …and it is emphatically NOT 90%, which is what ÷ sent would have said.
    expect(r.pct).not.toBe(90)
  })

  it('2 · failure rate uses the SAME divisor, so the two are complements', () => {
    const d = deliveryRate(ch()), f = failureRate(ch())
    expect(f.denominator).toBe(d.denominator)
    expect(d.pct! + f.pct!).toBe(100)
  })

  it('3 · unknown is in NEITHER rate, and is reported on its own', () => {
    const u = unconfirmedShare(ch())
    expect(u.denominator).toBe(1_000)      // of what was SENT
    expect(u.pct).toBe(8)                  // 1000 − 900 − 20
    // The basis NAMES the denominator and says nothing about the numerator — the UI renders
    // it as "of {n} {basis}", and a sentence there would report the divisor as the count.
    expect(u.basis).toBe('messages sent')
    expect(deliveryRate(ch()).basis).not.toMatch(/^of /)
  })

  it('4 · a webhook that barely reports does not produce a flattering rate', () => {
    // 5,000 sent, 4 confirmed delivered, 0 failed. The delivery rate is 100% of a divisor
    // of 4 — true, and useless without the 99.9% unconfirmed figure beside it.
    const thin = ch({ sent: 5_000, delivered: 4, failed: 0, unknown: 0 })
    expect(deliveryRate(thin).pct).toBe(100)
    expect(deliveryRate(thin).denominator).toBe(4)
    expect(unconfirmedShare(thin).pct).toBe(100)
  })

  it('5 · no confirmed outcome yields NO rate, not 0%', () => {
    const none = ch({ delivered: 0, failed: 0 })
    expect(deliveryRate(none).pct).toBeNull()
    expect(failureRate(none).pct).toBeNull()
    expect(deliveryRate(none).basis).toMatch(/no message has a confirmed outcome/i)
  })

  it('6 · an unmeasured side yields no rate at all', () => {
    expect(deliveryRate(ch({ delivered: null })).pct).toBeNull()
    expect(failureRate(ch({ failed: null })).pct).toBeNull()
    expect(unconfirmedShare(ch({ sent: null })).pct).toBeNull()
  })
})

// ─── L/Q · Channel support ────────────────────────────────────────────────────

describe('RD-ANALYTICS-11 · channel support is data-driven', () => {
  it('7 · SMS and Push are UNSUPPORTED, never zero', () => {
    const rows = channelRows(run().communications)
    for (const key of ['sms', 'push'] as const) {
      const row = rows.find(r => r.key === key)!
      expect(row.supported, key).toBe(false)
      expect(row.delivery, key).toBeNull()
      expect(channelState(row), key).toBe('unsupported')
    }
    // No figure of any kind for a channel with no transport.
    expect(JSON.stringify(rows.filter(r => !r.supported))).not.toMatch(/"sent":0/)
  })

  it('8 · email and WhatsApp are supported and carry their own figures', () => {
    const rows = channelRows(run().communications)
    const email = rows.find(r => r.key === 'email')!
    const wa    = rows.find(r => r.key === 'whatsapp')!
    expect(email.supported).toBe(true)
    expect(email.delivery?.sent).toBe(1_000)
    expect(wa.delivery?.sent).toBe(600)
    // Their rates differ, because their providers do.
    expect(deliveryRate(email.delivery!).pct).not.toBe(deliveryRate(wa.delivery!).pct)
  })

  it('9 · four states never look alike: unsupported, unreadable, silent, active', () => {
    const rows = channelRows(run().communications)
    expect(channelState(rows.find(r => r.key === 'email')!)).toBe('active')
    expect(channelState(rows.find(r => r.key === 'sms')!)).toBe('unsupported')

    const unread = channelRows(run({ communicationCounts: null }).communications)
    expect(channelState(unread.find(r => r.key === 'email')!)).toBe('unreadable')

    const silent = channelRows(run({
      communicationCounts: { email: ch({ sent: 0, delivered: 0, failed: 0, unknown: 0 }),
                             whatsapp: ch({ sent: 0, delivered: 0, failed: 0, unknown: 0 }),
                             total: 0 },
    }).communications)
    expect(channelState(silent.find(r => r.key === 'email')!)).toBe('silent')
  })

  it('10 · the platform\'s unsupported channels are named, not inferred from a UI list', () => {
    const src = code('lib/analytics/communicationsSources.ts')
    expect(src).toContain("SUPPORTED_CHANNELS = ['email', 'whatsapp']")
    expect(src).toContain("UNSUPPORTED_CHANNELS = ['sms', 'push']")
  })
})

// ─── A–H · Sent / delivered / failed / unknown semantics ──────────────────────

describe('RD-ANALYTICS-11 · sent is never delivered, unknown is never failed', () => {
  it('11 · the producer subtracts transport timeouts out of the failure count', () => {
    const src = code('lib/analytics/communicationsSources.ts')
    expect(src).toContain('Math.max(0, failedRaw - unknown)')
    expect(src).toContain("where('deliveryUnknown', '==', true)")
  })

  it('12 · `sent` is every ATTEMPT, so every rate is a share of something it contains', () => {
    // Found in browser QA on an event with 40 rejections. `sent` was `sentOnly + delivered`,
    // which left rejections OUTSIDE the total they were being measured against —
    // `unconfirmedShare` then subtracted a population the denominator never held and
    // understated how much of the event went unconfirmed.
    const src = code('lib/analytics/communicationsSources.ts')
    expect(src).toContain('sentOnly + delivered + failedRaw')
    // queued and skipped stay out — neither was ever attempted.
    expect(src).not.toMatch(/sentOnly \+ delivered \+ failedRaw \+ (queued|skipped)/)
  })

  it('12b · delivered, failed and unknown are all SUBSETS of sent', () => {
    // The arithmetic a reader does in their head: sent − delivered − failed = unconfirmed,
    // and it must never go negative or leave a remainder that belongs to nothing.
    const d = ch({ sent: 1_000, delivered: 900, failed: 20, unknown: 80 })
    expect(d.delivered! + d.failed! + d.unknown!).toBe(d.sent)
    expect(unconfirmedShare(d).pct).toBe(8)   // exactly the unknown population

    // …and with messages still in flight, the remainder is those plus the timeouts.
    const flight = ch({ sent: 1_000, delivered: 600, failed: 100, unknown: 50 })
    expect(unconfirmedShare(flight).pct).toBe(30)   // 1000 − 600 − 100
  })

  it('13 · email counts include rows that predate the `channel` field', () => {
    // `channel` is absent on every pre-WhatsApp row. Filtering channel == 'email' would
    // silently drop the entire history before WhatsApp shipped.
    const src = code('lib/analytics/communicationsSources.ts')
    expect(src).toContain('all - wa')
    expect(src).not.toMatch(/where\('channel', '==', 'email'\)/)
  })

  it('14 · nothing infers delivery, opens or clicks', () => {
    for (const p of ['lib/analytics/communicationsModel.ts',
                     'lib/analytics/communicationsSources.ts',
                     'components/analytics/communications/CommunicationsAnalytics.tsx']) {
      const src = code(p)
      expect(src, p).not.toMatch(/opened|clicked|openRate|clickRate/i)
    }
  })
})

// ─── T/U · Reminders ──────────────────────────────────────────────────────────

describe('RD-ANALYTICS-11 · reminders record execution, not delivery', () => {
  it('15 · the labels say executed, and no reminder delivery rate exists', () => {
    const rows = reminderRows(run().communications)
    expect(rows.map(r => r.label)).toEqual(['Scheduled', 'Executed'])
    expect(rows.find(r => r.key === 'executed')?.definition).toMatch(/not a delivery confirmation/i)
    expect(code('lib/analytics/communicationsModel.ts')).not.toMatch(/reminderDeliveryRate/)
  })

  it('16 · certificates are issuance counts, not messages', () => {
    const rows = certificateRows(run().communications)
    expect(rows.find(r => r.key === 'issued')?.value).toBe(30)
    expect(rows.find(r => r.key === 'downloaded')?.value).toBe(12)
  })
})

// ─── V/W · Financial boundary ─────────────────────────────────────────────────

describe('RD-ANALYTICS-11 · messaging spend rides the financial boundary', () => {
  it('17 · spend is present for a caller who holds the permission', () => {
    expect(run().communications.spend).toEqual({ ok: true, paise: 45_000 })
  })

  it('18 · without it the `spend` key is ABSENT, not null', () => {
    const out = run({ communicationSpend: null, financial: undefined, financialAllowed: false },
                    { financeAllowed: false })
    expect('spend' in out.communications).toBe(false)
  })

  it('19 · and no money survives serialization', () => {
    const out = run({ communicationSpend: null, financial: undefined, financialAllowed: false,
                      period: { confirmed: 10, cancelled: 2, checkedIn: 4 } },
                    { financeAllowed: false })
    const json = JSON.stringify(out.communications)
    for (const probe of [/Paise/, /spend/i, /cost/i, /₹/]) {
      expect(json, String(probe)).not.toMatch(probe)
    }
  })

  it('20 · the spend AGGREGATE is not issued without the permission', () => {
    // The gate is a ternary in the producer: no permission, no query object at all.
    const src = code('lib/analytics/eventAnalytics.ts')
    expect(src).toMatch(/includeFinancial \? readCommunicationSpend\(eventId\)/)
  })

  it('21 · operational communication metrics do NOT require the financial permission', () => {
    const out = run({ communicationSpend: null, financial: undefined, financialAllowed: false },
                    { financeAllowed: false })
    // A manager without `transactions` still sees what was sent and delivered.
    const email = channelRows(out.communications).find(r => r.key === 'email')!
    expect(email.delivery?.sent).toBe(1_000)
    expect(email.delivery?.delivered).toBe(900)
  })
})

// ─── M/N/Y · Reads, caps and truncation ───────────────────────────────────────

describe('RD-ANALYTICS-11 · read behaviour', () => {
  it('22 · counts come from aggregates — no document page, no cap to overflow', () => {
    const src = code('lib/analytics/communicationsSources.ts')
    expect(src).not.toMatch(/\.limit\(/)
    expect(src).not.toMatch(/\.docs/)
    expect((src.match(/\.count\(\)/g) ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('23 · the remaining capped read DETECTS truncation and lowers its limit flag', () => {
    const src = code('lib/analytics/eventAnalytics.ts')
    expect(src).toContain("collection('emailLogs').where('eventId', '==', eventId).limit(CAP + 1)")
    expect(src).toContain('commTruncated = true')
    expect(src).toContain('communications: commOk && !commTruncated,')
  })

  it('24 · a truncated page never contributes a money total', () => {
    // The aggregate is preferred; the in-memory total is the fallback for a caller entitled
    // to money whose sum() failed — and ONLY when the page was complete, because the first
    // 5,000 rows of a larger event are not that event's spend.
    const src = code('lib/analytics/eventAnalytics.ts')
    expect(src).toContain('commSpend?.ok                ? commSpend')
    expect(src).toContain(': commOk && !commTruncated   ? money(commCostPaise)')
    expect(src).toContain("gone(commTruncated ? 'out_of_budget' : 'query_failed')")
  })

  it('25 · a failed count read is null, never zero', () => {
    const out = run({ communicationCounts: null })
    expect(out.communications.totalMessages).toBeNull()
    const email = channelRows(out.communications).find(r => r.key === 'email')!
    expect(email.delivery).toBeNull()
  })

  it('26 · the model and UI add no data access of their own', () => {
    for (const p of ['lib/analytics/communicationsModel.ts',
                     'components/analytics/communications/CommunicationsAnalytics.tsx']) {
      expect(code(p), p).not.toMatch(/adminDb|collection\(|firebase|fetch\(/)
    }
  })
})

// ─── K · Zero-message event ───────────────────────────────────────────────────

describe('RD-ANALYTICS-11 · an event that sent nothing', () => {
  it('27 · reports measured zeros, and offers no rates', () => {
    const out = run({
      communicationCounts: {
        email: ch({ sent: 0, delivered: 0, failed: 0, unknown: 0, queued: 0, skipped: 0 }),
        whatsapp: ch({ sent: 0, delivered: 0, failed: 0, unknown: 0, queued: 0, skipped: 0 }),
        total: 0,
      },
    })
    expect(out.communications.totalMessages).toBe(0)
    const email = channelRows(out.communications).find(r => r.key === 'email')!
    expect(email.delivery?.sent).toBe(0)          // measured
    expect(email.delivery_rate?.pct).toBeNull()   // but no rate over an empty divisor
    expect(channelState(email)).toBe('silent')
  })
})

// ─── UI contract ──────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-11 · the module UI', () => {
  const UI = code('components/analytics/communications/CommunicationsAnalytics.tsx')

  it('28 · unknown has its own cell, never folded into failed', () => {
    expect(UI).toContain('label="Unknown"')
    expect(UI).toContain('Send timed out')
    expect(UI).toContain('Provider rejected — excludes timeouts')
  })

  it('29 · every rate is printed with its denominator, as a denominator', () => {
    expect(UI).toContain('function RateLine')
    expect(UI).toContain('rate.basis')
    // "of 1,440 messages sent" — NOT "1,440 of messages sent have no confirmation", which
    // reads the divisor as the count. Caught in browser QA, guarded here.
    expect(UI).toContain('`of ${nf(rate.denominator)} ${rate.basis}`')
  })

  it('30 · an unsupported channel says so instead of showing figures', () => {
    expect(UI).toContain('Not available on this platform')
    expect(UI).toContain('this is\n          not a count of zero')
  })

  it('31 · the absence of engagement metrics is explained, not silent', () => {
    expect(UI).toContain('Opens and clicks are not')
  })

  it('31b · the empty state names THIS module, not registrations', () => {
    // The shared chrome hardcoded "select an event to see its registration analytics", and
    // it rendered unchanged on Revenue, Operations and Communications. Seen in browser QA
    // on the finance role, whose event list is empty. The chrome now takes the noun; the
    // default keeps the three older modules byte-identical.
    expect(UI).toContain('subject="communication"')
    expect(code('components/analytics/ModuleChrome.tsx'))
      .toContain('see its {subject} analytics')
  })

  it('32 · an unmeasured count renders a mark, never 0', () => {
    expect(UI).toContain('UNAVAILABLE_MARK')
    expect(UI).not.toMatch(/\?\?\s*0\b/)
  })

  it('33 · spend renders only when the payload carried it', () => {
    expect(UI).toContain('c.spend !== undefined')
  })
})
