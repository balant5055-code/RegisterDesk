'use client'

// RD-ORG-FOUNDATION · Organizer sidebar.
//
// ═══ WHAT CHANGED AND WHY ════════════════════════════════════════════════════
// The previous sidebar was a two-level accordion (group → children) filtered only by
// feature flags. Three problems it created, all fixed here:
//
//   1. Nesting hid the IA. Ten collapsible groups meant the organizer had to open a
//      group to discover what was in it, and the open/closed state was one more thing
//      to get wrong on every navigation. The canonical IA is flat — one row per
//      capability, grouped under a static section label.
//
//   2. It was not permission-aware. A finance-only member saw Media Studio, Race
//      Operations and Team — fifteen of sixteen rows led to a 403 for at least one
//      role. It now gates on the SAME ROLE_PERMISSIONS matrix the server authorizes
//      against (advisory only; see useWorkspacePermissions).
//
//   3. It was not event-aware. Event-scoped rows linked without the selected event,
//      so a module could load workspace-wide data under an event heading. Every href
//      now comes from `resolveNavHref`, which either carries the event or returns
//      null — and a null href renders the row DISABLED rather than linking somewhere
//      that quietly drops the scope.
//
// One array drives desktop, collapsed and mobile — they cannot drift.

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useSearchParams } from 'next/navigation'
import { PanelLeftClose, PanelLeft, X, Search } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useFeatureFlags } from '@/lib/config/featureFlagsClient'
import { useWorkspacePermissions } from '@/lib/hooks/useWorkspacePermissions'
import { useInboxUnreadCount } from '@/lib/hooks/useInboxUnreadCount'
import { isCheckinOnlyRole, type TeamRole } from '@/lib/team/types'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { openCommandPalette } from '@/lib/commandPalette/bridge'
import {
  WORKSPACE_NAV, navItemForLocation, resolveNavHref, navHrefEnabled, navItemAvailableForEvent,
  type WorkspaceNavItem, type WorkspaceNavSection,
} from '@/config/workspaceNav'

const COLLAPSE_KEY = 'rd_org_sidebar_collapsed'

export interface SidebarProps {
  open:        boolean
  onClose:     () => void
  displayName: string
  email:       string
  initial:     string
}

// ─── Feature-flag gating ──────────────────────────────────────────────────────
// Unchanged behaviour, carried over verbatim: a globally disabled feature disappears
// from the sidebar. The server still enforces each feature independently.

// RD-EVENT-03 · `navHrefEnabled` moved to config/workspaceNav, beside `resolveNavHref`.
// Both halves of "where does this nav item go, and is it switched on" now live with the
// nav definition itself, so the Event Overview resolves destinations identically to this
// sidebar instead of re-deriving (and drifting from) the rule.

// ─── Row ──────────────────────────────────────────────────────────────────────

