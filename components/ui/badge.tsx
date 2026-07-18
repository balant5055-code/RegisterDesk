import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── Types ───────────────────────────────────────────────────────────────────

export type BadgeVariant =
  | 'default'
  | 'primary'
  | 'secondary'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'outline'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

// ─── Variant map ─────────────────────────────────────────────────────────────

const variantClasses: Record<BadgeVariant, string> = {
  default:     'bg-muted text-muted-foreground',
  primary:     'bg-primary text-primary-foreground',
  secondary:   'bg-secondary text-secondary-foreground',
  success:     'bg-success text-success-foreground',
  warning:     'bg-warning text-warning-foreground',
  destructive: 'bg-destructive text-destructive-foreground',
  outline:     'border border-border bg-transparent text-foreground',
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Badge({
  variant = 'default',
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center',
        'rounded-full',
        'px-[var(--badge-px)] py-[var(--badge-py)]',
        'text-[13px] font-medium',
        'whitespace-nowrap',
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}
