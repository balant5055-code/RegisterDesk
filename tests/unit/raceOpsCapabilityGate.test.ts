// RD-RACEOPS-02B · Race Operations is offered only where the event's TYPE admits it.
//
// Four layers, one rule. The rule is `isRaceOperationsAvailable` in the platform's own
// event capability model (lib/events/eventCapabilities); the sidebar row, the race-ops
// event list, the page gate and every route apply it. These tests pin the rule, the pure
// selection logic the sidebar uses (event switching included), and — by source
// assertion — that no layer grew a private definition of "sports event".

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isRaceOperationsAvailable, isEventTypeApplicable, isEventTabAvailable,
} from '@/lib/events/eventCapabilities'
import { EVENT_TABS } from '@/lib/events/eventTabs'
import { EVENT_TYPE_NAMES, EVENT_SUBTYPE_NAMES } from '@/lib/events/taxonomy'
import {
  WORKSPACE_NAV_ITEMS, navItemAvailableForEvent, resolveNavHref,
} from '@/config/workspaceNav'
import { RACE_OPS_TYPE_REASON, resolveRaceOpsEligibility } from '@/features/race-operations/utils/eligibility'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

const NON_SPORTS = Object.keys(EVENT_TYPE_NAMES).filter(t => t !== 'sports')

// ─── A–F · the rule ──────────────────────────────────────────────────────────

describe('isRaceOperationsAvailable — the one rule', () => {
  it('A · a sports event is admitted', () => {
    expect(isRaceOperationsAvailable('sports')).toBe(true)
  })

  it('every sports SUBTYPE the taxonomy knows is admitted — subtype is not an input', () => {
    // running, cycling, swimming, triathlon, cricket, … all arrive as eventType 'sports'.
    expect(Object.keys(EVENT_SUBTYPE_NAMES.sports).length).toBeGreaterThan(5)
    expect(isRaceOperationsAvailable('sports')).toBe(true)
  })

  it.each(NON_SPORTS)('B–E · %s is not admitted', type => {
    expect(isRaceOperationsAvailable(type)).toBe(false)
  })

  it('the taxonomy covers the four the brief names', () => {
    for (const t of ['conference', 'workshop', 'meetup', 'fundraising']) expect(NON_SPORTS).toContain(t)
  })

  it('an unknown / missing type is not admitted', () => {
    expect(isRaceOperationsAvailable(null)).toBe(false)
    expect(isRaceOperationsAvailable(undefined)).toBe(false)
    expect(isRaceOperationsAvailable('')).toBe(false)
  })

  it('F · timing / identifier configuration is NOT an input — the rule takes only the type', () => {
    // The function's arity is the contract: one argument, the event type.
    expect(isRaceOperationsAvailable.length).toBe(1)
    expect(isRaceOperationsAvailable('sports')).toBe(true)
  })

  it('is the SAME rule the event tabs apply for their type flags (no second definition)', () => {
    // `sportsOnly` is declared on EventTabDef and set on no tab today; Race Operations is its
    // first live use, through the shared predicate. The exhibition flag proves the sharing.
    expect(EVENT_TABS.some(t => t.sportsOnly)).toBe(false)
    for (const type of ['sports', ...NON_SPORTS, null]) {
      expect(isRaceOperationsAvailable(type)).toBe(isEventTypeApplicable({ sportsOnly: true }, type))
    }
    expect(isEventTypeApplicable({ exhibitionOnly: true }, 'exhibition')).toBe(true)
    expect(isEventTypeApplicable({ exhibitionOnly: true }, 'sports')).toBe(false)
  })

  it('isEventTabAvailable still delegates its type step to isEventTypeApplicable', () => {
    const src = read('lib/events/eventCapabilities.ts')
    expect(src).toContain('if (!isEventTypeApplicable(tab, ctx.eventType)) return false')
    // the inlined trio is gone — one rule, written once
    expect(src.match(/eventType !== 'sports'/g)?.length).toBe(1)
    // and an exhibition-only tab still behaves as before through the shared rule
    const exhibitionTab = EVENT_TABS.find(t => t.exhibitionOnly)!
    const ctx = { eventType: 'exhibition', registrationRules: null, applications: null, gate: { flags: {} as never, has: () => true } }
    expect(isEventTabAvailable(exhibitionTab, ctx)).toBe(true)
    expect(isEventTabAvailable(exhibitionTab, { ...ctx, eventType: 'sports' })).toBe(false)
  })
})

// ─── Event selection ─────────────────────────────────────────────────────────

