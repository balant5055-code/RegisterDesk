'use client'

// RD-PRICING-CALC · the public /pricing calculator.
//
// ═══ NO PRICE LIVES HERE ═════════════════════════════════════════════════════
// The configuration arrives ONCE: as `initialPricing` — the very snapshot the server rendered the
// plan cards and facts from (getPublicPricing) — or, when the server had none, fetched from
// GET /api/public/pricing (the same function). Every figure is then computed by
// `estimateEventCost` — which composes the checkout's own pricing functions. This file only
// draws controls and formats paise. If the configuration cannot be loaded, it says so; it
// never falls back to a remembered or default price.
//
// The quantities shown on first load and the slider granularity are presentation choices, not
// prices: they decide where the slider starts and how far one step moves it, nothing else. Any
// exact whole number can still be typed.

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowRight, Minus, Plus, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import { SERVICE_KINDS, SERVICE_LABELS, type ServiceKind } from '@/lib/licensing/serviceAllowances'
import {
  estimateEventCost, parsePublicPricingConfig, registrationLimits, serviceLimits, serviceConfigFor, formatTicketFee,
  type EstimateSelection, type PublicPricingConfig, type QuantityLimits,
} from '@/lib/licensing/publicPricing'
import { DEFAULT_PRESETS } from '@/components/wizard/ServiceQuantitySelector'

export const PRICING_UNAVAILABLE_MESSAGE = 'Pricing is temporarily unavailable. Please try again.'

// ─── Presentation: where the controls start, and how far one step moves them ────

/** First-load quantities (clamped to the configured limits). Illustrative, never a price. */
const STARTING_SELECTION: EstimateSelection = { registrations: 500, whatsapp: 2_000, certificates: 500, media: 1_000 }

/**
 * Slider stops between `min` and `max`: fine near the bottom, coarser as quantities grow, so a
 * 200,000 range is still usable on a phone. Purely positional — the typed value is never snapped.
 */
export function sliderStops(min: number, max: number): number[] {
  const stops = new Set<number>([min, max])
  const bands: [number, number][] = [[1_000, 50], [10_000, 500], [100_000, 5_000], [Infinity, 10_000]]
  let lo = 0
  for (const [hi, step] of bands) {
    for (let v = Math.ceil(Math.max(lo, min) / step) * step; v <= Math.min(hi, max); v += step) stops.add(v)
    lo = hi
    if (hi >= max) break
  }
  return [...stops].filter(v => v >= min && v <= max).sort((a, b) => a - b)
}

/** The slider's visual extent: the configured maximum, or (no maximum configured) the largest quick-select. */
function sliderExtent(limits: QuantityLimits, presets: number[], current: number): number {
  if (limits.max !== null) return limits.max
  return Math.max(limits.min, current, ...presets)
}

const nearestIndex = (stops: number[], v: number) =>
  stops.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(stops[best] - v) ? i : best), 0)

const clamp = (v: number, l: QuantityLimits) => Math.max(l.min, l.max === null ? v : Math.min(v, l.max))
const count = (n: number) => n.toLocaleString('en-IN')

// ─── Data loading ─────────────────────────────────────────────────────────────

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; config: PublicPricingConfig }

async function loadPricing(): Promise<PublicPricingConfig | null> {
  try {
    const res = await fetch('/api/public/pricing')
    if (!res.ok) return null
    const body = await res.json() as { pricing?: unknown }
    return parsePublicPricingConfig(body.pricing)
  } catch {
    return null
  }
}

// ─── One quantity control ─────────────────────────────────────────────────────

interface QuantityRowProps {
  title:    string
  units:    string
  hint:     string
  value:    number
  limits:   QuantityLimits
  presets:  number[]
  onChange: (v: number) => void
  /** Pre-GST charge for this line, or null when the line is refused. */
  chargePaise: number | null
  error:    string | null
  unavailableMessage?: string
}

