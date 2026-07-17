'use client'

import { usePathname }    from 'next/navigation'
import { ToastProvider }  from '@/components/ui/Toast'
import AttendeeShell      from '@/components/attendee/AttendeeShell'

export default function AttendeeLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isLogin  = pathname === '/attendee/login'

  return (
    <ToastProvider>
      {isLogin ? children : <AttendeeShell>{children}</AttendeeShell>}
    </ToastProvider>
  )
}
