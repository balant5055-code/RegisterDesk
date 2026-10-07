'use client'

// RD-ORG-FOUNDATION · Organizer shell.
//
// This file is a COMPOSITION ROOT and nothing else. It previously carried ~490 lines
// including the whole top bar, a private dropdown hook and a bespoke breadcrumb
// builder; each of those is now a named module with its own tests-in-waiting:
//
//   components/dashboard/DashboardHeader        top bar
//   components/dashboard/EventSelector          context control
//   components/dashboard/Breadcrumbs            location trail
//   lib/navigation/breadcrumbs                  trail resolution (pure)
//   lib/hooks/useDropdown                       popover dismissal
//
// ═══ PROVIDER ORDER MATTERS ══════════════════════════════════════════════════
// EventContextProvider sits INSIDE BusinessConfigProvider and OUTSIDE the header and
// the page. The header's event selector and every page's event-scoped fetch read the
// same context instance, which is what makes "one selected event" true rather than
// merely intended.
//
// It sits inside the auth gate too: it calls /api/organizer/events, which requires a
// verified token. Mounting it above the gate would fire that request for signed-out
// visitors on every organizer URL.

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import { resolveAuthGuard } from '@/lib/auth/authGuard'
import { Sidebar } from '@/components/dashboard/Sidebar'
import { DashboardHeader } from '@/components/dashboard/DashboardHeader'
import { SessionGuard } from '@/components/auth/SessionGuard'
import { CheckinStaffGuard } from '@/components/dashboard/CheckinStaffGuard'
import { ToastProvider } from '@/components/ui/Toast'
import { ConfirmProvider } from '@/components/ui/ConfirmDialog'
import { BusinessConfigProvider } from '@/lib/config/BusinessConfigProvider'
import { EventContextProvider } from '@/components/dashboard/EventContextProvider'
import { CommandPalette } from '@/components/dashboard/CommandPalette'

function AuthLoadingScreen() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="size-7 animate-spin rounded-pill border-2 border-border border-t-primary" />
        <p className="text-fs-sm text-muted-foreground">Loading your workspace…</p>
      </div>
    </div>
  )
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // RD-AUTH-01 Phase 1 (M-A): identity comes from the ONE shared AuthProvider
  // (undefined = resolving, null = signed out, User = signed in). Unchanged.
  const { user } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // RD-AUTH-01 Phase 4 (H-C): the ONE canonical client navigation decision, shared
  // with /welcome. It decides nothing until auth resolves. Unchanged — this is the
  // organizer route guard and is explicitly out of scope for the foundation work.
  const guard = resolveAuthGuard(user)
  useEffect(() => {
    if (guard.redirect) window.location.replace(guard.redirect)
  }, [guard.redirect])

  const displayName   = user?.displayName ?? user?.email?.split('@')[0] ?? 'Organizer'
  const email         = user?.email ?? ''
  const initial       = (displayName[0] ?? 'O').toUpperCase()
  const emailVerified = user?.emailVerified ?? false

  if (guard.status !== 'authorized') return <AuthLoadingScreen />

  return (
    <ToastProvider>
      <ConfirmProvider>
        <BusinessConfigProvider>
          <EventContextProvider>
            {/* RD-EVENT-19 — skip link, FIRST in DOM order so it is the first tab stop.
                Measured: a keyboard user previously traversed 12 sidebar stops before
                reaching page content, on every navigation. */}
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-control focus:bg-background focus:px-4 focus:py-2 focus:text-fs-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary"
            >
              Skip to main content
            </a>

            {/* h-dvh (dynamic viewport), not h-screen: on mobile the bottom of an
                internally-scrolling shell — including the sticky wizard footer — is
                otherwise pushed under the browser's address bar. */}
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
                  className="flex-1 overflow-y-auto focus:outline-none"
                >
                  {/* ONE page gutter, defined here rather than by each page — pages that
                      set their own padding were the reason two dashboard screens could
                      sit at different insets. */}
                  <div className="mx-auto w-full max-w-[1600px] px-4 py-5 md:px-6 md:py-6">
                    {children}
                  </div>
                </main>

                {/* Wizard footer portals here — outside the padded container so it can
                    span the full workspace width. */}
                <div id="wizard-footer-portal" />
              </div>

              {/* Idle/warn timeouts come from the live security config, so this sits
                  inside BusinessConfigProvider. */}
              <SessionGuard enabled={user != null} />

              {/* Routes a gate-only operator to their own console. A routing hint, not
                  a control — the organizer APIs already refuse them. */}
              <CheckinStaffGuard />

              <CommandPalette />
            </div>
          </EventContextProvider>
        </BusinessConfigProvider>
      </ConfirmProvider>
    </ToastProvider>
  )
}