describe('resolveRaceOpsEligibility — type before lifecycle', () => {
  it('a conference is ineligible with the type reason even when published with races', () => {
    expect(resolveRaceOpsEligibility('published', 3, 'conference'))
      .toEqual({ eligible: false, reason: RACE_OPS_TYPE_REASON })
  })
  it('a sports event keeps the existing lifecycle / pass-count behaviour', () => {
    expect(resolveRaceOpsEligibility('published', 3, 'sports')).toEqual({ eligible: true })
    expect(resolveRaceOpsEligibility('draft', 3, 'sports').reason).toBe('Publish this event before recording results.')
  })
})

// ─── Navigation (I, J · event switching) ─────────────────────────────────────

describe('navItemAvailableForEvent — the sidebar decision, pure', () => {
  const raceOps = WORKSPACE_NAV_ITEMS.find(i => i.key === 'race-ops')!
  const sports = { eventType: 'sports' }
  const conf   = { eventType: 'conference' }

  it('the Race Operations row declares the capability, and no other row does', () => {
    expect(raceOps.eventCapability).toBe('raceOperations')
    expect(WORKSPACE_NAV_ITEMS.filter(i => i.eventCapability).map(i => i.key)).toEqual(['race-ops'])
  })

  it('a row without a capability is never affected', () => {
    const analytics = WORKSPACE_NAV_ITEMS.find(i => i.key === 'analytics')!
    expect(navItemAvailableForEvent(analytics, conf, [conf])).toBe(true)
    expect(navItemAvailableForEvent(analytics, null, [])).toBe(true)
  })

  it('selected sports event → offered; selected conference → hidden', () => {
    expect(navItemAvailableForEvent(raceOps, sports, [sports, conf])).toBe(true)
    expect(navItemAvailableForEvent(raceOps, conf,   [sports, conf])).toBe(false)
  })

  it('I · eligible → switch to ineligible removes it; J · switch back restores it — no memory', () => {
    const list = [sports, conf]
    const before = navItemAvailableForEvent(raceOps, sports, list)
    const after  = navItemAvailableForEvent(raceOps, conf, list)
    const back   = navItemAvailableForEvent(raceOps, sports, list)
    expect([before, after, back]).toEqual([true, false, true])
  })

  it('no event selected → offered only when some listed event admits it (and stays disabled, href null)', () => {
    expect(navItemAvailableForEvent(raceOps, null, [conf, sports])).toBe(true)
    expect(navItemAvailableForEvent(raceOps, null, [conf, conf])).toBe(false)
    expect(navItemAvailableForEvent(raceOps, null, [])).toBe(false)
    expect(resolveNavHref(raceOps, null)).toBeNull()
  })

  it('K · the row still carries its permission — role AND capability, independently', () => {
    expect(raceOps.permission).toBe('events')
    const src = read('components/dashboard/Sidebar.tsx')
    expect(src).toContain(".filter(item => !item.permission || perms.has(item.permission))")
    expect(src).toContain('.filter(item => navItemAvailableForEvent(item, selectedEvent, events))')
    expect(src).toContain('const { selectedEventId, selectedEvent, events } = useEventContext()')
    expect(src).toMatch(/\[flags, perms, selectedEventId, selectedEvent, events, activeItem\]/)
  })
})

// ─── Page / direct URL (G) ───────────────────────────────────────────────────

describe('RaceOpsAccessGate — role AND event capability', () => {
  const src = read('features/race-operations/components/RaceOpsAccessGate.tsx')

  it('reads the shell\'s selected event and refuses an ineligible one with its own state', () => {
    expect(src).toContain("import { isRaceOperationsAvailable } from '@/lib/events/eventCapabilities'")
    expect(src).toContain('const { selectedEvent, loading: eventsLoading } = useEventContext()')
    expect(src).toContain('if (selectedEvent && !isRaceOperationsAvailable(selectedEvent.eventType))')
    expect(src).toContain('title="Race Operations is not available for this event"')
  })

  it('the role refusal comes first and is unchanged; children render only after both pass', () => {
    const role = src.indexOf('if (!allowed) {')
    const cap  = src.indexOf('if (selectedEvent && !isRaceOperationsAvailable')
    const kids = src.indexOf('return <>{children}</>')
    expect(role).toBeGreaterThan(0)
    expect(cap).toBeGreaterThan(role)
    expect(kids).toBeGreaterThan(cap)
    expect(src).toContain('title="Race Operations is restricted"')
  })

  it('every Race Operations page is wrapped by the gate', () => {
    for (const page of ['page.tsx', 'publish-results/page.tsx', 'history/page.tsx', 'finisher-badges/page.tsx']) {
      expect(read(`app/(dashboard)/dashboard/race-operations/${page}`)).toContain('<RaceOpsAccessGate>')
    }
  })

  it('the race-ops event list holds sports events only', () => {
    const hook = read('features/race-operations/hooks/useRaceOpsEvents.ts')
    expect(hook).toContain('data.events.filter(e => isRaceOperationsAvailable(e.eventType)).map(projectEvent)')
    const selector = read('features/race-operations/components/EventSelector.tsx')
    expect(selector).toContain('resolveRaceOpsEligibility(event.lifecycleStatus, event.raceCount, event.eventType)')
    expect(selector).toContain('title="No sports events yet"')
  })
})