function NavRow({ item, href, active, collapsed, onNavigate, badge = 0 }: {
  item: WorkspaceNavItem
  href: string | null
  active: boolean
  collapsed: boolean
  onNavigate?: () => void
  /** Unread count shown beside the label (WhatsApp Inbox). 0 renders nothing. */
  badge?: number
}) {
  const Icon = item.icon

  // No href = this row needs a selected event and there is none. Rendered as a
  // disabled control with an explanation, never as a link — following it would land
  // on a page that silently shows the wrong scope.
  if (!href) {
    return (
      <li>
        <span
          aria-disabled="true"
          title={collapsed ? `${item.label} — select an event first` : 'Select an event first'}
          className={cn(
            'flex items-center rounded-control text-fs-sm text-muted-foreground/45',
            collapsed ? 'h-9 w-9 justify-center' : 'h-9 gap-2.5 px-2.5',
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          {!collapsed && <span className="truncate">{item.label}</span>}
        </span>
      </li>
    )
  }

  return (
    <li>
      <Link
        href={href}
        onClick={onNavigate}
        prefetch={false}
        target={item.newTab ? '_blank' : undefined}
        rel={item.newTab ? 'noopener noreferrer' : undefined}
        aria-current={active ? 'page' : undefined}
        title={collapsed ? (badge > 0 ? `${item.label} — ${badge} unread` : item.label) : undefined}
        className={cn(
          'group relative flex items-center rounded-control text-fs-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          collapsed ? 'h-9 w-9 justify-center' : 'h-9 gap-2.5 px-2.5',
          active
            ? 'bg-primary/[0.06] font-medium text-primary'
            : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
        )}
      >
        {/* Active marker: a 2px rail rather than a filled pill. The filled treatment
            put a large rounded block in the sidebar for every visit; a rail reads as
            structure and keeps the restrained-radius language intact. */}
        {active && (
          <span
            className="absolute -left-2 top-1/2 h-4.5 w-[2px] -translate-y-1/2 rounded-pill bg-primary"
            aria-hidden
          />
        )}
        <Icon className="size-4 shrink-0" aria-hidden />
        {!collapsed && <span className="truncate">{item.label}</span>}
        {badge > 0 && (collapsed ? (
          <span className="absolute right-1.5 top-1.5 size-1.5 rounded-pill bg-primary" aria-hidden />
        ) : (
          <span aria-hidden className="ml-auto min-w-5 rounded-pill bg-primary px-1.5 text-center text-fs-2xs font-semibold leading-5 text-primary-foreground tabular-nums">
            {badge > 99 ? '99+' : badge}
          </span>
        ))}
        {badge > 0 && <span className="sr-only"> ({badge} unread)</span>}
      </Link>
    </li>
  )
}

// ─── Nav body ─────────────────────────────────────────────────────────────────

function NavBody({ sections, collapsed, onNavigate, badges }: {
  sections: Array<WorkspaceNavSection & { resolved: Array<{ item: WorkspaceNavItem; href: string | null; active: boolean }> }>
  collapsed: boolean
  onNavigate?: () => void
  /** Per-row badge counts keyed by nav item key. */
  badges?: Record<string, number>
}) {
  // pb-4, not py-3: this scroll region ends flush against the account block, so the
  // last row sat hard against it with no breathing space at short viewport heights —
  // visible on a 900px laptop and on every phone.
  return (
    <nav aria-label="Workspace" className={cn('flex-1 overflow-y-auto pt-3 pb-4', collapsed ? 'px-3' : 'px-4')}>
      {sections.map((section, i) => (
        <div key={section.sectionLabel} className={cn(i > 0 && (collapsed ? 'mt-3 border-t border-border/60 pt-3' : 'mt-4'))}>
          {!collapsed && (
            <p className="mb-1.5 px-2.5 text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground/60">
              {section.sectionLabel}
            </p>
          )}
          <ul className="space-y-0.5">
            {section.resolved.map(({ item, href, active }) => (
              <NavRow
                key={item.key}
                item={item}
                href={href}
                active={active}
                collapsed={collapsed}
                onNavigate={onNavigate}
                badge={badges?.[item.key]}
              />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export function Sidebar({ open, onClose, displayName, email, initial }: SidebarProps) {
  const pathname     = usePathname()
  const searchParams = useSearchParams()
  const flags        = useFeatureFlags()
  const perms        = useWorkspacePermissions(true)
  const { selectedEventId, selectedEvent, events } = useEventContext()

  // Lazy initializer, not an effect: reading the stored preference in an effect would
  // paint the sidebar expanded and then snap it closed on every load.
  // `window` is guarded for the server render, where it resolves to expanded.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return window.localStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
  })
  const firstLink = useRef<HTMLDivElement>(null)

  function toggleCollapsed() {
    setCollapsed(c => {
      const next = !c
      try { window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0') } catch { /* blocked storage */ }
      return next
    })
  }

  // Close the mobile drawer on Escape — the overlay handles pointer dismissal.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const activeItem = useMemo(
    () => navItemForLocation(pathname, searchParams.get('tab')),
    [pathname, searchParams],
  )

  // ONE resolution pass, shared by all three renderings.
  const sections = useMemo(() => {
    return WORKSPACE_NAV.map(section => ({
      ...section,
      resolved: section.items
        .filter(item => navHrefEnabled(item.href, flags))
        .filter(item => !item.permission || perms.has(item.permission))
        // RD-ANALYTICS-12-13 · the gate-role boundary the SERVER applies, mirrored.
        //
        // `authorizeAnyWorkspace` refuses a caller whose entire grant is `checkin`, and that
        // exclusion is not a permission, so a permission filter cannot express it. Without
        // this, a row carrying no `permission` — Reports, and Analytics before it gained one
        // — was offered to accounts every organizer API answers with 403.
        //
        // Advisory only. `isCheckinOnlyRole` returns false for the empty role the hook holds
        // while loading, so nothing flickers away from a legitimate operator mid-load.
        .filter(item => !item.hideFromGateRoles || !isCheckinOnlyRole(perms.role as TeamRole))
        // RD-RACEOPS-02B · the EVENT'S capability, independent of the person's permission.
        //
        // A row carrying `eventCapability` is offered only when the selected event holds that
        // capability (or, with no event selected, when some listed event does). Decided by
        // the same rule the Race Operations routes apply server-side, so a conference never
        // shows a Race Operations row that its API would refuse — and the decision follows
        // the selector, so switching events adds or removes the row without a reload.
        .filter(item => navItemAvailableForEvent(item, selectedEvent, events))
        .map(item => ({
          item,
          href:   item.newTab ? item.href : resolveNavHref(item, selectedEventId),
          active: activeItem?.key === item.key,
        })),
    })).filter(s => s.resolved.length > 0)
  }, [flags, perms, selectedEventId, selectedEvent, events, activeItem])

  // WhatsApp Inbox badge — fetched only when the Inbox row is shown (`broadcasts`, and not
  // while permissions are still the optimistic loading answer) AND the Inbox is switched on.
  // The row stays visible with the flag off; the count endpoint then answers 404, so asking
  // would only spend a request on every page.
  const inboxVisible = !perms.loading && sections.some(s => s.resolved.some(r => r.item.key === 'inbox'))
  const inboxUnread  = useInboxUnreadCount(inboxVisible && flags.whatsappInbox)
  const badges       = useMemo(() => ({ inbox: inboxUnread }), [inboxUnread])

  const brand = (
    <Link
      href="/dashboard"
      className="flex items-center gap-2 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      aria-label="RegisterDesk — workspace overview"
    >
      {/* The canonical mark: /logo/RegisterDesk-Logo.svg. This pointed at a derived
          `-optimized.webp` that is not in public/, so every dashboard load rendered a broken
          image here.

          The 26×26 box and `object-contain` are unchanged. `size-[26px]` sets both CSS
          dimensions explicitly, so width/height here only carry the artwork's intrinsic ratio
          (now square, so it fills the box rather than letterboxing) and never the rendered
          size. `unoptimized` is required: /_next/image rejects SVG unless the platform-wide
          `dangerouslyAllowSVG` is enabled, which would also admit organiser-uploaded SVGs —
          see the full note in components/marketing/BrandLockup.tsx. */}
      <Image
        src="/logo/RegisterDesk-Logo.svg"
        alt=""
        width={1254}
        height={1254}
        unoptimized
        className="size-[26px] shrink-0 object-contain"
        priority
      />
      {!collapsed && <span className="truncate text-fs-md font-semibold tracking-tight text-foreground">RegisterDesk</span>}
    </Link>
  )

  const account = (
    <div className={cn('flex items-center border-t border-border', collapsed ? 'justify-center px-3 py-3' : 'gap-2.5 px-4 py-3')}>
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-pill bg-primary/10 text-fs-xs font-semibold text-primary"
        aria-hidden
      >
        {initial}
      </span>
      {!collapsed && (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-fs-xs font-medium text-foreground">{displayName}</span>
          <span className="block truncate text-fs-2xs text-muted-foreground">{email}</span>
        </span>
      )}
    </div>
  )

  const shell = (mobile: boolean) => (
    <div ref={firstLink} className="flex h-full flex-col bg-card">
      <div className={cn('flex h-16 shrink-0 items-center border-b border-border', collapsed && !mobile ? 'justify-center px-3' : 'gap-2 px-4')}>
        <div className="min-w-0 flex-1">{brand}</div>
        {mobile ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="flex size-8 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {/* Search entry point into the command palette. One affordance, not a second
          search implementation — ⌘K already owns organizer search. */}
      {!collapsed && (
        <div className="px-4 pt-3">
          <button
            type="button"
            onClick={() => { openCommandPalette(); if (mobile) onClose() }}
            className="flex h-8 w-full items-center gap-2 rounded-control border border-border bg-background px-2.5 text-fs-xs text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="hidden rounded-[3px] border border-border px-1 font-sans text-fs-2xs text-muted-foreground/70 sm:inline">⌘K</kbd>
          </button>
        </div>
      )}

      <NavBody sections={sections} collapsed={collapsed && !mobile} onNavigate={mobile ? onClose : undefined} badges={badges} />

      {account}

      {!mobile && (
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'flex h-9 shrink-0 items-center border-t border-border text-muted-foreground transition-colors',
            'hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
            collapsed ? 'justify-center px-3' : 'gap-2 px-4',
          )}
        >
          {collapsed ? <PanelLeft className="size-4" aria-hidden /> : <PanelLeftClose className="size-4" aria-hidden />}
          {!collapsed && <span className="text-fs-xs">Collapse</span>}
        </button>
      )}
    </div>
  )

  return (
    <>
      {/* Desktop rail. Width is the only thing collapse changes — the nav array,
          the active row and the permission gate are identical in both states. */}
      <aside
        className={cn(
          'hidden shrink-0 border-r border-border transition-[width] duration-200 ease-out md:block',
          collapsed ? 'w-[68px]' : 'w-[248px]',
        )}
      >
        {shell(false)}
      </aside>

      {/* Mobile drawer */}
      <div
        className={cn('fixed inset-0 z-50 md:hidden', open ? 'pointer-events-auto' : 'pointer-events-none')}
        aria-hidden={!open}
      >
        <div
          onClick={onClose}
          className={cn('absolute inset-0 bg-foreground/40 transition-opacity duration-200', open ? 'opacity-100' : 'opacity-0')}
        />
        <aside
          role="dialog"
          aria-modal="true"
          aria-label="Workspace navigation"
          className={cn(
            'absolute inset-y-0 left-0 w-[272px] max-w-[85vw] border-r border-border shadow-xl',
            'transition-transform duration-200 ease-out',
            open ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          {shell(true)}
        </aside>
      </div>
    </>
  )
}
