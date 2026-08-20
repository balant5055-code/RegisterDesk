// EVENT-TOTAL Booking Milestone Alerts — behaviour, not source strings.
//
// ═══ THE SCENARIO THIS EXISTS FOR ════════════════════════════════════════════
// 5 KM = 1,500 bookings, 10 KM = 700. Neither pass reaches 2,000, but the EVENT has 2,200.
// A 2,000 event milestone must fire; a 2,000 per-pass milestone must not. Getting that
// backwards — resolving the event scope against a pass count — is the single most likely
// implementation error, so it is asserted directly and mutation-tested.
//
// ═══ WHY THE COUNT SOURCE MATTERS ════════════════════════════════════════════
// The event scope reads `registrationCounters.totalCount`, never a re-sum of `passCounts`.
// Two reasons, both load-bearing: totalCount is the number the CAPACITY gate itself enforces,
// and a historical dotted-key defect left `passCounts` empty on older events while totalCount
// was written correctly. Summing would therefore be both redundant and, on those events, wrong.
//
// The resolver is deliberately shared with the per-pass scope — same algorithm, different
// count — so these tests also pin that reuse: one alert shape resolving correctly against
// either scope, with neither able to suppress the other.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import {
  resolveMilestoneAlert,
  resolveMilestoneAlertsByPass,
  type MilestoneAlert,
} from '@/lib/events/milestoneAlerts'

const read  = (p: string) => readFileSync(resolvePath(process.cwd(), p), 'utf8')
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '')

const PUBLIC_PAGE   = 'app/events/[slug]/page.tsx'
const REGISTER_PAGE = 'app/events/[slug]/register/page.tsx'

/** The organizer's event-wide configuration. */
const EVENT_2000: MilestoneAlert[] = [
  { threshold: 2000, message: 'We have crossed 2,000 registrations!', tone: 'success' },
]

// ─── 1. The headline scenario ─────────────────────────────────────────────────

describe('1,500 + 700 = 2,200 fires the EVENT milestone, not the pass ones', () => {
  const counter = { totalCount: 2200, passCounts: { '5k': 1500, '10k': 700 } }
  const passes  = [
    { id: '5k',  milestoneAlerts: [{ threshold: 2000, message: 'pass-level 2000' }] },
    { id: '10k', milestoneAlerts: [{ threshold: 2000, message: 'pass-level 2000' }] },
  ]

  it('the event alert fires on the event total', () => {
    const alert = resolveMilestoneAlert(EVENT_2000, counter.totalCount)
    expect(alert).not.toBeNull()
    expect(alert?.threshold).toBe(2000)
    expect(alert?.message).toBe('We have crossed 2,000 registrations!')
  })

  it('NEITHER pass fires its own 2,000 milestone — 1,500 and 700 are both short', () => {
    expect(resolveMilestoneAlertsByPass(passes, counter.passCounts)).toEqual({})
  })

  it('the two scopes coexist: event fires while both passes stay silent', () => {
    const event   = resolveMilestoneAlert(EVENT_2000, counter.totalCount)
    const perPass = resolveMilestoneAlertsByPass(passes, counter.passCounts)
    expect(event).not.toBeNull()
    expect(Object.keys(perPass)).toEqual([])
  })

  it('a pass that DOES reach its own threshold still fires, independently', () => {
    const c = { totalCount: 2200, passCounts: { '5k': 2100, '10k': 100 } }
    const event   = resolveMilestoneAlert(EVENT_2000, c.totalCount)
    const perPass = resolveMilestoneAlertsByPass(passes, c.passCounts)
    expect(event).not.toBeNull()                 // event still fires…
    expect(Object.keys(perPass)).toEqual(['5k']) // …and so does the one pass that qualified
  })

  it('neither scope suppresses the other — both can be non-null at once', () => {
    const c = { totalCount: 5000, passCounts: { '5k': 3000, '10k': 2000 } }
    expect(resolveMilestoneAlert(EVENT_2000, c.totalCount)).not.toBeNull()
    expect(Object.keys(resolveMilestoneAlertsByPass(passes, c.passCounts)).sort()).toEqual(['10k', '5k'])
  })
})

// ─── 2. The event scope uses the TOTAL, never a pass count ───────────────────

