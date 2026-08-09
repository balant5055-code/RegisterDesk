'use client'

// MC-11 · Requesting a refund for one purchase.
//
// ═══ THIS FILE COMPUTES NO MONEY ══════════════════════════════════════════════
// Every figure on screen — purchase amount, service charge, net refund — arrives already
// calculated from `/refunds/eligibility`, which prices it with the SAME `refundMath`
// functions that price the refund when it is actually created.
//
// The organizer never types an amount. They pick a purchase and give a reason; the backend
// decides what that is worth. If this component multiplied a percentage itself, the number
// shown and the number paid would come from two implementations, and the first time an admin
// changed the charge method one of them would be wrong.
//
// ═══ WHAT THIS IS NOT ═════════════════════════════════════════════════════════
// Not an approval. A request enters the queue at `requested` and moves no money at all;
// approval is always an admin decision, and the organizer has no path to one.

import { useCallback, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Undo2 } from 'lucide-react'
import { Button, Card, Dialog } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'

const API = '/api/organizer/media-credits'

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (n: number) => n.toLocaleString('en-IN')

/** Exactly the server's figures for one purchase. Nothing here is derived on the client. */
export interface RefundTarget {
  purchaseId:          string
  /** Credits this purchase bought. */
  credits:             number
  /** RD-MC-REFUND-V2-P2 · of those, how many are spent and how many remain. */
  creditsUsed:         number
  creditsRemaining:    number
  availableCredits:    number
  purchaseAmountPaise: number
  /** RD-MC-REFUND-V2-P2 · `creditsRemaining × unit price`. What the charge is taken from. */
  refundBasePaise:     number
  serviceChargePaise:  number
  refundAmountPaise:   number
}

export interface RefundRequestDialogProps {
  target:   RefundTarget
  /** From config. When false the reason field is optional. */
  reasonRequired: boolean
  onClose:  () => void
  /** Fired after the request is accepted, so the dashboard re-reads its own data. */
  onRequested?: () => void
}

type Phase = 'form' | 'confirm' | 'submitting' | 'done' | 'error'

const MIN_REASON = 3
const MAX_REASON = 500

