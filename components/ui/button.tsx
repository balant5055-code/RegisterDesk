import { forwardRef, type ButtonHTMLAttributes, type CSSProperties } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── Types ───────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'gradient'
export type ButtonSize    = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:   ButtonVariant
  size?:      ButtonSize
  isLoading?: boolean
}

// ─── Variant map ─────────────────────────────────────────────────────────────

const variantClasses: Record<ButtonVariant, string> = {
  // Primary: matches the navbar "Start Free" button — the DS source of truth.
  // rounded-lg + font-semibold override the base rounded-xl + font-medium via twMerge.
  primary:
    'bg-primary text-white font-semibold rounded-lg ' +
    'shadow-[0_2px_12px_rgb(var(--primary-rgb)_/_0.28)] ' +
    'transition-all duration-200 ' +
    'hover:-translate-y-px hover:shadow-[0_4px_20px_rgb(var(--primary-rgb)_/_0.42)] ' +
    'active:translate-y-0 active:scale-[0.98]',
  secondary:
    'bg-secondary text-secondary-foreground hover:bg-secondary-hover',
  outline:
    'border border-border bg-transparent text-foreground hover:bg-muted hover:border-border-strong',
  ghost:
    'bg-transparent text-foreground hover:bg-muted',
  gradient:
    'text-white hover:opacity-90 rounded-lg',
}

// ─── Size map ─────────────────────────────────────────────────────────────────
// sm matches the navbar CTA exactly: h-9 px-4 text-sm.
// Other sizes remain unchanged from their original proportions.

// Structural dimensions consume the semantic component tokens (styles/tokens.css).
// Values are token-for-token identical to the former h-*/px-*/gap-* utilities, so
// output is pixel-identical; twMerge still groups these arbitrary utilities with
// their named counterparts, so caller className overrides behave exactly as before.
const sizeClasses: Record<ButtonSize, string> = {
  xs: 'h-[var(--button-height-xs)] px-[var(--button-px-xs)] text-xs     gap-[var(--button-gap-xs)]',
  sm: 'h-[var(--button-height-sm)] px-[var(--button-px-sm)] text-sm     gap-[var(--button-gap-sm)]',
  md: 'h-[var(--button-height-md)] px-[var(--button-px-md)] text-sm     gap-[var(--button-gap-md)]',
  lg: 'h-[var(--button-height-lg)] px-[var(--button-px-lg)] text-sm     gap-[var(--button-gap-lg)]',
  xl: 'h-[var(--button-height-xl)] px-[var(--button-px-xl)] text-[15px] gap-[var(--button-gap-xl)]',
}

const spinnerSizeClasses: Record<ButtonSize, string> = {
  xs: 'size-3',
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-4',
  xl: 'size-5',
}

// ─── buttonVariants ───────────────────────────────────────────────────────────
// Returns the full class string for a button — use this when you need button
// styles on a non-button element (e.g. <Link>) without nesting interactive els.

export function buttonVariants({
  variant   = 'primary',
  size      = 'md',
  className,
}: {
  variant?:   ButtonVariant
  size?:      ButtonSize
  className?: string
} = {}): string {
  return cn(
    'inline-flex items-center justify-center whitespace-nowrap',
    'cursor-pointer font-medium rounded-xl',
    'transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
    variantClasses[variant],
    sizeClasses[size],
    className,
  )
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

function Spinner({ size }: { size: ButtonSize }) {
  return (
    <svg
      className={cn('animate-spin shrink-0', spinnerSizeClasses[size])}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

// ─── Button ───────────────────────────────────────────────────────────────────

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant   = 'primary',
      size      = 'md',
      isLoading = false,
      disabled,
      className,
      style: callerStyle,
      children,
      ...props
    },
    ref,
  ) => {
    const gradientStyle: CSSProperties | undefined =
      variant === 'gradient'
        ? { backgroundImage: 'var(--primary-gradient)', ...callerStyle }
        : callerStyle

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        aria-busy={isLoading}
        style={gradientStyle}
        className={cn(
          'inline-flex items-center justify-center whitespace-nowrap',
          'cursor-pointer font-medium',
          'rounded-xl',
          'transition-colors duration-150',
          'focus-visible:outline-none',
          'focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        {...props}
      >
        {isLoading && <Spinner size={size} />}
        {children}
      </button>
    )
  },
)

Button.displayName = 'Button'
