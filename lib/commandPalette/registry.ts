// Command registry for the Global Command Palette (Phase H.4.2).
//
// PURE ORCHESTRATION LAYER. This module fabricates NO routes and NO business
// logic. Navigation commands are derived from the EXISTING information
// architecture (config/workspaceNav + config/navigation); event commands are
// derived from the EXISTING event tab list (lib/events/eventTabs) and the
// EXISTING event action routes. It only maps already-existing destinations and
// actions into a searchable, keyboard-driven list.

import type { LucideIcon } from 'lucide-react'
import { Copy, Lock, LockOpen, EyeOff, XCircle, CheckCircle, Archive, ClipboardCheck } from 'lucide-react'
import { WORKSPACE_NAV } from '@/config/workspaceNav'
import { EVENT_TABS, EVENT_ROOT_TAB, type EventTabKey } from '@/lib/events/eventTabs'
import { visibleEventTabs, type EventCapabilityContext } from '@/lib/events/eventCapabilities'
import type { TeamPermission } from '@/lib/team/types'
import type { EventLifecycleStatus } from '@/types/events'

// ─── Command shape ────────────────────────────────────────────────────────────

export type CommandKind = 'navigate' | 'event-tab' | 'event-action'

// Reversible actions are fired directly (with an inline confirm); destructive
// actions only ROUTE the user to the event's existing confirmation flow.
export type EventActionId =
  | 'duplicate' | 'close_registrations' | 'reopen_registrations' | 'unpublish'   // reversible → direct
  | 'cancel' | 'complete' | 'archive'                                            // destructive → routed

export interface PaletteCommand {
  id:           string
  title:        string
  subtitle?:    string
  group:        string
  keywords:     string[]
  icon?:        LucideIcon
  kind:         CommandKind
  href?:        string           // kind: navigate
  newTab?:      boolean
  tab?:         EventTabKey       // kind: event-tab
  action?:      EventActionId     // kind: event-action
  eventId?:     string           // event-tab / event-action target
  permission?:  TeamPermission    // advisory UI gate — the server re-checks every route
  destructive?: boolean           // event-action: routed to confirm flow, never fired blindly
}

/** Strings the fuzzy matcher searches for a command. */
export function commandStrings(c: PaletteCommand): string[] {
  return [c.title, c.subtitle ?? '', ...c.keywords].filter(Boolean)
}

// ─── Static navigation commands (from the existing sidebar IA) ────────────────

let navCache: PaletteCommand[] | null = null

