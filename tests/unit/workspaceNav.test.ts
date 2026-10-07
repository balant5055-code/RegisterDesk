// RD-ORG-FOUNDATION — the navigation IA and the breadcrumb trail.
//
// The IA rules ("one capability, one location", "event-scoped links carry their
// event") are only real if something enforces them. These are those assertions.

import { describe, it, expect } from 'vitest'
import {
  WORKSPACE_NAV_ITEMS, EVENT_SCOPED_PREFIXES,
  navItemForPath, navItemForLocation, resolveNavHref,
} from '@/config/workspaceNav'
import { buildBreadcrumbs, leafLabelFor } from '@/lib/navigation/breadcrumbs'
import { ROLE_PERMISSIONS, type TeamRole } from '@/lib/team/types'

// ─── IA invariants ────────────────────────────────────────────────────────────

describe('WORKSPACE_NAV — one capability, one location', () => {
  it('has no duplicate keys', () => {
    const keys = WORKSPACE_NAV_ITEMS.map(i => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('has no duplicate destinations among standalone routes', () => {
    // Two rows pointing at one page is the exact duplication this IA removes.
    // eventTab rows legitimately share /dashboard/events as a base, so they are
    // compared on their resolved tab instead.
    const standalone = WORKSPACE_NAV_ITEMS.filter(i => !i.eventTab).map(i => i.href)
    expect(new Set(standalone).size).toBe(standalone.length)

    const tabs = WORKSPACE_NAV_ITEMS.filter(i => i.eventTab).map(i => i.eventTab)
    expect(new Set(tabs).size).toBe(tabs.length)
  })

  it('declares a scope for every item', () => {
    for (const item of WORKSPACE_NAV_ITEMS) {
      expect(['global', 'event'], item.key).toContain(item.scope)
    }
  })

  it('only ever names permissions that exist in the server matrix', () => {
    // A typo'd permission would silently hide a row from every role — the UI would
    // simply lose a capability with no error anywhere.
    const real = new Set(Object.values(ROLE_PERMISSIONS).flat())
    for (const item of WORKSPACE_NAV_ITEMS) {
      if (item.permission) expect(real, item.key).toContain(item.permission)
    }
  })

  it('lists every event-scoped route in EVENT_SCOPED_PREFIXES, longest first', () => {
    const expected = WORKSPACE_NAV_ITEMS.filter(i => i.scope === 'event' && !i.newTab).length
    expect(EVENT_SCOPED_PREFIXES.length).toBe(expected)
    // Longest-first, so /dashboard/settings/team wins over /dashboard/settings.
    const lengths = EVENT_SCOPED_PREFIXES.map(p => p.length)
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths)
  })

  it('does not link to a Participants route, which does not exist', () => {
    // Guards the documented decision: no dead link, and no second row pointing at
    // Registrations. If Participants is ever built, this test is the reminder.
    expect(WORKSPACE_NAV_ITEMS.some(i => i.href === '/dashboard/participants')).toBe(false)
  })
})

// ─── Href resolution ──────────────────────────────────────────────────────────

describe('resolveNavHref', () => {
  const events       = WORKSPACE_NAV_ITEMS.find(i => i.key === 'events')!
  const registrations = WORKSPACE_NAV_ITEMS.find(i => i.key === 'registrations')!
  const passes       = WORKSPACE_NAV_ITEMS.find(i => i.key === 'passes')!

  it('leaves a global route alone and never adds an event', () => {
    expect(resolveNavHref(events, 'e1')).toBe('/dashboard/events')
  })

  it('carries the event on an event-scoped route', () => {
    expect(resolveNavHref(registrations, 'e1')).toBe('/dashboard/registrations?eventId=e1')
  })

  it('addresses an eventTab capability at its real location', () => {
    expect(resolveNavHref(passes, 'e1')).toBe('/dashboard/events/e1?tab=passes')
  })

  it('returns NULL — not a scope-less link — when no event is selected', () => {
    // The critical one. A link that drops its event scope would render another
    // event's data (or workspace-wide data) under this module's heading.
    expect(resolveNavHref(registrations, null)).toBeNull()
    expect(resolveNavHref(passes, null)).toBeNull()
  })

  it('still resolves global routes with no event selected', () => {
    expect(resolveNavHref(events, null)).toBe('/dashboard/events')
  })

  it('url-encodes the event id', () => {
    expect(resolveNavHref(registrations, 'a b/c')).toContain('eventId=a%20b%2Fc')
  })
})

// ─── Active-row resolution ────────────────────────────────────────────────────

describe('navItemForPath / navItemForLocation', () => {
  it('matches /dashboard exactly, never as a prefix of everything', () => {
    expect(navItemForPath('/dashboard')?.key).toBe('overview')
    expect(navItemForPath('/dashboard/finance')?.key).toBe('finance')
  })

  it('prefers the longest matching route', () => {
    // Team must win over Workspace Settings, which is its string prefix.
    expect(navItemForPath('/dashboard/settings/team')?.key).toBe('team')
    expect(navItemForPath('/dashboard/settings')?.key).toBe('settings')
  })

  it('matches sub-routes to their owning module', () => {
    expect(navItemForPath('/dashboard/finance/ledger')?.key).toBe('finance')
    expect(navItemForPath('/dashboard/communications/broadcasts')?.key).toBe('communications')
  })

  it('gives an event tab its own row rather than lighting up Events', () => {
    expect(navItemForLocation('/dashboard/events/e1', 'passes')?.key).toBe('passes')
    expect(navItemForLocation('/dashboard/events/e1', 'sports')?.key).toBe('identifiers')
  })

  it('leaves un-owned event tabs on Events', () => {
    // 'setup' and 'home' are the event's own surfaces, reached from its overview.
    expect(navItemForLocation('/dashboard/events/e1', 'setup')?.key).toBe('events')
    expect(navItemForLocation('/dashboard/events/e1', null)?.key).toBe('events')
  })
})

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────

describe('buildBreadcrumbs', () => {
  const base = { selectedEventId: 'e1', eventName: 'Vanathukkul Noyyal Marathon', tab: null, leafLabel: null }

  it('shows a single non-navigable crumb at the workspace root', () => {
    const c = buildBreadcrumbs({ ...base, pathname: '/dashboard' })
    expect(c).toEqual([{ label: 'Overview', href: null }])
  })

  it('NEVER renders a raw event id', () => {
    // The old trail matched ids by length and labelled them "Manage Event"; anything
    // it missed rendered a Firestore id to the organizer.
    const c = buildBreadcrumbs({ ...base, pathname: '/dashboard/events/e1' })
    for (const crumb of c) expect(crumb.label).not.toContain('e1')
  })

  it('names the event on the event workspace', () => {
    const c = buildBreadcrumbs({ ...base, pathname: '/dashboard/events/e1' })
    expect(c.map(x => x.label)).toEqual(['Overview', 'Events', 'Vanathukkul Noyyal Marathon'])
    expect(c.at(-1)!.href).toBeNull()
  })

  it('omits the event crumb entirely when the name is unresolved', () => {
    // Loading, or an event this caller cannot reach. A placeholder would be a lie.
    const c = buildBreadcrumbs({ ...base, pathname: '/dashboard/events/e1', eventName: null })
    expect(c.map(x => x.label)).toEqual(['Overview', 'Events'])
  })

  it('adds the tab and makes the event name navigable back to its overview', () => {
    const c = buildBreadcrumbs({ ...base, pathname: '/dashboard/events/e1', tab: 'passes' })
    expect(c.map(x => x.label)).toEqual(['Overview', 'Events', 'Vanathukkul Noyyal Marathon', 'Passes & Categories'])
    expect(c[2].href).toBe('/dashboard/events/e1')
  })

  it('places a module under its IA section', () => {
    const c = buildBreadcrumbs({ ...base, pathname: '/dashboard/registrations' })
    expect(c.map(x => x.label)).toEqual(['Overview', 'People', 'Registrations'])
  })

  it('names a sub-surface without title-casing a slug', () => {
    const c = buildBreadcrumbs({
      ...base, pathname: '/dashboard/communications/whatsapp-logs',
      leafLabel: leafLabelFor('/dashboard/communications/whatsapp-logs'),
    })
    // "WhatsApp Logs", not "Whatsapp Logs".
    expect(c.at(-1)!.label).toBe('WhatsApp Logs')
  })

  it('marks only the final crumb as the current page', () => {
    const c = buildBreadcrumbs({
      ...base, pathname: '/dashboard/finance/ledger', leafLabel: leafLabelFor('/dashboard/finance/ledger'),
    })
    expect(c.at(-1)!.href).toBeNull()
    expect(c.slice(0, -1).every(x => x.href !== undefined)).toBe(true)
  })
})

// ─── Permission projection sanity ─────────────────────────────────────────────

describe('nav ↔ role matrix', () => {
  it('leaves an owner every row', () => {
    const owner = new Set(ROLE_PERMISSIONS.owner)
    const visible = WORKSPACE_NAV_ITEMS.filter(i => !i.permission || owner.has(i.permission))
    expect(visible.length).toBe(WORKSPACE_NAV_ITEMS.length)
  })

  it('hides Finance from a manager and Events from finance', () => {
    const can = (role: TeamRole, key: string) => {
      const item = WORKSPACE_NAV_ITEMS.find(i => i.key === key)!
      return !item.permission || ROLE_PERMISSIONS[role].includes(item.permission)
    }
    expect(can('manager', 'finance')).toBe(false)
    expect(can('finance', 'events')).toBe(false)
    expect(can('finance', 'finance')).toBe(true)
    expect(can('manager', 'registrations')).toBe(true)
  })
})
