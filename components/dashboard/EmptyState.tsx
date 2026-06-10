import Link from 'next/link'
import { AlertCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

// ─── EmptyState ───────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  icon:        LucideIcon
  title:       string
  description: string
  action?: {
    label:    string
    href?:    string
    onClick?: () => void
  }
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-label={title}
      className={cn(
        'flex flex-col items-center justify-center px-6 py-10 text-center',
        className,
      )}
    >
      <div className="flex size-11 items-center justify-center rounded-xl bg-muted">
        <Icon className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <p className="mt-3 text-[14px] font-semibold text-foreground">{title}</p>
      <p className="mt-1 max-w-[220px] text-[13px] leading-relaxed text-muted-foreground">
        {description}
      </p>
      {action && (
        <div className="mt-4">
          {action.href ? (
            <Link href={action.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              {action.label}
            </Link>
          ) : (
            <button
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
  className?: string
}

export function ErrorState({
  message  = 'Something went wrong loading this data.',
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center px-6 py-10 text-center',
        className,
      )}
    >
      <div className="flex size-11 items-center justify-center rounded-xl bg-destructive/10">
        <AlertCircle className="size-5 text-destructive" aria-hidden />
      </div>
      <p className="mt-3 text-[14px] font-semibold text-foreground">Unable to load</p>
      <p className="mt-1 max-w-[220px] text-[13px] leading-relaxed text-muted-foreground">
        {message}
      </p>
      {onRetry && (
        <div className="mt-4">
          <button
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
