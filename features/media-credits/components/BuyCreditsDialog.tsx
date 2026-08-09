'use client'

// MC-08.2 · The one place an organizer buys Media Credits.
//
// Used by the Credits dashboard AND by the Import page's low-balance card. Deliberately one
// component rather than two: an organizer who runs out mid-import should not meet a different
// purchase flow from the one on the dashboard, and two flows would be two sets of error
// handling to keep in step.
//
// ═══ THIS FILE DECIDES NOTHING ABOUT MONEY ═══════════════════════════════════
//   price      → `pricePack`, from the server's unit price (utils/creditPacks)
//   charge     → the Razorpay ORDER, created server-side
//   outcome    → `POST /purchases/verify`, which re-fetches the payment from the gateway
//   phase copy → `utils/purchaseFlow`, pure and unit-tested
//
// The quantity is the only number that originates here, and the server re-prices it anyway.
//
// ═══ IDEMPOTENCY ═════════════════════════════════════════════════════════════
// One order per intent, and the submit control is disabled outside a resting phase, so a
// double click cannot open two orders. Beyond that the server is authoritative: verification
// is keyed on the order and a purchase that is already `granted` is never re-granted.

import { useCallback, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Loader2, Sparkles } from 'lucide-react'
import { Badge, Button, Card, Dialog } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import { openRazorpayCheckout } from '@/lib/razorpay/checkout'
import { CREDIT_PACKS, pricePack } from '@/features/media-credits/utils/creditPacks'
import {
  cancelledView, canSubmit, classifyIntentFailure, classifyVerifyResponse,
  gatewayUnavailableView, isBusy,
  type PhaseView, type PurchasePhase,
} from '@/features/media-credits/utils/purchaseFlow'

const API = '/api/organizer/media-credits'

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (n: number) => n.toLocaleString('en-IN')

interface IntentBody {
  purchaseId?: string; gatewayOrderId?: string; amountPaise?: number
  credits?: number; currency?: string; keyId?: string; error?: string
}

export interface BuyCreditsDialogProps {
  open:  boolean
  onClose: () => void
  /** Server unit price, in paise per credit. Never a constant. */
  unitPricePaise:  number
  creditsPerPhoto: number
  /** Pre-selects the smallest pack that clears a known shortfall. */
  suggestedCredits?: number | null
  /**
   * RD-MC-CUSTOM-01 · An EXACT quantity, already bounded by the event capacity.
   *
   * When set, the pack grid is not offered — the organizer has already chosen a number
   * and re-asking would let them pick one outside the range the server will accept.
   */
  fixedCredits?: number | null
  /** Sent with the purchase intent so the server re-checks capacity for this event. */
  eventId?: string | null
  /**
   * Fired once the wallet may have changed — on a grant AND on a deferred grant.
   * The caller re-reads its own data; this dialog never hands back a balance, because a
   * balance computed on the client is a second source of truth for the number that matters most.
   */
  onPurchased?: () => void
}

const TONE: Record<PhaseView['tone'], string> = {
  neutral: 'border-border bg-muted/40 text-muted-foreground',
  success: 'border-success/40 bg-success/[0.06] text-foreground',
  warning: 'border-warning/40 bg-warning/[0.06] text-foreground',
  danger:  'border-destructive/40 bg-destructive/[0.06] text-foreground',
}

const TONE_ICON: Record<PhaseView['tone'], typeof AlertTriangle> = {
  neutral: Clock, success: CheckCircle2, warning: Clock, danger: AlertTriangle,
}

