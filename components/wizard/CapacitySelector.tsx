'use client'

// RD-CAPACITY-01 · The organizer chooses a registration capacity, and sees what it costs.
//
// ═══ WHAT REPLACED WHAT ══════════════════════════════════════════════════════
// This is the successor to LicenseCards. There are no tiers to compare any more and no
// feature matrix to read: every organizer has every feature, and the only commercial decision
// left is how many registrations the event will accept.
//
// ═══ THE RULE THIS COMPONENT EXISTS TO HONOUR ════════════════════════════════
// An arbitrary integer stays arbitrary. 437 is 437. The old model quantised a choice up to
// the next pack (437 → 500), and the whole point of per-registration pricing is that it does
// not have to. So the slider steps by 1 and the numeric input accepts any integer in range —
// nothing here rounds, snaps or "helpfully" adjusts what was typed.
//
// ═══ WHY THE FIGURES COME FROM THE SERVER ════════════════════════════════════
// Every amount shown is fetched from /api/licensing/capacity/activation-quote. It would be
// easy to multiply capacity by a rate here and render it instantly, and it would be wrong:
// the rate, the free allowance and the GST are configuration the client does not own, and a
// screen that computes its own total will eventually disagree with the order the server
// creates. Disagreement over a price is the one bug this surface must not have. The local
// arithmetic here is therefore limited to the things that are not money — the slider's
// position, and the chargeable-slot count used for the "X × ₹1.50" explanation.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { auth } from '@/lib/firebase/auth'
import { DEFAULT_COMMERCIAL_TERMS, type CommercialTerms } from '@/lib/licensing/capacityCommercial'
import { formatPaise, type CapacityQuote } from '@/lib/licensing/capacityPricing'

interface QuoteResponse {
  ok?:      boolean
  quote?:   CapacityQuote
  terms?:   CommercialTerms
  code?:    string
  error?:   string
}

export interface CapacitySelectorProps {
  /** The current selection. */
  capacity: number
  /** Called on every change with the RAW integer the organizer chose. */
  onChange: (capacity: number) => void
  /** RD-CE-FIX M3 — the lowest capacity allowed (e.g. what the organizer already paid for). */
  minCapacity?: number
  /** Optional: a published event's id, so its own terms and current capacity are used. */
  eventId?: string | null
  className?: string
  /**
   * RD-EVENT-COMMERCE-02 — receives every server quote (or the error), so a page can render ONE
   * consolidated cost summary from the same figures instead of this component's own panel.
   */
  onQuote?: (quote: CapacityQuote | null, error: string | null) => void
  /** Render the built-in cost panel (default true). */
  showCost?: boolean
}

/** Debounce the quote request so dragging the slider does not fire one per pixel. */
const QUOTE_DEBOUNCE_MS = 220

