'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronDown,
  ChevronRight,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
} from 'lucide-react'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { useAuth } from '@/components/auth/AuthProvider'
import { resolveAuthGuard } from '@/lib/auth/authGuard'
import { Sidebar } from '@/components/dashboard/Sidebar'
import { WorkspaceBanner } from '@/components/dashboard/WorkspaceBanner'
import { SessionGuard } from '@/components/auth/SessionGuard'
import { CheckinStaffGuard } from '@/components/dashboard/CheckinStaffGuard'
import { useTheme } from '@/lib/hooks/useTheme'
import { VerifiedBadge } from '@/components/auth/VerifiedBadge'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'
import { ToastProvider } from '@/components/ui/Toast'
import { ConfirmProvider } from '@/components/ui/ConfirmDialog'
import { BusinessConfigProvider } from '@/lib/config/BusinessConfigProvider'
import { CommandPalette } from '@/components/dashboard/CommandPalette'
import { openCommandPalette } from '@/lib/commandPalette/bridge'
import { NotificationBell } from '@/components/dashboard/NotificationBell'

// ─── Breadcrumb helpers ───────────────────────────────────────────────────────

const SEG_LABELS: Record<string, string> = {
  dashboard:        'Dashboard',
  events:           'Events',
  new:              'Create Event',
  visibility:       'Visibility',
  'check-in':       'Check-In',
  checkin:          'Live Check-In',
  reports:          'Analytics',
  attendees:        'Attendees',
  registrations:    'Registrations',
  communications:   'Communications',
  certificates:     'Certificates',
  settings:         'Settings',
  finance:          'Finance',
}

interface Crumb { label: string; href: string; navigable: boolean }

// GA-7D S2: container segments that have NO index route — clicking them 404'd.
//   • 'builder' is always a container (the real page is builder/[templateId]).
//   • 'certificates' / 'licenses' have an index route only at the top level, so they
//     are non-navigable when nested (event-scoped certificates, billing-scoped
//     licenses). These render as plain text instead of dead links.
const NON_INDEX_SEGMENTS = new Set(['builder'])
const DEPTH1_ONLY_SEGMENTS = new Set(['certificates', 'licenses'])

// GA-7D S2: an ID crumb's label derives from its PARENT segment (a CRM contact was
// mislabelled "Manage Event"). Depth is 1-based here (dashboard = depth 1).
const ID_LABEL_BY_PARENT: Record<string, string> = {
  events:    'Manage Event',
  crm:       'Contact',
  campaigns: 'Campaign',
  licenses:  'License',
}

function buildBreadcrumbs(pathname: string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean)
  const crumbs: Crumb[] = []

  for (let i = 0; i < segments.length; i++) {
    const seg   = segments[i]
    const depth = i + 1
    const href  = '/' + segments.slice(0, i + 1).join('/')
    const isId  = seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg)
    const label = isId
      ? (ID_LABEL_BY_PARENT[segments[i - 1] ?? ''] ?? 'Details')
      : (SEG_LABELS[seg] ?? seg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
    const navigable = !NON_INDEX_SEGMENTS.has(seg)
      && !(DEPTH1_ONLY_SEGMENTS.has(seg) && depth > 1)
    crumbs.push({ label, href, navigable })
  }

  return crumbs
}

function Breadcrumbs() {
  const pathname = usePathname()
  const crumbs   = buildBreadcrumbs(pathname)

  if (crumbs.length <= 1) {
    return (
      <span className="text-[14px] font-semibold text-foreground">
        {crumbs[0]?.label ?? 'Dashboard'}
      </span>
    )
  }

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1
        return (
          <span key={crumb.href} className="flex items-center gap-1">
            {i > 0 && (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" aria-hidden />
            )}
            {isLast ? (
              <span className="text-[14px] font-semibold text-foreground">{crumb.label}</span>
            ) : crumb.navigable ? (
              <Link
                href={crumb.href}
                className="text-[14px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {crumb.label}
              </Link>
            ) : (
              // Non-navigable container segment — plain text, never a dead link.
              <span className="text-[14px] text-muted-foreground">{crumb.label}</span>
            )}
          </span>
        )
      })}
    </nav>
  )
}

// ─── Animation ────────────────────────────────────────────────────────────────

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

// ─── useDropdown ─────────────────────────────────────────────────────────────

function useDropdown() {
  const [open, setOpen] = useState(false)
  const containerRef    = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return { open, setOpen, containerRef }
}

// ─── ProfileMenu ──────────────────────────────────────────────────────────────

