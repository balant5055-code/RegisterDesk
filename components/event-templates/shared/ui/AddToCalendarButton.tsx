'use client'

import { useState, useRef, useEffect } from 'react'
import { CalendarPlus, ChevronDown, Globe, Mail, Download } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { googleCalendarUrl, outlookCalendarUrl } from '@/lib/calendar/ics'

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AddToCalendarButtonProps {
  title:       string
  startDate:   string   // YYYY-MM-DD
  endDate:     string   // YYYY-MM-DD
  startTime:   string   // HH:MM or ''
  endTime:     string   // HH:MM or ''
  location:    string
  description: string
  slug:        string   // used to build /api/events/[slug]/calendar.ics
  /** 'light' (default) renders on white/gray backgrounds; 'dark' for zinc-900 heroes. */
  variant?:    'light' | 'dark'
  /** Extra classes merged onto the trigger (tailwind-merge wins) — lets callers align it
   *  with a surrounding button group. Default appearance is unchanged. */
  className?:  string
  /** Trigger label (default 'Add to Calendar'). */
  label?:      string
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AddToCalendarButton({
  title, startDate, endDate, startTime, endTime, location, description, slug, variant = 'light', className, label = 'Add to Calendar',
}: AddToCalendarButtonProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const calInput = { title, startDate, endDate: endDate || startDate, startTime, endTime, location, description }

  const isDark = variant === 'dark'

  const btnCls = cn(
    'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors select-none',
    isDark
      ? 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100'
      : 'border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground',
    className,
  )

  const dropdownCls = cn(
    'absolute right-0 z-50 mt-1 min-w-[180px] overflow-hidden rounded-xl border shadow-lg',
    isDark
      ? 'border-zinc-700 bg-zinc-800'
      : 'border-border bg-card',
  )

  const itemCls = cn(
    'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] font-medium transition-colors',
    isDark
      ? 'text-zinc-300 hover:bg-zinc-700'
      : 'text-foreground hover:bg-muted/60',
  )

  const dividerCls = isDark ? 'border-zinc-700' : 'border-border'

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        className={btnCls}
      >
        <CalendarPlus className="size-3.5 shrink-0" aria-hidden />
        {label}
        <ChevronDown className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        <div className={dropdownCls} role="menu">

          {/* Google Calendar */}
          <a
            href={googleCalendarUrl(calInput)}
            target="_blank"
            rel="noopener noreferrer"
            className={itemCls}
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <Globe className="size-4 shrink-0 text-[#4285f4]" aria-hidden />
            Google Calendar
          </a>

          <div className={cn('border-t', dividerCls)} />

          {/* Outlook */}
          <a
            href={outlookCalendarUrl(calInput)}
            target="_blank"
            rel="noopener noreferrer"
            className={itemCls}
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <Mail className="size-4 shrink-0 text-[#0078d4]" aria-hidden />
            Outlook Calendar
          </a>

          <div className={cn('border-t', dividerCls)} />

          {/* Download ICS */}
          <a
            href={`/api/events/${slug}/calendar.ics`}
            download={`${slug}.ics`}
            className={itemCls}
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            Download .ics
          </a>
        </div>
      )}
    </div>
  )
}
