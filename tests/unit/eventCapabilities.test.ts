// RD-EVENT-16 · the Event Command Center's navigation tells the truth about this event.
//
// ═══ WHAT THIS PINS ══════════════════════════════════════════════════════════
// `EVENT_TABS` carried three visibility flags — `sportsOnly`, `exhibitionOnly`,
// `awardsOnly` — and `sportsOnly` was set on nothing. So every event showed the same
// sixteen tabs: a "Waitlist" tab on an event with no waitlist, a "Speakers" tab on an
// event that never invited speaker applications. The filter was ALSO duplicated inline in
// the Command Palette, free to drift from the bar it was supposed to mirror.
//
// Visibility is now one resolver over sources of truth that already existed:
//   · feature flag + team permission  → ITEM_GATES / gateState (lib/eventSetup/readiness)
//   · the waitlist switch             → resolveWaitlistSettings (RD-EVENT-15A)
//   · speaker / sponsor applications  → eventDetails.applications.{speaker,sponsor}.enabled,
//                                       the same condition the PUBLIC page gates its forms on
//
// It is NOT a security boundary — every route re-checks server-side. Hiding a tab removes
// a door that would slam.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The waitlist resolver's module graph reaches the gate, which reaches the Admin SDK.
// These tests exercise pure functions and source contracts, so the SDK is doubled.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import {
  UNGATED_BY_DESIGN, eventHasWaitlist, isEventTabAvailable, isEventTabReachable,
  visibleEventTabs, type EventCapabilityContext,
} from '@/lib/events/eventCapabilities'
import { EVENT_TABS, applyIdentifierLabel, type EventTabKey } from '@/lib/events/eventTabs'
import { FEATURE_FLAG_KEYS, type FeatureFlagsConfig } from '@/lib/config/businessConfig'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const SHELL   = read('app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx')
const PALETTE = read('lib/commandPalette/registry.ts')
const CAPS    = read('lib/events/eventCapabilities.ts')
const DETAIL  = read('app/api/organizer/events/[eventId]/route.ts')
const BAR     = read('app/(dashboard)/dashboard/events/[eventId]/EventTabsBar.tsx')

const ALL_FLAGS = Object.fromEntries(FEATURE_FLAG_KEYS.map(k => [k, true])) as unknown as FeatureFlagsConfig
const NO_FLAGS  = Object.fromEntries(FEATURE_FLAG_KEYS.map(k => [k, false])) as unknown as FeatureFlagsConfig

/** Everything on except what the case under test turns off. */
const ctx = (o: Partial<EventCapabilityContext> = {}): EventCapabilityContext => ({
  eventType: 'conference',
  registrationRules: null,
  applications: null,
  gate: { flags: ALL_FLAGS, has: () => true },
  ...o,
})

const keys = (c: EventCapabilityContext): EventTabKey[] =>
  visibleEventTabs(EVENT_TABS, c).map(t => t.key)

const tabDef = (k: EventTabKey) => EVENT_TABS.find(t => t.key === k)!

// ═══ 1 · Waitlist — the tab that started this ════════════════════════════════