// RD-UX-01: "My Profile" was removed — it and "Settings" both resolved to
// /dashboard/settings (no separate personal-account route exists), so two menu
// items opened the identical page. Account/profile controls live inside Settings.
const PROFILE_MENU = [
  { label: 'Settings', icon: Settings, href: ROUTES.DASHBOARD_SETTINGS },
] as const

interface ProfileMenuProps {
  displayName:   string
  email:         string
  initial:       string
  emailVerified: boolean
}

function ProfileMenu({ displayName, email, initial, emailVerified }: ProfileMenuProps) {
  const { open, setOpen, containerRef } = useDropdown()

  function handleSignOut() {
    setOpen(false)
    // Clear the in-progress draft reference so a subsequent login starts fresh
    localStorage.removeItem('rd_event_draft_id')
    signOut(auth).catch(() => null)
    // Hard navigation: replaces this entry in the browser history so Back
    // cannot return to an authenticated page after logout
    window.location.replace(ROUTES.LOGIN)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Open profile menu"
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1 rounded-md transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div
          className="flex size-8 items-center justify-center rounded-full text-[12px] font-bold text-primary-foreground"
          style={{ backgroundImage: 'var(--primary-gradient)' }}
          aria-hidden
        >
          {initial}
        </div>
        <ChevronDown
          className={cn('size-3 text-muted-foreground transition-transform duration-150', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            {...dropdownMotion}
            role="menu"
            aria-label="Profile options"
            className="absolute right-0 top-full z-50 mt-2 w-52 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
          >
            <div className="border-b border-border px-4 py-3.5">
              <div className="flex items-center gap-3">
                <div
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-primary-foreground"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                  aria-hidden
                >
                  {initial}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-[14px] font-semibold text-foreground">{displayName}</p>
                    <VerifiedBadge verified={emailVerified} />
                  </div>
                  <p className="truncate text-[13px] text-muted-foreground">{email}</p>
                </div>
              </div>
            </div>

            <div role="group" className="py-1">
              {PROFILE_MENU.map(({ label, icon: Icon, href }) => (
                <Link
                  key={label}
                  href={href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 px-4 py-2 text-[14px] text-foreground transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {label}
                </Link>
              ))}
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
    </div>
  )
}

// ─── DashboardHeader ──────────────────────────────────────────────────────────

interface DashboardHeaderProps {
  onMenuClick:   () => void
  displayName:   string
  email:         string
  initial:       string
  emailVerified: boolean
}

function DashboardHeader({ onMenuClick, displayName, email, initial, emailVerified }: DashboardHeaderProps) {
  const { isDark, toggle } = useTheme()

  return (
    <header
      role="banner"
      /* RD-UX-01: h-16 matches the sidebar's logo header (Sidebar.tsx h-[64px]) so
         the top bar and sidebar share one continuous bottom border — previously the
         h-[58px] top bar sat 6px above the sidebar header edge. */
      className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-card px-4 md:px-5"
    >
      {/* Mobile hamburger (< md) */}
      <button
        onClick={onMenuClick}
        aria-label="Open navigation menu"
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
      >
        <Menu className="size-[18px]" aria-hidden />
      </button>

      {/* Mobile wordmark */}
      <span className="text-[14px] font-semibold text-foreground md:hidden" aria-hidden>
        Register<span className="text-muted-foreground">Desk</span>
      </span>

      {/* Desktop breadcrumbs */}
      <div className="hidden md:flex">
        <Breadcrumbs />
      </div>

      {/* Workspace context (owner vs team member) */}
      <WorkspaceBanner />

      <div className="flex-1" />

      {/* RD-UX-01: right action group — one flex cluster so search, notifications,
          theme and avatar share a consistent gap and a uniform 32px (h-8) height,
          vertically centred. The duplicate "Create Event" button that used to sit
          here was removed (the dashboard hero CTA and the sidebar nav item remain). */}
      <div className="flex items-center gap-1.5 sm:gap-2">
        {/* Global search entry point (Phase H.4.2 — opens the Global Command
            Palette). Scope: events, participants, registrations, CRM, certificates,
            settlements, broadcasts, donations, identifiers. Also reachable via
            Ctrl/⌘+K anywhere in the workspace. */}
        <button
          type="button"
          onClick={openCommandPalette}
          aria-label="Open command palette — search events, participants, registrations, CRM, certificates, settlements, broadcasts, donations, identifiers"
          aria-keyshortcuts="Control+K Meta+K"
          className={cn(
            'relative hidden h-8 w-44 items-center rounded-lg border border-border bg-muted pl-8 pr-10 text-left text-[14px] text-muted-foreground sm:flex',
            'transition-colors duration-150 hover:border-primary/40 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25',
          )}
        >
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <span>Search workspace…</span>
          <kbd
            aria-hidden
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            ⌘K
          </kbd>
        </button>

        <NotificationBell />

        <button
          onClick={toggle}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {isDark
            ? <Sun  className="size-[18px]" aria-hidden />
            : <Moon className="size-[18px]" aria-hidden />
          }
        </button>

        <ProfileMenu displayName={displayName} email={email} initial={initial} emailVerified={emailVerified} />
      </div>
    </header>
  )
}

// ─── Auth loading screen ──────────────────────────────────────────────────────

function AuthLoadingScreen() {
  return (
    <div
      className="flex h-screen items-center justify-center bg-background"
      aria-label="Loading…"
      aria-busy="true"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
        <p className="text-[14px] text-muted-foreground">Loading…</p>
      </div>
    </div>
  )
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // RD-AUTH-01 Phase 1 (M-A): the user comes from the ONE shared AuthProvider
  // (undefined = resolving, null = signed out, User = signed in) — no layout-local
  // Firebase listener. The provider owns the single onAuthStateChanged/onIdTokenChanged.
  const { user } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // ── Route guard (RD-AUTH-01 Phase 4 / H-C) ──────────────────────────────────
  // Navigation is decided by the ONE canonical resolver (shared with /welcome):
  // signed out → login; verified-required → OTP page. It never redirects before auth
  // has resolved. (emailVerified is flipped by adminAuth.updateUser after OTP; the
  // client cache is refreshed by auth.currentUser.reload() on that page.)
  const guard = resolveAuthGuard(user)
  useEffect(() => {
    if (guard.redirect) window.location.replace(guard.redirect)
  }, [guard.redirect])

  // ── Derived user display data ──────────────────────────────────────────────
  const displayName   = user?.displayName ?? user?.email?.split('@')[0] ?? 'Organizer'
  const email         = user?.email ?? ''
  const initial       = (displayName[0] ?? 'O').toUpperCase()
  const emailVerified = user?.emailVerified ?? false

  // ── Loading & redirect states ──────────────────────────────────────────────
  // Any non-authorized status (resolving, or a redirect in flight) shows the loading
  // screen — same behaviour as the previous three explicit returns.
  if (guard.status !== 'authorized') return <AuthLoadingScreen />

  return (
    <ToastProvider>
    <ConfirmProvider>
    <BusinessConfigProvider>
    {/* GA-7D S2: h-dvh (dynamic viewport) instead of h-screen(=100vh) so the bottom
        of the internally-scrolling shell — incl. the sticky wizard footer — isn't
        pushed under the mobile browser's address bar. */}
    {/* RD-EVENT-19 — skip link. Measured: a keyboard user landing on any dashboard page
        traversed 12 sidebar stops before reaching page content, on every navigation. Placed
        FIRST in DOM order so it is the first tab stop; visually hidden until focused, so
        nothing changes for pointer users. Fixed here rather than in the wizard because the
        sidebar precedes content on every dashboard route. */}
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary"
    >
      Skip to main content
    </a>
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        displayName={displayName}
        email={email}
        initial={initial}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader
          onMenuClick={() => setSidebarOpen(true)}
          displayName={displayName}
          email={email}
          initial={initial}
          emailVerified={emailVerified}
        />
        <main
          id="main-content"
          role="main"
          tabIndex={-1}
          className="flex-1 overflow-y-auto px-4 py-5 md:px-5 lg:px-6 lg:py-6 focus:outline-none"
        >
          {children}
        </main>
        {/* Wizard footer renders here via createPortal — outside padded main, full workspace width */}
        <div id="wizard-footer-portal" />
      </div>

      {/* Session expiry warning — inside the provider so the idle/warn timeouts
          come from the live security config. Overlays everything at layout level. */}
      <SessionGuard enabled={user != null} />

      {/* RD-CHECKIN-STAFF-01 — routes a gate-only operator to their own console.
          A routing hint, not a control: the organizer APIs already refuse them. */}
      <CheckinStaffGuard />

      {/* Global Command Palette (Ctrl/⌘+K) — pure orchestration over existing routes/actions */}
      <CommandPalette />
    </div>
    </BusinessConfigProvider>
    </ConfirmProvider>
    </ToastProvider>
  )
}
