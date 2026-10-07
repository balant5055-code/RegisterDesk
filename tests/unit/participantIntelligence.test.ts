// RD-ANALYTICS-12-29 · Participants — registration composition, honestly named.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// The audit approved a deliberately small module on three conditions: every figure is a
// REGISTRATION (never a person), every read is an equality aggregate on one persisted
// field, and nothing demographic, identity-derived or CRM-derived enters the payload. The
// groups below pin the arithmetic (shares over the right denominator, "not recorded" kept
// apart from "online", statuses never merged), the absence discipline, the module gate, the
// terminology, and — at source level — the reads themselves.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  passMix, statusMix, share, sourceRows, sourceColumns, statusSourceRows, identityRuleRows,
  compositionMeasured, SEATS_NOT_PEOPLE,
} from '@/lib/analytics/participantsModel'
import { normalizeEventAnalytics } from '@/lib/analytics/normalize'
import { presetRange } from '@/lib/analytics/dateRange'
import { unmeasuredCommunicationIntelligence } from '@/lib/analytics/communicationIntelligence'
import { ANALYTICS_MODULES as MODULE_DEFS, isAnalyticsModuleAvailable } from '@/lib/analytics/modules'
import { ANALYTICS_MODULES as ROUTE_MODULES } from '@/lib/analytics/routes'
import type { AnalyticsModuleContext } from '@/lib/analytics/modules'
import type { EventAnalytics } from '@/lib/analytics/eventAnalytics'
import type { RegistrationAnalytics, RegistrationComposition, RegistrationSourceCounts } from '@/lib/analytics/contract'
import type { RegistrationSourceComposition } from '@/lib/analytics/participantsSources'

/** Source with comments stripped — prose about a rule must not satisfy its own guard. */
const code = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const SOURCES  = code('lib/analytics/participantsSources.ts')
const MODEL    = code('lib/analytics/participantsModel.ts')
const ENGINE   = code('lib/analytics/eventAnalytics.ts')
const NORMALIZE = code('lib/analytics/normalize.ts')
const ROUTE    = code('app/api/organizer/analytics/overview/[eventId]/route.ts')
const UI       = code('components/analytics/participants/ParticipantsAnalytics.tsx')
const CONTRACT = code('lib/analytics/contract.ts')

const RANGE = presetRange('30d', Date.parse('2026-06-15T12:00:00Z'))

const sc = (o: Partial<RegistrationSourceCounts> = {}): RegistrationSourceCounts =>
  ({ online: 70, walkin: 20, unrecorded: 10, ...o })

const composition = (o: Partial<RegistrationComposition> = {}): RegistrationComposition => ({
  source: sc(),
  sourceByStatus: {
    confirmed: sc({ online: 60, walkin: 18, unrecorded: 2 }),
    pending:   sc({ online: 4,  walkin: 0,  unrecorded: 0 }),
    cancelled: sc({ online: 5,  walkin: 2,  unrecorded: 8 }),
    rejected:  sc({ online: 1,  walkin: 0,  unrecorded: 0 }),
    waitlisted: sc({ online: 0, walkin: 0,  unrecorded: 0 }),
  },
  passMix: null, statusMix: null,
  identityRules: { limitPerEmail: true, limitPerMobile: false },
  basis: 'registration_source_field_and_status_counts',
  ...o,
})

const regs = (o: Partial<RegistrationAnalytics> = {}): RegistrationAnalytics => ({
  total: 100, confirmed: 80, pending: 4, cancelled: 15, rejected: 1, waitlisted: 0,
  paid: 60, free: 20, paymentPending: 4, refunded: 3, refundPending: 0,
  byDay: [], cancelledByDay: [],
  period: { confirmed: { value: 10, baseline: 8, delta: { pct: 25, direction: 'up' } },
            cancelled: { value: 1, baseline: 1, delta: { pct: 0, direction: 'flat' } } },
  byPass: [{ label: 'General', value: 50 }, { label: 'VIP', value: 20 }],
  byPassBasis: 'lifetime_confirmed',
  capacity: 200, capacityUsedPct: 40, remaining: 120,
  ...o,
})

