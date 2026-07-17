'use client'

import { useEffect, useRef, useState }    from 'react'
import Link                               from 'next/link'
import { usePathname }                    from 'next/navigation'
import { AnimatePresence, motion }        from 'framer-motion'
import { onAuthStateChanged, signOut }    from 'firebase/auth'
import type { User as FirebaseUser }      from 'firebase/auth'
import { auth }                           from '@/lib/firebase/auth'
import {
  ROUTES,
  ADMIN_PRIMARY_NAV,
  ADMIN_MORE_NAV,
}                                          from '@/config/navigation'
import type { AdminNavItem }               from '@/config/navigation'
import { cn }                              from '@/lib/utils/cn'
import { ToastProvider }                   from '@/components/ui/Toast'
import { ConfirmProvider }                 from '@/components/ui/ConfirmDialog'
import { CommandPaletteRoot }              from '@/components/admin/commandPalette'
import {
  ChevronDown, LayoutDashboard, LogOut, Menu, ShieldAlert, ShieldCheck, X,
} from 'lucide-react'

// ─── Auth state ───────────────────────────────────────────────────────────────

type AdminState = 'loading' | 'authorized' | 'denied'

// ─── Active-path helper ────────────────────────────────────────────────────────

function isActive(pathname: string, item: AdminNavItem): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href)
}

// ─── Dropdown behaviour (click-outside + Escape) ───────────────────────────────
// Mirrors the organizer dashboard header so both shells share one interaction model.

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

// ─── Loading screen ───────────────────────────────────────────────────────────

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

// ─── Access denied screen ─────────────────────────────────────────────────────

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

// ─── Primary nav link (top bar) ─────────────────────────────────────────────────

function AdminNavLink({ item }: { item: AdminNavItem }) {
  const pathname = usePathname()
  const active   = isActive(pathname, item)
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-md px-3 py-1.5 text-[13.5px] font-medium transition-colors',
        active
          ? 'bg-primary/[0.08] text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {item.label}
    </Link>
  )
}

// ─── More ▼ menu (grouped, metadata-driven) ─────────────────────────────────────

