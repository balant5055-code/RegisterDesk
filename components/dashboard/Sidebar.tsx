'use client'

import { Suspense, startTransition, useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Settings,
  X,
} from 'lucide-react'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { ROUTES } from '@/config/navigation'
import { WORKSPACE_NAV } from '@/config/workspaceNav'
import { useFeatureFlags } from '@/lib/config/featureFlagsClient'
import type { FeatureFlagsConfig } from '@/lib/config/businessConfig'
import { cn } from '@/lib/utils/cn'

// ─── Navigation structure ─────────────────────────────────────────────────────

interface NavChild {
  label: string
  href:  string
  /**
   * When present, each key is checked with searchParams.get().
   * A null value means the param must be absent.
   * Keys not listed here (e.g. eventId, dateRange) are ignored — adding
   * new URL filters to a page will never break sidebar highlighting.
   */
  matchParams?: Record<string, string | null>
  /** Open in a new tab (H.3 support hooks). */
  newTab?: boolean
}

interface NavGroup {
  key:      string
  label:    string
  icon:     React.ElementType
  href:     string
  children: NavChild[]
}

interface NavSection {
  sectionLabel: string
  groups:       NavGroup[]
}

// IA is sourced from config/workspaceNav.ts (single source of truth). Every href
// points at an existing route; the structural shape matches NavSection exactly.
const NAV_SECTIONS: NavSection[] = WORKSPACE_NAV

// Feature-flag gating (RD-CONF-08): hide nav items whose feature is globally
// disabled in Business Configuration. The server still enforces each feature; this
// just makes a disabled feature disappear from the sidebar.
function navHrefEnabled(href: string, flags: FeatureFlagsConfig): boolean {
  if (href.startsWith('/dashboard/crm'))                     return flags.crm
  if (href.startsWith('/dashboard/communications/broadcasts')) return flags.broadcast
  if (href.includes('/certificates'))                        return flags.certificates
  if (href.includes('/campaigns'))                           return flags.donations
  return true
}
function filterNavSections(flags: FeatureFlagsConfig): NavSection[] {
  return NAV_SECTIONS
    .map(s => ({
      ...s,
      groups: s.groups
        .filter(g => navHrefEnabled(g.href, flags))
        .map(g => ({ ...g, children: g.children.filter(c => navHrefEnabled(c.href, flags)) })),
    }))
    .filter(s => s.groups.length > 0)
}

// ─── Active helpers ───────────────────────────────────────────────────────────

function isGroupActive(group: NavGroup, pathname: string): boolean {
  if (group.href === '/dashboard') return pathname === '/dashboard'
  return pathname.startsWith(group.href)
}

/**
 * Determines whether a nav child should appear highlighted.
 *
 * Pathname is always compared exactly against the child's base path (query
 * string stripped from href).  If the child declares matchParams, every listed
 * key is checked with searchParams.get(); keys not listed are ignored — so
 * adding ?eventId or any other future filter to the URL never breaks
 * highlighting of unrelated nav items.
 */
function isChildActive(
  child:        NavChild,
  pathname:     string,
  searchParams: { get: (key: string) => string | null },
): boolean {
  // Compare pathname against the base path only (strip any ?query from href)
  const childPath = child.href.split('?')[0]
  if (pathname !== childPath) return false

  // No param constraints — pathname match alone is sufficient
  if (!child.matchParams) return true

  // Every declared param must match; unlisted params are ignored
  return Object.entries(child.matchParams).every(
    ([key, val]) => searchParams.get(key) === val,
  )
}

// ─── Floating tooltip (collapsed mode only) ───────────────────────────────────

function Tooltip({ label }: { label: string }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute left-full top-1/2 z-[60] ml-3.5 -translate-y-1/2',
        'whitespace-nowrap rounded-lg border border-border bg-popover px-3 py-1.5',
        'text-[13px] font-medium text-popover-foreground shadow-lg',
        'opacity-0 transition-opacity duration-100 group-hover:opacity-100',
      )}
      aria-hidden
    >
      {label}
    </span>
  )
}

// ─── Section label ────────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <p className="mb-1 mt-0.5 select-none px-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/50">
      {label}
    </p>
  )
}

// ─── SidebarContent ───────────────────────────────────────────────────────────

