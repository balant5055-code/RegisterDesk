// Phase P.1.4 — Navigation atoms (presentational; reused by navbar + drawer).
//
// NavLink · NavCTA · NavButton. No hooks, no page logic;
// CTAs resolve from the central cta registry. Rendered inside the client navbar.

import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  ChevronDown,
  Home, CalendarDays, HeartHandshake,
  LayoutDashboard, BriefcaseBusiness, BadgeIndianRupee, MessagesSquare,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { typography } from '@/lib/ds/typography'
import { buttonVariants, type ButtonVariant } from '@/components/ui/button'
import { getCta, type CtaKey } from '@/lib/marketing/cta'

// Lucide icon per TOP-LEVEL nav menu id. This is a navbar-only presentation mapping
// — the navigation registry stays pure data (no JSX/icons leak into content).
//
// Keys track PRIMARY_NAV's actual top-level entries. They had drifted: `security`
// and `about` were still mapped after both were removed from the top nav, while
// `home`, `events` and `causes` — added when the discovery surfaces were promoted —
// had no icon at all, so those three rows rendered icon-less in the mobile drawer
// while every other row had one.
export const NAV_ICONS: Record<string, LucideIcon> = {
  home:      Home,
  events:    CalendarDays,
  causes:    HeartHandshake,
  platform:  LayoutDashboard,
  solutions: BriefcaseBusiness,
  pricing:   BadgeIndianRupee,
  contact:   MessagesSquare,
}

/** Shared shape for a top-bar nav control, so links and menu buttons match exactly. */
export const NAV_ITEM_BASE =
  'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors duration-200 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

/**
 * Text tone only — NO background.
 *
 * The lit background is the navbar's single gliding indicator (a shared-layout
 * element that moves between items), so an item painting its own background would
 * double up with it and break the illusion of one continuous object. `active` here
 * means "the indicator is under this item", not "this is the current route".
 */
export const navItemTone = (opts: { active?: boolean }) =>
  opts.active ? 'text-foreground' : 'text-muted-foreground'

export function NavLink({ href, children, className, current, onClick }: {
  href: string; children: ReactNode; className?: string
  /** Marks the current route for assistive tech — the moving indicator is visual only. */
  current?: boolean
  onClick?: () => void
}) {
  return (
    <Link href={href} onClick={onClick} aria-current={current ? 'page' : undefined}
      className={cn(typography.nav, 'rounded text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', className)}>
      {children}
    </Link>
  )
}

export function NavCTA({ ctaKey, size = 'sm', variant, className, onClick }: {
  ctaKey: CtaKey; size?: 'sm' | 'md'; variant?: ButtonVariant; className?: string; onClick?: () => void
}) {
  const cta = getCta(ctaKey)
  const v   = variant ?? cta.variant
  return (
    <Link
      href={cta.href}
      onClick={onClick}
      target={cta.external ? '_blank' : undefined}
      rel={cta.external ? 'noopener noreferrer' : undefined}
      className={buttonVariants({ variant: v, size, className })}
      style={v === 'gradient' ? { backgroundImage: 'var(--primary-gradient)' } : undefined}
    >
      {cta.label}
    </Link>
  )
}

export function NavButton({ label, icon: Icon, expanded, active, controls, id, className, onClick, onMouseEnter }: {
  label: string; icon?: LucideIcon; expanded: boolean; active?: boolean; controls?: string; id?: string; className?: string; onClick?: () => void; onMouseEnter?: () => void
}) {
  return (
    <button
      type="button" id={id} aria-haspopup="true" aria-expanded={expanded} aria-controls={controls}
      onClick={onClick} onMouseEnter={onMouseEnter}
      className={cn(NAV_ITEM_BASE, typography.nav, navItemTone({ active }), className)}
    >
      {Icon && <Icon className="size-4" strokeWidth={1.8} aria-hidden />}
      {label}
      <ChevronDown
        className={cn('size-3.5 opacity-60 transition-transform duration-200', expanded && 'rotate-180')}
        aria-hidden
      />
    </button>
  )
}
