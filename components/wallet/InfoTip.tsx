'use client'

// A small, keyboard-accessible info icon: hover, focus or tap shows a short explanation. Used where
// the Wallet would otherwise need a paragraph of prose.

import { useId, useState } from 'react'
import { Info } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export function InfoTip({ label, children, className, align = 'center' }: {
  /** Accessible name of the button, e.g. "How the refund is calculated". */
  label: string
  children: React.ReactNode
  className?: string
  align?: 'center' | 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className={cn('relative inline-flex align-middle', className)}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open}
        onClick={() => setOpen(o => !o)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
        className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <Info className="size-3.5" aria-hidden />
      </button>
      {open && (
        <span id={id} role="tooltip"
          className={cn('absolute top-full z-40 mt-1.5 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card px-3 py-2 text-left text-[12px] font-normal leading-snug text-foreground shadow-lg',
            align === 'center' && 'left-1/2 -translate-x-1/2', align === 'start' && 'left-0', align === 'end' && 'right-0')}>
          {children}
        </span>
      )}
    </span>
  )
}