function QuantityRow({ title, units, hint, value, limits, presets, onChange, chargePaise, error, unavailableMessage }: QuantityRowProps) {
  const id = useId()
  const [text, setText] = useState(String(value))
  const [last, setLast] = useState(value)
  if (value !== last) { setLast(value); setText(String(value)) }

  const extent = sliderExtent(limits, presets, value)
  const stops  = useMemo(() => sliderStops(limits.min, extent), [limits.min, extent])
  const index  = nearestIndex(stops, Math.min(value, extent))
  const step   = (dir: 1 | -1) => {
    const i = nearestIndex(stops, value)
    const next = dir === 1
      ? (stops[i] > value ? stops[i] : stops[Math.min(stops.length - 1, i + 1)])
      : (stops[i] < value ? stops[i] : stops[Math.max(0, i - 1)])
    onChange(clamp(next, limits))
  }
  const commit = (raw: string) => {
    setText(raw)
    const n = Number(raw)
    if (raw.trim() !== '' && Number.isInteger(n) && n >= 0) onChange(n)
  }
  const typedInvalid = text.trim() !== '' && !(Number.isInteger(Number(text)) && Number(text) >= 0)
  const shownError = typedInvalid ? `Enter a whole number of ${units}.` : error

  if (unavailableMessage) {
    return (
      <div className="py-5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-accent-rule">{title}</p>
          <p className="text-fs-sm text-hero-ink-soft">Not available</p>
        </div>
        <p className="mt-2 text-fs-sm text-hero-ink-soft">{unavailableMessage}</p>
      </div>
    )
  }

  return (
    <div className="py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <label htmlFor={`${id}-qty`} className="text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-accent-rule">{title}</label>
        <p className="text-fs-xs text-hero-ink-soft">{hint}</p>
      </div>

      <input
        type="range"
        min={0}
        max={stops.length - 1}
        step={1}
        value={index}
        onChange={e => onChange(stops[Number(e.target.value)] ?? limits.min)}
        aria-label={`${title} quantity`}
        aria-valuetext={`${count(value)} ${units}`}
        className="mt-4 h-2 w-full cursor-pointer accent-[var(--action)]"
      />
      <div className="mt-1 flex justify-between text-fs-2xs text-hero-ink-soft tabular-nums" aria-hidden>
        <span>{count(limits.min)}</span>
        <span>{count(extent)}{limits.max === null ? '+' : ''}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => step(-1)} disabled={value <= limits.min} aria-label={`Fewer ${units}`}
            className="inline-flex size-9 items-center justify-center rounded-[var(--radius-control)] border border-border bg-card text-hero-ink transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action">
            <Minus className="size-4" aria-hidden />
          </button>
          <input
            id={`${id}-qty`}
            type="number"
            inputMode="numeric"
            min={limits.min}
            {...(limits.max !== null ? { max: limits.max } : {})}
            step={1}
            value={text}
            onChange={e => commit(e.target.value)}
            onBlur={() => { if (text.trim() === '') { setText(String(limits.min)); onChange(limits.min) } }}
            aria-describedby={`${id}-err`}
            aria-invalid={shownError ? true : undefined}
            className="h-9 w-28 rounded-[var(--radius-control)] border border-border bg-background px-3 text-center text-fs-sm font-semibold tabular-nums text-hero-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
          />
          <button type="button" onClick={() => step(1)} disabled={limits.max !== null && value >= limits.max} aria-label={`More ${units}`}
            className="inline-flex size-9 items-center justify-center rounded-[var(--radius-control)] border border-border bg-card text-hero-ink transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action">
            <Plus className="size-4" aria-hidden />
          </button>
          <span className="text-fs-sm text-hero-ink-soft">{units}</span>
        </div>
        <p className="text-fs-sm text-hero-ink-soft">
          Estimated charge{' '}
          <span className="ml-1 text-fs-md font-semibold tabular-nums text-hero-ink">{chargePaise === null ? '—' : formatPaise(chargePaise)}</span>
        </p>
      </div>

      <div id={`${id}-err`} aria-live="polite">
        {shownError && (
          <p className="mt-2 flex items-start gap-1.5 text-fs-xs text-destructive" role="alert">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{shownError}
          </p>
        )}
      </div>
    </div>
  )
}

