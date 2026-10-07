// RD-EVENT-04 · The Event Setup Center, asserted as rules.
//
// The defects these pin were found by auditing the real code before changing it:
//
//   D1 · RD-EVENT-03 read `evaluatePublishRequirements()` WITHOUT `.filter(r => !r.passed)`,
//        so a fully configured draft reported ten issues and a count of twelve. Every
//        other consumer filters; this one did not.
//   D2 · Setup derived readiness from the draft with its own rules, independently of the
//        evaluator the publish flow gates on — so a card could read "Ready" for an event
//        the platform would refuse to publish.
//   D3 · `event_organizer` is a CRITICAL publish blocker and had NO Setup card at all.
//   D4 · `organizer_phone` (warning) had no card either.
//   D5 · A missing logo rendered "Needs Attention", promoting a SUGGESTION to a problem.
//   D6 · Setup applied no feature-flag and no permission gate — a workspace with
//        certificates off still saw a live "Configure certificates" button.
//   D7 · Coupons and Waitlist have working tabs and nav entries but no Setup card.
//   D8 · Setup fetched three endpoints that each re-authorized and re-read the event
//        draft, and `sessions` returned a full agenda bundle to display one count.
//   D9 · Navigation used a local `onOpenTab` state setter, so a Setup action never
//        changed the URL and could not be cmd-clicked or shared.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  readiness, gateState, isLive, isLocked, publishChecksApply,
  SECTION_ORDER, STATE_LABEL, STATE_RANK, STATE_TONE,
} from '@/lib/eventSetup/readiness'
import { resolveItems, SETUP_ITEM_KEYS, type SetupSignals } from '@/lib/eventSetup/items'
import { evaluatePublishRequirements, severityOf } from '@/lib/events/publishRequirements'
import { EVENT_TABS } from '@/lib/events/eventTabs'
import type { EventDetailResponse, EventPublishCheck } from '@/app/api/organizer/events/[eventId]/route'
import type { FeatureFlagsConfig } from '@/lib/config/businessConfig'
import type { TeamPermission } from '@/lib/team/types'
import type { EventLifecycleStatus } from '@/types/events'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ROUTE   = strip(read('app/api/organizer/events/[eventId]/route.ts'))
const SIGNALS = strip(read('app/api/organizer/events/[eventId]/setup-signals/route.ts'))
const TAB     = strip(read('app/(dashboard)/dashboard/events/[eventId]/tabs/SetupCenterTab.tsx'))
const ITEMS   = strip(read('lib/eventSetup/items.ts'))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The authoritative check ids, taken from the evaluator itself. */
const ALL_CHECK_IDS = evaluatePublishRequirements({ eventDetails: null, pricing: null, registrationForm: null })
  .map(r => r.id)

function checks(over: Partial<Record<string, boolean>> = {}): EventPublishCheck[] {
  return evaluatePublishRequirements({ eventDetails: null, pricing: null, registrationForm: null })
    .map(r => ({
      id: r.id, title: r.title, description: r.description,
      stepName: r.stepName, stepIndex: r.stepIndex,
      severity: severityOf(r),
      passed: over[r.id] ?? true,
    }))
}

function ev(over: Partial<EventDetailResponse> = {}): EventDetailResponse {
  return {
    draftId: 'e1', status: 'draft', lifecycleStatus: 'draft',
    name: 'Chennai Marathon', tagline: null, shortDesc: null, fullDesc: null, slug: null,
    startDate: '2026-09-14', startTime: null, endDate: null, endTime: null, timezone: 'Asia/Kolkata',
    bannerUrl: null, logoUrl: null,
    eventType: 'sports', eventSubtype: null, campaignType: null, visibility: 'public',
    venueType: 'physical', venueName: 'Marina Beach', venueCity: 'Chennai',
    venueAddress: null, onlinePlatform: null, onlineMeetingUrl: null,
    totalCapacity: 5000, totalRegistrations: 2295, checkedInCount: 1180,
    confirmedRevenuePaise: 100000, isFreeEvent: false, passes: [],
    publishedAt: null, updatedAt: '2026-08-01T00:00:00.000Z',
    publishChecks: checks(),
    ...over,
  } as EventDetailResponse
}

