import { Badge, type BadgeVariant } from './badge'

// Semantic status tones mapped onto the existing Badge variants (EA-4 S3) — a
// thin wrapper so job/lifecycle statuses render consistently everywhere without a
// second chip implementation.
export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary'

const MAP: Record<StatusTone, BadgeVariant> = {
  neutral: 'default',
  success: 'success',
  warning: 'warning',
  danger:  'destructive',
  info:    'secondary',
  primary: 'primary',
}

export interface StatusChipProps {
  tone?:      StatusTone
  children:   React.ReactNode
  className?: string
}

export function StatusChip({ tone = 'neutral', children, className }: StatusChipProps) {
  return <Badge variant={MAP[tone]} className={className}>{children}</Badge>
}
