'use client'

// RD-EVENT-COMMERCE-02 · ONE payment for the whole License & Services selection, taken on the
// License & Services step itself.
//
// ═══ WHAT THE CLIENT DOES AND DOES NOT DECIDE ═════════════════════════════════
// The page sends QUANTITIES only — capacity, prepaid service units and an optional coupon code.
// /api/licensing/purchase re-validates and re-prices them and writes the order (the activation
// order, or — once that is paid — an add-on order for the difference). The confirm route
// verifies the Razorpay signature AND the captured amount against that order before settling
// it. "Paid" and "covered" are shown ONLY from server reads (the coverage-aware quote and
// /api/licensing/activation-status). A Razorpay success callback never marks anything paid by
// itself: it triggers server confirmation, and the panel then asks the server what happened.
//
// ═══ RETRY / DUPLICATE SUBMISSION / LOST RESPONSE ═════════════════════════════
// `inFlight` refuses a second click while one attempt runs. Across reloads and tabs the server
// is the guard: an unpaid order for the SAME selection is reused (never a second Razorpay
// order); a CAPTURED payment whose confirmation was lost is detected and settled on the next
// attempt (no second charge); a paid selection returns `alreadyPaid`.
//
// Payment never submits or publishes the event: that is the Review step's action.

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, XCircle, Info, CreditCard, Loader2, RefreshCw } from 'lucide-react'
import type { PublishAgreementInput } from '@/lib/legal/organizerAgreement'
import { cn } from '@/lib/utils/cn'
import { auth } from '@/lib/firebase/auth'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import { SERVICE_LABELS, type ServiceSelection } from '@/lib/licensing/serviceAllowances'
import type { PurchaseHistoryEntry } from '@/lib/licensing/purchaseHistory'

type RazorpayResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
type Notice = { kind: 'cancelled' | 'failed' | 'verifying' | 'paid'; message: string }

/** The coverage-aware payable figure from /api/licensing/checkout/quote. */
export interface PayableNow {
  kind:       'activation' | 'addon' | 'covered' | 'capacity_change'
  /** Server total before any activation coupon. */
  totalPaise: number
}

interface StatusView {
  state:        'none' | 'pending' | 'paid' | 'failed' | 'refunded'
  pendingAddon: { orderId: string; amountPaise: number } | null
  /** RD-EVENT-COMMERCE-05 — the event's PAID licensing purchases, newest first (server records). */
  purchases?:   PurchaseHistoryEntry[]
}

export interface ActivationPaymentPanelProps {
  /** RD-EVENT-COMMERCE-03 — 'published' buys MORE for a submitted event (capacity change and/or
   *  additional service units) through /api/licensing/published/purchase. */
  mode?:        'draft' | 'published'
  draftId:      string | null
  capacity:     number
  services:     ServiceSelection
  /** null while quoting, or when any selected item cannot be quoted (payment refused). */
  payable:      PayableNow | null
  /** The amount the summary shows as payable now (coupon applied to the activation only). */
  amountPaise:  number | null
  /** Why payable is null, when it is. */
  blockedReason: string | null
  couponCode:   string | null
  /** True once the server reports the full selection as paid AND at least one paid order exists. */
  activationPaid: boolean
  /** Flushes queued draft writes (useDraft.settle) before any money moves. */
  onSettle?:    () => Promise<boolean>
  /** Called after any server-side payment change so the page re-reads the coverage-aware quote. */
  onSettled:    () => void
  /**
   * RD-EVENT-COMMERCE-05B — License & Services is the FINAL new-event step: its "Pay & Submit Event"
   * drives the payment. The panel hands over an awaitable pay() and hides its own pay button, so
   * there is exactly one way to start a payment on the page. Outcome is known only from the
   * SERVER's verification (confirm route), never from the Razorpay callback alone.
   */
  onRegisterPay?: (pay: (agreement?: PublishAgreementInput) => Promise<PayOutcome>) => void
  /** Hide the panel's own pay button (the final step's footer owns the action). */
  hidePayButton?: boolean
  /**
   * RD-EVENT-COMMERCE-05E — published mode: what "nothing to pay" should tell the organizer
   * (e.g. that the purchase controls are locked). Defaults to the previous sentence.
   */
  coveredNote?: React.ReactNode
}

/**
 * How a payment attempt ended. 'paid' ONLY after the server verified the payment (or the server
 * reported the selection already paid / applied at no charge).
 */
export type PayOutcome = 'paid' | 'cancelled' | 'failed' | 'pending' | 'busy'