export function RefundRequestDialog({
  target, reasonRequired, onClose, onRequested,
}: RefundRequestDialogProps) {
  const { getToken } = useAuth()

  const [reason, setReason] = useState('')
  const [phase,  setPhase]  = useState<Phase>('form')
  const [error,  setError]  = useState<string | null>(null)

  const reasonOk = !reasonRequired || reason.trim().length >= MIN_REASON

  const submit = useCallback(async () => {
    setPhase('submitting')
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API}/refunds`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // The purchase and a reason. No amount — there is no field for one, which is the
        // point: a client-supplied figure could never be trusted anyway.
        body: JSON.stringify({ purchaseId: target.purchaseId, reason: reason.trim() }),
      })
      const body = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) throw new Error(body?.error ?? 'The refund request was not accepted.')

      setPhase('done')
      onRequested?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The refund request was not accepted.')
      setPhase('error')
    }
  }, [getToken, target.purchaseId, reason, onRequested])

  const busy = phase === 'submitting'

  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose() }}
      closeOnBackdrop={!busy}
      title="Request a refund"
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-fs-2xs text-muted-foreground">
            Reviewed by our team before any money moves.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              {phase === 'done' ? 'Done' : 'Cancel'}
            </Button>
            {(phase === 'form' || phase === 'error') && (
              <Button size="sm" onClick={() => setPhase('confirm')} disabled={!reasonOk}>
                Review request
              </Button>
            )}
            {phase === 'confirm' && (
              <>
                <Button variant="outline" size="sm" onClick={() => setPhase('form')}>Back</Button>
                <Button size="sm" onClick={() => void submit()}>
                  <Undo2 className="size-3.5" aria-hidden />
                  Submit request
                </Button>
              </>
            )}
            {busy && (
              <Button size="sm" disabled>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Submitting…
              </Button>
            )}
          </div>
        </div>
      }
    >
      {phase === 'done' ? (
        <div className="flex gap-2.5 rounded-xl border border-success/40 bg-success/[0.06] p-3">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <div className="min-w-0">
            <p className="text-fs-sm font-medium text-foreground">Refund requested</p>
            <p className="mt-0.5 text-fs-2xs text-muted-foreground">
              Your request is in the queue for review. Your credits stay available until it is
              approved — but the amount above was calculated on what is unused right now, so
              spending any of them will mean this request can no longer be approved. You would
              need to ask again for whatever is left.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* ── The figures. Every one of them from the server. ───────────────
              RD-MC-REFUND-V2-P2 · credits first, then money, because the money follows from
              the credits: Remaining is what is refundable, and Refund Base is that count at
              this purchase's price. Showing Purchased and Used above it is what makes the
              base checkable — an organizer can see 500 − 1 = 499 and why they are not being
              offered ₹500 back. */}
          <Card className="p-3">
            <dl className="space-y-1.5 text-fs-sm">
              <Line label="Credits purchased" value={num(target.credits)} />
              <Line label="Credits used" value={`− ${num(target.creditsUsed)}`} tone="muted" />
              <div className="flex items-baseline justify-between gap-3 border-t border-border/60 pt-1.5">
                <dt className="font-medium text-foreground">Credits remaining</dt>
                <dd className="font-semibold tabular-nums text-foreground">
                  {num(target.creditsRemaining)}
                </dd>
              </div>

              <div className="pt-1.5" />
              <Line label="Refund base" value={rupees(target.refundBasePaise)} />
              <Line
                label="Service charge"
                value={`− ${rupees(target.serviceChargePaise)}`}
                tone="muted"
              />
              <div className="flex items-baseline justify-between gap-3 border-t border-border/60 pt-1.5">
                <dt className="font-medium text-foreground">Refund you would receive</dt>
                <dd className="text-fs-base font-semibold tabular-nums text-foreground">
                  {rupees(target.refundAmountPaise)}
                </dd>
              </div>
            </dl>
          </Card>

          <p className="text-fs-2xs text-muted-foreground">
            {target.creditsUsed > 0
              ? `Only unused credits can be refunded. ${num(target.creditsUsed)} of the ${num(target.credits)} credits from this purchase have been used, so the refund covers the remaining ${num(target.creditsRemaining)}.`
              : 'Only unused credits can be refunded. None of this purchase has been used, so the refund covers all of it.'}
            {' '}The amount above is calculated by us and cannot be edited.
          </p>

          {phase === 'confirm' ? (
            <div className="flex gap-2.5 rounded-xl border border-warning/40 bg-warning/[0.06] p-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0">
                <p className="text-fs-sm font-medium text-foreground">
                  Submit this request for review?
                </p>
                <p className="mt-0.5 text-fs-2xs text-muted-foreground">
                  {num(target.creditsRemaining)} credits will be removed from your balance if
                  it is approved, and {rupees(target.refundAmountPaise)} returned to your
                  original payment method. Nothing happens until then.
                </p>
                {reason.trim() && (
                  <p className="mt-1.5 text-fs-2xs text-muted-foreground">
                    <span className="font-medium">Your reason:</span> {reason.trim()}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <label className="block">
              <span className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Reason {reasonRequired ? '' : '(optional)'}
              </span>
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                rows={3}
                maxLength={MAX_REASON}
                disabled={busy}
                placeholder="Why are you asking for this refund?"
                className={cn(
                  'mt-1 w-full resize-y rounded-lg border border-border bg-background px-3 py-2',
                  'text-fs-sm text-foreground placeholder:text-muted-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                )}
              />
              <span className="mt-1 block text-fs-2xs text-muted-foreground">
                {reasonRequired
                  ? `At least ${MIN_REASON} characters. This is read by whoever reviews the request.`
                  : 'Helps us review the request faster.'}
              </span>
            </label>
          )}
        </div>
      )}

      <div aria-live="assertive" aria-atomic="true">
        {phase === 'error' && error && (
          <div className="mt-3 flex gap-2.5 rounded-xl border border-destructive/40 bg-destructive/[0.06] p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0">
              <p className="text-fs-sm font-medium text-foreground">Request not accepted</p>
              <p className="mt-0.5 text-fs-2xs text-muted-foreground">{error}</p>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}

function Line({ label, value, tone }: { label: string; value: string; tone?: 'muted' }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', tone === 'muted' ? 'text-muted-foreground' : 'text-foreground')}>
        {value}
      </dd>
    </div>
  )
}
