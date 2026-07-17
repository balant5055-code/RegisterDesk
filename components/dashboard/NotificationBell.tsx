'use client'

// Notification Center — header bell (Phase H.4.3).
//
// Replaces the empty placeholder menu. Shows the live unread badge and a recent
// list from the real inbox (useNotifications), with mark-all-read and a link to
// the full /dashboard/notifications center. Rendering is metadata-driven via the
// catalog iconKey + severity.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import { Bell, CheckCheck } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useNotifications } from '@/lib/hooks/useNotifications'
import { categoryMeta } from '@/lib/notifications/inbox/catalog'
import { iconForKey, SEVERITY_ICON, relativeTime } from './notifications/presentation'
import type { NotificationView } from '@/lib/notifications/inbox/types'

const EASE = [0.22, 1, 0.36, 1] as const
const MAX_IN_DROPDOWN = 8

export function NotificationBell() {
  const router = useRouter()
  const { recent, unreadCount, markRead, markAllRead } = useNotifications()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function handleOpen(n: NotificationView) {
    if (!n.read) void markRead(n.id)
    setOpen(false)
    if (n.link) router.push(n.link)
  }

  const badge = unreadCount > 9 ? '9+' : String(unreadCount)
  const shown = recent.slice(0, MAX_IN_DROPDOWN)

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
            className="absolute right-0.5 top-0.5 flex min-w-[14px] items-center justify-center rounded-full bg-primary px-1 text-[8px] font-bold leading-[14px] text-primary-foreground"
          >
            {badge}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            variants={{ hidden: { opacity: 0, y: -6, scale: 0.97 }, show: { opacity: 1, y: 0, scale: 1 } }}
            initial="hidden" animate="show" exit="hidden" transition={{ duration: 0.14, ease: EASE }}
            role="dialog"
            aria-label="Notifications panel"
            className="absolute right-0 top-full z-50 mt-2 w-[22rem] overflow-hidden rounded-xl border border-border bg-card shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-[14px] font-semibold text-foreground">Notifications</p>
              {unreadCount > 0 && (
                <button
                  onClick={() => void markAllRead()}
                  className="flex items-center gap-1 text-[13px] font-medium text-primary hover:underline underline-offset-4"
                >
                  <CheckCheck className="size-3.5" /> Mark all read
                </button>
              )}
            </div>

            <ul aria-label="Recent notifications" className="max-h-80 divide-y divide-border overflow-y-auto">
              {shown.length === 0 && (
                <li className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                  You&rsquo;re all caught up.
                </li>
              )}
              {shown.map(n => {
                const Icon = iconForKey(categoryMeta(n.category).iconKey)
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => handleOpen(n)}
                      className={cn(
                        'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50',
                        !n.read && 'bg-primary/[0.03]',
                      )}
                    >
                      <Icon className={cn('mt-0.5 size-4 shrink-0', SEVERITY_ICON[n.severity])} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block text-[13px] leading-snug', !n.read ? 'font-semibold text-foreground' : 'text-foreground/90')}>
                          {n.title}
                        </span>
                        <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">{n.body}</span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground/80">{relativeTime(n.createdAt)}</span>
                      </span>
                      {!n.read && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                    </button>
                  </li>
                )
              })}
            </ul>

            <div className="border-t border-border px-4 py-2.5">
              <Link
                href="/dashboard/notifications"
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
