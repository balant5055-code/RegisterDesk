'use client'

// RD-EVENT-COMMERCE-02 / 03 · Choose how many prepaid units of a service to buy for this event.
//
// The organizer owns the QUANTITY; RegisterDesk owns the rate, the range, the GST and the quote.
// Every money figure here is the SERVER's (from /api/licensing/checkout/quote); this component
// computes no money. When the service is not configured for sale the control is shown but
// disabled, and it says exactly what is awaiting configuration — never a price, never "Included".
//
// `mode`:
//   total       (draft)      the quantity is the TOTAL the event will have
//   additional  (published)  the quantity is ADDITIONAL units on top of what was already bought
//
// The text field keeps its own string so a half-typed value does not fight the caller, and any
// whole number is passed up — the SERVER decides whether it is in range and says so. Presets
// are a convenience, not a quantisation. 0 means "none".

import { useId, useState } from 'react'
import { AlertCircle, Clock, PackagePlus } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import type { ServiceChargeItem } from '@/lib/licensing/serviceAllowances'
import type { CommunicationCapacityFigures } from '@/lib/communications/capacityFigures'

/** RD-EVENT-COMMERCE-05 — a specific badge per reason, never one blanket "awaiting configuration". */
export const SALE_STATE_BADGE: Record<NonNullable<ServiceCatalogEntry['state']>, string> = {
  available:      'Optional',
  not_configured: 'Not priced yet',
  disabled:       'Sales paused',
  invalid:        'Unavailable',
  unavailable:    'Temporarily unavailable',
  no_photo_limit: 'Not applicable',
}

export interface ServiceCatalogEntry {
  purchasable:    boolean
  missing:        string[]
  /** RD-EVENT-COMMERCE-05 — WHY it is (not) for sale, and the one sentence explaining it. */
  state?:         'available' | 'not_configured' | 'disabled' | 'invalid' | 'unavailable' | 'no_photo_limit'
  stateMessage?:  string
  minQuantity:    number
  maxQuantity:    number | null
  presets:        number[]
  unitPricePaise: number | null
  gstRatePercent: number | null
  onExhausted:    'block' | 'wallet_payg' | null
}

export interface ServiceQuantitySelectorProps {
  title:       string
  unit:        string   // 'message'
  units:       string   // 'messages'
  /** What one unit covers and what consumes one — from the ACTUAL billing rule. */
  usageRule:   string
  quantity:    number
  onChange:    (quantity: number) => void
  catalog:     ServiceCatalogEntry | null
  /** The server-priced line for the current quantity (null for 0 or while loading). */
  item:        ServiceChargeItem | null
  /** The server's validation message for the current quantity, if any. */
  error:       string | null
  mode?:       'total' | 'additional'
  /** Already purchased / consumed for this event. `consumed` null ⇒ not tracked as a counter. */
  purchased?:  number
  consumed?:   number | null
  /**
   * RD-COMMS-L2 — WhatsApp / certificates: the ONE organizer definition (capacityFigures), as on
   * Communications › Usage. When given it replaces purchased/consumed for the balance line, and
   * Available is the ledger's own figure (never Purchased − Used).
   */
  capacity?:   CommunicationCapacityFigures | null
  disabled?:   boolean
  /** Extra line under the balance (e.g. the media photo cap). */
  note?:       React.ReactNode
  /** RD-EVENT-COMMERCE-05 — the quote (and so the catalog) could not be loaded: say so, don't pretend "not priced". */
  unavailable?:    boolean
  /**
   * RD-PHOTO-01 — a SERVER-reported hard ceiling for this event (photos: 3,000 − the event's current
   * capacity in published mode, 3,000 − units held elsewhere in draft mode). Caps the input, slider
   * and presets; 0 ⇒ nothing more can be bought and `maxReachedMessage` is shown instead.
   */
  ceiling?:          number | null
  maxReachedMessage?: string
}

/** Quick-select quantities when the catalog sets none (presentation only — never a price). Shared with the public calculator. */
export const DEFAULT_PRESETS = [100, 500, 1_000, 2_500, 5_000, 10_000]