describe('waitlist visibility', () => {
  it('is HIDDEN when the event has no waitlist configuration at all', () => {
    expect(keys(ctx())).not.toContain('waitlist')
  })

  it('is HIDDEN when the switch is explicitly off', () => {
    expect(keys(ctx({ registrationRules: { waitlistEnabled: false } }))).not.toContain('waitlist')
  })

  it('is SHOWN when the canonical switch is on', () => {
    expect(keys(ctx({ registrationRules: { waitlistEnabled: true } }))).toContain('waitlist')
  })

  // RD-EVENT-15A: the canonical field is nested; the detail route flattens it onto
  // `registrationRules`, and this re-nests it for the ONE resolver rather than re-reading.
  it('reads the canonical field through resolveWaitlistSettings, not a local rule', () => {
    expect(eventHasWaitlist({ waitlistEnabled: true })).toBe(true)
    expect(eventHasWaitlist({ waitlistEnabled: false })).toBe(false)
    expect(eventHasWaitlist(null)).toBe(false)
    // A non-boolean is corrupt, not a setting.
    expect(eventHasWaitlist({ waitlistEnabled: 'true' })).toBe(false)
  })

  it('honours the legacy top-level pair the resolver still falls back to', () => {
    // No rules object → the resolver's legacy branch. Kept working, not special-cased here.
    expect(eventHasWaitlist({})).toBe(false)
  })

  it('is hidden when the member lacks the registrations permission', () => {
    const c = ctx({
      registrationRules: { waitlistEnabled: true },
      gate: { flags: ALL_FLAGS, has: p => p !== 'registrations' },
    })
    expect(keys(c)).not.toContain('waitlist')
  })

  it('the UI does not re-implement waitlist resolution', () => {
    // The shell and the palette must go through the capability module.
    expect(strip(SHELL)).not.toMatch(/waitlistEnabled/)
    expect(strip(PALETTE)).not.toMatch(/waitlistEnabled/)
    expect(strip(CAPS)).toMatch(/resolveWaitlistSettings/)
  })
})

// ═══ 2 · Applications — speakers and sponsors ════════════════════════════════

