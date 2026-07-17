import { cn } from '@/lib/utils/cn'

export type ProgressTone = 'primary' | 'success' | 'warning' | 'destructive'

export interface ProgressBarProps {
  value:      number
  max?:       number
  tone?:      ProgressTone
  label?:     string
  className?: string
}

const TONES: Record<ProgressTone, string> = {
  primary:     'bg-primary',
  success:     'bg-success',
  warning:     'bg-warning',
  destructive: 'bg-destructive',
}

/** Determinate progress bar (EA-4 S3). Exposes role="progressbar" + aria-valuenow
 *  for screen readers — used by useJobProgress / job UIs. */
export function ProgressBar({ value, max = 100, tone = 'primary', label, className }: ProgressBarProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div className={cn('h-full rounded-full transition-[width] duration-300', TONES[tone])} style={{ width: `${pct}%` }} />
    </div>
  )
}