function MoreMenu() {
  const pathname = usePathname()
  const { open, setOpen, containerRef } = useDropdown()

  // Highlight the trigger when any secondary destination is active.
  const anyActive = ADMIN_MORE_NAV.some(g => g.items.some(i => isActive(pathname, i)))

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'flex items-center gap-1 rounded-md px-3 py-1.5 text-[13.5px] font-medium transition-colors',
          anyActive || open
            ? 'bg-primary/[0.08] text-primary'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        More
        <ChevronDown
          className={cn('size-3.5 transition-transform duration-150', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            {...dropdownMotion}
            role="menu"
            aria-label="More admin sections"
            className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-border bg-card p-1.5 shadow-lg"
          >
            {ADMIN_MORE_NAV.map((group, gi) => (
              <div key={group.label} className={cn(gi > 0 && 'mt-1 border-t border-border pt-1')}>
                <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  {group.label}
                </p>
                {group.items.map(item => {
                  const active = isActive(pathname, item)
                  const Icon   = item.icon
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      role="menuitem"
                      onClick={() => setOpen(false)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium transition-colors',
                        active
                          ? 'bg-primary/[0.08] text-primary'
                          : 'text-foreground hover:bg-muted',
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      {item.label}
                    </Link>
                  )
                })}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Mobile drawer (< md) ────────────────────────────────────────────────────────

function MobileDrawer({
  open, onClose, onSignOut,
}: {
  open:      boolean
  onClose:   () => void
  onSignOut: () => void
}) {
  const pathname = usePathname()

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const renderItem = (item: AdminNavItem) => {
    const active = isActive(pathname, item)
    const Icon   = item.icon
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onClose}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] font-medium transition-colors',
          active
            ? 'bg-primary/[0.08] text-primary'
            : 'text-foreground hover:bg-muted',
        )}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {item.label}
      </Link>
    )
  }

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-foreground/30 backdrop-blur-[1px]"
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ duration: 0.2, ease: EASE }}
            role="dialog"
            aria-label="Admin navigation"
            className="absolute inset-y-0 left-0 flex w-[80%] max-w-[300px] flex-col border-r border-border bg-card shadow-xl"
          >
            {/* Drawer header */}
            <div className="flex h-[56px] shrink-0 items-center justify-between border-b border-border px-4">
              <div className="flex items-center gap-2">
                <div
                  className="flex size-7 items-center justify-center rounded-[7px] text-primary-foreground shadow-sm"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                  aria-hidden
                >
                  <span className="text-[9px] font-extrabold tracking-[0.1em]">RD</span>
                </div>
                <span className="text-[14px] font-bold tracking-tight text-foreground">Admin</span>
              </div>
              <button
                onClick={onClose}
                aria-label="Close navigation menu"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-[18px]" aria-hidden />
              </button>
            </div>

            {/* Scrollable nav */}
            <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Admin navigation">
              <div className="flex flex-col gap-0.5">
                {ADMIN_PRIMARY_NAV.map(renderItem)}
              </div>
              {ADMIN_MORE_NAV.map(group => (
                <div key={group.label} className="mt-3">
                  <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    {group.label}
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {group.items.map(renderItem)}
                  </div>
                </div>
              ))}
            </nav>

            {/* Drawer footer */}
            <div className="shrink-0 border-t border-border p-2">
              <Link
                href={ROUTES.DASHBOARD}
                onClick={onClose}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] font-medium text-foreground transition-colors hover:bg-muted"
              >
                <LayoutDashboard className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                Organizer Dashboard
              </Link>
              <button
                type="button"
                onClick={() => { onClose(); onSignOut() }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] font-medium text-destructive transition-colors hover:bg-destructive/[0.07]"
              >
                <LogOut className="size-4 shrink-0" aria-hidden />
                Sign Out
              </button>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  )
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [adminState, setAdminState] = useState<AdminState>('loading')
  const [user,       setUser]       = useState<FirebaseUser | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    return onAuthStateChanged(auth, async u => {
      // Not authenticated at all — send to the Platform Admin login
      if (!u) { window.location.replace(ROUTES.ADMIN_LOGIN); return }

      try {
        const token = await u.getIdToken()
        const res   = await fetch('/api/admin/auth-check', {
          headers: { authorization: `Bearer ${token}` },
          cache:   'no-store',
        })
        if (!res.ok) {
          // Authenticated but not an admin
          setAdminState('denied')
          return
        }
        setUser(u)
        setAdminState('authorized')
      } catch {
        setAdminState('denied')
      }
    })
  }, [])

  if (adminState === 'loading')    return <LoadingScreen />
  if (adminState === 'denied')     return <AccessDenied />

  const displayName = user?.displayName ?? user?.email?.split('@')[0] ?? 'Admin'
  const initial     = (displayName[0] ?? 'A').toUpperCase()

  async function handleSignOut() {
    await signOut(auth).catch(() => null)
    window.location.replace(ROUTES.ADMIN_LOGIN)
  }

  return (
    <ToastProvider>
    <ConfirmProvider>
    <div className="min-h-screen bg-background">

      {/* ── Admin top bar ── */}
      <header className="sticky top-0 z-40 flex h-[56px] items-center gap-3 border-b border-border bg-card px-4 shadow-sm md:px-6">

        {/* Mobile hamburger (< md) */}
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation menu"
          className="-ml-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
        >
          <Menu className="size-[18px]" aria-hidden />
        </button>

        {/* Brand */}
        <div className="flex shrink-0 items-center gap-2.5">
          <div
            className="flex size-7 items-center justify-center rounded-[7px] text-primary-foreground shadow-sm"
            style={{ backgroundImage: 'var(--primary-gradient)' }}
            aria-hidden
          >
            <span className="text-[9px] font-extrabold tracking-[0.1em]">RD</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[14px] font-bold tracking-tight text-foreground">RegisterDesk</span>
            <span
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary"
              aria-label="Admin console"
            >
              <ShieldCheck className="size-3" aria-hidden />
              Admin
            </span>
          </div>
        </div>

        {/* Primary nav — compact, always fits (5 links + More) */}
        <nav className="ml-4 hidden items-center gap-0.5 md:flex lg:ml-6" aria-label="Admin navigation">
          {ADMIN_PRIMARY_NAV.map(item => (
            <AdminNavLink key={item.href} item={item} />
          ))}
          <MoreMenu />
        </nav>

        {/* Right cluster — single baseline */}
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
          {/* Global search / command palette (⌘K) */}
          <CommandPaletteRoot />

          {/* Back to organizer dashboard */}
          <Link
            href={ROUTES.DASHBOARD}
            className="hidden items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:flex"
          >
            <LayoutDashboard className="size-3.5" aria-hidden />
            Organizer
          </Link>

          {/* User chip */}
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5">
            <div
              className="flex size-6 items-center justify-center rounded-full text-[10px] font-bold text-primary-foreground"
              style={{ backgroundImage: 'var(--primary-gradient)' }}
              aria-hidden
            >
              {initial}
            </div>
            <span className="hidden max-w-[140px] truncate text-[13px] font-medium text-foreground sm:block">
              {displayName}
            </span>
          </div>

          <button
            onClick={handleSignOut}
            aria-label="Sign out"
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <LogOut className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </header>

      {/* ── Mobile drawer ── */}
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSignOut={handleSignOut}
      />

      {/* ── Main content ── */}
      <main className="mx-auto max-w-7xl px-4 py-6 md:px-6 lg:px-8">
        {children}
      </main>

    </div>
    </ConfirmProvider>
    </ToastProvider>
  )
}