describe('the event scope reads the event total', () => {
  it('fires at exactly the threshold', () => {
    expect(resolveMilestoneAlert(EVENT_2000, 2000)?.threshold).toBe(2000)
  })

  it('does not fire below it, even when some pass count is high', () => {
    // 1,999 total. A naive implementation summing or using a pass count could differ.
    expect(resolveMilestoneAlert(EVENT_2000, 1999)).toBeNull()
  })

  it('highest crossed event milestone wins', () => {
    const tiers: MilestoneAlert[] = [
      { threshold: 1000, message: 'one thousand' },
      { threshold: 2000, message: 'two thousand' },
      { threshold: 3000, message: 'three thousand' },
    ]
    expect(resolveMilestoneAlert(tiers, 2500)?.message).toBe('two thousand')
    expect(resolveMilestoneAlert(tiers, 999)).toBeNull()
    expect(resolveMilestoneAlert(tiers, 99_999)?.message).toBe('three thousand')
  })

  it('private / invite-only bookings are INCLUDED, because totalCount includes them', () => {
    // The counter increments for any passId; visibility is a display concept only. 1,200
    // public + 900 invite-only = 2,100 ⇒ the milestone fires on the combined total.
    const totalIncludingPrivate = 1200 + 900
    expect(resolveMilestoneAlert(EVENT_2000, totalIncludingPrivate)).not.toBeNull()
  })
})

// ─── 3. Malformed configuration and counts stay harmless ─────────────────────

describe('malformed event configuration is inert', () => {
  it('absent / null / empty / non-array ⇒ null', () => {
    for (const cfg of [undefined, null, [], 'x', 7, {}] as unknown[]) {
      expect(resolveMilestoneAlert(cfg as MilestoneAlert[], 99_999), String(cfg)).toBeNull()
    }
  })

  it('threshold 0, negative, fractional or non-finite ⇒ null', () => {
    for (const t of [0, -1, -2000, 2.5, NaN, Infinity, -Infinity]) {
      expect(resolveMilestoneAlert([{ threshold: t, message: 'x' }], 99_999), String(t)).toBeNull()
    }
  })

  it('blank or whitespace-only message ⇒ null', () => {
    for (const m of ['', '   ', '\t\n']) {
      expect(resolveMilestoneAlert([{ threshold: 10, message: m }], 5000), JSON.stringify(m)).toBeNull()
    }
  })

  it('NaN / Infinity / negative / missing counts ⇒ null, never a throw', () => {
    for (const c of [NaN, Infinity, -1, -9999, null, undefined] as unknown[]) {
      expect(resolveMilestoneAlert(EVENT_2000, c as number), String(c)).toBeNull()
    }
  })

  it('never throws for any combination', () => {
    for (const cfg of [null, undefined, [], EVENT_2000, 'x'] as unknown[]) {
      for (const c of [null, undefined, NaN, -1, 0, 2200, Infinity] as unknown[]) {
        expect(() => resolveMilestoneAlert(cfg as MilestoneAlert[], c as number)).not.toThrow()
      }
    }
  })

  it('a zero total shows nothing', () => {
    expect(resolveMilestoneAlert(EVENT_2000, 0)).toBeNull()
  })
})

// ─── 4. showOnSelection is not part of the event scope ───────────────────────

describe('event alerts carry no show-on-selection behaviour', () => {
  it('the resolved event alert defaults showOnSelection to false', () => {
    expect(resolveMilestoneAlert(EVENT_2000, 2200)?.showOnSelection).toBe(false)
  })

  it('the register page never opens a dialog for the event alert', () => {
    const client = strip(read('app/events/[slug]/register/RegisterClient.tsx'))
    // The dialog is driven solely by the PER-PASS alert.
    expect(client).toMatch(/milestoneAlert\?\.showOnSelection === true/)
    expect(client).not.toMatch(/eventMilestoneAlert\?\.showOnSelection/)
  })
})

// ─── 5. Wiring: correct count source, correct ordering, zero extra reads ─────

