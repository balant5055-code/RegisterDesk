'use client'

// RD-ORG-FOUNDATION · Organizer top bar.
//
// Extracted from app/(dashboard)/layout.tsx, which had ~230 lines of header markup
// inline. The layout is now a composition root; this owns the top bar.
//
// ═══ THE LAYOUT DECISION ═════════════════════════════════════════════════════
// Two rows, not one:
//
//   row 1 — identity + context:  [☰] RegisterDesk · [ Event Selector ] … 🔔 👤
//   row 2 — location:            Breadcrumb trail
//
// A single row was tried and rejected: the event selector and the breadcrumb both
// answer "where am I?", and interleaving them on one line meant that on a laptop the
// breadcrumb truncated to nothing exactly when the event name was longest. Splitting
// them gives the selector a stable width and lets the trail use the full width.
//
// Row 2 collapses on mobile, where the page header states the location instead.

import Link from 'next/link'
import { AnimatePresence, motion } from 'framer-motion'
import { signOut } from 'firebase/auth'
import { ChevronDown, LogOut, Menu, Moon, Search, Settings, Sun } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { ROUTES } from '@/config/navigation'
import { useTheme } from '@/lib/hooks/useTheme'
import { useDropdown } from '@/lib/hooks/useDropdown'
import { clearWorkspaceCache } from '@/lib/hooks/useWorkspacePermissions'
import { VerifiedBadge } from '@/components/auth/VerifiedBadge'
import { NotificationBell } from '@/components/dashboard/NotificationBell'
import { EventSelector } from '@/components/dashboard/EventSelector'
import { SelectedEventIdentity } from '@/components/dashboard/SelectedEventIdentity'
import { Breadcrumbs } from '@/components/dashboard/Breadcrumbs'
import { WorkspaceBanner } from '@/components/dashboard/WorkspaceBanner'
import { openCommandPalette } from '@/lib/commandPalette/bridge'

const EASE = [0.22, 1, 0.36, 1] as const

const menuMotion = {
  initial:    { opacity: 0, y: -4, scale: 0.98 },
  animate:    { opacity: 1, y: 0,  scale: 1    },
  exit:       { opacity: 0, y: -4, scale: 0.98 },
  transition: { duration: 0.13, ease: EASE },
} as const

// RD-UX-01 (preserved): "My Profile" and "Settings" both resolved to
// /dashboard/settings, so only one entry exists. Account controls live in Settings.
const PROFILE_MENU = [
  { label: 'Workspace Settings', icon: Settings, href: ROUTES.DASHBOARD_SETTINGS },
] as const

// ─── Icon button ──────────────────────────────────────────────────────────────
// One treatment for every square control in the bar, so the theme toggle, the
// hamburger and the search trigger cannot drift apart.

function IconButton({ label, onClick, children }: {
  label: string; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-control text-muted-foreground',
        'transition-colors hover:bg-muted hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
      )}
    >
      {children}
    </button>
  )
}

// ─── Profile menu ─────────────────────────────────────────────────────────────

function ProfileMenu({ displayName, email, initial, emailVerified }: {
  displayName: string; email: string; initial: string; emailVerified: boolean
}) {
  const { open, setOpen, containerRef } = useDropdown()

  function handleSignOut() {
    setOpen(false)
    // Clear the in-progress wizard draft reference so a later login starts clean.
    try { localStorage.removeItem('rd_event_draft_id') } catch { /* blocked storage */ }
    clearWorkspaceCache()   // never serve this account's role to the next sign-in
    signOut(auth).catch(() => null)
    // Hard replace: Back must not return to an authenticated page after sign-out.
    window.location.replace(ROUTES.LOGIN)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="Open profile menu"
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1 rounded-control transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {/* rounded-pill is correct here — this is an avatar, one of the three places
            the restrained radius system still allows a full round. */}
        <span
          className="flex size-8 items-center justify-center rounded-pill text-fs-xs font-bold text-primary-foreground"
          style={{ backgroundImage: 'var(--primary-gradient)' }}
          aria-hidden
        >
          {initial}
        </span>
        <ChevronDown
          className={cn('size-3 text-muted-foreground transition-transform duration-150', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            {...menuMotion}
            role="menu"
            aria-label="Profile options"
            className="absolute right-0 top-full z-50 mt-1.5 w-60 overflow-hidden rounded-surface border border-border bg-card shadow-lg"
          >
            <div className="border-b border-border px-3.5 py-3">
              <div className="flex items-center gap-2.5">
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-pill text-fs-sm font-bold text-primary-foreground"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                  aria-hidden
                >
                  {initial}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-fs-sm font-semibold text-foreground">{displayName}</p>
                    <VerifiedBadge verified={emailVerified} />
                  </div>
                  <p className="truncate text-fs-xs text-muted-foreground">{email}</p>
                </div>
              </div>
            </div>

            <div role="group" className="p-1">
              {PROFILE_MENU.map(({ label, icon: Icon, href }) => (
                <Link
                  key={label}
                  href={href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-fs-sm text-foreground transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {label}
                </Link>
              ))}
            </div>

            <div className="border-t border-border p-1">
              <button
                type="button"
                role="menuitem"
                onClick={handleSignOut}
                className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-fs-sm text-destructive transition-colors hover:bg-destructive/[0.07] focus-visible:bg-destructive/[0.07] focus-visible:outline-none"
              >
                <LogOut className="size-3.5 shrink-0" aria-hidden />
                Sign out
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Header ───────────────────────────────────────────────────────────────────

export interface DashboardHeaderProps {
  onMenuClick:   () => void
  displayName:   string
  email:         string
  initial:       string
  emailVerified: boolean
}

export function DashboardHeader({
  onMenuClick, displayName, email, initial, emailVerified,
}: DashboardHeaderProps) {
  const { isDark, toggle } = useTheme()

  return (
    <header role="banner" className="shrink-0 border-b border-border bg-card">
      {/* ── Row 1 — identity + context ── */}
      <div className="flex h-14 items-center gap-2 px-3 md:px-4">
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation"
          className="flex size-8 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 md:hidden"
        >
          <Menu className="size-4" aria-hidden />
        </button>

        <EventSelector />

        {/* The selected event's IDENTITY sits beside the control that chose it, so the
            scope is legible from the top bar on every page — not only on the dashboard,
            and not as a second large heading further down. Hidden below lg where the top
            bar has no room; the page header still states the scope there. */}
        <SelectedEventIdentity />

        <div className="flex-1" />

        <IconButton label="Search (⌘K)" onClick={openCommandPalette}>
          <Search className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={isDark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle}>
          {isDark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
        </IconButton>
        <NotificationBell />
        <ProfileMenu
          displayName={displayName}
          email={email}
          initial={initial}
          emailVerified={emailVerified}
        />
      </div>

      {/* ── Row 2 — location + workspace context ──
          Hidden below sm: on a phone the page header already names the location, and
          a second line of chrome costs more than it tells. The workspace chip lives
          here rather than in row 1 because it qualifies WHERE you are, which is what
          this row is for; it renders nothing for owners. */}
      <div className="hidden h-9 items-center gap-3 border-t border-border/60 px-3 sm:flex md:px-4">
        <Breadcrumbs className="min-w-0 flex-1" />
        <WorkspaceBanner />
      </div>
    </header>
  )
}
