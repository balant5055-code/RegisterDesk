// Phase P.1.4 — Navigation atoms (presentational; reused by navbar + drawer).
//
// NavLink · NavCTA · NavButton. No hooks, no page logic;
// CTAs resolve from the central cta registry. Rendered inside the client navbar.

import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  ChevronDown,
  LayoutDashboard, BriefcaseBusiness, BadgeIndianRupee, ShieldCheck, Building2, MessagesSquare,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants, type ButtonVariant } from '@/components/ui/button'
import { getCta, type CtaKey } from '@/lib/marketing/cta'

// Lucide icon per nav menu id. This is a navbar-only presentation mapping — the
// navigation registry stays pure data (no JSX/icons leak into content).
export const NAV_ICONS: Record<string, LucideIcon> = {
  platform:  LayoutDashboard,
  solutions: BriefcaseBusiness,
  pricing:   BadgeIndianRupee,
  security:  ShieldCheck,
  about:     Building2,
  contact:   MessagesSquare,
}

export function NavLink({ href, children, className, onClick }: {
  href: string; children: ReactNode; className?: string; onClick?: () => void
}) {
  return (
    <Link href={href} onClick={onClick}
      className={cn('text-[14px] font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded', className)}>
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

export function NavButton({ label, icon: Icon, expanded, active, controls, id, onClick, onMouseEnter }: {
  label: string; icon?: LucideIcon; expanded: boolean; active?: boolean; controls?: string; id?: string; onClick?: () => void; onMouseEnter?: () => void
}) {
  return (
    <button
      type="button" id={id} aria-haspopup="true" aria-expanded={expanded} aria-controls={controls}
      onClick={onClick} onMouseEnter={onMouseEnter}
      className={cn(
        'inline-flex items-center gap-2 rounded-xl px-2.5 py-2 text-[14px] font-medium transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        expanded ? 'bg-muted/50 text-foreground' : active ? 'text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
      )}
    >
      {Icon && <Icon className="size-4" strokeWidth={1.8} aria-hidden />}
      {label}
      <ChevronDown className={cn('size-3.5 transition-transform duration-200', expanded && 'rotate-180')} aria-hidden />
    </button>
  )
}
