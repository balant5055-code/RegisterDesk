'use client'

// RD-LAUNCH-07 — the client half of the attendee portal layout.
//
// Extracted verbatim from app/attendee/layout.tsx so that the layout itself can be a
// Server Component and export `metadata`. A Client Component cannot export metadata,
// which is why every attendee page had no title, description or canonical
// (RD-LAUNCH-01 P1-7). Behaviour is unchanged — same pathname check, same shell.

import { usePathname }    from 'next/navigation'
import { ToastProvider }  from '@/components/ui/Toast'
import AttendeeShell      from '@/components/attendee/AttendeeShell'

export function AttendeeLayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isLogin  = pathname === '/attendee/login'

  return (
    <ToastProvider>
      {isLogin ? children : <AttendeeShell>{children}</AttendeeShell>}
    </ToastProvider>
  )
}
