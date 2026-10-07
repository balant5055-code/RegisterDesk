// RD-NAV-AUDIT-01 — WHY each sidebar row is enabled, disabled or hidden, in every state.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// A new organizer with no events sees most of the sidebar greyed out and reported it as lost
// permissions. It is not: `scope: 'event'` rows resolve to a NULL href until an event is
// selected, and `NavRow` renders a null href as a disabled control rather than a link that
// would silently drop its event scope.
//
// That is a deliberate design with no test covering it end to end, so nothing distinguished
// "disabled because no event is selected" from "hidden because a permission is missing" —
// which is exactly the confusion that made the report hard to answer. These cases pin the
// whole decision, per row, in each of the five states that matter.
//
// The pipeline mirrors components/dashboard/Sidebar.tsx in the SAME ORDER, and every gate is
// the real exported function, so a change to any of them moves this table rather than
// leaving it to drift.

import { describe, it, expect } from 'vitest'
import {
  WORKSPACE_NAV, navHrefEnabled, navItemAvailableForEvent, resolveNavHref,
  type WorkspaceNavItem,
} from '@/config/workspaceNav'
import { ROLE_PERMISSIONS, ALL_PERMISSIONS, isCheckinOnlyRole, type TeamRole } from '@/lib/team/types'

type State = 'ENABLED' | 'DISABLED_NO_EVENT' | 'HIDDEN'

/** The four flags navHrefEnabled consults, at their code defaults. */
const FLAGS = { crm: true, broadcast: true, certificates: true, donations: true } as never

const SPORTS = { eventType: 'sports' } as never
const CONFERENCE = { eventType: 'conference' } as never

function resolveRow(
  item: WorkspaceNavItem,
  o: { role: TeamRole; isOwner: boolean; events: never[]; selectedEvent: never | null; selectedEventId: string | null },
): State {
  const perms = o.isOwner ? [...ALL_PERMISSIONS] : (ROLE_PERMISSIONS[o.role] ?? [])
  const has = (p: (typeof ALL_PERMISSIONS)[number]) => o.isOwner || perms.includes(p)

  if (!navHrefEnabled(item.href, FLAGS)) return 'HIDDEN'
  if (item.permission && !has(item.permission)) return 'HIDDEN'
  if (item.hideFromGateRoles && isCheckinOnlyRole(o.role)) return 'HIDDEN'
  if (!navItemAvailableForEvent(item, o.selectedEvent, o.events)) return 'HIDDEN'
  const href = item.newTab ? item.href : resolveNavHref(item, o.selectedEventId)
  return href === null ? 'DISABLED_NO_EVENT' : 'ENABLED'
}

function table(o: Parameters<typeof resolveRow>[1]): Record<string, State> {
  const out: Record<string, State> = {}
  for (const section of WORKSPACE_NAV) for (const item of section.items) out[item.key] = resolveRow(item, o)
  return out
}

const OWNER = { role: 'owner' as TeamRole, isOwner: true }

describe('RD-NAV-AUDIT-01 · a new organizer with ZERO events', () => {
  const t = table({ ...OWNER, events: [], selectedEvent: null, selectedEventId: null })

  it('disables every event-scoped row — and for that reason, not a permission one', () => {
    // The reported screenshot, row by row.
    for (const key of ['registrations', 'checkin', 'identifiers', 'passes', 'waitlist',
                       'communications', 'certificates', 'media-studio', 'print-assets', 'analytics']) {
      expect(t[key], `${key} should be disabled for want of an event`).toBe('DISABLED_NO_EVENT')
    }
  })

  it('keeps every GLOBAL row fully enabled, which is what proves permissions are intact', () => {
    // If ownership resolution were broken these would be HIDDEN, not enabled. This is the
    // assertion that distinguishes the real cause from the reported one.
    for (const key of ['overview', 'events', 'crm', 'finance', 'reports', 'settings']) {
      expect(t[key], `${key} should be enabled`).toBe('ENABLED')
    }
  })

  it('hides Race Operations rather than disabling it, because no event can admit it', () => {
    // With no events at all, `events.some(...)` is false, so the capability gate removes the
    // row. A workspace that has never run a sports event does not carry a dead row.
    expect(t['race-ops']).toBe('HIDDEN')
  })
})

describe('RD-NAV-AUDIT-01 · an event exists but none is selected', () => {
  const t = table({ ...OWNER, events: [SPORTS], selectedEvent: null, selectedEventId: null })

  it('still disables event-scoped rows — existence is not selection', () => {
    expect(t['registrations']).toBe('DISABLED_NO_EVENT')
    expect(t['certificates']).toBe('DISABLED_NO_EVENT')
  })

  it('now DISABLES Race Operations instead of hiding it, since a listed event admits it', () => {
    // The one row whose state differs between "no events" and "an unselected event", and the
    // difference is intended: the capability gate passes, then the href gate holds it.
    expect(t['race-ops']).toBe('DISABLED_NO_EVENT')
  })
})

describe('RD-NAV-AUDIT-01 · an event is selected', () => {
  it('enables every row for a sports event', () => {
    const t = table({ ...OWNER, events: [SPORTS], selectedEvent: SPORTS, selectedEventId: 'ev-1' })
    for (const [key, state] of Object.entries(t)) expect(state, `${key}`).toBe('ENABLED')
  })

  it('hides ONLY Race Operations for a conference', () => {
    const t = table({ ...OWNER, events: [CONFERENCE], selectedEvent: CONFERENCE, selectedEventId: 'ev-2' })
    expect(t['race-ops']).toBe('HIDDEN')
    for (const [key, state] of Object.entries(t)) {
      if (key !== 'race-ops') expect(state, `${key}`).toBe('ENABLED')
    }
  })
})

describe('RD-NAV-AUDIT-01 · a gate operator stays restricted', () => {
  // Both gate-only roles, so the containment is not proved for one role name only.
  for (const role of ['checkin_staff', 'checkin_lead'] as TeamRole[]) {
    const t = table({ role, isOwner: false, events: [SPORTS], selectedEvent: SPORTS, selectedEventId: 'ev-1' })

    it(`${role} is offered check-in and nothing that would refuse it`, () => {
      expect(t['checkin']).toBe('ENABLED')
      for (const key of ['events', 'registrations', 'identifiers', 'passes', 'waitlist',
                         'communications', 'certificates', 'media-studio', 'print-assets',
                         'analytics', 'reports', 'finance', 'inbox']) {
        expect(t[key], `${key} must be hidden from ${role}`).toBe('HIDDEN')
      }
    })

    it(`${role} is NOT offered CRM, whose API refuses it`, () => {
      // The nav half of the CRM defect: the row carries no `permission` (CRM's model is
      // role-tiered, not a single permission), so only `hideFromGateRoles` can express it.
      expect(t['crm'], `CRM must be hidden from ${role}`).toBe('HIDDEN')
    })
  }
})
