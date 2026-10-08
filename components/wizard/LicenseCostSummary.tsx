'use client'

// RD-EVENT-COMMERCE-02 / 03 · ONE itemized summary of everything the organizer is buying on the
// License & Services step, and what is payable NOW.
//
// Every number is the SERVER's — the coverage-aware quote from /api/licensing/checkout/quote and,
// for an activation coupon, /api/licensing/coupons/validate. This component adds nothing up the
// server did not already add up, except applying the coupon's server-computed discount to the
// activation line it belongs to. Nothing selected is ever omitted: an item that cannot be priced
// is listed as such and blocks payment rather than being treated as free.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Tag, X, Loader2, AlertTriangle, Receipt } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { auth } from '@/lib/firebase/auth'
import { formatPaise, type CapacityQuote } from '@/lib/licensing/capacityPricing'
import { SERVICE_KINDS, SERVICE_LABELS, type ServiceChargeItem, type ServiceKind, type ServiceSelection } from '@/lib/licensing/serviceAllowances'
import { SALE_STATE_BADGE } from './ServiceQuantitySelector'
import type { CommunicationCapacityFigures } from '@/lib/communications/capacityFigures'

export interface CatalogEntryDto { purchasable: boolean; missing: string[]; state?: 'available' | 'not_configured' | 'disabled' | 'invalid' | 'unavailable' | 'no_photo_limit'; stateMessage?: string; minQuantity: number; maxQuantity: number | null; presets: number[]; unitPricePaise: number | null; gstRatePercent: number | null; onExhausted: 'block' | 'wallet_payg' | null }

export interface CheckoutQuoteResponse {
  mode:     'draft' | 'published'
  catalog:  Record<ServiceKind, CatalogEntryDto>
  capacity: { ok: true; quote: CapacityQuote } | { ok: false; code: string; error: string }
  services: Record<ServiceKind, { ok: true; item: ServiceChargeItem | null } | { ok: false; code: string; error: string }>
  totals:   { activationPaise: number; servicesPaise: number; basePaise: number; gstPaise: number; totalPaise: number }
  payable:  { kind: 'activation' | 'addon' | 'covered' | 'capacity_change'; capacityCharge: CapacityQuote | null; serviceItems: ServiceChargeItem[]; totalPaise: number } | null
  coverage: {
    activationPaid: boolean; paidCapacity: number | null; purchased: ServiceSelection; consumed: ServiceSelection; remaining: ServiceSelection
    /** RD-COMMS-L2 — the ONE organizer definition (lib/communications/capacityFigures), as on Usage. */
    communication?: { whatsapp: CommunicationCapacityFigures; certificates: CommunicationCapacityFigures }
  } | null
  published: { currentCapacity: number; sold: number; eligible: boolean } | null
  /**
   * RD-PHOTO-01 — the event's PAID photo capacity (server). baseCap is always 0 (no free photos);
   * capacity = net paid units; maxTotal = 3,000; maxAdditional = 3,000 − capacity.
   */
  media:    { baseCap: number | null; used: number | null; capacity: number; purchased: number; maxTotal: number; maxAdditional: number }
}

function Row({ label, value, strong, muted, indent }: { label: ReactNode; value: ReactNode; strong?: boolean; muted?: boolean; indent?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-1 text-[12.5px]', indent && 'pl-3')}>
      <span className={cn(strong ? 'font-semibold text-foreground' : 'text-muted-foreground', muted && 'text-muted-foreground/80')}>{label}</span>
      <span className={cn('shrink-0 tabular-nums', strong ? 'font-bold text-foreground' : 'font-medium text-foreground', muted && 'text-muted-foreground')}>{value}</span>
    </div>
  )
}
function Block({ title, tag, children }: { title: string; tag?: ReactNode; children: ReactNode }) {
  return (
    <div className="py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12.5px] font-semibold text-foreground">{title}</p>
        {tag}
      </div>
      <div className="mt-0.5">{children}</div>
    </div>
  )
}
const Tagline = ({ tone, children }: { tone: 'ok' | 'muted' | 'warn'; children: ReactNode }) => (
  <span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-semibold',
    tone === 'ok' ? 'bg-emerald-50 text-emerald-700' : tone === 'warn' ? 'bg-amber-50 text-amber-700' : 'bg-muted text-muted-foreground')}>{children}</span>
)

