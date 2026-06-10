'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bell,
  ChevronDown,
  ChevronRight,
  LogOut,
  Menu,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  User,
} from 'lucide-react'
import type { User as FirebaseUser } from 'firebase/auth'
import { onAuthStateChanged, onIdTokenChanged, signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { Sidebar } from '@/components/dashboard/Sidebar'
import { SessionWarningModal } from '@/components/auth/SessionWarningModal'
import { useSessionManager } from '@/lib/session/useSessionManager'
import { useTheme } from '@/lib/hooks/useTheme'
import { VerifiedBadge } from '@/components/auth/VerifiedBadge'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'
import { ToastProvider } from '@/components/ui/Toast'

// ─── Types ────────────────────────────────────────────────────────────────────

type NotifPriority = 'critical' | 'warning' | 'success' | 'info'

interface Notification {
  id:       string
  priority: NotifPriority
  message:  string
  time:     string
  read:     boolean
}

// ─── Static data ──────────────────────────────────────────────────────────────

const INITIAL_NOTIFICATIONS: Notification[] = [
  { id: '1', priority: 'critical', message: 'DevConf 2026 is 80% full — only 80 seats remaining.', time: '2m ago',  read: false },
  { id: '2', priority: 'success',  message: '47 check-ins completed for UX Workshop 2026.',         time: '30m ago', read: false },
  { id: '3', priority: 'warning',  message: '3 pending registrations have incomplete profiles.',     time: '1h ago',  read: true  },
  { id: '4', priority: 'warning',  message: 'AI & ML Summit registration closes in 48 hours.',      time: '2h ago',  read: true  },
]

const NOTIF_DOT: Record<NotifPriority, string> = {
  critical: 'bg-destructive',
  warning:  'bg-amber-400',
  success:  'bg-emerald-500',
  info:     'bg-primary',
}

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
}

interface Crumb { label: string; href: string }

