'use client'

import { useEffect, useRef, useState }    from 'react'
import Link                               from 'next/link'
import { usePathname }                    from 'next/navigation'
import { AnimatePresence, motion }        from 'framer-motion'
import { signOut }                        from 'firebase/auth'
import type { User as FirebaseUser }      from 'firebase/auth'
import { auth }                           from '@/lib/firebase/auth'
import { useAuth }                        from '@/components/auth/AuthProvider'
import { ROUTES, ADMIN_SIDEBAR_NAV }      from '@/config/navigation'
import type { AdminNavItem, AdminNavGroup } from '@/config/navigation'
import { cn }                             from '@/lib/utils/cn'
import { ToastProvider }                  from '@/components/ui/Toast'
import { ConfirmProvider }                from '@/components/ui/ConfirmDialog'
import { CommandPaletteRoot }             from '@/components/admin/commandPalette'
import {
  ChevronDown, LayoutDashboard, LogOut, Menu, ShieldAlert, ShieldCheck, X,
  Bell, Zap, PanelLeft, PanelLeftClose, ClipboardCheck, PlusCircle, Search, Building2,
} from 'lucide-react'

// ─── Auth state ───────────────────────────────────────────────────────────────

type AdminState = 'loading' | 'authorized' | 'denied'

const SIDEBAR_KEY = 'rd_admin_sidebar_collapsed'

// ─── Active-path helper ────────────────────────────────────────────────────────

function isActive(pathname: string, item: AdminNavItem): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href)
}

// ─── Dropdown behaviour (click-outside + Escape) ───────────────────────────────

function useDropdown() {
  const [open, setOpen] = useState(false)
  const containerRef    = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return { open, setOpen, containerRef }
}

const EASE = [0.22, 1, 0.36, 1] as const
const dropdownMotion = {
  variants: {
    hidden: { opacity: 0, y: -6, scale: 0.97 },
    show:   { opacity: 1, y: 0,  scale: 1    },
  } as const,
  initial:    'hidden',
  animate:    'show',
  exit:       'hidden',
  transition: { duration: 0.14, ease: EASE },
}

// ─── Loading / denied screens ───────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
        <p className="text-[14px] text-muted-foreground">Verifying access…</p>
      </div>
    </div>
  )
}

function AccessDenied() {
  return (
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-destructive/10">
          <ShieldAlert className="size-7 text-destructive" aria-hidden />
        </div>
        <h1 className="text-[18px] font-bold text-foreground">Access Denied</h1>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          Your account does not have admin privileges.
          Contact the platform owner to request access.
        </p>
        <Link
          href={ROUTES.DASHBOARD}
          className="mt-6 inline-flex w-full items-center justify-center rounded-lg border border-border px-4 py-2.5 text-[13.5px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          Back to Organizer Dashboard
        </Link>
      </div>
    </div>
  )
}

// ─── Sidebar item + collapsible group ───────────────────────────────────────────

function SidebarItem({ item, active, collapsed, onNavigate }: {
  item: AdminNavItem; active: boolean; collapsed: boolean; onNavigate?: () => void
}) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center rounded-md text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        collapsed ? 'justify-center py-2' : 'gap-2.5 px-2.5 py-2',
        active
          ? 'bg-primary/[0.08] text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className={cn('shrink-0', collapsed ? 'size-[18px]' : 'size-4')} aria-hidden />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  )
}