export function BuyCreditsDialog({
  open, onClose, unitPricePaise, creditsPerPhoto, suggestedCredits, fixedCredits, eventId,
  onPurchased,
}: BuyCreditsDialogProps) {
  const { getToken } = useAuth()

  // Initialised once, from the suggestion. Callers MOUNT this component when the dialog opens
  // and unmount it when it closes, so every opening starts from a clean phase — reopening
  // after a completed purchase cannot show the previous result or a still-disabled button.
  // A reset effect would do the same job less reliably and would fight the lint rule that
  // exists precisely to discourage it.
  const [selected, setSelected] = useState<number>(
    // An exact quantity wins outright — see `fixedCredits`.
    () => fixedCredits ?? (CREDIT_PACKS.find(p => p.credits >= (suggestedCredits ?? 0))
        ?? CREDIT_PACKS[CREDIT_PACKS.length - 1]).credits,
  )
  const [phase, setPhase] = useState<PurchasePhase>('idle')
  const [view,  setView]  = useState<PhaseView | null>(null)

  const priced = pricePack({ credits: selected }, unitPricePaise, creditsPerPhoto)

  const purchase = useCallback(async () => {
    if (!canSubmit(phase, selected)) return

    setPhase('creating')
    setView(null)

    let intent: IntentBody
    let intentStatus: number
    try {
      const token = await getToken()
      const res = await fetch(`${API}/purchases`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // `eventId` lets the server re-derive the capacity and refuse a quantity the UI
        // should never have offered.
        body:    JSON.stringify({ credits: selected, eventId: eventId ?? null }),
      })
      intentStatus = res.status
      intent = await res.json() as IntentBody
      if (!res.ok || !intent.gatewayOrderId || !intent.keyId) {
        const v = classifyIntentFailure(intentStatus, intent.error)
        setView(v); setPhase(v.phase)
        return
      }
    } catch {
      const v = classifyIntentFailure(0)
      setView(v); setPhase(v.phase)
      return
    }

    // ── Gateway ───────────────────────────────────────────────────────────────
    setPhase('paying')
    const outcome = await openRazorpayCheckout({
      keyId:       intent.keyId,
      orderId:     intent.gatewayOrderId,
      // Display only. The order carries the real charge.
      amountPaise: intent.amountPaise ?? priced.amountPaise,
      currency:    intent.currency ?? 'INR',
      description: `${num(intent.credits ?? selected)} Media Credits`,
      notes:       { purchaseId: intent.purchaseId ?? '' },
    })

    if (outcome.status === 'cancelled') {
      const v = cancelledView()
      setView(v); setPhase(v.phase)
      return
    }
    if (outcome.status === 'unavailable') {
      const v = gatewayUnavailableView(outcome.message)
      setView(v); setPhase(v.phase)
      return
    }

    // ── Verification ──────────────────────────────────────────────────────────
    // The browser saying "paid" is not evidence. Only this response decides the outcome.
    setPhase('verifying')
    try {
      const token = await getToken()
      const res = await fetch(`${API}/purchases/verify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          orderId:   outcome.payment.razorpay_order_id,
          paymentId: outcome.payment.razorpay_payment_id,
          signature: outcome.payment.razorpay_signature,
        }),
      })
      const body = await res.json().catch(() => null) as
        { success?: boolean; pending?: boolean; error?: string } | null
      const v = classifyVerifyResponse(res.status, body)
      setView(v); setPhase(v.phase)
      if (v.phase === 'granted' || v.phase === 'pending') onPurchased?.()
    } catch {
      // The network dropped AFTER the payment. Treated as deferred, never as failed: the
      // money may well have been captured, and telling someone to retry here is how a
      // double charge happens.
      const v = classifyVerifyResponse(202, { pending: true })
      setView(v); setPhase(v.phase)
      onPurchased?.()
    }
  }, [phase, selected, getToken, priced.amountPaise, eventId, onPurchased])

  const busy     = isBusy(phase)
  const finished = phase === 'granted' || phase === 'pending'
  const Icon     = view ? TONE_ICON[view.tone] : Clock

  return (
    <Dialog
      open={open}
      // A backdrop click must not abandon a purchase mid-flight.
      onClose={() => { if (!busy) onClose() }}
      closeOnBackdrop={!busy}
      title="Buy Media Credits"
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-fs-2xs text-muted-foreground">
            Secure payment via Razorpay.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              {finished ? 'Done' : 'Cancel'}
            </Button>
            {!finished && (
              <Button
                size="sm"
                onClick={() => void purchase()}
                disabled={!canSubmit(phase, selected)}
              >
                {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                {phase === 'creating'  && 'Starting…'}
                {phase === 'paying'    && 'Waiting for payment…'}
                {phase === 'verifying' && 'Verifying…'}
                {!busy && `Pay ${rupees(priced.amountPaise)}`}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* ── Pack selection ─────────────────────────────────────────────────── */}
        {!finished && fixedCredits == null && (
          <fieldset disabled={busy} className="min-w-0">
            <legend className="text-fs-2xs uppercase tracking-wide text-muted-foreground">
              Choose an amount
            </legend>
            <div
              role="radiogroup"
              aria-label="Credit packs"
              className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
            >
              {CREDIT_PACKS.map(pack => {
                const p       = pricePack(pack, unitPricePaise, creditsPerPhoto)
                const active  = pack.credits === selected
                return (
                  <button
                    key={pack.credits}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setSelected(pack.credits)}
                    disabled={busy}
                    className={cn(
                      'relative rounded-xl border p-3 text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                      active
                        ? 'border-primary bg-primary/[0.06]'
                        : 'border-border hover:border-primary/40 hover:bg-muted/40',
                    )}
                  >
                    {pack.recommended && (
                      <Badge className="absolute right-2 top-2" variant="secondary">
                        <Sparkles className="size-3" aria-hidden />
                        Popular
                      </Badge>
                    )}
                    <p className="text-fs-2xs uppercase tracking-wide text-muted-foreground">
                      Credits
                    </p>
                    <p className="mt-0.5 text-fs-lg font-semibold leading-none tabular-nums text-foreground">
                      {num(pack.credits)}
                    </p>
                    <p className="mt-2 text-fs-sm font-semibold text-foreground">
                      {rupees(p.amountPaise)}
                    </p>
                    {p.photosCovered !== null && (
                      <p className="text-fs-2xs text-muted-foreground">
                        about {num(p.photosCovered)} photos
                      </p>
                    )}
                  </button>
                )
              })}
            </div>
          </fieldset>
        )}

        {/* ── Order summary ──────────────────────────────────────────────────── */}
        {!finished && (
          <Card className="p-3">
            <dl className="space-y-1.5 text-fs-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Credits</dt>
                <dd className="tabular-nums text-foreground">{num(selected)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Rate</dt>
                <dd className="tabular-nums text-foreground">
                  {rupees(priced.unitPricePaise)} per credit
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-border/60 pt-1.5">
                <dt className="font-medium text-foreground">Total</dt>
                <dd className="text-fs-base font-semibold tabular-nums text-foreground">
                  {rupees(priced.amountPaise)}
                </dd>
              </div>
            </dl>
          </Card>
        )}

        {/* ── Outcome ────────────────────────────────────────────────────────── */}
        {/* Assertive: this announces the result of a payment, which a shopper must not
            miss because focus happened to be elsewhere. */}
        <div aria-live="assertive" aria-atomic="true">
          {view && (
            <div className={cn('flex gap-2.5 rounded-xl border p-3', TONE[view.tone])}>
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="text-fs-sm font-medium text-foreground">{view.title}</p>
                <p className="mt-0.5 text-fs-2xs text-muted-foreground">{view.message}</p>
              </div>
            </div>
          )}
        </div>

        {/* Status for the busy phases, so a screen reader is not left in silence while a
            payment is in flight. */}
        <p className="sr-only" role="status" aria-live="polite">
          {phase === 'creating'  && 'Starting your purchase.'}
          {phase === 'paying'    && 'Waiting for payment in the gateway window.'}
          {phase === 'verifying' && 'Verifying your payment.'}
        </p>
      </div>
    </Dialog>
  )
}
