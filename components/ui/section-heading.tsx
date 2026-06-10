import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SectionHeadingProps extends HTMLAttributes<HTMLDivElement> {
  /** Small label rendered above the title — e.g. "New", "Beta", "Events" */
  badge?: string
  /** Primary heading text — required */
  title: string
  /** Supporting copy rendered below the title */
  description?: string
  /** Text alignment and layout direction — defaults to left */
  align?: 'left' | 'center'
  /** Optional slot for a CTA or filter control, floats right on left-aligned layouts */
  action?: ReactNode
  /** Semantic heading level — defaults to h2 */
  level?: 2 | 3 | 4
}

// ─── Heading tag map ──────────────────────────────────────────────────────────

const headingTag = { 2: 'h2', 3: 'h3', 4: 'h4' } as const

// ─── Component ───────────────────────────────────────────────────────────────

export function SectionHeading({
  badge,
  title,
  description,
  align = 'left',
  action,
  level = 2,
  className,
  ...props
}: SectionHeadingProps) {
  const Tag = headingTag[level]
  const isCenter = align === 'center'

  return (
    <div
      className={cn(
        'flex gap-4',
        isCenter
          ? 'flex-col items-center text-center'
          : 'flex-col sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
      {...props}
    >
      {/* ── Text group ──────────────────────────────────────── */}
      <div className={cn('flex flex-col gap-1.5', isCenter && 'items-center')}>

        {badge && (
          <span
            className={cn(
              'inline-flex items-center rounded-full',
              'border border-border',
              'px-2.5 py-0.5',
              'text-xs font-medium text-primary',
              !isCenter && 'self-start',
            )}
          >
            {badge}
          </span>
        )}

        <Tag
          className={cn(
            'text-[22px] font-semibold tracking-tight text-foreground',
            'sm:text-[26px]',
          )}
        >
          {title}
        </Tag>

        {description && (
          <p className="max-w-prose text-[15px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}

      </div>

      {/* ── Action slot ─────────────────────────────────────── */}
      {action && (
        <div className="shrink-0 self-start">
          {action}
        </div>
      )}
    </div>
  )
}