export function LicenseCostSummary({
  quote, quoting, draftId, capacity, onCouponChange, onPayableAmount,
}: {
  quote:    CheckoutQuoteResponse | null
  quoting:  boolean
  draftId:  string | null
  capacity: number
  onCouponChange: (code: string | null) => void
  /** Reports the amount payable now (coupon applied), or null when payment is not possible. */
  onPayableAmount: (paise: number | null) => void
}) {
  const published = quote?.mode === 'published'
  const cap = quote?.capacity.ok ? quote.capacity.quote : null
  const payable = quote?.payable ?? null

  // ── Coupon (activation only; the server re-validates on purchase) ──────────────
  const [code, setCode]       = useState('')
  const [applied, setApplied] = useState<{ code: string; discountPaise: number } | null>(null)
  const [validating, setValidating] = useState(false)
  const [couponError, setCouponError] = useState('')
  const couponAllowed = !published && payable?.kind === 'activation' && (cap?.totalPaise ?? 0) > 0

  useEffect(() => {
    const t = setTimeout(() => { setApplied(null); setCode(''); setCouponError(''); onCouponChange(null) }, 0)
    return () => clearTimeout(t)
  }, [capacity, onCouponChange])

  const applyCoupon = useCallback(async () => {
    const c = code.trim().toUpperCase()
    if (!c || !draftId) return
    setValidating(true); setCouponError('')
    try {
      const token = await auth.currentUser?.getIdToken()
      const res = await fetch('/api/licensing/coupons/validate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body:    JSON.stringify({ eventId: draftId, capacity, couponCode: c }),
      })
      const j = await res.json() as { valid?: boolean; message?: string; discountPaise?: number }
      if (!res.ok || !j.valid) { setCouponError(j.message ?? 'This coupon is not valid.'); return }
      setApplied({ code: c, discountPaise: j.discountPaise ?? 0 }); onCouponChange(c)
    } catch {
      setCouponError('Could not validate the coupon. Please try again.')
    } finally { setValidating(false) }
  }, [code, draftId, capacity, onCouponChange])

  const discount = applied && couponAllowed ? Math.min(applied.discountPaise, cap?.totalPaise ?? 0) : 0
  const payNow = payable ? Math.max(0, payable.totalPaise - discount) : null
  useEffect(() => { onPayableAmount(payNow) }, [payNow, onPayableAmount])

  const capChanged = !!cap && !(published && cap.kind === 'unchanged')
  const paidBefore = !published && quote?.coverage?.activationPaid && payable && payable.kind !== 'activation'
    ? Math.max(0, quote.totals.totalPaise - payable.totalPaise) : 0

  return (
    <section aria-labelledby="license-cost-heading" className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
          <Receipt className="size-4 text-primary" aria-hidden />
        </div>
        <div className="min-w-0">
          <p id="license-cost-heading" className="text-[14px] font-bold tracking-tight text-foreground">Cost summary</p>
          <p className="text-[11.5px] text-muted-foreground">Calculated by RegisterDesk · rates excl. GST</p>
        </div>
        {quoting && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" aria-label="Updating" />}
      </div>

      <div className="divide-y divide-border/40 px-5" aria-live="polite">
        {!quote ? (
          <p className="py-4 text-[12.5px] text-muted-foreground">Calculating…</p>
        ) : (
          <>
            {/* ── Registration capacity ── */}
            <Block title="Registration capacity" tag={published ? <Tagline tone="muted">{cap?.kind === 'unchanged' ? 'No change' : cap?.kind === 'decrease' ? 'Reduction' : 'Increase'}</Tagline> : null}>
              {!quote.capacity.ok ? (
                <p role="alert" className="flex items-start gap-1.5 py-1 text-[12.5px] text-destructive"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{quote.capacity.error}</p>
              ) : cap && published ? (
                <>
                  <Row label="Current capacity" value={(cap.previousCapacity ?? cap.capacity).toLocaleString('en-IN')} indent />
                  <Row label="New capacity" value={cap.capacity.toLocaleString('en-IN')} indent />
                  {quote.published && <Row label="Registrations taken" value={quote.published.sold.toLocaleString('en-IN')} indent muted />}
                  {cap.kind === 'increase' && <Row label={`Additional capacity × ${formatPaise(cap.activationRatePaise)}`} value={`${cap.chargeableCapacity.toLocaleString('en-IN')} → ${formatPaise(cap.basePaise)}`} indent />}
                  {cap.kind === 'decrease' && <Row label={`Reduction charge (${cap.decreaseFeePercent ?? 0}% of ${formatPaise(cap.removedCapacityValuePaise ?? 0)})`} value={formatPaise(cap.basePaise)} indent />}
                  {capChanged && <Row label={`GST ${cap.gstRatePercent}%`} value={formatPaise(cap.gstPaise)} indent />}
                  {capChanged && <Row label="Capacity total" value={formatPaise(cap.totalPaise)} indent strong />}
                </>
              ) : cap ? (
                <>
                  <Row label="Registrations" value={cap.capacity.toLocaleString('en-IN')} indent />
                  <Row label="Free capacity" value={cap.freeCapacity.toLocaleString('en-IN')} indent />
                  <Row label="Additional capacity" value={cap.chargeableCapacity.toLocaleString('en-IN')} indent />
                  <Row label="Activation rate" value={`${formatPaise(cap.activationRatePaise)} / registration`} indent />
                  <Row label="Activation subtotal" value={formatPaise(cap.basePaise)} indent />
                  <Row label={`GST ${cap.gstRatePercent}%`} value={formatPaise(cap.gstPaise)} indent />
                  <Row label="Capacity total" value={formatPaise(cap.totalPaise)} indent strong />
                </>
              ) : null}
            </Block>

            {/* ── Prepaid services ── */}
            {SERVICE_KINDS.map(k => {
              const s = quote.services[k], c = quote.catalog[k], L = SERVICE_LABELS[k]
              // RD-EVENT-COMMERCE-05 — the specific reason, not one blanket "awaiting configuration".
              const tag = !c.purchasable ? <Tagline tone="muted">{SALE_STATE_BADGE[c.state ?? 'not_configured']}</Tagline> : <Tagline tone="ok">Optional</Tagline>
              if (!s.ok) return <Block key={k} title={L.title} tag={tag}><p role="alert" className="py-1 text-[12.5px] text-destructive">{s.error}</p></Block>
              if (!s.item) return <Block key={k} title={L.title} tag={tag}><Row label={c.purchasable ? 'Not selected' : 'Not included'} value="—" indent muted /></Block>
              const i = s.item
              return (
                <Block key={k} title={L.title} tag={tag}>
                  <Row label={`${published ? 'Additional ' : ''}${L.units}`} value={i.quantity.toLocaleString('en-IN')} indent />
                  <Row label="Unit rate" value={`${formatPaise(i.unitPricePaise)} / ${L.unit}`} indent />
                  <Row label="Subtotal" value={formatPaise(i.basePaise)} indent />
                  <Row label={`GST ${i.gstRatePercent}%`} value={formatPaise(i.gstPaise)} indent />
                  <Row label={`${L.title.split(' ')[0]} total`} value={formatPaise(i.totalPaise)} indent strong />
                </Block>
              )
            })}

            <Block title="Included & unavailable">
              <Row label="Email notifications" value={<Tagline tone="ok">Included</Tagline>} indent />
              <Row label="SMS notifications" value={<Tagline tone="warn">Unavailable</Tagline>} indent />
            </Block>

            {/* ── Totals ── */}
            <div className="py-2.5">
              <Row label="Subtotal (excl. GST)" value={formatPaise(quote.totals.basePaise)} />
              <Row label="GST" value={formatPaise(quote.totals.gstPaise)} />
              {discount > 0 && applied && (
                <Row label={<span className="inline-flex items-center gap-1.5 text-emerald-700"><Tag className="size-3" aria-hidden />Coupon {applied.code} (activation)</span>}
                  value={<span className="text-emerald-700">−{formatPaise(discount)}</span>} />
              )}
              <Row strong label={published ? 'Total for this purchase' : 'Total for this selection'} value={formatPaise(Math.max(0, quote.totals.totalPaise - discount))} />
              {paidBefore > 0 && <Row muted label="Already paid for this selection" value={`−${formatPaise(paidBefore)}`} />}
            </div>
          </>
        )}
      </div>

      {couponAllowed && draftId && (
        <div className="border-t border-border/40 px-5 py-3">
          {applied ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-emerald-700"><Tag className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{applied.code} applied · −{formatPaise(applied.discountPaise)}</span></span>
              <button type="button" onClick={() => { setApplied(null); setCode(''); onCouponChange(null) }} aria-label="Remove coupon"
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-emerald-700 hover:bg-emerald-100"><X className="size-3.5" aria-hidden />Remove</button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <input value={code} onChange={e => { setCode(e.target.value.toUpperCase()); if (couponError) setCouponError('') }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void applyCoupon() } }}
                  placeholder="Activation coupon code" aria-label="Activation coupon code"
                  className="h-9 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-[12.5px] font-semibold uppercase tracking-wide text-foreground placeholder:font-normal placeholder:normal-case placeholder:tracking-normal placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/15" />
                <button type="button" onClick={() => void applyCoupon()} disabled={!code.trim() || validating}
                  className="inline-flex h-9 shrink-0 items-center rounded-xl border border-border px-3.5 text-[12.5px] font-semibold text-foreground hover:bg-muted/50 disabled:opacity-50">
                  {validating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : 'Apply'}
                </button>
              </div>
              {couponError && <p role="alert" className="mt-1.5 text-[11.5px] text-destructive">{couponError}</p>}
              <p className="mt-1.5 text-[11px] text-muted-foreground">Coupons apply to the activation fee only, not to prepaid services.</p>
            </>
          )}
        </div>
      )}

      <div className="border-t border-border bg-muted/30 px-5 py-3.5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[12.5px] font-semibold text-foreground">Payable now</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {!payable ? 'Resolve the items above to pay'
                : payable.kind === 'covered' ? 'Nothing to pay'
                : payable.kind === 'addon' ? (published ? 'Additional services, incl. GST' : 'The difference from what you already paid')
                : payable.kind === 'capacity_change' ? 'Capacity change and any services, incl. GST'
                : 'One-time, incl. GST'}
            </p>
          </div>
          <span className={cn('text-[20px] font-extrabold tabular-nums', payNow ? 'text-primary-text' : 'text-foreground')}>
            {payNow === null ? '—' : formatPaise(payNow)}
          </span>
        </div>
      </div>

      <div className="border-t border-border/40 px-5 py-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          WhatsApp messages and certificates are sent only from the capacity you buy here; buy more here at any
          time while the event is open. Unused prepaid units are tracked per event; after the event closes you can request a refund or
          carry them to another event from the Wallet. Every request is reviewed — nothing is refunded automatically.
        </p>
      </div>
    </section>
  )
}