// ─── API / server (H, L) ─────────────────────────────────────────────────────

describe('server gate — every Race Operations route re-applies the rule', () => {
  it('resolveRaceOpsEvent decides on the draft\'s type with the same predicate, 409 with a reason', () => {
    const repo = read('features/race-operations/repositories/eventReadRepo.ts')
    expect(repo).toContain("import { isRaceOperationsAvailable } from '@/lib/events/eventCapabilities'")
    expect(repo).toContain('if (!isRaceOperationsAvailable(eventType)) {')
    expect(repo).toContain("return { ok: false, status: 409, error: RACE_OPS_TYPE_ERROR }")
    // resolveRace goes through it before reading anything else
    expect(repo).toContain('const gate = await resolveRaceOpsEvent(workspaceUid, eventId)')
  })

  it('session-scoped services compose ownership + capability through requireEligibleSession', () => {
    const gate = read('features/race-operations/services/eventGate.ts')
    expect(gate).toContain('const session = await getOwnedSession(sessionId, workspaceUid)')
    expect(gate).toContain('const gate = await resolveRaceOpsEvent(workspaceUid, session.eventId)')
    for (const f of [
      'features/race-operations/services/importService.ts',
      'features/race-operations/services/registrationVerify.ts',
      'features/race-operations/services/snapshotService.ts',
    ]) {
      const src = read(f)
      expect(src).toContain("from '@/features/race-operations/services/eventGate'")
      expect(src).not.toMatch(/await getOwnedSession\(/)
    }
    const svc = read('features/race-operations/services/importService.ts')
    for (const fn of ['appendResults', 'rankSessionChunk', 'publishSession', 'cancelSession']) {
      const at = svc.indexOf(`export async function ${fn}(`)
      expect(at, fn).toBeGreaterThan(0)
      expect(svc.slice(at, at + 1400)).toContain('requireEligibleSession(')
    }
  })

  it('every route either resolves the event through the gate or calls a gated service — after role authorization', () => {
    const routes = [
      ['sessions/route.ts',                       /createImportSession\(|resolveRaceOpsEvent\(/],
      ['sessions/[sessionId]/route.ts',           /requireEligibleSession\(/],
      ['sessions/[sessionId]/results/route.ts',   /appendResults\(|requireEligibleSession\(/],
      ['sessions/[sessionId]/verify/route.ts',    /verifySessionRegistrations\(/],
      ['sessions/[sessionId]/rank/route.ts',      /rankSessionChunk\(/],
      ['sessions/[sessionId]/snapshot/route.ts',  /buildSnapshotChunk\(/],
      ['sessions/[sessionId]/publish/route.ts',   /publishSession\(/],
      ['sessions/[sessionId]/cancel/route.ts',    /cancelSession\(/],
      ['races/route.ts',                          /resolveRace\(/],
      ['races/export/route.ts',                   /resolveRace\(/],
      ['badges/route.ts',                         /resolveRaceOpsEvent\(/],
    ] as const
    for (const [file, gated] of routes) {
      const src = read(`app/api/organizer/race-operations/${file}`)
      expect(src, file).toMatch(gated)
      // role first: authorizeRaceOps appears before the first gated call
      expect(src.indexOf('authorizeRaceOps(req)'), file).toBeLessThan(src.search(gated))
    }
  })

  it('the rule is imported from the capability model, never re-derived — no private sports check anywhere in the module', () => {
    const files = [
      'features/race-operations/repositories/eventReadRepo.ts',
      'features/race-operations/services/eventGate.ts',
      'features/race-operations/hooks/useRaceOpsEvents.ts',
      'features/race-operations/utils/eligibility.ts',
      'features/race-operations/components/RaceOpsAccessGate.tsx',
      'components/dashboard/Sidebar.tsx',
      'config/workspaceNav.ts',
    ]
    for (const f of files) expect(read(f), f).not.toMatch(/=== 'sports'|!== 'sports'/)
  })
})

// ─── Firestore safety ────────────────────────────────────────────────────────

describe('no schema, index or rule was needed', () => {
  it('the gate reads only the draft document the platform already owns', () => {
    const repo = read('features/race-operations/repositories/eventReadRepo.ts')
    const at = repo.indexOf('export async function resolveRaceOpsEvent(')
    const body = repo.slice(at, repo.indexOf('export async function fetchEventRoster('))
    expect(body).toContain('eventDrafts/${eventId}`).get()')
    expect(body).not.toMatch(/\.where\(|\.collection\(/)
  })
})
