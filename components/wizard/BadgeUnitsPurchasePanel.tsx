'use client'

// RD-PRINT-BILL-P6 · ID BADGES on License & Services — buy prepaid ID-badge units for a PUBLISHED
// event. Its OWN purchase and Pay button, separate from the combined licence cost summary (a badge
// purchase is its own order, `bdg_…` — Phase 4), and no new route or modal:
//
//   price   POST /api/organizer/events/[slug]/print-badges/quote     { quantity, couponCode? }
//   order   POST /api/organizer/events/[slug]/print-badges/purchase  { quantity, couponCode?, requestId, expectedNetPaise }
//   pay     openCheckout(handoff)  — the shared provider-neutral checkout (never decides success)
//   confirm POST /api/licensing/checkout/confirm                     { eventId: slug, orderId, razorpay_* }
//
// Every amount is the server's quote; the browser computes no price, GST or discount. A purchase is
// applied only when the SERVER reports it (confirm success, a free-coupon order, or already paid).
// Owner-only on the server; the controls appear only when the server summary says this caller can buy.

import { useCallback, useEffect, useState } from 'react'
import { IdCard, Loader2, CheckCircle2, Info } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Button, StatusChip } from '@/components/ui'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import { useOptionalEventContext } from '@/components/dashboard/EventContextProvider'
import { openCheckout } from '@/lib/payments/checkout/clientCheckout'
import { useBadgeSummary, BADGE_MODE_LABEL } from '@/components/print-assets/badges/BadgeBalanceCard'
import { mapPurchaseResponse, PURCHASE_STATE_TEXT } from '@/components/print-assets/badges/badgeErrors'

/** The purchase quote, as the quote route returns it. */
interface BadgePurchaseQuote {
  quantity: number; unitPricePaise: number; priceSource: string
  grossPaise: number; discountPaise: number; netPaise: number
  gstRatePercent: number; netBasePaise: number; netGstPaise: number
  couponCode: string | null; currency: string; minQuantity: number; maxQuantity: number | null; free: boolean
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'working'; text: string }
  | { kind: 'done'; text: string }
  | { kind: 'message'; tone: 'info' | 'warn'; text: string; canCheck?: boolean }

