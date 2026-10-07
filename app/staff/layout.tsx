// RD-CHECKIN-2.0 — the /staff layout.
//
// Deliberately empty of chrome, exactly like app/ops/layout.tsx: /staff sits outside
// the (dashboard) route group, so it inherits no organizer sidebar, no command
// palette and no links a gate operator would only be refused at.
//
// That is a UI property, not a security control. The control is that every route
// these pages call re-authorizes server-side. The root layout still applies, so
// Firebase auth (AuthProvider) and the design tokens come along without being
// re-declared.

import type { Metadata } from 'next'
import { ToastProvider } from '@/components/ui/Toast'

export const metadata: Metadata = {
  title: 'Staff sign-in',
  robots: { index: false, follow: false },
}

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="min-h-dvh bg-background text-foreground">{children}</div>
    </ToastProvider>
  )
}
