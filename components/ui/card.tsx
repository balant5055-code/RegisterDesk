import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── Types ───────────────────────────────────────────────────────────────────

export type CardVariant = 'default' | 'elevated' | 'modal'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Visual weight of the card surface.
   *
   * - `default`  rounded-xl  shadow-sm   p-4 sm:p-5   Standard cards, panels
   * - `elevated` rounded-2xl shadow-md   p-5 sm:p-6   Feature / primary cards
   * - `modal`    rounded-2xl shadow-xl   p-6 sm:p-7   Dialogs, overlays
   */
  variant?: CardVariant
  /** Applies inner padding — defaults to true */
  padded?: boolean
  /** Lifts shadow and sharpens border on hover — use for clickable cards */
  hover?: boolean
}

// ─── Variant maps ─────────────────────────────────────────────────────────────

const variantRadius: Record<CardVariant, string> = {
  default:  'rounded-xl',
  elevated: 'rounded-2xl',
  modal:    'rounded-2xl',
}

const variantShadow: Record<CardVariant, string> = {
  default:  'shadow-sm',
  elevated: 'shadow-md',
  modal:    'shadow-xl',
}

// Padding consumes the semantic card tokens (styles/tokens.css). Values are
// identical to the former p-*/sm:p-* utilities (base + sm: breakpoint preserved),
// so responsive behaviour and rendered output are pixel-identical.
const variantPadding: Record<CardVariant, string> = {
  default:  'p-[var(--card-px-default)]  sm:p-[var(--card-px-default-sm)]',
  elevated: 'p-[var(--card-px-elevated)] sm:p-[var(--card-px-elevated-sm)]',
  modal:    'p-[var(--card-px-modal)]    sm:p-[var(--card-px-modal-sm)]',
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Card({
  variant = 'default',
  padded  = true,
  hover   = false,
  className,
  children,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        'bg-card text-card-foreground',
        'border border-border',
        variantRadius[variant],
        variantShadow[variant],
        padded && variantPadding[variant],
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
