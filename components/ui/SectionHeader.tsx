'use client'

import type { HTMLAttributes, ReactNode } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils/cn'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SectionHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** Small overline label above the title — e.g. "Don't Miss Out", "New" */
  overline?: string
  /** Primary heading text */
  title: string
  /** Optional supporting description below the title */
  description?: string
  /** Text alignment — defaults to left */
  align?: 'left' | 'center'
  /** Semantic heading level — defaults to h2 */
  level?: 2 | 3
  /** Animate on scroll-enter — defaults to true */
  animate?: boolean
}

// ─── Heading tag map ──────────────────────────────────────────────────────────

const headingTag = { 2: 'h2', 3: 'h3' } as const

// ─── Component ───────────────────────────────────────────────────────────────

export function SectionHeader({
  overline,
  title,
  description,
  align     = 'left',
  level     = 2,
  animate   = true,
  className,
  ...props
}: SectionHeaderProps) {
  const Tag      = headingTag[level]
  const isCenter = align === 'center'

  const inner = (
    <div
      className={cn(
        'flex flex-col',
        isCenter ? 'items-center text-center gap-2' : 'gap-1.5',
        className,
      )}
      {...props}
    >
      {overline && (
        <p className={cn(
          'text-[var(--fs-2xs)] font-semibold uppercase tracking-[0.12em] text-primary',
        )}>
          {overline}
        </p>
      )}

      <Tag className={cn(
        'text-[var(--fs-xl)] font-semibold tracking-tight text-foreground',
        'sm:text-[var(--fs-2xl)]',
      )}>
        {title}
      </Tag>

      {description && (
        <p className={cn(
          'text-[var(--fs-base)] leading-relaxed text-muted-foreground',
          isCenter && 'max-w-xl',
        )}>
          {description}
        </p>
      )}
    </div>
  )

  if (!animate) return inner

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      {inner}
    </motion.div>
  )
}