describe('wiring — count source and ordering', () => {
  it('the PUBLIC page resolves the event alert from counter.totalCount', () => {
    const src = strip(read(PUBLIC_PAGE))
    expect(src).toMatch(/resolveMilestoneAlert\(\s*pricing\?\.eventMilestoneAlerts[\s\S]{0,120}counter\?\.totalCount,/)
    // It must NOT be resolved from a pass count or a re-sum.
    expect(src).not.toMatch(/eventMilestoneAlerts[\s\S]{0,120}passCounts/)
    expect(src).not.toMatch(/Object\.values\(\s*counter\?\.passCounts/)
  })

  it('the REGISTER page resolves it from gate.availability.eventTotalCount', () => {
    const src = strip(read(REGISTER_PAGE))
    expect(src).toMatch(/resolveMilestoneAlert\(\s*rawPricing\?\.eventMilestoneAlerts[\s\S]{0,200}gate\.availability\?\.eventTotalCount,/)
    expect(src).not.toMatch(/eventMilestoneAlerts[\s\S]{0,200}passCount,/)
  })

  it('the public page resolves the event alert AFTER capacity is computed', () => {
    const src      = strip(read(PUBLIC_PAGE))
    const capacity = src.indexOf('computeEventAvailability(')
    const event    = src.indexOf('const eventMilestoneAlert =')
    expect(capacity).toBeGreaterThan(-1)
    expect(event).toBeGreaterThan(capacity)
  })

  it('the register page resolves it AFTER the gate has allowed the attendee', () => {
    const src   = strip(read(REGISTER_PAGE))
    const gate  = src.indexOf('await checkRegistrationGate(')
    const event = src.indexOf('const eventMilestoneAlert =')
    expect(gate).toBeGreaterThan(-1)
    expect(event).toBeGreaterThan(gate)
  })

  it('adds ZERO counter reads on either surface', () => {
    // One pre-existing read on the public page; the register page relies on the gate's.
    expect(strip(read(PUBLIC_PAGE)).match(/getRegistrationCounter\(/g)?.length).toBe(1)
    expect(strip(read(REGISTER_PAGE))).not.toContain('getRegistrationCounter')
    expect(strip(read(REGISTER_PAGE))).not.toContain("collection('registrations')")
  })

  it('introduces no new API route, index or rule', () => {
    expect(read('firestore.rules')).not.toContain('eventMilestone')
    expect(read('firestore.indexes.json')).not.toContain('eventMilestone')
  })

  it('does not modify the protected registration/capacity files', () => {
    for (const f of [
      'lib/registrations/gate.ts', 'lib/registrations/capacity.ts',
      'lib/registrations/availability.ts', 'lib/firebase/firestore/registrationCounters.ts',
    ]) {
      expect(read(f), f).not.toContain('eventMilestone')
    }
  })
})

// ─── 6. Absent configuration preserves today's behaviour ─────────────────────

describe('events without event-total configuration are unaffected', () => {
  it('the field is optional wherever it is declared', () => {
    expect(read('lib/events/builder/types.ts')).toMatch(/eventMilestoneAlerts\?:/)
    expect(read('components/event-templates/types.ts')).toMatch(/eventMilestoneAlert\?:/)
    expect(read('app/events/[slug]/register/RegisterClient.tsx')).toMatch(/eventMilestoneAlert\?:/)
  })

  it('the client prop defaults to null', () => {
    expect(strip(read('app/events/[slug]/register/RegisterClient.tsx'))).toMatch(/eventMilestoneAlert = null,/)
  })

  it('an unconfigured event resolves to null at any count', () => {
    expect(resolveMilestoneAlert(undefined, 1_000_000)).toBeNull()
  })
})

// ─── 7. Presentation only ────────────────────────────────────────────────────

describe('the event alert cannot block registration', () => {
  const client = strip(read('app/events/[slug]/register/RegisterClient.tsx'))

  it('no guard, early return or disabled state depends on it', () => {
    expect(client).not.toMatch(/if\s*\([^)]*eventMilestone[^)]*\)\s*(return|throw)/i)
    expect(client).not.toMatch(/disabled=\{[^}]*eventMilestone/i)
  })

  it('it is rendered, not consulted by the submit path', () => {
    expect(client).toContain('<MilestoneNotice alert={eventMilestoneAlert}')
    const submit = client.slice(client.indexOf('async function handleSubmit'))
    expect(submit).not.toContain('eventMilestoneAlert')
  })

  it('the message renders as escaped React text — never HTML', () => {
    expect(strip(read('components/event-templates/shared/registration/MilestoneNotice.tsx')))
      .not.toContain('dangerouslySetInnerHTML')
  })

  it('is pass-INDEPENDENT — no milestoneVisible guard, so a pass switch cannot hide it', () => {
    // The per-pass notice is guarded; the event one deliberately is not.
    expect(client).toMatch(/\{milestoneVisible && <MilestoneNotice alert=\{milestoneAlert\}/)
    expect(client).toMatch(/<MilestoneNotice alert=\{eventMilestoneAlert\}/)
    expect(client).not.toMatch(/milestoneVisible && <MilestoneNotice alert=\{eventMilestoneAlert\}/)
  })
})
