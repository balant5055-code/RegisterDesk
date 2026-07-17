import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── StatusPill ─────────────────────────────────────────────────────────────────
// The soft, ring-outlined status pill used throughout the Platform Admin (status
// columns, category tags). Tone names mirror PageHeader's StatusTone so the whole
// admin surface speaks one colour language. Pages with bespoke category colours
// (e.g. the audit action map) can pass `className` to override just the colours
// while keeping the shared pill shape.

export type PillTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone
}

const TONE: Record<PillTone, string> = {
  neutral: 'bg-muted text-muted-foreground ring-border',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  warning: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  danger:  'bg-rose-50 text-rose-700 ring-rose-600/20',
  info:    'bg-sky-50 text-sky-700 ring-sky-600/20',
  accent:  'bg-purple-50 text-purple-700 ring-purple-600/20',
}

export function StatusPill({ tone = 'neutral', className, children, ...props }: StatusPillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1',
        TONE[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}