// ─── The calculator ───────────────────────────────────────────────────────────

const SERVICE_TITLES: Record<ServiceKind, string> = { whatsapp: 'WhatsApp', certificates: 'Certificates', media: 'Photos' }

export function PricingCalculator({ ctaHref, ctaLabel, initialPricing = null }: {
  ctaHref: string
  ctaLabel: string
  /** The server-rendered snapshot (same as the plan cards). Null ⇒ fetch it from the endpoint. */
  initialPricing?: PublicPricingConfig | null
}) {
  const [load, setLoad] = useState<LoadState>(initialPricing ? { status: 'ready', config: initialPricing } : { status: 'loading' })
  const [selection, setSelection] = useState<EstimateSelection | null>(initialPricing ? startingSelection(initialPricing) : null)
  const hasInitial = initialPricing !== null

  const fetchPricing = useCallback(() => {
    void loadPricing().then(config => {
      if (!config) { setLoad({ status: 'error' }); return }
      setLoad({ status: 'ready', config })
      setSelection(prev => prev ?? startingSelection(config))
    })
  }, [])

  // Only when the server could not supply pricing: one fetch, and a manual retry after a failure.
  useEffect(() => { if (!hasInitial) fetchPricing() }, [fetchPricing, hasInitial])

  const retry = () => { setLoad({ status: 'loading' }); fetchPricing() }

  if (load.status === 'loading' || (load.status === 'ready' && !selection)) {
    return (
      <div className="py-10 text-center text-fs-sm text-hero-ink-soft" role="status" aria-live="polite">
        Loading current pricing…
      </div>
    )
  }
  if (load.status === 'error' || !selection) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center" role="alert">
        <p className="text-fs-sm text-hero-ink">{PRICING_UNAVAILABLE_MESSAGE}</p>
        <button type="button" onClick={retry}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border px-3 py-1.5 text-fs-sm font-medium text-hero-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action">
          <RotateCw className="size-3.5" aria-hidden />Try again
        </button>
      </div>
    )
  }

  return <ReadyCalculator config={load.config} selection={selection} onSelection={setSelection} ctaHref={ctaHref} ctaLabel={ctaLabel} />
}

function startingSelection(config: PublicPricingConfig): EstimateSelection {
  const out = { registrations: clamp(STARTING_SELECTION.registrations, registrationLimits(config)) } as EstimateSelection
  for (const k of SERVICE_KINDS) {
    out[k] = config.services[k].available ? clamp(STARTING_SELECTION[k], serviceLimits(config, k)) : 0
  }
  return out
}

