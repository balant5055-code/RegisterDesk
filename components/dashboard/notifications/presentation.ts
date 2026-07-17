// Notification Center — client presentation helpers (Phase H.4.3).
//
// Rendering is metadata-driven: the catalog assigns each category an `iconKey`
// and every notification a `severity`; this module maps those to concrete lucide
// icons and Tailwind classes. Adding a category never requires touching the UI —
// only the catalog + this key map.

import type { LucideIcon } from 'lucide-react'
import {
  BadgeCheck, CreditCard, Wallet, Ticket, Award, Megaphone, Banknote, AlertTriangle, Bell,
} from 'lucide-react'
import type { NotificationSeverity } from '@/lib/notifications/inbox/types'

const ICON_BY_KEY: Record<string, LucideIcon> = {
  'badge-check':    BadgeCheck,
  'credit-card':    CreditCard,
  wallet:           Wallet,
  ticket:           Ticket,
  award:            Award,
  megaphone:        Megaphone,
  banknote:         Banknote,
  'alert-triangle': AlertTriangle,
}

export function iconForKey(key: string): LucideIcon {
  return ICON_BY_KEY[key] ?? Bell
}

export const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  info:    'bg-primary',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error:   'bg-destructive',
}

export const SEVERITY_ICON: Record<NotificationSeverity, string> = {
  info:    'text-primary',
  success: 'text-emerald-600',
  warning: 'text-amber-600',
  error:   'text-destructive',
}

/** Compact relative time for feed rows. */
export function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const min = Math.floor((Date.now() - then) / 60000)
  if (min < 1)  return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24)  return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7)  return `${day}d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}
