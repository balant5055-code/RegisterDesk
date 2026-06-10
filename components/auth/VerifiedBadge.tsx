import { CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

interface VerifiedBadgeProps {
  /** When true the badge renders; when false nothing is shown */
  verified: boolean
  /** 'sm' (default) for inline use in headers; 'md' for settings panels */
  size?: 'sm' | 'md'
  className?: string
}

export function VerifiedBadge({ verified, size = 'sm', className }: VerifiedBadgeProps) {
  if (!verified) return null
  return (
    <span
      title="Email verified"
      aria-label="Email verified"
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-semibold',
        size === 'sm' && 'border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-400',
        size === 'md' && 'border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-400',
        className,
      )}
    >
      <CheckCircle2
        aria-hidden
        className={cn(size === 'sm' ? 'size-3' : 'size-3.5')}
      />
      Verified
    </span>
  )
}