export function buildNavigationCommands(): PaletteCommand[] {
  if (navCache) return navCache
  const out: PaletteCommand[] = []
  const seen = new Set<string>()

  // RD-ORG-FOUNDATION — WORKSPACE_NAV is now FLAT (section → items) instead of
  // nested (section → group → children), matching the canonical IA where one
  // capability has exactly one location. The palette gains the same `permission`
  // field the sidebar reads, so both gate identically.
  //
  // Event-scoped items are listed with their bare href: the palette cannot know the
  // selected event at module scope, and the destination reads the context itself.
  // `eventTab` items are skipped — they need an event id to address at all, and the
  // palette already offers per-event navigation through its event search.
  for (const section of WORKSPACE_NAV) {
    for (const item of section.items) {
      if (item.eventTab) continue
      const dedupeKey = `${item.href}::${item.label}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      out.push({
        id:         `nav:${item.key}`,
        title:      item.label,
        subtitle:   section.sectionLabel,
        group:      section.sectionLabel,
        keywords:   [item.label, section.sectionLabel, item.key],
        icon:       item.icon,
        kind:       'navigate',
        href:       item.href,
        newTab:     item.newTab,
        permission: item.permission,
      })
    }
  }

  // Completeness: the organizer "approval queue" is the pending-registrations
  // filter — there is no separate organizer approvals page (audited in H.4.2).
  out.push({
    id:       'nav:approvals:pending',
    title:    'Approval queue · Pending registrations',
    subtitle: 'People',
    group:    'People',
    keywords: ['approval', 'approvals', 'queue', 'pending', 'review', 'registrations'],
    icon:     ClipboardCheck,
    kind:     'navigate',
    href:     '/dashboard/registrations?status=pending',
  })

  navCache = out
  return out
}

// ─── Event-context: jump to any tab ───────────────────────────────────────────

export function buildEventTabCommands(
  eventId:   string,
  /**
   * RD-EVENT-16 · the event's capabilities, or `null` while the detail is still loading.
   *
   * This used to take just `eventType` and re-implement the three event-type flags
   * inline — a second copy of the tab bar's filter, free to drift from it. It now calls
   * the same resolver the bar does, so the palette can never offer a jump to a section
   * the event does not have.
   *
   * `null` falls back to the unfiltered list: before the detail arrives the palette
   * cannot know, and hiding a real tab is worse than briefly offering one that resolves
   * to the command center anyway.
   */
  capabilities?: EventCapabilityContext | null,
  eventName?: string,
): PaletteCommand[] {
  // RD-EVENT-09 · The root leads. It is a plain `navigate` command rather than an
  // `event-tab` one because the command center has no `?tab=` value — it IS the event
  // route — so there is no tab key to hand to the bridge.
  const root: PaletteCommand = {
    id:       `event-root:${eventId}`,
    title:    `Go to ${EVENT_ROOT_TAB.label}`,
    subtitle: eventName ?? 'Current event',
    group:    'This event',
    keywords: ['command center', 'overview', 'home', 'summary', 'event', eventName ?? ''],
    icon:     EVENT_ROOT_TAB.icon,
    kind:     'navigate',
    href:     `/dashboard/events/${eventId}`,
  }

  const tabs = (capabilities ? visibleEventTabs(EVENT_TABS, capabilities) : EVENT_TABS)
    .map<PaletteCommand>(t => ({
      id:       `event-tab:${eventId}:${t.key}`,
      title:    `Go to ${t.label}`,
      subtitle: eventName ?? 'Current event',
      group:    'This event',
      keywords: [t.label, t.key, 'tab', 'jump', eventName ?? ''],
      icon:     t.icon,
      kind:     'event-tab',
      tab:      t.key,
      eventId,
    }))

  return [root, ...tabs]
}

// ─── Event-context: safe actions (reuse existing routes) ──────────────────────

interface ActionDef {
  action:      EventActionId
  title:       string
  keywords:    string[]
  icon:        LucideIcon
  destructive?: boolean
}

const REVERSIBLE_ACTIONS: ActionDef[] = [
  { action: 'duplicate',            title: 'Duplicate event',      keywords: ['duplicate', 'copy', 'clone'],          icon: Copy     },
  { action: 'close_registrations',  title: 'Close registrations',  keywords: ['close', 'stop', 'registrations'],      icon: Lock     },
  { action: 'reopen_registrations', title: 'Reopen registrations', keywords: ['reopen', 'open', 'registrations'],     icon: LockOpen },
  { action: 'unpublish',            title: 'Unpublish event',      keywords: ['unpublish', 'hide', 'draft'],          icon: EyeOff   },
]

const DESTRUCTIVE_ACTIONS: ActionDef[] = [
  { action: 'complete', title: 'Mark event complete…', keywords: ['complete', 'finish', 'done'], icon: CheckCircle, destructive: true },
  { action: 'archive',  title: 'Archive event…',       keywords: ['archive', 'hide'],            icon: Archive,     destructive: true },
  { action: 'cancel',   title: 'Cancel event…',        keywords: ['cancel', 'abort'],            icon: XCircle,     destructive: true },
]

/**
 * Which actions are valid for a lifecycle status. Mirrors the gating already in
 * EventActionsPanel so the palette never offers an action the server would
 * certainly reject — the SERVER remains authoritative. Duplicate is always valid.
 */
export function availableEventActions(ls: EventLifecycleStatus): EventActionId[] {
  // Recognition only (Phase L2): an unpublished event exposes the same minimal,
  // non-destructive action set as archived — NO new actions are introduced.
  if (ls === 'archived' || ls === 'unpublished') return ['duplicate']
  const ids: EventActionId[] = []
  if (ls === 'published')                                   ids.push('close_registrations', 'unpublish', 'complete')
  if (ls === 'registration_closed')                         ids.push('reopen_registrations')
  if (ls === 'published' || ls === 'registration_closed')   ids.push('cancel')
  if (ls === 'completed' || ls === 'cancelled')             ids.push('archive')
  ids.push('duplicate')
  return ids
}

export function buildEventActionCommands(
  eventId:   string,
  ls:        EventLifecycleStatus,
  eventName?: string,
): PaletteCommand[] {
  const available = new Set(availableEventActions(ls))
  return [...REVERSIBLE_ACTIONS, ...DESTRUCTIVE_ACTIONS]
    .filter(d => available.has(d.action))
    .map<PaletteCommand>(d => ({
      id:          `event-action:${eventId}:${d.action}`,
      title:       d.title,
      subtitle:    eventName ?? 'Current event',
      group:       'Event actions',
      keywords:    [...d.keywords, eventName ?? ''],
      icon:        d.icon,
      kind:        'event-action',
      action:      d.action,
      eventId,
      permission:  'events',
      destructive: d.destructive,
    }))
}