export function ServiceQuantitySelector({
  title, unit, units, usageRule, quantity, onChange, catalog, item, error,
  mode = 'total', purchased = 0, consumed = 0, capacity = null, disabled, note, unavailable = false,
  ceiling = null, maxReachedMessage,
}: ServiceQuantitySelectorProps) {
  const id = useId()
  const [text, setText] = useState(String(quantity))
  const [last, setLast] = useState(quantity)
  if (quantity !== last) { setLast(quantity); setText(String(quantity)) }

  const maxReached = ceiling !== null && ceiling <= 0
  const purchasable = catalog?.purchasable === true && !disabled && !maxReached
  const min = catalog?.minQuantity ?? 1
  const catalogMax = catalog?.maxQuantity ?? null
  const max = ceiling === null ? catalogMax : catalogMax === null ? ceiling : Math.min(catalogMax, ceiling)
  const presets = (catalog?.presets?.length ? catalog.presets : DEFAULT_PRESETS)
    .filter(n => n >= min && (max === null || n <= max))
  // RD-EVENT-COMMERCE-05A — no RegisterDesk maximum (confirmed) ⇒ the SLIDER spans up to the
  // largest quick-select (or the current quantity, whichever is larger). Display only: the input
  // accepts any whole number ≥ the minimum, and the server is the only judge of the quantity.
  const sliderMax = max ?? Math.max(min, quantity, ...(presets.length ? presets : [min]))

  const commit = (raw: string) => {
    setText(raw)
    if (raw.trim() === '') return
    const n = Number(raw)
    if (Number.isInteger(n) && n >= 0) onChange(n)
  }
  const localError = text.trim() !== '' && !(Number.isInteger(Number(text)) && Number(text) >= 0)
    ? `Enter a whole number of ${units}.` : null
  const shownError = localError ?? error
  const tracked = consumed !== null
  const remaining = tracked ? Math.max(0, purchased - (consumed ?? 0)) : null
  const hasCapacity = capacity !== null && capacity.purchased + capacity.carriedIn > 0
  const exhausted = capacity !== null ? hasCapacity && capacity.available === 0 : purchased > 0 && tracked && remaining === 0
  const showBalance = capacity !== null ? hasCapacity : purchased > 0
  const q = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-IN'))
  const label = mode === 'additional' ? `Additional ${units} to buy` : `${units[0].toUpperCase()}${units.slice(1)} to buy`

  return (
    <div className={cn('rounded-xl border border-border bg-card p-4 sm:p-5', !purchasable && 'bg-muted/[0.25]')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-[13px] font-semibold text-foreground">{title}</p>
        {/* RD-PHOTO-01 — a maxed-out service is still PRICED; it just has nothing left to sell. */}
        {!catalog && !unavailable ? null : catalog && (purchasable || (maxReached && catalog.purchasable)) ? (
          <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-0.5 text-[11.5px] font-semibold text-primary-text tabular-nums">
            {formatPaise(catalog.unitPricePaise ?? 0)} / {unit} + {catalog.gstRatePercent}% GST
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-[11.5px] font-semibold text-muted-foreground">
            <Clock className="size-3" aria-hidden />{SALE_STATE_BADGE[unavailable || !catalog ? 'unavailable' : (catalog.state ?? 'not_configured')]}
          </span>
        )}
      </div>
      <p className="mt-1 text-[12px] text-muted-foreground">{usageRule}</p>

      {(showBalance || note) && (
        <div className={cn('mt-3 rounded-lg px-3 py-2 text-[12px] tabular-nums', exhausted ? 'bg-amber-50 text-amber-800' : 'bg-muted/40 text-foreground')}>
          {capacity !== null && hasCapacity && (
            <p>
              Purchased {q(capacity.purchased)}
              {capacity.carriedIn > 0 && <> · carried in {q(capacity.carriedIn)}</>}
              {' '}· used {q(capacity.used)}
              {(capacity.inProgress ?? 0) > 0 && <> · in progress {q(capacity.inProgress)}</>}
              {' '}· <span className="font-semibold">{exhausted ? 'Used up' : `${q(capacity.available)} available`}</span>
            </p>
          )}
          {capacity === null && purchased > 0 && (
            <p>
              Purchased {purchased.toLocaleString('en-IN')}
              {tracked && <> · used {(consumed ?? 0).toLocaleString('en-IN')} · <span className="font-semibold">{exhausted ? 'Used up' : `${(remaining ?? 0).toLocaleString('en-IN')} remaining`}</span></>}
            </p>
          )}
          {note && <p className={showBalance ? 'mt-0.5' : ''}>{note}</p>}
          {exhausted && purchasable && quantity === 0 && (
            <button type="button" onClick={() => onChange(Math.max(min, presets[0] ?? min))}
              className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-amber-100 px-2 py-1 text-[12px] font-semibold text-amber-900 hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <PackagePlus className="size-3.5" aria-hidden />Buy more
            </button>
          )}
        </div>
      )}

      <label htmlFor={`${id}-qty`} className="mt-4 block text-[12px] font-medium text-foreground">{label}</label>
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        <input
          id={`${id}-qty`}
          type="number"
          inputMode="numeric"
          min={0}
          {...(max !== null ? { max } : {})}
          step={1}
          value={text}
          disabled={!purchasable}
          onChange={e => commit(e.target.value)}
          onBlur={() => { if (text.trim() === '') { setText('0'); onChange(0) } }}
          aria-describedby={`${id}-range ${id}-err`}
          aria-invalid={shownError ? true : undefined}
          className="w-32 rounded-lg border border-border bg-background px-3 py-2 text-[15px] font-semibold tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span id={`${id}-range`} className="text-[12px] text-muted-foreground tabular-nums">
          {maxReached
            ? <>{maxReachedMessage ?? 'Maximum reached'}</>
            : !purchasable
            ? <>Not available to buy</>
            : max !== null
              // RD-EVENT-COMMERCE-05B — the SERVER-resolved range (catalog.minQuantity / maxQuantity), never
              // the slider's visual extent. 0 ("None") is always allowed and is not part of the range.
              ? <>{min.toLocaleString('en-IN')}–{max.toLocaleString('en-IN')} {units}</>
              : <>{min.toLocaleString('en-IN')} or more · No maximum</>}
        </span>
      </div>

      {purchasable && (
        <>
          <input
            type="range"
            min={0}
            max={sliderMax}
            step={1}
            value={Math.min(Math.max(quantity, 0), sliderMax)}
            onChange={e => onChange(Number(e.target.value))}
            aria-label={`${title} slider`}
            aria-valuetext={`${quantity.toLocaleString('en-IN')} ${units}`}
            className="mt-4 w-full accent-[var(--primary)]"
          />
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums" aria-hidden>
            <span>0</span>
            <span className="font-semibold text-foreground">{quantity.toLocaleString('en-IN')} {units}</span>
            <span>{sliderMax.toLocaleString('en-IN')}{max === null ? '+' : ''}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => onChange(0)} aria-pressed={quantity === 0}
              className={cn('rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
                quantity === 0 ? 'border-primary bg-primary/10 text-primary-text' : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground')}>
              None
            </button>
            {presets.map(n => (
              <button key={n} type="button" onClick={() => onChange(n)} aria-pressed={quantity === n}
                className={cn('rounded-full border px-3 py-1 text-[12px] font-medium tabular-nums transition-colors',
                  quantity === n ? 'border-primary bg-primary/10 text-primary-text' : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground')}>
                {n.toLocaleString('en-IN')}
              </button>
            ))}
          </div>
        </>
      )}

      <div id={`${id}-err`} aria-live="polite">
        {shownError && (
          <p className="mt-3 flex items-start gap-1.5 text-[12.5px] text-destructive" role="alert">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{shownError}
          </p>
        )}
        {!purchasable && !maxReached && (catalog || unavailable) && !disabled && (
          <p className="mt-3 text-[12px] text-muted-foreground" role="status">
            {unavailable || !catalog
              ? `Prepaid ${units} pricing couldn’t be loaded just now. Try again in a moment — nothing is charged.`
              : catalog.stateMessage || `Prepaid ${units} can’t be purchased yet — awaiting ${catalog.missing.join(', ')}. Nothing is charged for this.`}
          </p>
        )}
        {purchasable && item && !shownError && (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted/30 px-3 py-2 text-[12.5px] tabular-nums sm:grid-cols-4">
            <div><dt className="text-[11px] text-muted-foreground">Quantity</dt><dd className="font-semibold">{item.quantity.toLocaleString('en-IN')}</dd></div>
            <div><dt className="text-[11px] text-muted-foreground">Subtotal</dt><dd className="font-semibold">{formatPaise(item.basePaise)}</dd></div>
            <div><dt className="text-[11px] text-muted-foreground">GST {item.gstRatePercent}%</dt><dd className="font-semibold">{formatPaise(item.gstPaise)}</dd></div>
            <div><dt className="text-[11px] text-muted-foreground">Total</dt><dd className="font-bold">{formatPaise(item.totalPaise)}</dd></div>
          </dl>
        )}
      </div>
    </div>
  )
}