export function ActivationPaymentPanel({
  mode = 'draft', draftId, capacity, services, payable, amountPaise, blockedReason, couponCode, activationPaid, onSettle, onSettled,
  onRegisterPay, hidePayButton = false, coveredNote,
}: ActivationPaymentPanelProps) {
  const [status,   setStatus]   = useState<StatusView | null>(null)
  const [payState, setPayState] = useState<'idle' | 'paying' | 'confirming'>('idle')
  const [notice,   setNotice]   = useState<Notice | null>(null)
  const inFlight = useRef(false)
  // RD-EVENT-COMMERCE-05B — resolves the awaitable pay() at the attempt's terminal state.
  const outcomeRef = useRef<((o: PayOutcome) => void) | null>(null)
  const finish = useCallback((o: PayOutcome) => { const r = outcomeRef.current; outcomeRef.current = null; r?.(o) }, [])

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (!draftId) return
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) return
      const res = await fetch(`/api/licensing/activation-status?eventId=${encodeURIComponent(draftId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json() as StatusView
      setStatus({ state: data.state, pendingAddon: data.pendingAddon ?? null, purchases: Array.isArray(data.purchases) ? data.purchases : [] })
    } catch { /* status unknown → panel stays as it is */ }
  }, [draftId])

  useEffect(() => {
    const t = setTimeout(() => { void refreshStatus() }, 0)
    return () => clearTimeout(t)
  }, [refreshStatus])

  const refreshAll = useCallback(async () => { await refreshStatus(); onSettled() }, [refreshStatus, onSettled])

  const confirm = useCallback(async (orderId: string | null, rzp?: RazorpayResponse, via: 'checkout' | 'capacity' = 'checkout') => {
    setPayState('confirming')
    try {
      const token = await auth.currentUser?.getIdToken()
      // A capacity-change order settles through the capacity confirm route (which applies the
      // capacity AND any service lines atomically); everything else through checkout confirm.
      const res   = await fetch(via === 'capacity' ? '/api/licensing/capacity/confirm' : '/api/licensing/checkout/confirm', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        // No amount and no quantities: the route reads both from the order the server wrote.
        body:    JSON.stringify({ eventId: draftId, ...(orderId ? { orderId } : {}), ...(rzp ?? {}) }),
      })
      const json = await res.json().catch(() => ({})) as { success?: boolean; error?: string }
      const verified = res.ok && json.success === true
      setNotice(verified
        ? { kind: 'paid', message: 'Payment verified by RegisterDesk.' }
        : { kind: 'failed', message: `${json.error ?? 'We could not confirm the payment.'} If money left your account it is matched to this event automatically — paying again will not charge you twice.` })
      finish(verified ? 'paid' : 'failed')
    } catch {
      setNotice({ kind: 'verifying', message: 'We could not reach the server to confirm your payment. Refresh the status in a moment — you will not be charged twice.' })
      finish('pending')
    } finally {
      setPayState('idle'); inFlight.current = false
      await refreshAll()
    }
  }, [draftId, refreshAll, finish])

  // RD-EVENT-COMMERCE-05F — `agreement`: the Publish Agreement exactly as ticked on the final step.
  // The draft purchase route refuses to create any order without it.
  const pay = useCallback(async (agreement?: PublishAgreementInput) => {
    if (inFlight.current) { finish('busy'); return }
    if (!draftId || !payable) { finish('failed'); return }
    if (payable.kind === 'covered') { finish('paid'); return }
    inFlight.current = true
    setPayState('paying'); setNotice(null)
    const release = () => { setPayState('idle'); inFlight.current = false }
    if (onSettle && !(await onSettle())) {
      setNotice({ kind: 'failed', message: 'Your latest changes haven’t finished saving, so nothing was charged. Check your connection and try again.' })
      release(); finish('failed'); return
    }
    try {
      const token = await auth.currentUser?.getIdToken()
      const pRes  = await fetch(mode === 'published' ? '/api/licensing/published/purchase' : '/api/licensing/purchase', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        // QUANTITIES ONLY — never a rate, GST or total. `expectedTotalPaise` is the figure the
        // page DISPLAYED: the server only compares it with its own and refuses a stale quote.
        body:    JSON.stringify({
          eventId: draftId, capacity, services,
          ...(mode === 'draft' && couponCode ? { couponCode } : {}),
          ...(amountPaise !== null ? { expectedTotalPaise: amountPaise } : {}),
          ...(mode === 'draft' && agreement ? { agreement } : {}),
        }),
      })
      const purchase = await pRes.json().catch(() => ({})) as {
        ok?: boolean; alreadyPaid?: boolean; applied?: boolean; message?: string; error?: string; code?: string; orderId?: string
        confirmVia?: 'checkout' | 'capacity' | null
        checkout?: { keyId: string; razorpayOrderId: string; amountPaise: number } | null
      }
      if (purchase.code === 'QUOTE_CHANGED') {
        setNotice({ kind: 'failed', message: purchase.message ?? 'The price changed. Review the updated total and try again — nothing was charged.' })
        release(); await refreshAll(); finish('failed'); return
      }
      if (!pRes.ok || !purchase.ok) throw new Error(purchase.message ?? purchase.error ?? 'Could not start payment')
      if (purchase.applied) {
        setNotice({ kind: 'paid', message: 'Capacity updated — this change had no charge.' })
        release(); await refreshAll(); finish('paid'); return
      }
      if (purchase.alreadyPaid) {
        setNotice({ kind: 'paid', message: 'This selection is already paid — nothing was charged.' })
        release(); await refreshAll(); finish('paid'); return
      }
      // No checkout only when a coupon brought the whole amount to ₹0 → the server confirms it.
      const via: 'checkout' | 'capacity' = purchase.confirmVia === 'capacity' ? 'capacity' : 'checkout'
      if (!purchase.checkout) { await confirm(purchase.orderId ?? null, undefined, via); return }

      const checkout = purchase.checkout
      const orderId  = purchase.orderId ?? null
      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.onload = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rz = new (window as any).Razorpay({
          key:         checkout.keyId,
          order_id:    checkout.razorpayOrderId,
          amount:      checkout.amountPaise,
          currency:    'INR',
          name:        'RegisterDesk',
          description: 'Event licence & services',
          handler:     (resp: RazorpayResponse) => { void confirm(orderId, resp, via) },
          modal: { ondismiss: () => {
            setNotice({ kind: 'cancelled', message: 'Payment cancelled — you were not charged. You can pay whenever you’re ready.' })
            release(); void refreshStatus(); finish('cancelled')
          } },
        })
        rz.open()
      }
      script.onerror = () => {
        setNotice({ kind: 'failed', message: 'The payment window could not load, so nothing was charged. Check your connection and retry.' })
        release(); finish('failed')
      }
      document.body.appendChild(script)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Payment could not be started.'
      setNotice({ kind: 'failed', message: `${msg} Nothing was charged.` })
      release(); void refreshStatus(); finish('failed')
    }
  }, [mode, draftId, payable, amountPaise, onSettle, capacity, services, couponCode, confirm, refreshAll, refreshStatus, finish])

  // RD-EVENT-COMMERCE-05B — the awaitable pay() the final step's "Pay & Submit Event" uses.
  const payAndWait = useCallback((agreement?: PublishAgreementInput): Promise<PayOutcome> => new Promise<PayOutcome>(resolve => {
    if (outcomeRef.current) { resolve('busy'); return }       // one attempt at a time
    outcomeRef.current = resolve
    void pay(agreement)
  }), [pay])
  useEffect(() => { onRegisterPay?.(payAndWait) }, [onRegisterPay, payAndWait])

  const busy = payState !== 'idle'
  const covered = payable?.kind === 'covered'
  const pendingOrder = status?.state === 'pending' || !!status?.pendingAddon

  return (
    <section aria-labelledby="activation-payment-heading" className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <p id="activation-payment-heading" className="text-[14px] font-bold tracking-tight text-foreground">Payment</p>
        <button
          type="button"
          onClick={() => { void refreshAll() }}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        >
          <RefreshCw className="size-3" aria-hidden />Refresh status
        </button>
      </div>

      <div className="flex flex-col gap-3 px-5 py-4" aria-live="polite">
        {!payable ? (
          blockedReason
            ? <Line tone="error" icon={XCircle} role="alert">{blockedReason}</Line>
            : <Line tone="muted" icon={Loader2} spin>Calculating what’s payable…</Line>
        ) : covered ? (
          <Line tone="success" icon={CheckCircle2}>
            {mode === 'published'
              ? (coveredNote ?? <>Nothing to pay. Change the capacity or choose additional services above to buy more.</>)
              : activationPaid
                ? <><span className="font-semibold">Payment received.</span> Your current selection is fully paid{hidePayButton ? ' — publish your event below.' : ' — continue.'}</>
                : <>No payment needed — this selection is within the free capacity.</>}
          </Line>
        ) : (
          <>
            {payable.kind === 'addon' && mode === 'draft' && (
              <Line tone="muted" icon={Info}>
                You’ve already paid for part of this selection. Pay the difference below to continue.
              </Line>
            )}
            {pendingOrder && (
              <Line tone="muted" icon={Info}>
                A checkout was started earlier and not completed. Paying reuses it when the selection is
                unchanged — you won’t be charged twice.
              </Line>
            )}
            {!hidePayButton && <button
              type="button"
              onClick={() => { void pay() }}
              disabled={busy || !draftId || amountPaise === null}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13.5px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-60"
            >
              {busy
                ? <><Loader2 className="size-4 animate-spin" aria-hidden />{payState === 'confirming' ? 'Verifying payment…' : 'Processing…'}</>
                : <><CreditCard className="size-4" aria-hidden />{notice?.kind === 'failed' || notice?.kind === 'cancelled' ? 'Retry payment' : `Pay ${formatPaise(amountPaise ?? payable.totalPaise)} via Razorpay`}</>}
            </button>}
            {hidePayButton && (
              <p className="text-[13px] font-semibold text-foreground tabular-nums">
                {busy ? (payState === 'confirming' ? 'Verifying payment…' : 'Processing payment…') : <>Payable now {formatPaise(amountPaise ?? payable.totalPaise)} — {mode === 'published' ? 'pay with the payment button below.' : <>pay with “Pay &amp; Publish Event” below.</>}</>}
              </p>
            )}
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              {mode === 'published'
                ? 'One payment for the capacity change and the additional services itemized above, incl. GST. Capacity and allowances apply only after RegisterDesk verifies the payment.'
                : hidePayButton
                  ? 'One payment for the registration capacity and the prepaid services itemized above, incl. GST. Your event is published only AFTER RegisterDesk verifies the payment; if anything fails you are not charged again.'
                  : 'One payment for the registration capacity and the prepaid services itemized above, incl. GST. Nothing is charged until you complete the Razorpay checkout; the event is not submitted.'}
            </p>
          </>
        )}

        {notice && (
          <Line
            tone={notice.kind === 'failed' ? 'error' : notice.kind === 'paid' ? 'success' : 'muted'}
            icon={notice.kind === 'failed' ? XCircle : notice.kind === 'paid' ? CheckCircle2 : Info}
            role={notice.kind === 'failed' ? 'alert' : 'status'}
          >
            {notice.message}
          </Line>
        )}

        {/* RD-EVENT-COMMERCE-05 — what this event has already bought, from paid orders only. */}
        {status?.purchases && status.purchases.length > 0 && (
          <details className="rounded-lg border border-border/70 px-3 py-2 text-[12px]">
            <summary className="cursor-pointer font-semibold text-foreground">Purchase history ({status.purchases.length})</summary>
            <ul className="mt-2 space-y-1.5">
              {status.purchases.map(p => (
                <li key={p.orderId} className="flex items-start justify-between gap-3 tabular-nums">
                  <span className="min-w-0 text-muted-foreground">
                    <span className="text-foreground">
                      {p.kind === 'activation' ? 'Activation' : p.kind === 'addon' ? 'Add-on' : 'Capacity change'}
                    </span>
                    {p.paidAt && <> · {new Date(p.paidAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</>}
                    {p.capacity !== null && <> · {p.previousCapacity !== null ? `${p.previousCapacity.toLocaleString('en-IN')} → ` : ''}{p.capacity.toLocaleString('en-IN')} registrations</>}
                    {p.services.map(sv => <span key={sv.service}> · {sv.quantity.toLocaleString('en-IN')} {SERVICE_LABELS[sv.service]?.units ?? sv.service}</span>)}
                  </span>
                  <span className="shrink-0 font-semibold text-foreground">{formatPaise(p.totalPaise)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  )
}

function Line({ tone, icon: Icon, spin, role, children }: {
  tone: 'success' | 'warning' | 'error' | 'muted'
  icon: React.ElementType
  spin?: boolean
  role?: 'alert' | 'status'
  children: React.ReactNode
}) {
  return (
    <div role={role} className={cn(
      'flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[12.5px] leading-relaxed',
      tone === 'success' && 'border-emerald-200/60 bg-emerald-50/60 text-emerald-800',
      tone === 'warning' && 'border-amber-200/70 bg-amber-50/60 text-amber-800',
      tone === 'error'   && 'border-rose-200/60 bg-rose-50/60 text-rose-700',
      tone === 'muted'   && 'border-border bg-muted/30 text-foreground',
    )}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', spin && 'animate-spin')} aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
