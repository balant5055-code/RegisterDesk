'use client'

// RD-CAPACITY-01 · Change a PUBLISHED event's registration capacity.
//
// ═══ WHY THIS SURFACE HAS TO EXIST ═══════════════════════════════════════════
// At 100% utilisation the platform emails the organizer "increase your capacity to continue
// accepting registrations". Without a place to do that, the migration ships an instruction
// with no action behind it — and the organizer's event is refusing registrations while they
// hunt for a button. This is that button.
//
// ═══ WHAT THIS COMPONENT IS NOT ══════════════════════════════════════════════
// It is not authoritative about anything. It asks the server for a quote, sends only a
// capacity, and lets the server decide the amount and whether a payment is needed at all.
// A payable change is paid in full through Razorpay — never the communication wallet. If it
// disagreed with the server about a price the server would simply win —
// which is the correct shape for a screen that spends someone's money.
//
// ═══ THE ONE THING IT MUST SAY OUT LOUD ══════════════════════════════════════
// Reducing capacity is NOT a refund. The organizer paid for capacity; giving it back costs a
// percentage of what is removed. A surface that let someone click "reduce" expecting money
// back would be a support ticket at best, so the decrease case says so before the button.

import { useCallback, useState } from 'react'
import { Loader2, TrendingUp, TrendingDown, AlertCircle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { CapacitySelector } from '@/components/wizard/CapacitySelector'
import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'

interface CapacityOrderResponse {
  ok?:              boolean
  paymentRequired?: boolean
  applied?:         boolean
  unchanged?:       boolean
  orderId?:         string
  capacity?:        number
  quote?:           { kind: string; totalPaise: number; chargeableCapacity: number; previousCapacity: number | null }
  checkout?:        { keyId: string; razorpayOrderId: string; amountPaise: number } | null
  error?:           string
  code?:            string
}

type Phase = 'idle' | 'ordering' | 'paying' | 'confirming' | 'done'

export function EventCapacityManager({
  eventId, currentCapacity, registrations, token, onChanged, editable = true,
}: {
  eventId:         string
  /**
   * The event's ENFORCED capacity (`events/{slug}`). `null` = unlimited, which has no delta
   * to price. `undefined` = not known (no readable live event) — the panel then refuses to
   * quote rather than pricing a change against a guessed number.
   */
  currentCapacity: number | null | undefined
  registrations:   number
  token:           string
  onChanged:       () => void
  editable?:       boolean
}) {
  // The fallback is inert — an unlimited event early-returns below and never quotes — but a
  // hardcoded 100 in a money surface is the exact thing the commercial model must not contain,
  // so it reads the constant.
  const [capacity, setCapacity] = useState<number>(currentCapacity ?? DEFAULT_COMMERCIAL_TERMS.freeRegistrationCapacity)
  const [phase, setPhase]   = useState<Phase>('idle')
  const [error, setError]   = useState<string | null>(null)
  const [done,  setDone]    = useState<string | null>(null)

  const busy      = phase !== 'idle' && phase !== 'done'
  const unchanged = typeof currentCapacity === 'number' && capacity === currentCapacity
  const isDecrease = typeof currentCapacity === 'number' && capacity < currentCapacity

  const post = useCallback(async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
    })
    return { res, data: await res.json() as CapacityOrderResponse }
  }, [token])

  /** Finish a paid change. The server re-verifies the payment and applies it atomically. */
  const confirm = useCallback(async (
    orderId: string,
    razorpay?: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
  ) => {
    setPhase('confirming')
    const { res, data } = await post('/api/licensing/capacity/confirm', { eventId, orderId, ...(razorpay ?? {}) })
    if (!res.ok) { setPhase('idle'); setError(data.error ?? 'Could not confirm the payment.'); return }
    setPhase('done')
    setDone(`Capacity updated to ${(data.capacity ?? capacity).toLocaleString('en-IN')} registrations.`)
    onChanged()
  }, [post, eventId, capacity, onChanged])

  const submit = useCallback(async () => {
    if (busy || unchanged) return
    setError(null); setDone(null); setPhase('ordering')

    // Only the capacity is sent. The server quotes it, claims a sequence number and creates
    // the order in one transaction, so two concurrent changes cannot price from the same
    // stale capacity.
    const { res, data } = await post('/api/licensing/capacity/order', { eventId, capacity })
    if (!res.ok || !data.ok) {
      setPhase('idle')
      setError(data.error ?? 'Could not start the capacity change.')
      return
    }

    // Free (nothing to collect) → already applied server-side.
    if (!data.paymentRequired) {
      setPhase('done')
      setDone(data.unchanged
        ? 'Capacity is unchanged.'
        : `Capacity updated to ${(data.capacity ?? capacity).toLocaleString('en-IN')} registrations — no charge.`)
      onChanged()
      return
    }

    if (!data.orderId) { setPhase('idle'); setError('The server did not return an order.'); return }

    // RD-LICENSE-PAYMENT-01 · a payable change ALWAYS carries a Razorpay checkout for its whole
    // amount. No checkout means the server could not start the payment — never 'nothing due'.
    if (!data.checkout) { setPhase('idle'); setError('Could not start the payment. Please try again.'); return }

    // The full amount → the existing Razorpay checkout script, same as every other
    // payment surface in the product.
    const checkout = data.checkout
    const orderId  = data.orderId
    setPhase('paying')
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
        description: isDecrease
          ? `Capacity reduction — ${capacity.toLocaleString('en-IN')} registrations`
          : `Capacity increase — ${capacity.toLocaleString('en-IN')} registrations`,
        handler: (resp: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          void confirm(orderId, resp)
        },
        modal: {
          ondismiss: () => {
            setPhase('idle')
            // The order stays `created` and unpaid. Retrying re-quotes and takes a NEW
            // sequence number, so nothing is stranded and nothing is double-charged.
            setError('Payment cancelled. Your capacity is unchanged — you can try again.')
          },
        },
      })
      rz.open()
    }
    script.onerror = () => { setPhase('idle'); setError('Could not load the payment window. Please try again.') }
    document.body.appendChild(script)
  }, [busy, unchanged, post, eventId, capacity, confirm, isDecrease, onChanged])

  // ── The enforced capacity could not be read — never price against a guess ────
  if (currentCapacity === undefined) {
    return (
      <Card>
        <Header />
        <p className="text-[13px] text-muted-foreground">
          The current registration capacity for this event is unavailable right now, so it
          can’t be changed. Refresh the page to try again.
        </p>
      </Card>
    )
  }

  // ── Unlimited events have no delta to price ─────────────────────────────────
  if (currentCapacity === null) {
    return (
      <Card>
        <Header />
        <p className="text-[13px] text-muted-foreground">
          This event has unlimited registration capacity, so there is nothing to change.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <Header />

      <dl className="mb-4 flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
        <div>
          <dt className="text-muted-foreground">Current capacity</dt>
          <dd className="font-semibold tabular-nums text-foreground">{currentCapacity.toLocaleString('en-IN')}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Registrations</dt>
          <dd className="font-semibold tabular-nums text-foreground">
            {registrations.toLocaleString('en-IN')}
            <span className="ml-1.5 font-normal text-muted-foreground">
              ({Math.min(100, Math.round((registrations / currentCapacity) * 100))}% used)
            </span>
          </dd>
        </div>
      </dl>

      {editable ? (
        <>
          <CapacitySelector capacity={capacity} onChange={setCapacity} eventId={eventId} />

          {/* Reducing capacity is a CHARGE. Saying so before the button is the difference
              between an informed decision and a support ticket. */}
          {isDecrease && (
            <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12.5px] text-amber-800">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Reducing capacity is not a refund. You are charged a percentage of the capacity you
                remove, and the activation fee you already paid is not returned.
              </span>
            </p>
          )}

          {registrations > capacity && (
            <p className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[12.5px] text-red-700">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                This event already has {registrations.toLocaleString('en-IN')} registrations. Setting a
                lower capacity will not cancel any of them — it will simply stop new ones.
              </span>
            </p>
          )}

          {error && (
            <p className="mt-3 flex items-start gap-2 text-[13px] text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{error}</span>
            </p>
          )}
          {done && (
            <p className="mt-3 flex items-start gap-2 text-[13px] text-emerald-700">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{done}</span>
            </p>
          )}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || unchanged}
            className={cn(
              'mt-4 inline-flex items-center gap-2 rounded-xl px-4 py-2 text-[14px] font-semibold transition-colors',
              busy || unchanged
                ? 'cursor-not-allowed bg-muted text-muted-foreground'
                : 'bg-primary text-primary-foreground hover:opacity-90',
            )}
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {!busy && (isDecrease ? <TrendingDown className="size-4" aria-hidden /> : <TrendingUp className="size-4" aria-hidden />)}
            {unchanged
              ? 'Capacity unchanged'
              : phase === 'ordering'    ? 'Preparing…'
              : phase === 'paying'      ? 'Waiting for payment…'
              : phase === 'confirming'  ? 'Applying…'
              : isDecrease              ? 'Reduce capacity'
              : 'Increase capacity'}
          </button>
        </>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          Capacity cannot be changed while this event is archived or completed.
        </p>
      )}
    </Card>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-border bg-card p-5">{children}</div>
}

function Header() {
  return (
    <div className="mb-4">
      <h3 className="text-[15px] font-bold text-foreground">Registration capacity</h3>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">
        You pay only for the capacity you add. Every RegisterDesk feature is included.
      </p>
    </div>
  )
}
