'use client'

// Apparel size guide for a registration form field (e.g. "T-Shirt Size").
//
// Built on the existing <Dialog> primitive, so focus trapping, the Escape key, the
// backdrop and the portal all come from the component the rest of the app already uses —
// there is no second modal implementation here.
//
// Read-only by construction: it renders tables and holds no form state beyond the unit
// toggle, so opening it, switching units, or closing it cannot touch the selected size,
// trigger validation, or submit anything.
//
// ═══ WHY THE HEADER IS OURS RATHER THAN Dialog's ═════════════════════════════
// Dialog's built-in header is a single line of text plus an X. This surface needs an icon
// lockup, a title, a supporting line and a unit control, so the header is composed here and
// Dialog is mounted WITHOUT its `title` prop — every behaviour it owns is untouched, only
// its optional chrome is declined. The accessible name is re-attached below.
//
// ═══ THE DATA IS NEVER TOUCHED ═══════════════════════════════════════════════
// Rows, values and their order come from lib/registrations/sizeChart.ts and are stored in
// INCHES. Centimetres are produced at render time by pure helpers that always return new
// objects; nothing is written back, so the chart an organizer configured is the chart that
// stays configured. The fit note renders `chart.note` when an event supplies one — no fit
// advice is authored here.

import { useEffect, useId, useRef, useState } from 'react'
import { Shirt, User, Baby, Lightbulb, X } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { cn } from '@/lib/utils/cn'
import {
  resolveSizeChart, hasMeasurements, toDisplayRows, unitSuffix, deriveSizeGuideTitle,
  type SizeChart, type SizeChartRow, type SizeUnit,
} from '@/lib/registrations/sizeChart'

// Two accents, one system: the brand magenta for adult, the brand violet for kids. Both are
// existing tokens — the violet uses the `rgb(var(--…-rgb) / a)` form the stylesheet already
// composes translucent brand surfaces with.
const ACCENT = {
  adult: {
    chip:     'bg-primary/10 text-primary',
    headRow:  'bg-primary/[0.06]',
    headText: 'text-primary',
    pill:     'bg-primary/10 text-primary ring-primary/15',
  },
  kids: {
    chip:     'bg-[rgb(var(--brand-violet-rgb)/0.10)] text-[rgb(var(--brand-violet-rgb))]',
    headRow:  'bg-[rgb(var(--brand-violet-rgb)/0.06)]',
    headText: 'text-[rgb(var(--brand-violet-rgb))]',
    pill:     'bg-[rgb(var(--brand-violet-rgb)/0.10)] text-[rgb(var(--brand-violet-rgb))] ring-[rgb(var(--brand-violet-rgb)/0.15)]',
  },
} as const

type AccentKey = keyof typeof ACCENT

const TH = 'whitespace-nowrap px-3 py-2.5 text-left text-fs-2xs font-bold uppercase tracking-wider sm:px-4'
const TD = 'whitespace-nowrap px-3 py-2.5 text-fs-sm tabular-nums text-foreground sm:px-4'

// ─── Unit control ─────────────────────────────────────────────────────────────

const UNITS: ReadonlyArray<{ value: SizeUnit; label: string }> = [
  { value: 'in', label: 'Inches' },
  { value: 'cm', label: 'CM' },
]

/**
 * Segmented unit switch.
 *
 * Plain <button>s with `aria-pressed` rather than a radiogroup: a radiogroup is only correct
 * with roving tabindex and arrow-key handling, and a half-built one is worse for a keyboard
 * user than a pair of buttons that Tab and Enter/Space already drive natively. The pressed
 * state is what assistive technology announces.
 */