function ReadyCalculator({ config, selection, onSelection, ctaHref, ctaLabel }: {
  config: PublicPricingConfig
  selection: EstimateSelection
  onSelection: (s: EstimateSelection) => void
  ctaHref: string
  ctaLabel: string
}) {
  const estimate = useMemo(() => estimateEventCost(config, selection), [config, selection])
  const set = (key: keyof EstimateSelection) => (v: number) => onSelection({ ...selection, [key]: v })
  const t = config.terms
  const reg = estimate.registrations

  // One GST label when every priced line shares a rate; otherwise just "GST".
  const gstRates = new Set<number>([t.gstRatePercent, ...SERVICE_KINDS.flatMap(k => {
    const s = config.services[k]
    return s.available && s.config.gstRatePercent !== null && selection[k] > 0 ? [s.config.gstRatePercent] : []
  })])
  const gstLabel = gstRates.size === 1 ? `GST (${[...gstRates][0]}%)` : 'GST'

  return (
    <div>
      <p className="text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-ink">Event services</p>
      <div className="divide-y divide-border/70">
        <QuantityRow
          title="Registrations"
          units="registrations"
          hint={`First ${count(t.freeRegistrationCapacity)} free · then ${formatPaise(t.activationRatePaise)} each`}
          value={selection.registrations}
          limits={registrationLimits(config)}
          presets={[]}
          onChange={set('registrations')}
          chargePaise={reg.ok ? reg.quote.basePaise : null}
          error={reg.ok ? null : reg.message}
        />
        {SERVICE_KINDS.map(kind => {
          const s = config.services[kind]
          const line = estimate.services[kind]
          const cfg = serviceConfigFor(config, kind)
          const labels = SERVICE_LABELS[kind]
          return (
            <QuantityRow
              key={kind}
              title={SERVICE_TITLES[kind]}
              units={labels.units}
              hint={s.available && s.config.unitPricePaise !== null ? `${formatPaise(s.config.unitPricePaise)} per ${labels.unit}` : ''}
              value={selection[kind]}
              limits={serviceLimits(config, kind)}
              presets={cfg.presets.length ? cfg.presets : DEFAULT_PRESETS}
              onChange={set(kind)}
              chargePaise={line.ok ? (line.item?.basePaise ?? 0) : null}
              error={line.ok ? null : line.message}
              unavailableMessage={s.available ? undefined : `${SERVICE_TITLES[kind]} pricing isn’t available right now.`}
            />
          )
        })}
      </div>

      <dl className="mt-4 border-t-2 border-hero-ink pt-3 tabular-nums">
        <div className="flex items-baseline justify-between py-1.5">
          <dt className="text-fs-sm text-hero-ink-soft">Estimated service charges</dt>
          <dd className="text-fs-md font-semibold text-hero-ink">{estimate.totals ? formatPaise(estimate.totals.basePaise) : '—'}</dd>
        </div>
        <div className="flex items-baseline justify-between py-1.5">
          <dt className="text-fs-sm text-hero-ink-soft">{gstLabel}</dt>
          <dd className="text-fs-md font-semibold text-hero-ink">{estimate.totals ? formatPaise(estimate.totals.gstPaise) : '—'}</dd>
        </div>
        <div className="mt-1 flex items-baseline justify-between border-t border-border/70 pt-3">
          <dt className="text-fs-sm font-semibold uppercase tracking-[0.12em] text-hero-ink">Estimated total</dt>
          <dd className="text-fs-2xl font-semibold text-hero-ink" aria-live="polite">{estimate.totals ? formatPaise(estimate.totals.totalPaise) : '—'}</dd>
        </div>
      </dl>
      {!estimate.totals && (
        <p className="mt-2 text-fs-xs text-hero-ink-soft">Adjust the highlighted quantity to see a total.</p>
      )}
      <p className="mt-3 text-fs-xs leading-relaxed text-hero-ink-soft">
        A one-time, per-event estimate of event services from current pricing. The License &amp; Services step
        confirms the exact amount before you pay.
      </p>

      {/* RD-FEE-02 — paid TICKET sales are a different thing from the event services above, and two
          separate parties charge on them: RegisterDesk (its platform fee, live from the fee resolver)
          and the payment provider (gateway charges). Neither is part of the estimate. */}
      <section aria-labelledby="paid-ticket-fees" className="mt-5 rounded-[var(--radius-control)] border border-border/70 px-4 py-3">
        <p id="paid-ticket-fees" className="text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-ink">Paid ticket sales</p>
        <dl className="mt-2 space-y-1.5 text-fs-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-hero-ink-soft">RegisterDesk platform fee</dt>
            <dd className="font-semibold text-hero-ink">{formatTicketFee(config.ticketFee)}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-hero-ink-soft">Payment gateway</dt>
            <dd className="font-semibold text-hero-ink">Charged separately by the payment provider</dd>
          </div>
        </dl>
        <p className="mt-2 text-fs-2xs text-hero-ink-soft">Paid ticket charges are not included in the estimate above.</p>
      </section>

      <Link
        href={ctaHref}
        className={cn(marketingButton({ variant: 'primary', size: 'md' }), 'mt-6 h-11 w-full justify-center gap-2 rounded-[var(--radius-control)]')}
        style={{ backgroundImage: 'var(--action-gradient)' }}
      >
        {ctaLabel}
        <ArrowRight className="size-4" aria-hidden />
      </Link>
    </div>
  )
}
