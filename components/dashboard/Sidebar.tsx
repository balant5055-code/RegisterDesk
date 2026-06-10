'use client'

import { startTransition, useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Mail,
  ScanLine,
  Settings,
  Ticket,
  X,
} from 'lucide-react'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'

// ─── Navigation structure ─────────────────────────────────────────────────────

interface NavChild {
  label:        string
  href:         string
  exactSearch?: boolean
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

const NAV_SECTIONS: NavSection[] = [
  {
    sectionLabel: 'Workspace',
    groups: [
      {
        key: 'dashboard', label: 'Overview', icon: LayoutDashboard, href: '/dashboard',
        children: [{ label: 'Overview', href: '/dashboard' }],
      },
    ],
  },
  {
    sectionLabel: 'Event Operations',
    groups: [
      {
        key: 'events', label: 'Events', icon: CalendarDays, href: '/dashboard/events',
        children: [
          { label: 'All Events',   href: '/dashboard/events' },
          { label: 'Create Event', href: '/dashboard/events/new/visibility' },
        ],
      },
      {
        key: 'registrations', label: 'Registrations', icon: Ticket, href: '/dashboard/registrations',
        children: [
          { label: 'All Registrations', href: '/dashboard/registrations',                 exactSearch: true },
          { label: 'Confirmed',         href: '/dashboard/registrations?status=confirmed', exactSearch: true },
          { label: 'Cancelled',         href: '/dashboard/registrations?status=cancelled', exactSearch: true },
        ],
      },
      {
        key: 'checkin', label: 'Check-In', icon: ScanLine, href: '/dashboard/check-in',
        children: [{ label: 'Check-In Hub', href: '/dashboard/check-in' }],
      },
    ],
  },
  {
    sectionLabel: 'Insights',
    groups: [
      {
        key: 'analytics', label: 'Analytics', icon: BarChart3, href: '/dashboard/reports',
        children: [{ label: 'Overview', href: '/dashboard/reports' }],
      },
      {
        key: 'communications', label: 'Communications', icon: Mail, href: '/dashboard/communications',
        children: [
          { label: 'Hub',          href: '/dashboard/communications' },
          { label: 'Certificates', href: '/dashboard/communications/certificates' },
        ],
      },
    ],
  },
]

// Flat list used in collapsed mode and for active-group detection
const NAV_GROUPS: NavGroup[] = NAV_SECTIONS.flatMap(s => s.groups)

const BOTTOM_NAV_LINKS = [
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
] as const

// ─── Active helpers ───────────────────────────────────────────────────────────

function isGroupActive(group: NavGroup, pathname: string): boolean {
  if (group.href === '/dashboard') return pathname === '/dashboard'
  return pathname.startsWith(group.href)
}

function isChildActive(child: NavChild, pathname: string, search: string): boolean {
  if (!child.exactSearch) return pathname === child.href
  if (child.href.includes('?')) {
    const [p, q] = child.href.split('?')
    return pathname === p && search === `?${q}`
  }
  return pathname === child.href && search === ''
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
    <p className="mb-1 mt-0.5 select-none px-3 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/50">
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
  const pathname = usePathname()
  const router   = useRouter()

  async function handleSignOut() {
    onClose()
    await signOut(auth).catch(() => null)
    router.replace(ROUTES.LOGIN)
  }

  // Track search string for exactSearch child-active matching without Suspense
  const [search, setSearch] = useState('')
  useEffect(() => {
    const s = typeof window !== 'undefined' ? window.location.search : ''
    startTransition(() => setSearch(s))
  }, [pathname])

  // Which nav groups have their submenu open
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const activeKey = NAV_GROUPS.find(g => isGroupActive(g, pathname))?.key
    return activeKey ? new Set([activeKey]) : new Set()
  })

  // Auto-expand the active group on route change
  useEffect(() => {
    const activeKey = NAV_GROUPS.find(g => isGroupActive(g, pathname))?.key
    if (activeKey) startTransition(() => setOpenGroups(prev => new Set([...prev, activeKey])))
  }, [pathname])

  function toggleGroup(key: string) {
    setOpenGroups(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
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
                <span className="text-[10.5px] font-extrabold tracking-[0.12em]">RD</span>
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
                <span className="text-[10.5px] font-extrabold tracking-[0.12em]">RD</span>
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
            {NAV_SECTIONS.map(section => (
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
                                  const childActive = isChildActive(child, pathname, search)
                                  return (
                                    <li key={`${group.key}-${child.label}`}>
                                      <Link
                                        href={child.href}
                                        onClick={onClose}
                                        className={cn(
                                          'flex items-center gap-2.5 rounded-lg px-3 py-[7px] text-[13.5px] transition-all duration-150',
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
            {NAV_GROUPS.map(group => {
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

      {/* ── Bottom nav — System ── */}
      <div className={cn(
        'shrink-0 border-t border-border py-3',
        showExpanded ? 'px-3' : 'px-2',
      )}>
        {showExpanded && <SectionLabel label="System" />}
        <ul className="space-y-0.5">
          {BOTTOM_NAV_LINKS.map(({ href, icon: Icon, label }) => (
            <li key={label}>
              {showExpanded ? (
                <Link
                  href={href}
                  onClick={onClose}
                  className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14.5px] font-medium text-muted-foreground transition-all duration-150 hover:translate-x-1 hover:bg-muted/60 hover:text-foreground"
                >
                  <Icon className="size-5 shrink-0 text-muted-foreground/70" aria-hidden />
                  {label}
                </Link>
              ) : (
                <Link
                  href={href}
                  onClick={onClose}
                  className="group relative flex h-10 w-full items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={label}
                >
                  <Icon className="size-5 shrink-0" aria-hidden />
                  <Tooltip label={label} />
                </Link>
              )}
            </li>
          ))}
          <li>
            {showExpanded ? (
              <button
                type="button"
                onClick={handleSignOut}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14.5px] font-medium text-muted-foreground transition-all duration-150 hover:translate-x-1 hover:bg-destructive/[0.07] hover:text-destructive"
              >
                <LogOut className="size-5 shrink-0 text-muted-foreground/70" aria-hidden />
                Sign Out
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSignOut}
                className="group relative flex h-10 w-full items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-destructive/[0.07] hover:text-destructive"
                aria-label="Sign Out"
              >
                <LogOut className="size-5 shrink-0" aria-hidden />
                <Tooltip label="Sign Out" />
              </button>
            )}
          </li>
        </ul>
      </div>

      {/* ── User card ── */}
      {showExpanded ? (
        <div className="shrink-0 border-t border-border px-3 py-3">
          <div className="flex items-center gap-3 rounded-xl bg-muted/40 px-3 py-2.5 ring-1 ring-border/60">
            <div
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-primary-foreground shadow-sm ring-2 ring-background"
              style={{ backgroundImage: 'var(--primary-gradient)' }}
            >
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold leading-tight text-foreground">{displayName}</p>
              <p className="truncate text-[12px] leading-tight text-muted-foreground">{email}</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-t border-border px-2 py-3">
          <div className="group relative flex h-10 w-full items-center justify-center">
            <div
              className="flex size-8 items-center justify-center rounded-full text-[11px] font-bold text-primary-foreground shadow-sm ring-2 ring-background"
              style={{ backgroundImage: 'var(--primary-gradient)' }}
            >
              {initial}
            </div>
            <Tooltip label={email} />
          </div>
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
              <SidebarContent
                collapsed={false}
                onClose={onClose}
                onToggleCollapsed={toggleCollapsed}
                isMobile
                displayName={displayName}
                email={email}
                initial={initial}
              />
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
        <SidebarContent
          collapsed={collapsed}
          onClose={onClose}
          onToggleCollapsed={toggleCollapsed}
          displayName={displayName}
          email={email}
          initial={initial}
        />
      </aside>
    </>
  )
}
