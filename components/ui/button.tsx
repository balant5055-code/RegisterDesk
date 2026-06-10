import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── Types ───────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  isLoading?: boolean
}

// ─── Variant & size maps ──────────────────────────────────────────────────────

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground hover:bg-primary-hover',
  secondary:
    'bg-secondary text-secondary-foreground hover:bg-secondary-hover',
  outline:
    'border border-border bg-transparent text-foreground hover:bg-muted hover:border-border-strong',
  ghost:
    'bg-transparent text-foreground hover:bg-muted',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8  px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-[14px] gap-2',
  lg: 'h-12 px-6 text-[15px] gap-2.5',
}

const spinnerSizeClasses: Record<ButtonSize, string> = {
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-5',
}

// ─── buttonVariants ──────────────────────────────────────────────────────────
// Returns the full class string for a button — use this when you need button
// styles on a non-button element (e.g. <Link>) without nesting interactive els.

export function buttonVariants({
  variant = 'primary',
  size = 'md',
  className,
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
} = {}): string {
  return cn(
    'inline-flex items-center justify-center whitespace-nowrap',
    'font-medium rounded-md',
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
      {/* track */}
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        className="opacity-25"
      />
      {/* indicator */}
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ─── Button ───────────────────────────────────────────────────────────────────

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      isLoading = false,
      disabled,
      className,
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      disabled={disabled || isLoading}
      aria-busy={isLoading}
      className={cn(
        // base layout
        'inline-flex items-center justify-center whitespace-nowrap',
        // typography
        'font-medium',
        // shape
        'rounded-md',
        // motion
        'transition-colors duration-150',
        // keyboard focus ring — uses primary token
        'focus-visible:outline-none',
        'focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        // disabled — covers both disabled attr and isLoading
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
        // variant + size
        variantClasses[variant],
        sizeClasses[size],
        // caller overrides last — twMerge resolves conflicts
        className,
      )}
      {...props}
    >
      {isLoading && <Spinner size={size} />}
      {children}
    </button>
  ),
)

Button.displayName = 'Button'