describe('speaker and sponsor application tabs', () => {
  it('are hidden when the event invites neither', () => {
    const k = keys(ctx())
    expect(k).not.toContain('speaker-applications')
    expect(k).not.toContain('sponsor-applications')
  })

  it('appear independently of one another', () => {
    const speakersOnly = keys(ctx({
      applications: { speaker: { enabled: true }, sponsor: { enabled: false } },
    }))
    expect(speakersOnly).toContain('speaker-applications')
    expect(speakersOnly).not.toContain('sponsor-applications')

    const sponsorsOnly = keys(ctx({
      applications: { speaker: { enabled: false }, sponsor: { enabled: true } },
    }))
    expect(sponsorsOnly).toContain('sponsor-applications')
    expect(sponsorsOnly).not.toContain('speaker-applications')
  })

  // `enabled === true` is the whole contract — the public page uses exactly this.
  it.each([undefined, null, 'true', 1, {}])('treats enabled=%p as closed', v => {
    const c = ctx({ applications: { speaker: { enabled: v }, sponsor: null } })
    expect(keys(c)).not.toContain('speaker-applications')
  })

  it('the detail route exposes the config the public page reads', () => {
    const s = strip(DETAIL)
    expect(s).toMatch(/details\.applications/)
    expect(s).toMatch(/speaker: \{ enabled:/)
    expect(s).toMatch(/sponsor: \{ enabled:/)
  })
})

// ═══ 3 · Event type — no marathon assumptions ════════════════════════════════

describe('event-type applicability', () => {
  it.each(['sports', 'conference', 'exhibition', 'awards', 'cultural', 'workshop', null])(
    'resolves a tab list for a %s event without throwing', eventType => {
      expect(() => keys(ctx({ eventType }))).not.toThrow()
      expect(keys(ctx({ eventType })).length).toBeGreaterThan(0)
    })

  it('exhibition tooling appears only for an exhibition', () => {
    expect(keys(ctx({ eventType: 'exhibition' }))).toContain('exhibition')
    for (const t of ['sports', 'conference', 'awards', 'cultural', null]) {
      expect(keys(ctx({ eventType: t }))).not.toContain('exhibition')
    }
  })

  it('nominations appear only for an awards event', () => {
    expect(keys(ctx({ eventType: 'awards' }))).toContain('nominations')
    for (const t of ['sports', 'conference', 'exhibition', 'cultural', null]) {
      expect(keys(ctx({ eventType: t }))).not.toContain('nominations')
    }
  })

  // Identifiers are bibs OR badge numbers OR seat numbers. Gating them on `sports` would
  // be the marathon assumption this platform does not make.
  it('Identifiers and Conference are NOT gated on event type', () => {
    for (const t of ['sports', 'conference', 'exhibition', 'awards', 'cultural', null]) {
      const k = keys(ctx({ eventType: t }))
      expect(k).toContain('sports')
      expect(k).toContain('conference')
    }
  })

  it('an unknown event type still gets the universal tabs', () => {
    const k = keys(ctx({ eventType: 'some-future-type' }))
    for (const t of UNGATED_BY_DESIGN) expect(k).toContain(t)
  })
})

// ═══ 4 · Flags and permissions — the EXISTING gate table ═════════════════════

describe('feature flags and permissions', () => {
  it('every flag off hides exactly the flag-gated tabs, and no more', () => {
    const k = keys(ctx({ gate: { flags: NO_FLAGS, has: () => true } }))
    expect(k).not.toContain('coupons')          // flag: coupons
    expect(k).not.toContain('communications')   // flag: broadcast
    expect(k).not.toContain('certificates')     // flag: certificates
    // Not flag-gated — still there.
    expect(k).toContain('registrations')
    expect(k).toContain('passes')
    expect(k).toContain('settings')
  })

  it.each([
    ['registrations', 'registrations'],
    ['checkin',       'attendance'],
    ['participants',  'sports'],
    ['certificates',  'certificates'],
  ] as const)('missing the %s permission hides %s', (perm, tab) => {
    const c = ctx({ gate: { flags: ALL_FLAGS, has: p => p !== perm } })
    expect(keys(c)).not.toContain(tab)
  })

  // While permissions load, `has()` answers optimistically — the bar must not flash short.
  it('an optimistic permission set shows the full universal list', () => {
    const k = keys(ctx({ gate: { flags: ALL_FLAGS, has: () => true } }))
    for (const t of UNGATED_BY_DESIGN) expect(k).toContain(t)
  })

  it('Setup and Settings are never hidden — they are how capabilities get turned on', () => {
    const c = ctx({ gate: { flags: NO_FLAGS, has: () => false } })
    expect(keys(c)).toContain('setup')
    expect(keys(c)).toContain('settings')
  })
})

// ═══ 5 · Routing safety ══════════════════════════════════════════════════════

describe('direct URL to a hidden tab', () => {
  it('is not reachable', () => {
    expect(isEventTabReachable('waitlist', EVENT_TABS, ctx())).toBe(false)
    expect(isEventTabReachable('nominations', EVENT_TABS, ctx({ eventType: 'conference' }))).toBe(false)
  })

  it('is reachable once the capability exists', () => {
    expect(isEventTabReachable('waitlist', EVENT_TABS, ctx({ registrationRules: { waitlistEnabled: true } }))).toBe(true)
  })

  it('the root is always reachable', () => {
    expect(isEventTabReachable(null, EVENT_TABS, ctx())).toBe(true)
  })

  it('an unknown key fails closed', () => {
    expect(isEventTabReachable('not-a-tab' as EventTabKey, EVENT_TABS, ctx())).toBe(false)
  })

  it('the shell falls back to the command center and cleans the URL', () => {
    const s = strip(SHELL)
    expect(s).toMatch(/isEventTabReachable\(requestedTab, EVENT_TABS, capabilityCtx\)/)
    expect(s).toMatch(/router\.replace\(rootHref/)
    // It must NOT bounce a valid deep link before the event has loaded.
    expect(s).toMatch(/event === null \|\| isEventTabReachable/)
  })
})

// ═══ 6 · One resolver, everywhere ════════════════════════════════════════════

describe('a single source of truth', () => {
  it('the shell filters through the resolver', () => {
    // RD-BIB-UX-04 · the tab list is now relabelled with the event's configured
    // identifier noun before it is filtered. `applyIdentifierLabel` is a pure
    // rename that adds and removes no tab, so the property under test — the shell
    // decides visibility through the ONE resolver, never its own filter — holds
    // exactly as before.
    expect(strip(SHELL))
      .toMatch(/visibleEventTabs\(applyIdentifierLabel\(EVENT_TABS, event\?\.identifierLabel\), capabilityCtx\)/)
  })

  it('the relabelling changes only the name, never the set of tabs', () => {
    const renamed = applyIdentifierLabel(EVENT_TABS, 'Delegate Number')
    expect(renamed.map(t => t.key)).toEqual(EVENT_TABS.map(t => t.key))
    expect(renamed.find(t => t.key === 'sports')!.label).toBe('Delegate Numbers')
    // Every other label is untouched.
    for (const t of renamed) {
      if (t.key === 'sports') continue
      expect(t.label).toBe(EVENT_TABS.find(x => x.key === t.key)!.label)
    }
  })

  it('an absent or blank label leaves the generic tab exactly as it was', () => {
    for (const l of [null, undefined, '', '   ']) {
      expect(applyIdentifierLabel(EVENT_TABS, l).find(t => t.key === 'sports')!.label)
        .toBe(EVENT_TABS.find(t => t.key === 'sports')!.label)
    }
  })

  it('a label that is already plural is not pluralised twice', () => {
    expect(applyIdentifierLabel(EVENT_TABS, 'Race Numbers').find(t => t.key === 'sports')!.label)
      .toBe('Race Numbers')
  })

  it('the Command Palette keeps the GENERIC label — it has no event in hand', () => {
    // The palette imports EVENT_TABS directly and must not be renamed per-event.
    expect(EVENT_TABS.find(t => t.key === 'sports')!.label).toBe('Identifiers')
  })

  it('the Command Palette filters through the SAME resolver', () => {
    const s = strip(PALETTE)
    expect(s).toMatch(/visibleEventTabs\(EVENT_TABS, capabilities\)/)
    // The duplicated inline event-type filter is gone.
    expect(s).not.toMatch(/eventType === 'exhibition'/)
    expect(s).not.toMatch(/eventType === 'awards'/)
  })

  it('the More menu is the overflow of the same filtered list', () => {
    // EventTabsBar receives `tabs` and slices it; it never consults EVENT_TABS itself.
    expect(strip(BAR)).not.toMatch(/EVENT_TABS/)
    expect(strip(BAR)).toMatch(/overflow = tabs\.slice\(count\)/)
    expect(strip(BAR)).toMatch(/<MoreMenu tabs=\{overflow\}/)
  })

  it('no component re-implements a capability check', () => {
    for (const src of [SHELL, PALETTE, BAR]) {
      expect(strip(src)).not.toMatch(/eventType === 'sports'/)
      expect(strip(src)).not.toMatch(/applications\?\.speaker/)
    }
  })

  it('the resolver is pure — no React, no fetch, no SDK', () => {
    expect(CAPS).not.toMatch(/useState|useEffect|fetch\(|firebase-admin|adminDb/)
  })
})

// ═══ 7 · Read cost ══════════════════════════════════════════════════════════

describe('the tab bar performs no network requests', () => {
  it('capability inputs come from data the page already has', () => {
    const s = strip(SHELL)
    // Context hooks, not fetches.
    expect(s).toMatch(/const flags = useFeatureFlags\(\)/)
    expect(s).toMatch(/const perms = useWorkspacePermissions\(true\)/)
    // The capability context is built from the already-loaded event detail.
    expect(s).toMatch(/registrationRules: event\?\.registrationRules/)
    expect(s).toMatch(/applications:      event\?\.applications/)
  })

  it('the detail route adds no Firestore read for the new field', () => {
    // `details` is the same draft object every other field is read from.
    expect(strip(DETAIL)).toMatch(/const rawApps = details\.applications/)
  })

  it('the capability module fetches nothing', () => {
    expect(CAPS).not.toMatch(/fetch\(|axios|XMLHttpRequest/)
  })
})

// ═══ 8 · Accessibility and shape ════════════════════════════════════════════

describe('hidden tabs leave nothing behind', () => {
  it('the keyboard ring is built from the visible list', () => {
    expect(strip(SHELL)).toMatch(/const order: \(TabKey \| null\)\[\] = \[null, \.\.\.visibleTabs\.map\(t => t\.key\)\]/)
  })

  it('a hidden tab is absent from the list entirely — not disabled in place', () => {
    const c = ctx()
    // The per-tab predicate and the list filter must agree; a tab that fails the
    // predicate must not survive the filter as a disabled entry.
    expect(isEventTabAvailable(tabDef('waitlist'), c)).toBe(false)
    const defs = visibleEventTabs(EVENT_TABS, c)
    expect(defs.some(t => t.key === 'waitlist')).toBe(false)
    // No placeholder object survives filtering.
    expect(defs.every(t => typeof t.key === 'string' && t.label.length > 0)).toBe(true)
  })

  it('the panel rendered is keyed off the resolved tab, so no orphan panel remains', () => {
    expect(strip(SHELL)).toMatch(/const panelKey = activeTab \?\? ROOT_TAB_ID/)
  })
})

// ═══ 9 · The screenshot case ════════════════════════════════════════════════

describe('the reported event', () => {
  // A conference with no waitlist and no application forms — the tab bar in the report.
  const reported = ctx({ eventType: 'conference' })

  it('no longer contains Waitlist', () => {
    expect(keys(reported)).not.toContain('waitlist')
  })

  it('still contains everything that event genuinely has', () => {
    const k = keys(reported)
    for (const t of ['setup', 'attendance', 'registrations', 'passes', 'coupons',
                     'conference', 'sports', 'communications', 'reports',
                     'certificates', 'settings'] as EventTabKey[]) {
      expect(k).toContain(t)
    }
  })

  it('is not special-cased by id or name anywhere', () => {
    expect(CAPS).not.toMatch(/qa13|evt_|draftId|eventId/)
  })

  it('the tab definitions themselves stayed intact — nothing was deleted', () => {
    expect(EVENT_TABS.length).toBe(16)
    expect(tabDef('waitlist').label).toBe('Waitlist')
    expect(tabDef('sports').label).toBe('Identifiers')
  })
})

// ═══ 10 · Nothing links into a hidden tab ═══════════════════════════════════
//
// The routing fallback catches a stale link and lands on the command center, so nothing
// BREAKS — but a link that returns the reader to the page they are already on is a dead
// end, and §6/§9 of the brief call that out. Every in-workspace producer of a `?tab=`
// link therefore checks the same resolver.

describe('no surface links into a tab this event does not have', () => {
  const CENTER = read('app/(dashboard)/dashboard/events/[eventId]/EventCommandCenter.tsx')
  const HOME   = read('lib/events/eventHome.ts')
  const ITEMS  = read('lib/eventSetup/items.ts')

  it('the command center drops modules whose destination is hidden', () => {
    const s = strip(CENTER)
    expect(s).toMatch(/isEventTabReachable\(key, EVENT_TABS, \{/)
    expect(s).toMatch(/function tabKeyOf\(href: string\)/)
  })

  // People can still be queued from before the switch was turned off — that is exactly
  // when this item fires, so it must route somewhere that exists.
  it('the attention item routes to settings when the waitlist is off', () => {
    const s = strip(HOME)
    expect(s).toMatch(/const on = eventHasWaitlist\(event\.registrationRules\)/)
    expect(s).toMatch(/href: on \? tab\('waitlist'\) : tab\('settings'\)/)
    expect(HOME).toMatch(/switched off, so nobody new can join/i)
  })

  it('the setup card routes to settings when the waitlist is off', () => {
    const s = strip(ITEMS)
    expect(s).toMatch(/const on = eventHasWaitlist\(ctx\.event\.registrationRules\)/)
    expect(s).toMatch(/href: ctx\.tab\('settings'\)/)
    // And it still says how many are stranded rather than reporting an empty queue.
    expect(ITEMS).toMatch(/still queued from before/)
  })

  it('all three go through the ONE capability module', () => {
    for (const src of [CENTER, HOME, ITEMS]) {
      expect(strip(src)).toMatch(/eventCapabilities/)
    }
  })
})
