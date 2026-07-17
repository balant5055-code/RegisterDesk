import Link from 'next/link'
import { AlertCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { buttonVariants } from './button'
import { cn } from '@/lib/utils/cn'

// ─── EmptyState ───────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  /** Lucide icon to display */
  icon: LucideIcon
  /** Short heading */
  title: string
  /** Supporting explanation copy */
  description: string
  /**
   * Visual size.
   *
   * - `sm`  Compact — fits inside dashboard cards and narrow panels
   * - `md`  Default — standalone sections and filter result states
   * - `lg`  Spacious — full-page empty screens
   */
  size?: 'sm' | 'md' | 'lg'
  /** Optional primary CTA */
  action?: {
    label:    string
    href?:    string
    onClick?: () => void
  }
  className?: string
}

const sizeConfig = {
  sm: {
    wrapper:   'px-5 py-8',
    iconBox:   'size-10',
    icon:      'size-4',
    iconBg:    'rounded-xl',
    titleText: 'text-[var(--fs-base)] font-semibold',
    descText:  'text-[var(--fs-sm)]',
    descWidth: 'max-w-[200px]',
  },
  md: {
    wrapper:   'px-6 py-12',
    iconBox:   'size-12',
    icon:      'size-5',
    iconBg:    'rounded-xl',
    titleText: 'text-[var(--fs-md)] font-semibold',
    descText:  'text-[var(--fs-base)]',
    descWidth: 'max-w-[260px]',
  },
  lg: {
    wrapper:   'px-8 py-16',
    iconBox:   'size-16',
    icon:      'size-7',
    iconBg:    'rounded-2xl',
    titleText: 'text-[var(--fs-lg)] font-semibold',
    descText:  'text-[var(--fs-base)]',
    descWidth: 'max-w-xs',
  },
} as const

export function EmptyState({
  icon: Icon,
  title,
  description,
  size     = 'md',
  action,
  className,
}: EmptyStateProps) {
  const cfg = sizeConfig[size]

  return (
    <div
      role="status"
      aria-label={title}
      className={cn(
        'flex flex-col items-center justify-center text-center',
        cfg.wrapper,
        className,
      )}
    >
      <div
        className={cn(
          'flex shrink-0 items-center justify-center bg-muted',
          cfg.iconBox,
          cfg.iconBg,
        )}
      >
        <Icon className={cn(cfg.icon, 'text-muted-foreground/60')} aria-hidden />
      </div>

      <p className={cn('mt-3', cfg.titleText, 'text-foreground')}>
        {title}
      </p>

      <p className={cn('mt-1 leading-relaxed text-muted-foreground', cfg.descText, cfg.descWidth)}>
        {description}
      </p>

      {action && (
        <div className="mt-5">
          {action.href ? (
            <Link
              href={action.href}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {action.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={action.onClick}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── ErrorState ───────────────────────────────────────────────────────────────

export interface ErrorStateProps {
  message?: string
  onRetry?: () => void
  size?:    'sm' | 'md' | 'lg'
  className?: string
}

export function ErrorState({
  message   = 'Something went wrong loading this data.',
  onRetry,
  size      = 'md',
  className,
}: ErrorStateProps) {
  const cfg = sizeConfig[size]

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        cfg.wrapper,
        className,
      )}
    >
      <div
        className={cn(
          'flex shrink-0 items-center justify-center bg-destructive/10',
          cfg.iconBox,
          cfg.iconBg,
        )}
      >
        <AlertCircle className={cn(cfg.icon, 'text-destructive')} aria-hidden />
      </div>

      <p className={cn('mt-3', cfg.titleText, 'text-foreground')}>
        Unable to load
      </p>

      <p className={cn('mt-1 leading-relaxed text-muted-foreground', cfg.descText, cfg.descWidth)}>
        {message}
      </p>

      {onRetry && (
        <div className="mt-5">
          <button
            type="button"
            onClick={onRetry}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