function buildBreadcrumbs(pathname: string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean)
  const crumbs: Crumb[] = []

  for (let i = 0; i < segments.length; i++) {
    const seg  = segments[i]
    const href = '/' + segments.slice(0, i + 1).join('/')
    const isId = seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg)
    const label = isId
      ? 'Manage Event'
      : (SEG_LABELS[seg] ?? seg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
    crumbs.push({ label, href })
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
            ) : (
              <Link
                href={crumb.href}
                className="text-[14px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {crumb.label}
              </Link>
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

// ─── NotificationMenu ─────────────────────────────────────────────────────────

function NotificationMenu() {
  const { open, setOpen, containerRef } = useDropdown()
  const [notifications, setNotifications] = useState<Notification[]>(INITIAL_NOTIFICATIONS)
  const unreadCount = notifications.filter(n => !n.read).length

  const markAllRead = () =>
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={`Notifications — ${unreadCount} unread`}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="relative rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Bell className="size-[18px]" aria-hidden />
        {unreadCount > 0 && (
          <span
            aria-hidden
            className="absolute right-1 top-1 flex size-[14px] items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground"
          >
            {unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            {...dropdownMotion}
            role="dialog"
            aria-label="Notifications panel"
            className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-[14px] font-semibold text-foreground">Notifications</p>
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className="text-[12px] font-medium text-primary hover:underline underline-offset-4"
                >
                  Mark all read
                </button>
              )}
            </div>

            <ul
              aria-label="Notification list"
              className="max-h-72 divide-y divide-border overflow-y-auto"
            >
              {notifications.map(n => (
                <li
                  key={n.id}
                  className={cn(
                    'flex gap-3 px-4 py-3 transition-colors hover:bg-muted/40',
                    !n.read && 'bg-primary/[0.025]',
                  )}
                >
                  <span
                    className={cn('mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full', NOTIF_DOT[n.priority])}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'text-[13px] leading-snug',
                        !n.read ? 'font-medium text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {n.message}
                    </p>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">{n.time}</p>
                  </div>
                  {!n.read && (
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />
                  )}
                </li>
              ))}
            </ul>

            <div className="border-t border-border px-4 py-2.5">
              <Link
                href={ROUTES.DASHBOARD}
                onClick={() => setOpen(false)}
                className="text-[13px] font-medium text-primary hover:underline underline-offset-4"
              >
                View all notifications
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── ProfileMenu ──────────────────────────────────────────────────────────────

const PROFILE_MENU = [
  { label: 'My Profile', icon: User,     href: ROUTES.DASHBOARD_SETTINGS },
  { label: 'Settings',   icon: Settings, href: ROUTES.DASHBOARD_SETTINGS },
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
        className="flex items-center gap-1 rounded-md p-0.5 transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div
          className="flex size-[30px] items-center justify-center rounded-full text-[11px] font-bold text-primary-foreground"
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
                  <p className="truncate text-[12px] text-muted-foreground">{email}</p>
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
      className="flex h-[58px] shrink-0 items-center gap-3 border-b border-border bg-card px-4 md:px-5"
    >
      {/* Mobile hamburger (< md) */}
      <button
        onClick={onMenuClick}
        aria-label="Open navigation menu"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
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

      <div className="flex-1" />

      {/* Quick Create (desktop) */}
      <Link
        href={ROUTES.NEW_EVENT}
        className={cn(
          'hidden items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 md:flex',
        )}
        style={{ backgroundImage: 'var(--primary-gradient)' }}
        aria-label="Create new event"
      >
        <Plus className="size-3.5" aria-hidden />
        <span>Create Event</span>
      </Link>

      {/* Search */}
      <div className="relative hidden sm:block">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          placeholder="Search…"
          aria-label="Search events and attendees"
          className={cn(
            'h-8 w-44 rounded-lg border border-border bg-muted pl-8 pr-3 text-[14px] text-foreground',
            'placeholder:text-muted-foreground',
            'transition-all duration-150',
            'focus:w-52 focus:border-primary/40 focus:bg-card focus:outline-none focus:ring-2 focus:ring-primary/25',
          )}
        />
      </div>

      <NotificationMenu />

      <button
        onClick={toggle}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {isDark
          ? <Sun  className="size-[18px]" aria-hidden />
          : <Moon className="size-[18px]" aria-hidden />
        }
      </button>

      <ProfileMenu displayName={displayName} email={email} initial={initial} emailVerified={emailVerified} />
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
  // undefined = still resolving, null = not signed in, User = signed in
  const [user,        setUser]        = useState<FirebaseUser | null | undefined>(undefined)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // ── Auth state & token refresh ─────────────────────────────────────────────
  useEffect(() => {
    // onAuthStateChanged fires immediately with the cached state — no round-trip.
    const unsubAuth = onAuthStateChanged(auth, (u) => {
      // Not signed in → hard redirect (replaces history, clears React state)
      if (!u) {
        window.location.replace(ROUTES.LOGIN)
        return
      }
      // Signed in but email not verified → send to OTP page
      // emailVerified is set to true by adminAuth.updateUser after OTP success,
      // and the client cache is refreshed by auth.currentUser.reload() on that page.
      if (!u.emailVerified) {
        window.location.replace(ROUTES.VERIFY_EMAIL)
        return
      }
      setUser(u)
    })

    // onIdTokenChanged fires whenever Firebase silently refreshes the ID token
    // (~every 1 hour). The token itself is managed by child components via
    // auth.currentUser.getIdToken(); this subscription exists to detect
    // auth-state invalidation between normal onAuthStateChanged events.
    const unsubToken = onIdTokenChanged(auth, (u) => {
      if (!u) window.location.replace(ROUTES.LOGIN)
    })

    return () => {
      unsubAuth()
      unsubToken()
    }
  }, [])

  // ── Session manager (idle timeout + multi-tab sync) ─────────────────────────
  const { showWarning, countdown, onStaySignedIn, onLogout } = useSessionManager(
    user != null && user !== undefined,
  )

  // ── Derived user display data ──────────────────────────────────────────────
  const displayName   = user?.displayName ?? user?.email?.split('@')[0] ?? 'Organizer'
  const email         = user?.email ?? ''
  const initial       = (displayName[0] ?? 'O').toUpperCase()
  const emailVerified = user?.emailVerified ?? false

  // ── Loading & redirect states ──────────────────────────────────────────────
  if (user === undefined)        return <AuthLoadingScreen />  // auth resolving
  if (user === null)             return <AuthLoadingScreen />  // redirect to login in flight
  if (!user.emailVerified)       return <AuthLoadingScreen />  // redirect to verify-email in flight

  return (
    <ToastProvider>
    <div className="flex h-screen overflow-hidden bg-background">
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
          className="flex-1 overflow-y-auto px-4 py-5 md:px-5 lg:px-6 lg:py-6"
        >
          {children}
        </main>
      </div>

      {/* Session expiry warning — rendered at layout level so it overlays everything */}
      <SessionWarningModal
        open={showWarning}
        countdown={countdown}
        onStaySignedIn={onStaySignedIn}
        onLogout={onLogout}
      />
    </div>
    </ToastProvider>
  )
}