// ─── Source composition ─────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-29 · registration source', () => {
  it('1 · online, walk-in and not-recorded are three figures that sum to the total, each with its share', () => {
    const rows = sourceRows(composition())
    expect(rows.map(r => r.key)).toEqual(['online', 'walkin', 'unrecorded'])
    expect(rows.map(r => r.value)).toEqual([70, 20, 10])
    expect(rows.map(r => r.share?.pct)).toEqual([70, 20, 10])
    expect(rows.every(r => r.share?.of === 100)).toBe(true)
  })

  it('2 · a measured zero is 0 with a 0% share, not an unmeasured cell', () => {
    const rows = sourceRows(composition({ source: sc({ walkin: 0 }) }))
    const w = rows.find(r => r.key === 'walkin')!
    expect(w.value).toBe(0)
    expect(w.share).toEqual({ pct: 0, of: 80 })
  })

  it('3 · an unmeasured source has no value and no share, and removes the total\'s denominator', () => {
    const rows = sourceRows(composition({ source: sc({ walkin: null }) }))
    expect(rows.find(r => r.key === 'walkin')!.value).toBeNull()
    for (const r of rows) expect(r.share).toBeNull()
  })

  it('4 · nothing registered ⇒ zeros and no shares (no denominator), never NaN', () => {
    const rows = sourceRows(composition({ source: sc({ online: 0, walkin: 0, unrecorded: 0 }) }))
    expect(rows.map(r => r.value)).toEqual([0, 0, 0])
    for (const r of rows) expect(r.share).toBeNull()
    expect(JSON.stringify(rows)).not.toMatch(/NaN|Infinity/)
  })

  it('5 · "not recorded" is never relabelled online — the definition says so and the source keeps it apart', () => {
    const row = sourceRows(composition()).find(r => r.key === 'unrecorded')!
    expect(row.label).toBe('Source not recorded')
    expect(row.definition).toMatch(/not assumed online/)
    expect(SOURCES).toMatch(/unrecorded: remainder\(totals\.total, lo, lw\)/)
    expect(SOURCES).not.toMatch(/\?\? 'online'|online \+ unrecorded|unrecorded \+ online/)
  })

  it('6 · the not-recorded column is drawn only when it carries something (or is unmeasured)', () => {
    expect(sourceColumns(composition())).toEqual(['online', 'walkin', 'unrecorded'])
    const clean = composition({
      source: sc({ unrecorded: 0 }),
      sourceByStatus: {
        confirmed: sc({ unrecorded: 0 }), pending: sc({ unrecorded: 0 }), cancelled: sc({ unrecorded: 0 }),
        rejected: sc({ unrecorded: 0 }), waitlisted: sc({ unrecorded: 0 }),
      },
    })
    expect(sourceColumns(clean)).toEqual(['online', 'walkin'])
    const unknown = composition({ source: sc({ unrecorded: null }) })
    expect(sourceColumns(unknown)).toContain('unrecorded')
  })
})

// ─── Status × source ────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-29 · status by source', () => {
  it('7 · the five statuses stay apart, in the contract\'s order, never merged into "inactive"', () => {
    const rows = statusSourceRows(composition())
    expect(rows.map(r => r.key)).toEqual(['confirmed', 'pending', 'cancelled', 'rejected', 'waitlisted'])
    expect(rows.map(r => r.label)).toEqual(['Confirmed', 'Pending approval', 'Cancelled', 'Rejected', 'Waitlisted'])
    for (const src of [MODEL, UI]) expect(src).not.toMatch(/inactive/i)
  })

  it('8 · each status row carries its own three-way split', () => {
    const cancelled = statusSourceRows(composition()).find(r => r.key === 'cancelled')!
    expect(cancelled.counts).toEqual({ online: 5, walkin: 2, unrecorded: 8 })
  })

  it('9 · the producer takes each status remainder against THAT status\'s aggregate total', () => {
    expect(SOURCES).toMatch(/return \[s, \{ online: o, walkin: w, unrecorded: remainder\(totals\[s\], o, w\) \}\]/)
  })
})