async function call(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  try {
    const token = await auth.currentUser?.getIdToken()
    const res = await fetch(url, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  } catch {
    return { status: 0, body: null }
  }
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `bdg-${Date.now()}-${Math.random().toString(36).slice(2)}`)

export function BadgeUnitsPurchasePanel({ draftId, onPurchased }: {
  draftId: string
  /** After the server applied units (the step returns to the Wallet when it was the hand-off). */
  onPurchased?: () => void
}) {
  const eventCtx = useOptionalEventContext()
  const eventsLoading = eventCtx?.loading ?? false
  const event = eventCtx?.events.find(e => e.draftId === draftId) ?? null
  const slug = event?.slug ?? null          // the ownership-checked PUBLISHED slug, never the draft pointer
  const [reloadKey, setReloadKey] = useState(0)
  const { summary, error: summaryError, loading, retry } = useBadgeSummary(slug, reloadKey)

  const [qtyText, setQtyText] = useState('')
  const [coupon, setCoupon] = useState('')
  const quantity = /^\d{1,7}$/.test(qtyText.trim()) ? Number(qtyText.trim()) : null
  const couponCode = coupon.trim().toUpperCase() || null
  const selectionKey = `${quantity ?? ''}|${couponCode ?? ''}`

  // ── The server quote for the current selection (debounced) ──────────────────────────
  const [quote, setQuote] = useState<{ key: string; quote: BadgePurchaseQuote | null; error: string | null } | null>(null)
  // The SERVER says whether this caller can buy (owner + purchases available); the routes re-check.
  const canBuy = !!slug && summary?.purchase.canBuy === true
  useEffect(() => {
    if (!canBuy || quantity === null || quantity <= 0) return
    let alive = true
    const t = setTimeout(() => {
      void call(`/api/organizer/events/${encodeURIComponent(slug!)}/print-badges/quote`, { quantity, ...(couponCode ? { couponCode } : {}) }).then(r => {
        if (!alive) return
        const b = (r.body ?? {}) as { quote?: BadgePurchaseQuote; error?: string }
        if (r.status === 200 && b.quote) setQuote({ key: selectionKey, quote: b.quote, error: null })
        else setQuote({ key: selectionKey, quote: null, error: b.error ?? (r.status === 0 ? 'Could not reach RegisterDesk.' : 'Could not price this purchase.') })
      })
    }, 400)
    return () => { alive = false; clearTimeout(t) }
  }, [canBuy, slug, quantity, couponCode, selectionKey])
  const current = quote && quote.key === selectionKey ? quote : null

  // ONE requestId per purchase intent (this quantity + coupon): a retry, a dismissed checkout or a
  // double click reuses it, so the server resolves the SAME order. A different selection is a new intent.
  const [intent, setIntent] = useState<{ key: string; requestId: string } | null>(null)
  const requestIdFor = useCallback((key: string) => {
    if (intent && intent.key === key) return intent.requestId
    const next = { key, requestId: newId() }
    setIntent(next)
    return next.requestId
  }, [intent])

  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [lastConfirm, setLastConfirm] = useState<Record<string, unknown> | null>(null)

  const applied = useCallback((text: string) => {
    setStage({ kind: 'done', text })
    setIntent(null); setLastConfirm(null)
    setReloadKey(k => k + 1)
    onPurchased?.()
  }, [onPurchased])

  const confirm = useCallback(async (payload: Record<string, unknown>) => {
    setStage({ kind: 'working', text: 'Verifying your payment…' })
    const r = await call('/api/licensing/checkout/confirm', payload)
    const o = mapPurchaseResponse(r.status, r.body)
    if (o.kind === 'applied' || o.kind === 'already_paid') return applied('Payment verified — your ID badges have been added.')
    if (o.kind === 'processing') return setStage({ kind: 'message', tone: 'info', text: o.message, canCheck: true })
    if (o.kind === 'held') return setStage({ kind: 'message', tone: 'warn', text: o.message })
    if (o.kind === 'refused') return setStage({ kind: 'message', tone: 'warn', text: o.message, canCheck: o.retryable })
    setStage({ kind: 'message', tone: 'warn', text: 'Your payment could not be verified. Please do not pay again — check status in a moment.', canCheck: true })
  }, [applied])

  const pay = useCallback(async () => {
    const q = current?.quote
    if (!slug || !q || stage.kind === 'working') return
    setStage({ kind: 'working', text: 'Starting your purchase…' })
    const requestId = requestIdFor(selectionKey)
    const r = await call(`/api/organizer/events/${encodeURIComponent(slug)}/print-badges/purchase`, {
      quantity: q.quantity, ...(q.couponCode ? { couponCode: q.couponCode } : {}), requestId, expectedNetPaise: q.netPaise,
    })
    const o = mapPurchaseResponse(r.status, r.body)
    if (o.kind === 'applied') return applied(`${(o.quantity ?? q.quantity).toLocaleString('en-IN')} ID badges added.`)
    if (o.kind === 'already_paid') return applied('This purchase was already paid — your ID badges are on the event.')
    if (o.kind !== 'checkout') {
      return setStage({ kind: 'message', tone: o.kind === 'processing' ? 'info' : 'warn', text: o.kind === 'refused' || o.kind === 'processing' || o.kind === 'held' ? o.message : 'Could not start this purchase.' })
    }
    const b = r.body as { orderId: string; checkout: { provider: 'razorpay'; razorpayOrderId: string; amountPaise: number; currency: string; keyId: string } }
    const user = auth.currentUser
    setStage({ kind: 'working', text: 'Complete the payment in the Razorpay window…' })
    const outcome = await openCheckout({ provider: 'razorpay', keyId: b.checkout.keyId }, {
      orderId: b.checkout.razorpayOrderId, amountPaise: b.checkout.amountPaise, currency: b.checkout.currency,
      eventName: event?.name ?? 'RegisterDesk', passName: `${q.quantity.toLocaleString('en-IN')} ID badges`,
      attendeeName: user?.displayName ?? '', attendeeEmail: user?.email ?? '',
    })
    if (outcome.kind === 'signed') {
      const payload = { eventId: slug, orderId: b.orderId, ...outcome.payload }
      setLastConfirm(payload)
      return confirm(payload)
    }
    if (outcome.kind === 'dismissed') return setStage({ kind: 'message', tone: 'info', text: 'Payment not completed. Your order is kept — select Pay again to resume it.' })
    if (outcome.kind === 'unavailable') return setStage({ kind: 'message', tone: 'warn', text: 'The payment window could not be opened. Check your connection and try again.' })
    setStage({ kind: 'message', tone: 'info', text: 'Payment submitted — it will be applied once verified.' })
  }, [current, slug, stage.kind, requestIdFor, selectionKey, applied, event?.name, confirm])

  const busy = stage.kind === 'working'

  return (
    <div id="license-service-print_badges" className="scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-start gap-3.5 px-4 py-4 sm:px-5">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/[0.08]"><IdCard className="size-4 text-primary" aria-hidden /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13.5px] font-semibold text-foreground">Prepaid ID badges</p>
            {summary && <StatusChip tone={summary.billing.mode === 'paid' ? 'primary' : 'neutral'}>{BADGE_MODE_LABEL[summary.billing.mode]}</StatusChip>}
          </div>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Bought separately from the licence above, with its own payment. One unit prints one attendee&apos;s ID card or badge for the first time; reprints are free.
          </p>
        </div>
        {summary && <div className="text-right"><p className="text-[11px] text-muted-foreground">Available</p><p className="text-[20px] font-bold leading-tight tabular-nums text-foreground">{summary.units.available.toLocaleString('en-IN')}</p></div>}
      </div>

      <div className="border-t border-border/50 bg-muted/[0.15] px-4 py-4 text-[12.5px] sm:px-5">
        {(eventsLoading || loading) && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-3.5 animate-spin" aria-hidden />Loading ID badges…</p>}
        {!eventsLoading && !slug && <p className="text-muted-foreground">ID badges can be bought once the event is published.</p>}
        {summaryError && <p className="text-muted-foreground">{summaryError} <button type="button" onClick={retry} className="font-semibold text-primary hover:underline">Retry</button></p>}

        {summary && !canBuy && (
          <p className="text-muted-foreground">
            {summary.purchase.state !== 'available' ? PURCHASE_STATE_TEXT[summary.purchase.state] : 'Only the workspace owner can buy ID badges.'}
          </p>
        )}

        {summary && canBuy && (
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="block">
              <span className="mb-1 block font-medium text-foreground">Badges to buy</span>
              <input inputMode="numeric" value={qtyText} onChange={e => setQtyText(e.target.value)} placeholder={current?.quote ? String(current.quote.minQuantity) : 'e.g. 100'}
                aria-describedby="badge-qty-help" className="h-10 w-full rounded-lg border border-border bg-background px-3 text-[13px] tabular-nums" disabled={busy} />
            </label>
            <label className="block">
              <span className="mb-1 block font-medium text-foreground">Coupon <span className="font-normal text-muted-foreground">(optional)</span></span>
              <input value={coupon} onChange={e => setCoupon(e.target.value)} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-[13px] uppercase" disabled={busy} />
            </label>
            <Button onClick={() => void pay()} disabled={busy || !current?.quote} isLoading={busy} className="h-10">
              {current?.quote ? (current.quote.free ? 'Apply free badges' : `Pay ${formatPaise(current.quote.netPaise)}`) : 'Pay'}
            </Button>
            <div id="badge-qty-help" className="sm:col-span-3">
              {current?.error && <p className="text-amber-800">{current.error}</p>}
              {current?.quote && (
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                  <div><dt className="inline">Price </dt><dd className="inline font-semibold text-foreground">{formatPaise(current.quote.unitPricePaise)}</dd> each, incl. GST</div>
                  <div><dt className="inline">Subtotal </dt><dd className="inline font-semibold text-foreground">{formatPaise(current.quote.grossPaise)}</dd></div>
                  {current.quote.discountPaise > 0 && <div><dt className="inline">Coupon </dt><dd className="inline font-semibold text-foreground">−{formatPaise(current.quote.discountPaise)}</dd></div>}
                  <div><dt className="inline">You pay </dt><dd className="inline font-semibold text-foreground">{formatPaise(current.quote.netPaise)}</dd> (incl. {formatPaise(current.quote.netGstPaise)} GST)</div>
                  <div>Minimum {current.quote.minQuantity.toLocaleString('en-IN')}{current.quote.maxQuantity !== null && <> · maximum {current.quote.maxQuantity.toLocaleString('en-IN')}</>}</div>
                </dl>
              )}
            </div>
          </div>
        )}

        {stage.kind !== 'idle' && (
          <div role="status" className={cn('mt-3 flex items-start gap-2 rounded-lg p-2.5',
            stage.kind === 'done' ? 'bg-emerald-50 text-emerald-800' : stage.kind === 'message' && stage.tone === 'warn' ? 'bg-amber-50 text-amber-900' : 'bg-surface-3 text-foreground')}>
            {stage.kind === 'working' ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
              : stage.kind === 'done' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
            <p>{stage.text}{stage.kind === 'message' && stage.canCheck && lastConfirm && <> <button type="button" onClick={() => void confirm(lastConfirm)} className="font-semibold text-primary hover:underline">Check status</button></>}</p>
          </div>
        )}
      </div>
    </div>
  )
}