function SidebarContent({
  collapsed,
  onClose,
  onToggleCollapsed,
  isMobile = false,
  displayName,
  email,
  initial,
}: {
  collapsed:         boolean
  onClose:           () => void
  onToggleCollapsed: () => void
  isMobile?:         boolean
  displayName:       string
  email:             string
  initial:           string
}) {
  const pathname     = usePathname()
  const router       = useRouter()
  // useSearchParams() is used here for reactive active-state detection.
  // The <Suspense> wrapper in the Sidebar export satisfies the Next.js
  // App Router requirement for components that call useSearchParams().
  const searchParams = useSearchParams()

  // Feature-flag-filtered nav (server still enforces each feature).
  const flags     = useFeatureFlags()
  const sections  = filterNavSections(flags)
  const navGroups = sections.flatMap(s => s.groups)

  // ── Profile card dropdown ──────────────────────────────────────────────────
  const profileCardRef              = useRef<HTMLDivElement>(null)
  const [profileOpen, setProfileOpen] = useState(false)

  useEffect(() => {
    if (!profileOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (!profileCardRef.current?.contains(e.target as Node)) setProfileOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [profileOpen])

  async function handleSignOut() {
    setProfileOpen(false)
    onClose()
    await signOut(auth).catch(() => null)
    router.replace(ROUTES.LOGIN)
  }

  // Which nav groups have their submenu open
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const activeKey = navGroups.find(g => isGroupActive(g, pathname))?.key
    return activeKey ? new Set([activeKey]) : new Set()
  })

  // Auto-expand the active group on route change
  useEffect(() => {
    const activeKey = navGroups.find(g => isGroupActive(g, pathname))?.key
    if (activeKey) startTransition(() => setOpenGroups(prev => new Set([...prev, activeKey])))
  }, [pathname])

  function toggleGroup(key: string) {
    setOpenGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const showExpanded = isMobile || !collapsed

  return (
    <div className="flex h-full flex-col">

      {/* ── Logo + collapse toggle ── */}
      <div className={cn(
        'flex h-[64px] shrink-0 items-center border-b border-border',
        showExpanded ? 'justify-between px-5' : 'justify-center px-3',
      )}>
        {showExpanded ? (
          <>
            <Link href="/dashboard" onClick={onClose} className="flex items-center gap-3">
              <div
                className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-primary-foreground shadow-sm ring-1 ring-primary/20"
                style={{ backgroundImage: 'var(--primary-gradient)' }}
              >
                <span className="text-[11px] font-extrabold tracking-[0.12em]">RD</span>
              </div>
              <div className="leading-none">
                <span className="text-[15px] font-bold tracking-[-0.02em] text-foreground">Register</span>
                <span className="text-[15px] font-bold tracking-[-0.02em] text-muted-foreground/60">Desk</span>
              </div>
            </Link>
            <div className="flex items-center">
              {/* Desktop collapse */}
              <button
                onClick={onToggleCollapsed}
                className="hidden items-center justify-center rounded-lg p-1.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground lg:flex"
                aria-label="Collapse sidebar"
              >
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              {/* Mobile close */}
              <button
                onClick={onClose}
                className="flex items-center justify-center rounded-lg p-1.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground lg:hidden"
                aria-label="Close sidebar"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          </>
        ) : (
          <>
            <Link href="/dashboard" onClick={onClose} aria-label="Dashboard">
              <div
                className="flex size-8 items-center justify-center rounded-[9px] text-primary-foreground shadow-sm ring-1 ring-primary/20"
                style={{ backgroundImage: 'var(--primary-gradient)' }}
              >
                <span className="text-[11px] font-extrabold tracking-[0.12em]">RD</span>
              </div>
            </Link>
            <button
              onClick={onToggleCollapsed}
              className="absolute -right-3.5 top-5 hidden size-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground lg:flex"
              aria-label="Expand sidebar"
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </>
        )}
      </div>

      {/* ── Primary navigation ── */}
      <nav
        className={cn(
          'flex-1 py-4',
          showExpanded ? 'overflow-y-auto px-3' : 'overflow-visible px-2',
        )}
        aria-label="Primary navigation"
      >
        {showExpanded ? (
          <div className="space-y-5">
            {sections.map(section => (
              <div key={section.sectionLabel}>
                <SectionLabel label={section.sectionLabel} />
                <ul className="space-y-0.5">
                  {section.groups.map(group => {
                    const active    = isGroupActive(group, pathname)
                    const groupOpen = openGroups.has(group.key)
                    const Icon      = group.icon

                    return (
                      <li key={group.key}>
                        <button
                          type="button"
                          onClick={() => toggleGroup(group.key)}
                          className={cn(
                            'relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14.5px] font-medium',
                            'transition-all duration-150 ease-out',
                            active
                              ? 'bg-gradient-to-r from-primary/[0.1] to-primary/[0.02] text-primary'
                              : 'text-muted-foreground hover:translate-x-1 hover:bg-muted/60 hover:text-foreground',
                          )}
                          aria-expanded={groupOpen}
                        >
                          {active && (
                            <span
                              className="absolute inset-y-[7px] left-0 w-[3px] rounded-r-full bg-primary shadow-[0_0_8px_rgba(229,39,126,0.4)]"
                              aria-hidden
                            />
                          )}
                          <Icon
                            className={cn(
                              'size-5 shrink-0',
                              active ? 'text-primary' : 'text-muted-foreground/70',
                            )}
                            aria-hidden
                          />
                          <span className="flex-1 leading-none">{group.label}</span>
                          <ChevronDown
                            className={cn(
                              'size-3.5 shrink-0 transition-transform duration-200',
                              groupOpen ? 'rotate-180' : '',
                              active ? 'text-primary/60' : 'text-muted-foreground/30',
                            )}
                            aria-hidden
                          />
                        </button>

                        <AnimatePresence initial={false}>
                          {groupOpen && (
                            <motion.ul
                              key="submenu"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                              className="overflow-hidden"
                            >
                              <div className="ml-5 mt-0.5 border-l border-border/60 pb-1 pl-4">
                                {group.children.map(child => {
                                  const childActive = isChildActive(child, pathname, searchParams)
                                  return (
                                    <li key={`${group.key}-${child.label}`}>
                                      <Link
                                        href={child.href}
                                        onClick={onClose}
                                        target={child.newTab ? '_blank' : undefined}
                                        rel={child.newTab ? 'noopener noreferrer' : undefined}
                                        className={cn(
                                          'flex items-center gap-2.5 rounded-lg px-3 py-[7px] text-[14px] transition-all duration-150',
                                          childActive
                                            ? 'bg-primary/[0.08] font-semibold text-primary'
                                            : 'font-medium text-muted-foreground hover:translate-x-0.5 hover:bg-muted/50 hover:text-foreground',
                                        )}
                                        aria-current={childActive ? 'page' : undefined}
                                      >
                                        <span
                                          className={cn(
                                            'size-1.5 shrink-0 rounded-full transition-all',
                                            childActive
                                              ? 'bg-primary shadow-[0_0_5px_rgba(229,39,126,0.5)]'
                                              : 'bg-muted-foreground/25',
                                          )}
                                          aria-hidden
                                        />
                                        {child.label}
                                      </Link>
                                    </li>
                                  )
                                })}
                              </div>
                            </motion.ul>
                          )}
                        </AnimatePresence>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          /* Collapsed — icon-only links */
          <ul className="space-y-1">
            {navGroups.map(group => {
              const active = isGroupActive(group, pathname)
              const Icon   = group.icon
              return (
                <li key={group.key}>
                  <Link
                    href={group.href}
                    onClick={onClose}
                    className={cn(
                      'group relative flex h-10 w-full items-center justify-center rounded-xl transition-colors',
                      active
                        ? 'bg-primary/[0.1] text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                    aria-label={group.label}
                    aria-current={active ? 'page' : undefined}
                  >
                    {active && (
                      <span
                        className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary shadow-[0_0_8px_rgba(229,39,126,0.4)]"
                        aria-hidden
                      />
                    )}
                    <Icon className="size-5 shrink-0" aria-hidden />
                    <Tooltip label={group.label} />
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </nav>

      {/* ── User card ── */}
      {showExpanded ? (
        <div ref={profileCardRef} className="relative shrink-0 border-t border-border px-3 py-3">
          {/* Dropdown — anchored above the card */}
          <AnimatePresence>
            {profileOpen && (
              <motion.div
                key="profile-dropdown"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                role="menu"
                aria-label="Profile options"
                className="absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
              >
                <div role="group" className="py-1">
                  <Link
                    href={ROUTES.DASHBOARD_SETTINGS}
                    role="menuitem"
                    onClick={() => { setProfileOpen(false); onClose() }}
                    className="flex items-center gap-2.5 px-4 py-2 text-[14px] text-foreground transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  >
                    <Settings className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    Settings
                  </Link>
                </div>
                <div className="border-t border-border py-1">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-[14px] text-destructive transition-colors hover:bg-destructive/[0.07] focus-visible:bg-destructive/[0.07] focus-visible:outline-none"
                  >
                    <LogOut className="size-3.5 shrink-0" aria-hidden />
                    Sign Out
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Card trigger */}
          <button
            type="button"
            onClick={() => setProfileOpen(o => !o)}
            aria-label="Open profile menu"
            aria-expanded={profileOpen}
            aria-haspopup="menu"
            className="flex w-full items-center gap-3 rounded-xl bg-muted/40 px-3 py-2.5 ring-1 ring-border/60 transition-colors hover:bg-muted/60"
          >
            <div
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-primary-foreground shadow-sm ring-2 ring-background"
              style={{ backgroundImage: 'var(--primary-gradient)' }}
              aria-hidden
            >
              {initial}
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-[14px] font-semibold leading-tight text-foreground">{displayName}</p>
              <p className="truncate text-[13px] leading-tight text-muted-foreground">{email}</p>
            </div>
            <ChevronDown
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150',
                profileOpen && 'rotate-180',
              )}
              aria-hidden
            />
          </button>
        </div>
      ) : (
        <div className="shrink-0 border-t border-border px-2 py-3">
          <Link
            href={ROUTES.DASHBOARD_SETTINGS}
            onClick={onClose}
            className="group relative flex h-10 w-full items-center justify-center rounded-xl transition-colors hover:bg-muted"
            aria-label="Settings"
          >
            <div
              className="flex size-8 items-center justify-center rounded-full text-[12px] font-bold text-primary-foreground shadow-sm ring-2 ring-background"
              style={{ backgroundImage: 'var(--primary-gradient)' }}
              aria-hidden
            >
              {initial}
            </div>
            <Tooltip label="Settings" />
          </Link>
        </div>
      )}

    </div>
  )
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

interface SidebarProps {
  open:        boolean
  onClose:     () => void
  displayName: string
  email:       string
  initial:     string
}

export function Sidebar({ open, onClose, displayName, email, initial }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    const saved = localStorage.getItem('rd-sidebar-collapsed')
    return saved !== null ? saved === 'true' : window.innerWidth < 1024
  })
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    startTransition(() => setMounted(true))
  }, [])

  function toggleCollapsed() {
    setCollapsed(prev => {
      const next = !prev
      localStorage.setItem('rd-sidebar-collapsed', String(next))
      return next
    })
  }

  // SidebarContent calls useSearchParams(), which requires a Suspense boundary
  // in Next.js App Router.  The fallback is null because the sidebar shell
  // (logo, user card) is inside SidebarContent; a visible flash cannot occur
  // in practice since the dashboard is fully client-rendered.
  return (
    <>
      {/* ── Mobile off-canvas (< md) ── */}
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
              onClick={onClose}
            />
            <motion.aside
              key="sidebar"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              className="fixed inset-y-0 left-0 z-50 w-[280px] border-r border-border bg-card shadow-xl md:hidden"
              aria-label="Navigation drawer"
            >
              <Suspense fallback={null}>
                <SidebarContent
                  collapsed={false}
                  onClose={onClose}
                  onToggleCollapsed={toggleCollapsed}
                  isMobile
                  displayName={displayName}
                  email={email}
                  initial={initial}
                />
              </Suspense>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ── Desktop / tablet side panel (>= md) ── */}
      <aside
        className={cn(
          'relative hidden flex-col border-r border-border bg-card md:flex',
          'transition-[width] duration-200 ease-out',
          !mounted && 'invisible',
          collapsed ? 'w-[72px]' : 'w-[296px]',
        )}
        aria-label="Dashboard sidebar"
      >
        <Suspense fallback={null}>
          <SidebarContent
            collapsed={collapsed}
            onClose={onClose}
            onToggleCollapsed={toggleCollapsed}
            displayName={displayName}
            email={email}
            initial={initial}
          />
        </Suspense>
      </aside>
    </>
  )
}