// ─── Mixes ──────────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-29 · pass and status mix', () => {
  it('10 · pass shares are over the CONFIRMED total, and the unlisted remainder is its own row', () => {
    const mix = passMix(regs())!   // listed 70 of 80 confirmed
    expect(mix.map(m => m.label)).toEqual(['General', 'VIP', 'Other passes'])
    expect(mix.map(m => m.sharePct)).toEqual([63, 25, 13])
    expect(mix.reduce((s, m) => s + m.value, 0)).toBe(80)
  })

  it('11 · no remainder row when the list accounts for every confirmed seat', () => {
    const mix = passMix(regs({ confirmed: 70 }))!
    expect(mix.map(m => m.label)).toEqual(['General', 'VIP'])
  })

  it('12 · a list that exceeds the confirmed total (counter drift) yields NO mix, not a >100% chart', () => {
    expect(passMix(regs({ confirmed: 60 }))).toBeNull()
  })

  it('13 · an unmeasured confirmed count, an empty list, or zero confirmed ⇒ null', () => {
    expect(passMix(regs({ confirmed: null }))).toBeNull()
    expect(passMix(regs({ byPass: [] }))).toBeNull()
    expect(passMix(regs({ confirmed: 0, byPass: [] }))).toBeNull()
  })

  it('14 · the pass mix comes from the payload\'s own byPass with its basis — no second count', () => {
    expect(MODEL).toContain("r.byPassBasis !== 'lifetime_confirmed'")
    expect(MODEL).not.toMatch(/adminDb|collection\(|count\(\)/)
  })

  it('15 · status mix is over every registration; any unmeasured status voids it', () => {
    const mix = statusMix(regs())!
    expect(mix.map(m => m.key)).toEqual(['confirmed', 'pending', 'cancelled', 'rejected', 'waitlisted'])
    expect(mix.reduce((s, m) => s + m.value, 0)).toBe(100)
    expect(mix.find(m => m.key === 'confirmed')!.sharePct).toBe(80)
    expect(statusMix(regs({ waitlisted: null }))).toBeNull()
    expect(statusMix(regs({ confirmed: 0, pending: 0, cancelled: 0, rejected: 0, waitlisted: 0 }))).toBeNull()
  })

  it('16 · share() refuses an unmeasured side or an empty denominator', () => {
    expect(share(5, 0)).toBeNull()
    expect(share(null, 10)).toBeNull()
    expect(share(5, null)).toBeNull()
    expect(share(5, 20)).toEqual({ pct: 25, of: 20 })
  })
})

// ─── Identity rules ─────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-29 · duplicate rules are facts about the gate', () => {
  it('17 · the rows state On/Off and nothing else', () => {
    expect(identityRuleRows(composition())).toEqual([
      { key: 'email',  label: 'One registration per email',  state: 'On' },
      { key: 'mobile', label: 'One registration per mobile', state: 'Off' },
    ])
    expect(identityRuleRows(composition({ identityRules: null }))).toBeNull()
  })

  it('18 · the producer reads the rules from the event document as booleans, defaulting to Off', () => {
    expect(ENGINE).toContain("limitPerEmail:  (rulesRaw as Record<string, unknown>).limitPerEmail  === true")
    expect(ENGINE).toContain("limitPerMobile: (rulesRaw as Record<string, unknown>).limitPerMobile === true")
  })
})

// ─── Normalization and the module gate ──────────────────────────────────────

