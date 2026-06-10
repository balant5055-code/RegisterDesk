import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds responsive inner padding — defaults to true */
  padded?: boolean
  /** Lifts shadow and sharpens border on hover — use for clickable cards */
  hover?: boolean
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Card({
  padded = true,
  hover = false,
  className,
  children,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        // surface
        'bg-card text-card-foreground',
        // shape
        'rounded-lg border border-border',
        // resting shadow
        'shadow-sm',
        // padding
        padded && 'p-5 sm:p-6',
        // interactive hover — shadow lifts, border sharpens
        hover && [
          'cursor-pointer',
          'transition-[box-shadow,border-color] duration-200',
          'hover:shadow-md hover:border-border-strong',
        ],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}