export function CapacitySelector({ capacity, onChange, eventId, className, onQuote, showCost = true, minCapacity }: CapacitySelectorProps) {
  // The text field keeps its own string state so a half-typed value ("4", "43") does not
  // fight the caller. An empty field is a legitimate intermediate state, not zero.
  const [text, setText] = useState(String(capacity))
  const [quote, setQuote] = useState<CapacityQuote | null>(null)
  const [terms, setTerms] = useState<CommercialTerms>(DEFAULT_COMMERCIAL_TERMS)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The field mirrors the prop when the prop changes from OUTSIDE (a preset button, the
  // slider, a reloaded draft) — but it must keep its own half-typed value while the organizer
  // is typing, so it cannot simply be `value={String(capacity)}`.
  //
  // This is React's adjust-state-when-a-prop-changes pattern rather than an effect. An effect
  // would render the stale text once, then re-render with the new text: a visible flicker on
  // every slider step, and the reason `react-hooks/set-state-in-effect` exists.
  const [lastCapacity, setLastCapacity] = useState(capacity)
  if (capacity !== lastCapacity) {
    setLastCapacity(capacity)
    setText(String(capacity))
  }

  const fetchQuote = useCallback(async (value: number) => {
    setLoading(true)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { setError(null); return }
      const endpoint = eventId
        ? '/api/licensing/capacity/quote'
        : '/api/licensing/capacity/activation-quote'
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(eventId ? { eventId, capacity: value } : { capacity: value }),
      })
      const data = await res.json() as QuoteResponse
      if (data.terms) setTerms(data.terms)
      if (res.ok && data.quote) { setQuote(data.quote); setError(null); onQuote?.(data.quote, null) }
      else {
        const msg = data.error ?? 'Could not price this capacity.'
        setQuote(null); setError(msg); onQuote?.(null, msg)
      }
    } catch {
      setQuote(null)
      // Deliberately not a price: a failed quote shows no figures at all rather than stale
      // or guessed ones.
      const msg = 'Could not reach the pricing service. Check your connection and try again.'
      setError(msg); onQuote?.(null, msg)
    } finally {
      setLoading(false)
    }
  }, [eventId, onQuote])

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void fetchQuote(capacity) }, QUOTE_DEBOUNCE_MS)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [capacity, fetchQuote])

  const min = Math.max(1, Math.floor(minCapacity ?? 1))
  const max = terms.maximumEventCapacity

  /** Accept only a whole number in range; anything else leaves the caller's value alone. */
  const commit = useCallback((raw: string) => {
    setText(raw)
    if (raw.trim() === '') return
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min || n > max) return
    onChange(n)
  }, [onChange, max, min])

  /** On blur, snap a genuinely invalid field back into range so nothing is left broken. */
  const normalise = useCallback(() => {
    const n = Number(text)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) { setText(String(capacity)); return }
    if (n > max) { setText(String(max)); onChange(max); return }
    setText(String(n))
  }, [text, capacity, max, min, onChange])

  const free = quote?.freeCapacity ?? terms.freeRegistrationCapacity
  const chargeable = quote?.chargeableCapacity ?? Math.max(0, capacity - free)
  const isFree = (quote?.totalPaise ?? 0) === 0

  // Presets are convenience, not quantisation: they set the value, and the organizer can
  // immediately type over it. They exist because most people want a round number and
  // dragging a 1-step slider to 5,000 is not a kindness.
  const presets = useMemo(
    () => [free, 250, 500, 1_000, 2_500, 5_000].filter((n, i, a) => n <= max && a.indexOf(n) === i),
    [free, max],
  )

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      {/* ── The choice ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <label htmlFor="capacity-input" className="block text-[13px] font-semibold text-foreground">
          How many registrations do you want to accept?
        </label>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          The first {free.toLocaleString('en-IN')} are free. Beyond that you pay{' '}
          {formatPaise(terms.activationRatePaise)} per registration, once.
        </p>

        <div className="mt-4 flex items-center gap-4">
          <input
            id="capacity-input"
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={text}
            onChange={e => commit(e.target.value)}
            onBlur={normalise}
            aria-label="Registration capacity"
            aria-describedby="capacity-range"
            className="w-32 rounded-lg border border-border bg-background px-3 py-2 text-[15px] font-semibold tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <span id="capacity-range" className="text-[12px] text-muted-foreground tabular-nums">
            {min.toLocaleString('en-IN')} – {max.toLocaleString('en-IN')}
          </span>
        </div>

        <input
          type="range"
          min={min}
          max={max}
          // step 1 — the slider must be able to land on any integer, because the price is
          // per registration and a snapped value would overcharge or undersell.
          step={1}
          value={Math.min(Math.max(capacity, min), max)}
          onChange={e => onChange(Number(e.target.value))}
          aria-label="Registration capacity slider"
          className="mt-4 w-full accent-[var(--primary)]"
        />

        <div className="mt-3 flex flex-wrap gap-2">
          {presets.map(n => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              aria-pressed={capacity === n}
              className={cn(
                'rounded-full border px-3 py-1 text-[12px] font-medium tabular-nums transition-colors',
                capacity === n
                  ? 'border-primary bg-primary/10 text-primary-text'
                  : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
              )}
            >
              {n.toLocaleString('en-IN')}
            </button>
          ))}
        </div>
      </div>

      {/* ── What it costs ──────────────────────────────────────────────────── */}
      {showCost && <div className="rounded-xl border border-border bg-muted/20 p-5" aria-live="polite">
        {error ? (
          <p className="flex items-start gap-2 text-[13px] text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        ) : (
          <dl className="flex flex-col gap-2.5 text-[13px]">
            <Row label="Registration capacity" value={capacity.toLocaleString('en-IN')} />
            <Row label="Free capacity" value={free.toLocaleString('en-IN')} muted />
            <Row label="Additional capacity" value={chargeable.toLocaleString('en-IN')} muted />

            <div className="my-1 border-t border-border" />

            <Row
              label={`Activation fee${chargeable > 0 ? ` (${chargeable.toLocaleString('en-IN')} × ${formatPaise(terms.activationRatePaise)})` : ''}`}
              value={quote ? formatPaise(quote.basePaise) : '—'}
            />
            <Row
              label={`GST (${quote?.gstRatePercent ?? terms.gstRatePercent}%)`}
              value={quote ? formatPaise(quote.gstPaise) : '—'}
            />

            <div className="my-1 border-t border-border" />

            <div className="flex items-baseline justify-between">
              <dt className="text-[14px] font-semibold text-foreground">Total</dt>
              <dd className="flex items-center gap-2 text-[18px] font-bold tabular-nums text-foreground">
                {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />}
                {quote ? formatPaise(quote.totalPaise) : '—'}
              </dd>
            </div>

            {isFree && quote && (
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                No payment is needed for this capacity — you can publish straight away.
              </p>
            )}
          </dl>
        )}
      </div>}
    </div>
  )
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cn('text-[13px]', muted ? 'text-muted-foreground' : 'text-foreground')}>{label}</dt>
      <dd className={cn('tabular-nums text-[13px] font-medium', muted ? 'text-muted-foreground' : 'text-foreground')}>
        {value}
      </dd>
    </div>
  )
}