describe('RD-ANALYTICS-12-29 · payload and gate', () => {
  const caps = (over: Partial<AnalyticsModuleContext> = {}): AnalyticsModuleContext => ({
    eventType: 'conference', registrationRules: null, applications: null,
    gate: { flags: { coupons: true, broadcast: true, certificates: true, donations: true },
            has: () => true } as unknown as AnalyticsModuleContext['gate'],
    financeAllowed: true, ...over,
  })
  const comp: RegistrationSourceComposition = {
    lifetime: sc(),
    byStatus: composition().sourceByStatus,
  }
  const producer = (over: Partial<EventAnalytics> = {}): EventAnalytics => ({
    eventId: 'e', eventName: 'E', lifecycleStatus: 'published', publishedAt: null,
    truncated: false,
    limits: { registrations: true, communications: true, reminders: true, certificates: true, ledger: true, passValue: true },
    financialAllowed: false, range: RANGE,
    period: { confirmed: 10, cancelled: 2, checkedIn: 4 }, baseline: null,
    coverageSince: null, coveragePartial: false, baselineOutsideCoverage: false,
    kpis: { registrations: 100, confirmed: 80, pending: 4, cancelled: 15, rejected: 1, waitlisted: 0, paid: 60,
            free: 20, paymentPending: 4, refunded: 3, refundPending: 0, checkedIn: 40, conversionPct: 80,
            capacity: 200, capacityUsedPct: 40, remaining: 120 },
    registrationsByDay: [], cancellationsByDay: [], checkInsByDay: [],
    paymentStatus: [], passSales: [{ label: 'General', value: 50 }, { label: 'VIP', value: 20 }],
    couponUsage: [], funnel: [],
    communication: null, reminders: null, certificates: null,
    operationalCapabilities: { identifiersEnabled: false, identifierLabel: null, timingEnabled: false, timingLabel: null },
    identifierProgress: null, timingProgress: null,
    communicationCounts: null, communicationSpend: null,
    communicationIntelligence: unmeasuredCommunicationIntelligence(RANGE),
    registrationComposition: comp,
    registrationIdentityRules: { limitPerEmail: true, limitPerMobile: false },
    dataFlags: { trafficSources: 'no_data', certificateVerifications: 'no_data', sms: 'no_data' },
    ...over,
  })
  const run = (p?: Partial<EventAnalytics>, c?: Partial<AnalyticsModuleContext>) =>
    normalizeEventAnalytics({ analytics: producer(p), range: RANGE, capabilities: caps(c), eventId: 'draft-A' })

  it('19 · participants is written when the composition was measured, with mixes derived from the same counts', () => {
    const r = run()
    expect(r.participants).toBeDefined()
    const c = r.participants!.composition
    expect(c.source).toEqual({ online: 70, walkin: 20, unrecorded: 10 })
    expect(c.passMix!.map(m => m.label)).toEqual(['General', 'VIP', 'Other passes'])
    expect(c.statusMix!.map(m => m.value)).toEqual([80, 4, 15, 1, 0])
    expect(c.identityRules).toEqual({ limitPerEmail: true, limitPerMobile: false })
    expect(c.basis).toBe('registration_source_field_and_status_counts')
  })

  it('20 · participants is ABSENT — not a shell of nulls — when the composition could not be read', () => {
    const r = run({ registrationComposition: null })
    expect(r.participants).toBeUndefined()
  })

  it('21 · the demographic and returning keys are never written, whatever the event', () => {
    const p = run().participants!
    for (const k of ['returning', 'ageBuckets', 'genderBuckets', 'cityBuckets']) {
      expect(k in p, k).toBe(false)
    }
    expect(NORMALIZE).not.toMatch(/ageBuckets|genderBuckets|cityBuckets|returning:/)
  })

  it('22 · the module is available exactly when the producer measured the composition', () => {
    const participants = MODULE_DEFS.find(m => m.key === 'participants')!
    expect(isAnalyticsModuleAvailable(participants, caps({ hasParticipantData: true }))).toBe(true)
    expect(isAnalyticsModuleAvailable(participants, caps({ hasParticipantData: false }))).toBe(false)
    expect(ROUTE).toContain('hasParticipantData: Boolean(result.analytics.registrationComposition)')
    expect(ROUTE).not.toContain('hasParticipantData: false')
    expect(ROUTE).not.toContain('hasParticipantData: true')
  })

  it('23 · the payload carries the module in capabilities.modules only when gated in', () => {
    expect(run(undefined, { hasParticipantData: true }).capabilities.modules).toContain('participants')
    expect(run(undefined, { hasParticipantData: false }).capabilities.modules).not.toContain('participants')
  })

  it('24 · the module has a route, a page, a breadcrumb leaf and a place in the nav', () => {
    const m = ROUTE_MODULES.find(x => x.key === 'participants')!
    expect(m.href).toBe('/dashboard/analytics/participants')
    expect(readFileSync(resolve(process.cwd(), 'app/(dashboard)/dashboard/analytics/participants/page.tsx'), 'utf8'))
      .toContain('AnalyticsModuleNav')
    expect(code('lib/navigation/breadcrumbs.ts')).toContain("'/dashboard/analytics/participants':   'Participants'")
  })

  it('25 · compositionMeasured reads the source figures, not the module name', () => {
    expect(compositionMeasured(run().participants)).toBe(true)
    expect(compositionMeasured(undefined)).toBe(false)
    expect(compositionMeasured({ composition: composition({ source: sc({ online: null, walkin: null }) }) })).toBe(false)
  })
})

// ─── Terminology ────────────────────────────────────────────────────────────