function UnitSwitch({ unit, onChange, labelId }: {
  unit:     SizeUnit
  onChange: (u: SizeUnit) => void
  labelId:  string
}) {
  return (
    <div role="group" aria-labelledby={labelId} className="inline-flex rounded-xl border border-border bg-muted/50 p-0.5">
      {UNITS.map(u => {
        const active = u.value === unit
        return (
          <button
            key={u.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(u.value)}
            className={cn(
              'min-h-8 rounded-[0.625rem] px-3 text-fs-2xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              active
                ? 'bg-card text-primary shadow-sm ring-1 ring-inset ring-primary/15'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {u.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Table ────────────────────────────────────────────────────────────────────

function ChartSection({ caption, rows, measurements, accent, icon: Icon, unit }: {
  caption:      string
  rows:         SizeChartRow[]
  measurements: boolean
  accent:       AccentKey
  icon:         typeof User
  unit:         SizeUnit
}) {
  if (rows.length === 0) return null
  const a = ACCENT[accent]
  const u = unitSuffix(unit)

  return (
    <section className="mt-7 first:mt-0">
      <div className="mb-3 flex items-center gap-2.5">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg', a.chip)}>
          <Icon className="size-4" aria-hidden />
        </span>
        <h3 className="text-fs-base font-bold tracking-tight text-foreground">{caption}</h3>
      </div>

      {/* The SCROLLER is this wrapper, not the page: overflow-x lives here so a narrow
          phone scrolls the table alone and the document never scrolls sideways. */}
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className={cn('w-full border-collapse', measurements ? 'min-w-[34rem]' : 'min-w-[18rem]')}>
          <caption className="sr-only">{caption}</caption>
          <thead className={a.headRow}>
            <tr>
              <th scope="col" className={cn(TH, a.headText)}>Brand Size</th>
              <th scope="col" className={cn(TH, a.headText)}>Standard Size</th>
              {measurements && <>
                <th scope="col" className={cn(TH, a.headText)}>Chest ({u})</th>
                <th scope="col" className={cn(TH, a.headText)}>Shoulder ({u})</th>
                <th scope="col" className={cn(TH, a.headText)}>Length ({u})</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.brandSize}-${i}`}
                className="border-t border-border/50 transition-colors hover:bg-muted/40"
              >
                <td className={cn(TD, 'font-semibold')}>
                  {/* The size is the one value an attendee is actually looking for, so it
                      carries the accent while every measurement stays neutral. */}
                  <span className={cn('inline-flex min-w-11 justify-center rounded-lg px-2.5 py-1 text-fs-2xs font-bold ring-1 ring-inset', a.pill)}>
                    {r.brandSize}
                  </span>
                </td>
                <td className={TD}>{r.standardSize}</td>
                {measurements && <>
                  <td className={TD}>{r.chest ?? '—'}</td>
                  <td className={TD}>{r.shoulder ?? '—'}</td>
                  <td className={TD}>{r.length ?? '—'}</td>
                </>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ─── Dialog ───────────────────────────────────────────────────────────────────

export function SizeChartDialog({ open, onClose, chart, title = 'Size Chart' }: {
  open:    boolean
  onClose: () => void
  chart:   SizeChart
  title?:  string
}) {
  const resolved  = resolveSizeChart(chart)
  const titleId   = useId()
  const unitLabelId = useId()
  const headerRef = useRef<HTMLElement>(null)

  // Inches is the stored unit and therefore the default: the first render shows exactly
  // what the organizer configured, with no conversion applied.
  const [unit, setUnit] = useState<SizeUnit>('in')

  const adultRows = toDisplayRows(resolved.regular, unit)
  const kidsRows  = toDisplayRows(resolved.kids, unit)

  // ═══ ACCESSIBLE NAME ════════════════════════════════════════════════════════
  // Dialog wires `aria-labelledby` only when its `title` prop is passed, and passing it
  // would render the chrome this surface replaces — so the panel would otherwise announce
  // as an unnamed "dialog". Its prop surface has no aria/contentProps/rest-spread escape
  // hatch, so the association is made HERE instead of widening the shared primitive.
  //
  // Scoped by `closest()` from this component's own header rather than a document query:
  // with two dialogs open it can only ever reach its own panel. The id comes from useId(),
  // not Dialog's hardcoded 'rd-dialog-title', so it cannot collide with a titled Dialog
  // mounted at the same time. The previous value is restored on cleanup.
  useEffect(() => {
    if (!open) return
    const panel = headerRef.current?.closest('[role="dialog"]')
    if (!panel) return
    const prev = panel.getAttribute('aria-labelledby')
    panel.setAttribute('aria-labelledby', titleId)
    return () => {
      if (prev === null) panel.removeAttribute('aria-labelledby')
      else panel.setAttribute('aria-labelledby', prev)
    }
  }, [open, titleId])

  // The page behind a modal must not scroll. Dialog does not lock the body, so it is done
  // here with the same save-and-restore the gallery lightbox uses — restoring the PREVIOUS
  // value rather than clearing it, so a nested/parent lock is never stomped.
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prevOverflow }
  }, [open])

  return (
    <Dialog open={open} onClose={onClose} size="lg">
      {/* Dialog applies its own body padding; this cancels it so the header can span the
          full panel width and stay flush with the rounded corners. */}
      <div className="-mx-[var(--modal-px)] -my-[var(--modal-py)] flex max-h-[85vh] flex-col">

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <header ref={headerRef} className="border-b border-border px-5 py-4 sm:px-6 sm:py-5">
          <div className="flex items-start gap-3 sm:gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary sm:size-12">
              <Shirt className="size-5 sm:size-6" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="truncate text-fs-lg font-bold tracking-tight text-foreground">
                {deriveSizeGuideTitle(title)}
              </h2>
              <p className="mt-0.5 text-fs-xs text-muted-foreground">
                Choose the right fit before you pick your size.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-9 shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Helper + unit switch share a row on tablet and up, and stack on a phone so the
              control keeps a full-width comfortable touch target. */}
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p id={unitLabelId} className="text-fs-xs text-muted-foreground">
              Check your measurements before choosing your size.
            </p>
            <UnitSwitch unit={unit} onChange={setUnit} labelId={unitLabelId} />
          </div>
        </header>

        {/* ── Scrollable body ────────────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <ChartSection
            caption="Adult Fit"
            rows={adultRows}
            measurements={hasMeasurements(adultRows)}
            accent="adult"
            icon={User}
            unit={unit}
          />
          <ChartSection
            caption="Kids Fit"
            rows={kidsRows}
            measurements={hasMeasurements(kidsRows)}
            accent="kids"
            icon={Baby}
            unit={unit}
          />

          {/* Rendered ONLY when the event supplies `note`. The copy is the organizer's,
              stored and shown verbatim. */}
          {resolved.note && (
            <div className="mt-7 flex items-start gap-3 rounded-2xl border border-border bg-muted/40 px-4 py-3.5">
              <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0">
                <p className="text-fs-sm font-bold text-foreground">Fit note</p>
                <p className="mt-0.5 text-fs-xs leading-relaxed text-muted-foreground">{resolved.note}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