function SidebarGroup({ group, collapsed, pathname, onNavigate }: {
  group: AdminNavGroup; collapsed: boolean; pathname: string; onNavigate?: () => void
}) {
  // Groups default open (each group is small; the whole IA fits). Users may collapse
  // any group; the active item stays highlighted regardless of its group's open state.
  const [open, setOpen] = useState(true)

  // Collapsed rail: icon-only items, grouped by a subtle divider (no header labels).
  if (collapsed) {
    return (
      <div role="group" aria-label={group.label} className="border-b border-border/40 py-1.5 last:border-0">
        <div className="flex flex-col gap-0.5">
          {group.items.map(item => (
            <SidebarItem key={item.href} item={item} active={isActive(pathname, item)} collapsed onNavigate={onNavigate} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {group.label}
        <ChevronDown className={cn('size-3.5 transition-transform duration-150', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="mt-0.5 flex flex-col gap-0.5">
          {group.items.map(item => (
            <SidebarItem key={item.href} item={item} active={isActive(pathname, item)} collapsed={false} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Permanent left sidebar (md+) ───────────────────────────────────────────────

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = usePathname()
  return (
    <aside
      aria-label="Admin navigation"
      className={cn(
        'sticky top-[56px] hidden h-[calc(100vh-56px)] shrink-0 flex-col border-r border-border bg-card transition-[width] duration-150 md:flex',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Admin sections">
        {ADMIN_SIDEBAR_NAV.map(group => (
          <SidebarGroup key={group.label} group={group} collapsed={collapsed} pathname={pathname} />
        ))}
      </nav>
      <div className="shrink-0 border-t border-border p-2">
        <Link
          href={ROUTES.DASHBOARD}
          title={collapsed ? 'Organizer Dashboard' : undefined}
          className={cn(
            'mb-1 flex items-center rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            collapsed ? 'justify-center py-2' : 'gap-2.5 px-2.5 py-2',
          )}
        >
          <LayoutDashboard className="size-4 shrink-0" aria-hidden />
          {!collapsed && 'Organizer Dashboard'}
        </Link>
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'flex w-full items-center rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            collapsed ? 'justify-center py-2' : 'gap-2.5 px-2.5 py-2',
          )}
        >
          {collapsed
            ? <PanelLeft className="size-4 shrink-0" aria-hidden />
            : <><PanelLeftClose className="size-4 shrink-0" aria-hidden /> Collapse</>}
        </button>
      </div>
    </aside>
  )
}

// ─── Mobile drawer (< md) — same IA, off-canvas ─────────────────────────────────

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-foreground/30 backdrop-blur-[1px]"
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
            transition={{ duration: 0.2, ease: EASE }}
            role="dialog"
            aria-label="Admin navigation"
            className="absolute inset-y-0 left-0 flex w-[80%] max-w-[300px] flex-col border-r border-border bg-card shadow-xl"
          >
            <div className="flex h-[56px] shrink-0 items-center justify-between border-b border-border px-4">
              <div className="flex items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded-[7px] text-primary-foreground shadow-sm" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden>
                  <span className="text-[9px] font-extrabold tracking-[0.1em]">RD</span>
                </div>
                <span className="text-[14px] font-bold tracking-tight text-foreground">Admin</span>
              </div>
              <button onClick={onClose} aria-label="Close navigation menu"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <X className="size-[18px]" aria-hidden />
              </button>
            </div>

            <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Admin sections">
              {ADMIN_SIDEBAR_NAV.map(group => (
                <SidebarGroup key={group.label} group={group} collapsed={false} pathname={pathname} onNavigate={onClose} />
              ))}
            </nav>

            <div className="shrink-0 border-t border-border p-2">
              <Link href={ROUTES.DASHBOARD} onClick={onClose}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] font-medium text-foreground transition-colors hover:bg-muted">
                <LayoutDashboard className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                Organizer Dashboard
              </Link>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  )
}

// ─── Top-bar: Quick Actions (navigation to existing routes only) ────────────────

const QUICK_ACTIONS: AdminNavItem[] = [
  { label: 'Review Approvals', href: ROUTES.ADMIN_EVENT_APPROVALS, icon: ClipboardCheck },
  { label: 'Wallet Top-ups',   href: ROUTES.ADMIN_WALLET_TOPUPS,   icon: PlusCircle },
  { label: 'Global Search',    href: ROUTES.ADMIN_SEARCH,          icon: Search },
  { label: 'Organizers',       href: ROUTES.ADMIN_ORGANIZERS,      icon: Building2 },
]

function QuickActionsMenu() {
  const { open, setOpen, containerRef } = useDropdown()
  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Quick actions"
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Zap className="size-4 text-primary" aria-hidden />
        <span className="hidden sm:inline">Quick actions</span>
        <ChevronDown className={cn('size-3.5 transition-transform duration-150', open && 'rotate-180')} aria-hidden />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div {...dropdownMotion} role="menu" aria-label="Quick actions"
            className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border border-border bg-card p-1.5 shadow-lg">
            {QUICK_ACTIONS.map(a => {
              const Icon = a.icon
              return (
                <Link key={a.href} href={a.href} role="menuitem" onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium text-foreground transition-colors hover:bg-muted">
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  {a.label}
                </Link>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Top-bar: Profile menu ──────────────────────────────────────────────────────

function ProfileMenu({ displayName, email, initial, onSignOut }: {
  displayName: string; email: string; initial: string; onSignOut: () => void
}) {
  const { open, setOpen, containerRef } = useDropdown()
  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Profile menu"
        className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2 py-1.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div className="flex size-6 items-center justify-center rounded-full text-[10px] font-bold text-primary-foreground" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden>
          {initial}
        </div>
        <span className="hidden max-w-[140px] truncate text-[13px] font-medium text-foreground sm:block">{displayName}</span>
        <ChevronDown className={cn('hidden size-3.5 text-muted-foreground/60 transition-transform duration-150 sm:block', open && 'rotate-180')} aria-hidden />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div {...dropdownMotion} role="menu" aria-label="Profile"
            className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-border bg-card p-1.5 shadow-lg">
            <div className="border-b border-border px-2.5 pb-2 pt-1.5">
              <p className="truncate text-[13.5px] font-semibold text-foreground">{displayName}</p>
              <p className="truncate text-[12px] text-muted-foreground">{email}</p>
            </div>
            <Link href={ROUTES.DASHBOARD} role="menuitem" onClick={() => setOpen(false)}
              className="mt-1 flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium text-foreground transition-colors hover:bg-muted">
              <LayoutDashboard className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              Organizer Dashboard
            </Link>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onSignOut() }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] font-medium text-destructive transition-colors hover:bg-destructive/[0.07]">
              <LogOut className="size-4 shrink-0" aria-hidden />
              Sign Out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // RD-AUTH-01 Phase 1 (M-A): identity comes from the ONE shared AuthProvider;
  // this layout keeps its own admin-authorization state (auth-check result) and the
  // display `user` (set only after the admin check passes) — behaviour unchanged.
  const { user: authUser } = useAuth()
  const [adminState, setAdminState] = useState<AdminState>('loading')
  const [user,       setUser]       = useState<FirebaseUser | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Restore the persisted sidebar collapse preference via a lazy initializer (the admin
  // shell renders client-only after the auth check, so there is no SSR/hydration risk).
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try { return localStorage.getItem(SIDEBAR_KEY) === '1' } catch { return false }
  })
  const toggleCollapsed = () => setCollapsed(c => {
    const next = !c
    try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0') } catch { /* ignore */ }
    return next
  })

  useEffect(() => {
    if (authUser === undefined) return                                     // auth still resolving
    let cancelled = false
    const run = async () => {
      if (!authUser) { window.location.replace(ROUTES.ADMIN_LOGIN); return }
      try {
        const token = await authUser.getIdToken()
        const res   = await fetch('/api/admin/auth-check', {
          headers: { authorization: `Bearer ${token}` },
          cache:   'no-store',
        })
        if (cancelled) return
        if (!res.ok) { setAdminState('denied'); return }
        setUser(authUser)
        setAdminState('authorized')
      } catch {
        if (!cancelled) setAdminState('denied')
      }
    }
    run()
    return () => { cancelled = true }
  }, [authUser])

  if (adminState === 'loading') return <LoadingScreen />
  if (adminState === 'denied')  return <AccessDenied />

  const displayName = user?.displayName ?? user?.email?.split('@')[0] ?? 'Admin'
  const email       = user?.email ?? ''
  const initial     = (displayName[0] ?? 'A').toUpperCase()

  async function handleSignOut() {
    await signOut(auth).catch(() => null)
    window.location.replace(ROUTES.ADMIN_LOGIN)
  }

  return (
    <ToastProvider>
    <ConfirmProvider>
    <div className="min-h-screen bg-background">

      {/* ── Top bar: Logo · Global Search · Notifications · Quick Actions · Profile ── */}
      <header className="sticky top-0 z-40 flex h-[56px] items-center gap-3 border-b border-border bg-card px-4 shadow-sm md:px-6">
        {/* Mobile hamburger (< md) */}
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation menu"
          className="-ml-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
        >
          <Menu className="size-[18px]" aria-hidden />
        </button>

        {/* Logo */}
        <Link href={ROUTES.ADMIN_DASHBOARD} className="flex shrink-0 items-center gap-2.5">
          <div className="flex size-7 items-center justify-center rounded-[7px] text-primary-foreground shadow-sm" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden>
            <span className="text-[9px] font-extrabold tracking-[0.1em]">RD</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[14px] font-bold tracking-tight text-foreground">RegisterDesk</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary" aria-label="Admin console">
              <ShieldCheck className="size-3" aria-hidden />
              Admin
            </span>
          </div>
        </Link>

        {/* Right cluster */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          {/* Global search / command palette (⌘K) */}
          <CommandPaletteRoot />

          {/* Notifications → platform incidents & alerts (existing surface) */}
          <Link
            href={ROUTES.ADMIN_INCIDENTS}
            aria-label="Incidents & alerts"
            title="Incidents & alerts"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Bell className="size-[18px]" aria-hidden />
          </Link>

          <QuickActionsMenu />
          <ProfileMenu displayName={displayName} email={email} initial={initial} onSignOut={handleSignOut} />
        </div>
      </header>

      {/* ── Shell: permanent sidebar + content ── */}
      <div className="flex">
        <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
        <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
        <main className="min-w-0 flex-1 px-4 py-6 md:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            {children}
          </div>
        </main>
      </div>

    </div>
    </ConfirmProvider>
    </ToastProvider>
  )
}
