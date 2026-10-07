'use client'

// ─── Date picker ─────────────────────────────────────────────────────────────
//
// Compact date discovery: six named ranges plus a custom window, all behind ONE trigger
// rather than seven competing buttons.
//
// Every option maps to a range the server predicate implements (matchesDateRange in
// lib/firebase/firestore/publicEvents.ts). The custom window sends `date=custom` with
// `dateFrom` / `dateTo`, and an open-ended window is allowed — "from the 20th onwards" is a
// real thing to want.

import { useState } from 'react'
import { CalendarDays, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { DiscoveryPopover, PopoverRow, PopoverGroupLabel, FieldTrigger } from './DiscoveryPopover'
import { DATE_OPTIONS, DATE_LABEL } from './discoveryTaxonomy'
import type { DateKey } from './discoveryTaxonomy'

export interface DateValue {
  key:  DateKey | null
  from: string   // YYYY-MM-DD, '' = open start
  to:   string   // YYYY-MM-DD, '' = open end
}

export const EMPTY_DATE: DateValue = { key: null, from: '', to: '' }

function prettyDay(d: string): string {
  if (!d) return ''
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y, m - 1, day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export function dateLabel(v: DateValue): string {
  if (!v.key) return 'Any date'
  if (v.key !== 'custom') return DATE_LABEL[v.key]
  if (v.from && v.to) return `${prettyDay(v.from)} – ${prettyDay(v.to)}`
  if (v.from)          return `From ${prettyDay(v.from)}`
  if (v.to)            return `Until ${prettyDay(v.to)}`
  return 'Custom dates'
}

export function DatePicker({
  value,
  onChange,
  className,
  variant = 'segment',
}: {
  value:      DateValue
  onChange:   (v: DateValue) => void
  className?: string
  variant?:   'segment' | 'pill' | 'field'
}) {
  const [open, setOpen]     = useState(false)
  const [custom, setCustom] = useState(value.key === 'custom')
  const [from, setFrom]     = useState(value.from)
  const [to, setTo]         = useState(value.to)

  // Seeding the draft window happens in the open handler rather than an effect: the draft is
  // derived from the committed value at exactly one moment (the panel opening), so an effect
  // would only add a cascading render for no extra correctness.
  const toggle = () => {
    if (!open) {
      setCustom(value.key === 'custom')
      setFrom(value.from)
      setTo(value.to)
    }
    setOpen(o => !o)
  }

  const active = value.key !== null
  const label  = dateLabel(value)

  const choose = (key: DateKey | null) => {
    onChange(key ? { key, from: '', to: '' } : EMPTY_DATE)
    setOpen(false)
  }

  const applyCustom = () => {
    if (!from && !to) { onChange(EMPTY_DATE); setOpen(false); return }
    // A reversed window is a slip, not an intent — swap rather than return nothing.
    const [a, b] = from && to && from > to ? [to, from] : [from, to]
    onChange({ key: 'custom', from: a, to: b })
    setOpen(false)
  }

  return (
    <DiscoveryPopover
      open={open}
      onClose={() => setOpen(false)}
      title="When"
      widthPx={280}
      align="end"
      className={className}
      trigger={a => (
        variant === 'field' ? (
          <FieldTrigger
            {...a}
            label="Date"
            value={label}
            icon={<CalendarDays className={cn('size-3.5 shrink-0', active ? 'text-action' : 'text-hero-accent-rule')} />}
            active={active}
            open={open}
            onClick={toggle}
            className="w-full"
          />
        ) : (
        <button
          {...a}
          type="button"
          onClick={toggle}
          className={cn(
            'group flex w-full cursor-pointer items-center gap-2 text-left transition-colors',
            variant === 'segment'
              ? 'h-full min-w-0 px-3.5 py-2 hover:bg-muted/40'
              : cn(
                  'h-10 shrink-0 justify-center rounded-xl border px-2.5 text-[13px] font-semibold sm:justify-start sm:px-3',
                  active
                    ? 'border-action/40 bg-action/[0.06] text-action'
                    : 'border-border/70 bg-card text-foreground hover:border-border-strong hover:bg-muted/40',
                ),
          )}
        >
          <CalendarDays className={cn(
            'size-4 shrink-0',
            variant === 'segment'
              ? (active ? 'text-action' : 'text-muted-foreground/60')
              : '',
          )} />
          {variant === 'segment' ? (
            <span className="min-w-0 flex-1">
              <span className="block text-[10.5px] font-bold uppercase tracking-[0.07em] text-muted-foreground/70">
                When
              </span>
              <span className={cn(
                'block truncate text-[13.5px] font-semibold leading-tight',
                active ? 'text-foreground' : 'text-muted-foreground/70',
              )}>
                {label}
              </span>
            </span>
          ) : (
            <span className="hidden max-w-[8.5rem] truncate sm:inline">{label}</span>
          )}
        </button>
        )
      )}
    >
      <PopoverRow
        active={!active}
        onClick={() => choose(null)}
        label="Any date"
        trailing={!active ? <Check className="size-4 shrink-0 text-action" /> : undefined}
      />
      {DATE_OPTIONS.map(o => (
        <PopoverRow
          key={o.key}
          active={value.key === o.key}
          onClick={() => choose(o.key)}
          label={o.label}
          hint={o.hint}
          trailing={value.key === o.key ? <Check className="size-4 shrink-0 text-action" /> : undefined}
        />
      ))}

      <PopoverGroupLabel>Custom</PopoverGroupLabel>
      {!custom ? (
        <PopoverRow
          active={value.key === 'custom'}
          onClick={() => setCustom(true)}
          label="Pick exact dates"
          hint={value.key === 'custom' ? label : 'Choose a start and end'}
          trailing={value.key === 'custom' ? <Check className="size-4 shrink-0 text-action" /> : undefined}
        />
      ) : (
        <div className="px-2.5 pb-1 pt-1">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-[0.07em] text-muted-foreground/70">From</span>
              <input
                type="date"
                value={from}
                onChange={e => setFrom(e.target.value)}
                className="h-9 w-full rounded-lg border border-border/70 bg-card px-2 text-[12.5px] text-foreground outline-none transition-colors focus:border-action/50 focus:ring-2 focus:ring-action/10"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10.5px] font-bold uppercase tracking-[0.07em] text-muted-foreground/70">To</span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={e => setTo(e.target.value)}
                className="h-9 w-full rounded-lg border border-border/70 bg-card px-2 text-[12.5px] text-foreground outline-none transition-colors focus:border-action/50 focus:ring-2 focus:ring-action/10"
              />
            </label>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setCustom(false); setFrom(''); setTo(''); if (value.key === 'custom') onChange(EMPTY_DATE) }}
              className="flex h-9 shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border/70 px-2.5 text-[12.5px] font-semibold text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <X className="size-3.5" /> Clear
            </button>
            <button
              type="button"
              onClick={applyCustom}
              className="h-9 flex-1 cursor-pointer rounded-lg text-[12.5px] font-bold text-white transition-opacity hover:opacity-90"
              style={{ backgroundImage: 'var(--action-gradient)' }}
            >
              Apply dates
            </button>
          </div>
        </div>
      )}
    </DiscoveryPopover>
  )
}