const ALL_FLAGS = new Proxy({}, { get: () => true }) as FeatureFlagsConfig
const NO_FLAGS  = new Proxy({}, { get: () => false }) as FeatureFlagsConfig
const ALLOW = () => true
const DENY  = () => false

const SIG: SetupSignals = {
  certificates: { generated: 0, pending: 0 },
  identifiers:  { configured: true },
  sessions:     { count: 3 },
  coupons:      { count: 2 },
  waitlist:     { count: 0 },
}

function items(
  event = ev(), signals: SetupSignals = SIG,
  flags: FeatureFlagsConfig = ALL_FLAGS, has: (p: TeamPermission) => boolean = ALLOW,
) {
  return resolveItems({
    event, signals, gate: { flags, has },
    eventHref: '/dashboard/events/e1',
    tab: k => `/dashboard/events/e1?tab=${k}`,
    scoped: p => `${p}?eventId=e1`,
  })
}
const byKey = (k: string, ...args: Parameters<typeof items>) =>
  items(...args).find(i => i.key === k)!

// ═══ D1 · the `passed` filter ═════════════════════════════════════════════════

describe('publish requirements are filtered by `passed`', () => {
  it('the evaluator returns PASSED requirements too — the filter is mandatory', () => {
    const all = evaluatePublishRequirements({
      eventDetails: { info: { name: 'X' } }, pricing: null, registrationForm: null,
    })
    expect(all.some(r => r.passed)).toBe(true)
    expect(all.length).toBeGreaterThan(all.filter(r => !r.passed).length)
  })

  it('the route filters before building the issue list and the count', () => {
    expect(ROUTE).toContain('const unmet = requirements.filter(r => !r.passed)')
    expect(ROUTE).toContain('const setupIssueCount = unmet.length')
    // The defect: `const unmet = evaluatePublishRequirements({...})` with no filter.
    expect(ROUTE).not.toMatch(/const unmet = evaluatePublishRequirements\(\{/)
  })

  it('a fully configured event reports NO issues', () => {
    const r = readiness(ev({ publishChecks: checks() }))
    expect(r.blockers).toHaveLength(0)
    expect(r.warnings).toHaveLength(0)
    expect(r.canPublish).toBe(true)
  })
})

// ═══ D2 · ONE definition of readiness ═════════════════════════════════════════

describe('readiness comes from the publish evaluator, not a second definition', () => {
  it('the route serialises the evaluator roll-call', () => {
    expect(ROUTE).toContain('const publishChecks: EventPublishCheck[] = requirements.map')
    expect(ROUTE).toContain('passed:   r.passed')
  })

  it('Setup never re-derives a requirement — it reads publishChecks', () => {
    expect(ITEMS).toContain('ctx.event.publishChecks?.find(c => c.id === checkId)')
    expect(ITEMS).not.toContain('evaluatePublishRequirements')
  })

  it('every check id the items reference actually exists in the evaluator', () => {
    const referenced = [...ITEMS.matchAll(/fromCheck\(ctx, '([a-z_]+)'/g)].map(m => m[1])
    expect(referenced.length).toBeGreaterThan(0)
    for (const id of referenced) expect(ALL_CHECK_IDS, id).toContain(id)
  })

  it('a card can NEVER read "Ready" while a critical check fails', () => {
    const blocked = ev({ publishChecks: checks({ event_venue: false }) })
    expect(byKey('venue', blocked).state).toBe('blocked')
    expect(readiness(blocked).canPublish).toBe(false)
  })

  it('unknown readiness is never reported as ready', () => {
    const r = readiness(ev({ publishChecks: undefined }))
    expect(r.known).toBe(false)
    expect(r.canPublish).toBe(false)
    expect(r.headline).toBe("Setup status couldn't be checked.")
  })

  it('reports a literal tally, never a manufactured percentage', () => {
    const r = readiness(ev({ publishChecks: checks({ event_venue: false, passes: false }) }))
    expect(r.criticalTotal).toBeGreaterThan(0)
    expect(r.criticalPassed).toBe(r.criticalTotal - 2)
    expect(TAB).toContain('of {ready.criticalTotal} required checks ready')
    expect(TAB).not.toMatch(/percent|Math\.round\([^)]*\/[^)]*\* *100/)
  })
})

// ═══ D3 + D4 · the missing blockers ═══════════════════════════════════════════

describe('every publish blocker has a Setup card', () => {
  it('event_organizer — a CRITICAL blocker that previously had no card', () => {
    const blocked = ev({ publishChecks: checks({ event_organizer: false }) })
    const card = byKey('organizer', blocked)
    expect(card).toBeDefined()
    expect(card.state).toBe('blocked')
    expect(card.checkId).toBe('event_organizer')
  })

  it('organizer_phone — a warning that previously had no card', () => {
    const card = byKey('organizer', ev({ publishChecks: checks({ organizer_phone: false }) }))
    expect(card.state).toBe('attention')
    expect(card.checkId).toBe('organizer_phone')
  })

  it('EVERY critical requirement is represented by some card', () => {
    const criticalIds = evaluatePublishRequirements({ eventDetails: null, pricing: null, registrationForm: null })
      .filter(r => severityOf(r) === 'critical').map(r => r.id)
    const covered = new Set([...ITEMS.matchAll(/fromCheck\(ctx, '([a-z_]+)'/g)].map(m => m[1]))
    for (const id of criticalIds) expect(covered, `critical '${id}' has no card`).toContain(id)
  })

  it('a blocked event surfaces every blocker in the readiness summary', () => {
    const r = readiness(ev({ publishChecks: checks({ event_organizer: false, passes: false }) }))
    expect(r.blockers.map(b => b.id).sort()).toEqual(['event_organizer', 'passes'])
    expect(r.headline).toBe('2 items block publishing.')
  })
})

// ═══ D5 · severity is not inflated ════════════════════════════════════════════

describe('severity is respected, never promoted', () => {
  it('a missing LOGO is a suggestion — it must not read "needs attention"', () => {
    // `event_branding` is severity 'suggestion'. The old card said "Needs Attention".
    const card = byKey('branding', ev({ publishChecks: checks({ event_branding: false }) }))
    expect(card.state).toBe('optional')
    expect(card.state).not.toBe('attention')
    expect(card.state).not.toBe('blocked')
  })

  it('a missing COVER is a warning — attention, but never blocking', () => {
    const card = byKey('branding', ev({ publishChecks: checks({ event_cover: false }) }))
    expect(card.state).toBe('attention')
  })

  it('social links are a suggestion', () => {
    expect(byKey('social', ev({ publishChecks: checks({ event_social: false }) })).state).toBe('optional')
  })

  it('warnings never make canPublish false', () => {
    const r = readiness(ev({ publishChecks: checks({ event_description: false, event_cover: false }) }))
    expect(r.canPublish).toBe(true)
    expect(r.warningOpen).toBe(2)
  })
})

// ═══ D6 · gating ══════════════════════════════════════════════════════════════

describe('feature flags and permissions gate Setup as they gate the rest of the UI', () => {
  it('a disabled feature makes its item not applicable, with no live action', () => {
    const card = byKey('certificates', ev(), SIG, NO_FLAGS)
    expect(card.state).toBe('not_applicable')
    expect(card.action).toBeUndefined()
  })

  it('a missing permission makes its item not applicable', () => {
    expect(byKey('checkin', ev(), SIG, ALL_FLAGS, DENY).state).toBe('not_applicable')
    expect(byKey('registrations', ev(), SIG, ALL_FLAGS, DENY).state).toBe('not_applicable')
  })

  it('gateState is driven by the declared gate, not guesswork', () => {
    const denyAll = { flags: NO_FLAGS, has: DENY }
    expect(gateState('coupons', denyAll)).toBe('not_applicable')
    expect(gateState('reports', denyAll)).toBeNull()      // no gate declared
    expect(gateState('nonexistent', denyAll)).toBeNull()
  })

  it('an ungated item is unaffected by a denied permission', () => {
    expect(byKey('schedule', ev(), SIG, ALL_FLAGS, DENY).state).not.toBe('not_applicable')
  })

  it('the component uses the SHARED flag and permission hooks', () => {
    expect(TAB).toContain('useFeatureFlags')
    expect(TAB).toContain('useWorkspacePermissions')
    expect(TAB).toContain('has: perms.has')
  })
})

// ═══ D7 · missed features ═════════════════════════════════════════════════════

describe('capabilities that exist in the product have a Setup item', () => {
  it('coupons and waitlist — both have working tabs and nav entries', () => {
    expect(SETUP_ITEM_KEYS).toContain('coupons')
    expect(SETUP_ITEM_KEYS).toContain('waitlist')
    expect(EVENT_TABS.map(t => t.key)).toContain('coupons')
    expect(EVENT_TABS.map(t => t.key)).toContain('waitlist')
  })

  it('coupon and waitlist counts report zero as a real zero, not attention', () => {
    const none: SetupSignals = { ...SIG, coupons: { count: 0 }, waitlist: { count: 0 } }
    expect(byKey('coupons', ev(), none).state).toBe('optional')
    expect(byKey('waitlist', ev(), none).state).toBe('optional')
  })

  it('people waiting IS actionable', () => {
    const waiting: SetupSignals = { ...SIG, waitlist: { count: 12 } }
    const card = byKey('waitlist', ev(), waiting)
    expect(card.state).toBe('attention')
    expect(card.summary).toContain('12')
  })

  it('media studio and print assets are reachable', () => {
    expect(SETUP_ITEM_KEYS).toContain('media')
    expect(SETUP_ITEM_KEYS).toContain('print_assets')
  })
})

// ═══ Zero vs unavailable ══════════════════════════════════════════════════════

describe('an unreadable signal is never a zero and never a state', () => {
  it('every signal degrades to `unavailable` on its own', () => {
    for (const [key, itemKey] of [
      ['certificates', 'certificates'], ['identifiers', 'identifiers'],
      ['sessions', 'sessions'], ['coupons', 'coupons'], ['waitlist', 'waitlist'],
    ] as const) {
      const one: SetupSignals = { ...SIG, [key]: 'unavailable' }
      expect(byKey(itemKey, ev(), one).state, itemKey).toBe('unavailable')
    }
  })

  it('one unavailable signal leaves every OTHER item intact', () => {
    const one: SetupSignals = { ...SIG, sessions: 'unavailable' }
    expect(byKey('sessions', ev(), one).state).toBe('unavailable')
    expect(byKey('coupons', ev(), one).state).toBe('ready')
    expect(byKey('identifiers', ev(), one).state).toBe('ready')
  })

  it('a failed registration counter never reads as "0 registered"', () => {
    const card = byKey('registrations', ev({ lifecycleStatus: 'published', statsUnavailable: true }))
    expect(card.state).toBe('unavailable')
    expect(card.summary).not.toMatch(/\b0\b/)
  })

  it('the server returns null — never 0 — for a failed signal', () => {
    expect(SIGNALS).toContain('const settle = async <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null)')
    expect(SIGNALS).toContain('identifiers: identifierCfg === null ? null : { configured: identifierCfg }')
  })

  it('an event with no slug reports real zeros, not unavailable', () => {
    // Nothing exists to read yet — that IS zero, and saying "unavailable" would be wrong.
    expect(SIGNALS).toContain('if (!slug) {')
    expect(SIGNALS).toContain('coupons:      { count: 0 },')
  })
})

// ═══ D8 · read cost ═══════════════════════════════════════════════════════════

describe('Setup reads are bounded and non-duplicating', () => {
  it('the page makes ONE request, not three', () => {
    const fetches = TAB.match(/fetch\(/g) ?? []
    expect(fetches).toHaveLength(1)
    expect(TAB).toContain('/setup-signals')
    for (const gone of ['/certificates/stats', '/identifiers`', '/sessions`']) {
      expect(TAB).not.toContain(gone)
    }
  })

  it('every count is an aggregate — no collection is downloaded to be counted', () => {
    expect((SIGNALS.match(/\.count\(\)\.get\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4)
    // The unbounded reads the old sources used.
    expect(SIGNALS).not.toMatch(/\.orderBy\([^)]*\)\s*\.get\(\)/)
    expect(SIGNALS).not.toMatch(/collection\('waitlists'\)[\s\S]{0,120}\.get\(\)\.then\(s => s\.docs/)
  })

  it('reads the draft exactly once, then fans out in ONE parallel wave', () => {
    expect((SIGNALS.match(/eventDrafts\/\$\{eventId\}`\)\.get\(\)/g) ?? []).length).toBe(1)
    expect((SIGNALS.match(/await Promise\.all\(\[/g) ?? []).length).toBe(1)
  })

  it('no read sits inside a loop', () => {
    expect(SIGNALS).not.toMatch(/for\s*\([\s\S]{0,200}?await[\s\S]{0,80}?\.get\(\)/)
    expect(SIGNALS).not.toMatch(/\.map\([^)]*await[\s\S]{0,80}?\.(count|get)\(/)
  })

  it('is READ ONLY — no write verb anywhere', () => {
    for (const verb of ['.set(', '.update(', '.delete(', '.add(', 'runTransaction', 'writeBatch', 'FieldValue']) {
      expect(SIGNALS, verb).not.toContain(verb)
    }
  })

  it('setup health on the event route still costs no extra read', () => {
    expect(ROUTE).toContain('evaluatePublishRequirements({')
    expect(ROUTE).toContain('eventDetails:     d.eventDetails')
  })
})

// ═══ Security ═════════════════════════════════════════════════════════════════

describe('the server remains the security boundary', () => {
  it('the signals route authorises and scopes by PATH', () => {
    expect(SIGNALS).toContain("authorizeWorkspace(req, 'events')")
    expect(SIGNALS).toContain('const uid = authz.workspaceUid')
    expect(SIGNALS).toContain('adminDb.doc(`users/${uid}/eventDrafts/${eventId}`)')
  })

  it('a forged event id 404s rather than reaching another workspace', () => {
    expect(SIGNALS).toContain("{ error: 'Event not found' }, { status: 404 }")
    expect(SIGNALS).not.toMatch(/users\/\$\{(?!uid)/)
  })

  it('the slug is READ from the owned draft, never taken from the client', () => {
    // RD-CE-FIX C1 — read from the owned draft AND verified against the live document's owner.
    expect(SIGNALS).toContain('const slug    = await resolveOwnedEventSlug(uid, eventId, d)')
    expect(SIGNALS).not.toMatch(/searchParams\.get\('slug'\)/)
  })
})

// ═══ Lifecycle ════════════════════════════════════════════════════════════════

describe('lifecycle behaviour', () => {
  it('publish checks only apply while the event can still be published', () => {
    for (const ls of ['draft', 'pending_review', 'changes_requested', 'unpublished'] as EventLifecycleStatus[]) {
      expect(publishChecksApply(ev({ lifecycleStatus: ls })), ls).toBe(true)
    }
    for (const ls of ['published', 'registration_closed', 'completed', 'cancelled', 'archived'] as EventLifecycleStatus[]) {
      expect(publishChecksApply(ev({ lifecycleStatus: ls })), ls).toBe(false)
    }
  })

  it('a LIVE event with a failed check is informed, not blocked', () => {
    const live = ev({ lifecycleStatus: 'published', publishChecks: checks({ event_cover: false }) })
    expect(byKey('branding', live).state).toBe('optional')
    expect(byKey('branding', live).state).not.toBe('blocked')
  })

  it('operational tooling waits for the event to go live', () => {
    expect(byKey('checkin', ev({ lifecycleStatus: 'draft' })).state).toBe('optional')
    expect(byKey('checkin', ev({ lifecycleStatus: 'published' })).state).toBe('ready')
    expect(isLive(ev({ lifecycleStatus: 'registration_closed' }))).toBe(true)
    expect(isLive(ev({ lifecycleStatus: 'draft' }))).toBe(false)
  })

  it('a cancelled or archived event offers no edit action — the backend refuses those writes', () => {
    for (const ls of ['cancelled', 'archived'] as EventLifecycleStatus[]) {
      const internal = items(ev({ lifecycleStatus: ls })).filter(i => i.action && !i.action.external)
      expect(internal, ls).toHaveLength(0)
    }
    expect(isLocked(ev({ lifecycleStatus: 'cancelled' }))).toBe(true)
    // Completed is NOT locked — reports and certificates stay useful.
    expect(isLocked(ev({ lifecycleStatus: 'completed' }))).toBe(false)
    expect(items(ev({ lifecycleStatus: 'completed' })).some(i => i.action)).toBe(true)
  })

  it('a live event keeps its external public-page link even when locked', () => {
    const cancelled = ev({ lifecycleStatus: 'cancelled', slug: 's', status: 'published' })
    expect(items(cancelled).find(i => i.key === 'public_page')?.action?.external).toBeUndefined()
  })
})

// ═══ Destinations ═════════════════════════════════════════════════════════════

describe('every action goes somewhere real, carrying the event', () => {
  const all = items()

  it('tab destinations exist in the tab registry', () => {
    const keys = new Set(EVENT_TABS.map(t => t.key))
    for (const i of all) {
      const m = i.action?.href.match(/\?tab=([a-z-]+)$/)
      if (m) expect(keys, `${i.key} → ${m[1]}`).toContain(m[1])
    }
  })

  it('module destinations carry the event scope', () => {
    for (const i of all) {
      const href = i.action?.href
      // RD-ANALYTICS-12-13 · /dashboard/finance/reports joins the exceptions.
      //
      // Reports is WORKSPACE-scoped: its event field is a slug filter the user types, not
      // the `eventId` this helper appends, and its History spans the workspace. Scoping the
      // link would add a parameter the page ignores and imply a context it does not have.
      // The rule this case defends — that an EVENT-scoped destination carries its event —
      // is unchanged.
      if (href?.startsWith('/dashboard/') && !href.includes('?tab=')
          && !href.includes('/settings/integrations') && !href.startsWith('/dashboard/finance/reports')) {
        expect(href, i.key).toContain('eventId=e1')
      }
    }
  })

  it('actions are real links, never a local tab-state setter', () => {
    // D9 · `onOpenTab` never changed the URL, so an action could not be cmd-clicked.
    expect(TAB).not.toContain('onOpenTab(')
    expect(TAB).toContain('<Link')
    // Destinations are built as hrefs, not dispatched as tab keys.
    expect(TAB).toContain('?tab=${k}')
  })

  it('every action link has an accessible name that identifies its item', () => {
    expect(TAB).toContain('aria-label={`${item.action.label} — ${item.label}`}')
  })
})

// ═══ State model ══════════════════════════════════════════════════════════════

describe('the state model is stable and readable without colour', () => {
  it('every state has a word, a rank and a semantic tone', () => {
    const states = Object.keys(STATE_RANK) as (keyof typeof STATE_RANK)[]
    expect(states).toHaveLength(6)
    for (const s of states) {
      expect(STATE_LABEL[s], s).toBeTruthy()
      expect(STATE_TONE[s], s).toBeTruthy()
    }
  })

  it('blocked outranks everything, not_applicable ranks last', () => {
    expect(STATE_RANK.blocked).toBe(0)
    expect(Math.max(...Object.values(STATE_RANK))).toBe(STATE_RANK.not_applicable)
    expect(STATE_RANK.blocked).toBeLessThan(STATE_RANK.attention)
    expect(STATE_RANK.attention).toBeLessThan(STATE_RANK.ready)
  })

  it('item keys are stable ids, never UI text', () => {
    for (const k of SETUP_ITEM_KEYS) expect(k).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(new Set(SETUP_ITEM_KEYS).size).toBe(SETUP_ITEM_KEYS.length)
  })

  it('every item lands in a declared section', () => {
    const sections = new Set(SECTION_ORDER.map(s => s.key))
    for (const i of items()) expect(sections, i.key).toContain(i.section)
  })

  it('no item is left without a summary', () => {
    for (const i of items()) expect(i.summary, i.key).toBeTruthy()
  })
})

// ═══ UI contract ══════════════════════════════════════════════════════════════

describe('the page keeps its states and its tokens', () => {
  it('has skeleton, error-with-retry and an isolated failure line', () => {
    expect(TAB).toContain('SetupSkeleton')
    expect(TAB).toContain('role="alert"')
    expect(TAB).toContain('Try again')
    expect(TAB).toContain('setReloadKey(k => k + 1)')
  })

  it('a retry does not blank the page', () => {
    expect(TAB).toContain("if (signalsState === 'loading' && signals === UNRESOLVED_SIGNALS) return <SetupSkeleton />")
  })

  it('never leaks a raw error to the organizer', () => {
    expect(TAB).not.toMatch(/\{error\}|err\.message|\.digest/)
    expect(TAB).toContain("Some setup details couldn&apos;t be checked.")
  })

  it('uses design tokens only — no arbitrary sizes, radii or hues', () => {
    expect(TAB).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
    expect(TAB).not.toMatch(/\brounded-(xl|lg|2xl)\b/)
    expect(TAB).not.toMatch(/\b(bg|text|border)-(emerald|amber|slate|rose|sky|violet|teal|red)-\d{2,3}\b/)
    expect(TAB).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(TAB).not.toMatch(/shadow-(sm|md|lg|xl)|backdrop-blur|\bblur-/)
  })

  it('announces loading and labels every section', () => {
    expect(TAB).toContain('aria-busy="true"')
    expect(TAB).toContain('aria-live="polite"')
    expect(TAB).toContain('<span className="sr-only">Loading setup status…</span>')
    expect(TAB).toContain('aria-labelledby="setup-readiness"')
    expect(TAB).toContain('aria-labelledby={`setup-${section.key}`}')
  })

  it('the signals endpoint exists', () => {
    expect(existsSync(resolve(process.cwd(), 'app/api/organizer/events/[eventId]/setup-signals/route.ts'))).toBe(true)
  })
})

// ═══ Contract stability ═══════════════════════════════════════════════════════

describe('the event payload contract only grows', () => {
  it('publishChecks is additive and optional', () => {
    expect(ROUTE).toMatch(/publishChecks\?: EventPublishCheck\[\]/)
  })

  it('the pre-existing setup fields still exist', () => {
    for (const f of ['setupIssues', 'setupIssueCount', 'statsUnavailable', 'revenueUnavailable']) {
      expect(ROUTE, f).toMatch(new RegExp(`${f}\\??:`))
    }
  })
})