describe('RD-ANALYTICS-12-29 · seats, never people', () => {
  it('26 · the module states the rule in its first line', () => {
    expect(SEATS_NOT_PEOPLE).toMatch(/counts registrations/)
    expect(SEATS_NOT_PEOPLE).toMatch(/does not identify unique participants/)
    expect(UI).toContain('subtitle={SEATS_NOT_PEOPLE}')
  })

  it('27 · no label, key or copy claims a unique, total, new or returning PARTICIPANT count', () => {
    // The two sentences that NEGATE these phrases are the module's honesty; strip exactly
    // them and demand that nothing else uses the words.
    const negations = /does not identify unique participants|Unique and returning participants are not reported/g
    for (const [name, src] of [['model', MODEL], ['ui', UI], ['contract-participants', CONTRACT.slice(CONTRACT.indexOf('interface RegistrationComposition'))]]) {
      const rest = src.replace(negations, '')
      expect(rest, name).not.toMatch(/unique participants?|total participants|new participants|returning participants/i)
      expect(rest, name).not.toMatch(/uniqueParticipants|totalParticipants|newParticipants|returningParticipants/)
    }
  })

  it('28 · no demographic figure is produced anywhere in the participants path', () => {
    const DEMOGRAPHIC = /\bage\b|gender|\bcity\b|country|pincode|\bdob\b|birth|location/i
    for (const src of [SOURCES, MODEL]) expect(src).not.toMatch(DEMOGRAPHIC)
    // The UI names them ONCE, in the closing notice that explains their absence — nowhere else.
    expect(UI.slice(0, UI.indexOf('function TrustNotice'))).not.toMatch(DEMOGRAPHIC)
    expect(UI.slice(UI.indexOf('function TrustNotice'))).toMatch(/Age, gender and location are not reported/)
  })

  it('29 · the closing notice explains the absences instead of leaving blank space', () => {
    expect(UI).toMatch(/What this page does not show, and why/)
    expect(UI).toMatch(/None of these is zero/)
  })
})

// ─── Data boundary, isolation, scale ────────────────────────────────────────

describe('RD-ANALYTICS-12-29 · reads', () => {
  it('30 · the source module reads ONE field and no PII, form answers or CRM', () => {
    expect(SOURCES).toContain("where('registrationSource', '==', 'online')")
    expect(SOURCES).toContain("where('registrationSource', '==', 'walkin')")
    const engineBlock = ENGINE.slice(ENGINE.indexOf('const registrationComposition = status'), ENGINE.indexOf('const [campaignCounts'))
    for (const src of [SOURCES, MODEL, engineBlock]) {
      expect(src).not.toMatch(/attendee\.|formResponses|crmContacts|crmActivities|lib\/crm|recipientEmail|\.email\b|\.phone\b/)
    }
  })

  it('31 · every query names the workspace AND the event', () => {
    expect(SOURCES).toMatch(/\.where\('organizerUid', '==', organizerUid\)\s*\.where\('eventSlug',\s+'==', eventSlug\)/)
    expect(ENGINE).toContain('readRegistrationSourceComposition(organizerUid, eventId, {')
  })

  it('32 · aggregates only — no document page, no cap, no scan', () => {
    expect((SOURCES.match(/countOf\(/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(SOURCES).toContain('.count().get()')
    expect(SOURCES).not.toMatch(/\.limit\(|\.docs|\.forEach\(|\.get\(\)\s*$/m)
    expect(SOURCES).not.toMatch(/(?<!count\(\))\.get\(\)/)
  })

  it('33 · a failed aggregate is null, never zero, and a wholly failed read is a null block', () => {
    expect(SOURCES).toContain('.catch(() => null)')
    expect(SOURCES).not.toMatch(/catch\(\(\) => 0\)|\?\? 0/)
    expect(SOURCES).toContain('return anyMeasured ? { lifetime, byStatus } : null')
  })

  it('34 · the composition is skipped when the status aggregates failed — no remainder against an unmeasured total', () => {
    expect(ENGINE).toMatch(/const registrationComposition = status\s*\? await readRegistrationSourceComposition/)
  })

  it('35 · everything in the block is lifetime and the screen says so; no windowed source figure exists', () => {
    expect(SOURCES).not.toMatch(/createdAt|registeredAt|istRangeBounds/)
    expect(UI).toMatch(/all time/)
    expect(UI).toMatch(/the date range above does not apply/)
  })

  it('36 · the module is universal: no BIB, timing, session or event-type branch', () => {
    for (const src of [SOURCES, MODEL, UI]) {
      expect(src).not.toMatch(/bibNumber|bibCategory|timingTag|selectedSessions|eventType/)
    }
  })
})
