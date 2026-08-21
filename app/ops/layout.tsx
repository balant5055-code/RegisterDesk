// RD-CHECKIN-STAFF-01 — the /ops layout.
//
// Deliberately EMPTY of chrome. /ops sits outside the (dashboard) route group, so
// it does not inherit app/(dashboard)/layout.tsx and therefore has no organizer
// sidebar, no breadcrumbs, no command palette, no notification bell and no links
// to Events / Registrations / CRM / Finance / Reports / Settings / Team.
//
// That is a UI property, not a security control — the control is that every route
// this surface calls re-authorizes server-side through authorizeEvent. This layout
// exists so a gate operator is never SHOWN a door they would only be refused at.
//
// The root layout still applies, so Firebase auth (AuthProvider) and the design
// tokens in globals.css are inherited without re-declaring either.

import type { Metadata } from 'next'
import { ToastProvider } from '@/components/ui/Toast'

export const metadata: Metadata = {
  title: 'Check-in',
  // An event-day operator console has nothing to offer a crawler, and the URL
  // carries an event id we would rather not see indexed.
  robots: { index: false, follow: false },
}

export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="min-h-dvh bg-background text-foreground">{children}</div>
    </ToastProvider>
  )
}
