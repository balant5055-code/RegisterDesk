import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export interface SpinnerProps {
  size?:      'sm' | 'md' | 'lg'
  className?: string
  label?:     string
}

const SIZES = { sm: 'size-4', md: 'size-6', lg: 'size-8' } as const

/** Standard loading spinner (EA-4 S3). Announces itself via role="status". */
export function Spinner({ size = 'md', className, label = 'Loading' }: SpinnerProps) {
  return (
    <Loader2
      role="status"
      aria-label={label}
      className={cn('animate-spin text-muted-foreground', SIZES[size], className)}
    />
  )
}
