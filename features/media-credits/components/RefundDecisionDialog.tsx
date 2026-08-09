'use client'

// MC-12.1 · Approving or rejecting one refund.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// MC-12's audit found `POST /admin/media-credits/refunds/{id}/decide` with zero callers. The
// endpoint has existed since MC-05, fully guarded and audited; the queue only ever offered
// "Retry payout", which is unreachable because nothing could reach `approved`. So organizers
// could file refund requests that no admin could action.
//
// This dialog is the missing caller. It adds no endpoint, no state and no arithmetic.
//
// ═══ THIS FILE DECIDES NOTHING ABOUT MONEY ═══════════════════════════════════
// Every figure is a stored value from the refund record, frozen when the request was created.
// Nothing here re-derives a service charge: doing so would price an old refund at today's
// rate, and the number an admin approves must be the number the organizer was quoted.
//
// The note requirement comes from `validateDecisionNote`, the SAME function the route
// enforces — so this dialog cannot offer a submit the server will refuse.

import { useCallback, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, ThumbsDown, ThumbsUp } from 'lucide-react'
import { Button, Card, Dialog } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import {
  MAX_DECISION_NOTE, validateDecisionNote,
} from '@/features/media-credits/utils/refundEligibility'

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (n: number) => n.toLocaleString('en-IN')

/** Exactly the stored refund record. Nothing is computed from these. */
export interface RefundDecisionTarget {
  refundId:            string
  organizerUid:        string
  purchaseId:          string
  /** Credits to debit. RD-MC-REFUND-V2-P2: the purchase's UNUSED credits, not all of them. */
  credits:             number
  /** RD-MC-REFUND-V2-P3 · what the purchase bought in total, and how much of it is spent. */
  purchaseCredits:     number
  creditsUsed:         number
  creditsRemaining:    number
  /** RD-MC-REFUND-V2-P3 · credits this request is RESERVING right now. 0 once decided. */
  heldCredits:         number
  /** The whole wallet's unused credits when the request was made. Context, not the basis. */
  unusedAtRequest:     number
  /** What the purchase cost in full. Context — a partial refund is not taken from this. */
  purchaseAmountPaise: number
  /** RD-MC-REFUND-V2-P2 · the frozen basis the charge below is subtracted from. */
  refundBasePaise:     number
  serviceChargePaise:  number
  refundAmountPaise:   number
  reason:              string
}

export interface RefundDecisionDialogProps {
  target:  RefundDecisionTarget
  /** True to approve, false to reject. Fixed for the life of the dialog. */
  approve: boolean
  /** From Business Configuration. */
  noteRequired: boolean
  onClose: () => void
  /** Fired once the decision has committed, so the console re-reads its queue. */
  onDecided?: () => void
}

type Phase = 'form' | 'submitting' | 'done' | 'pending' | 'error'

export function RefundDecisionDialog({
  target, approve, noteRequired, onClose, onDecided,
}: RefundDecisionDialogProps) {
  const { getToken } = useAuth()

  const [note,  setNote]  = useState('')
  const [phase, setPhase] = useState<Phase>('form')
  const [error, setError] = useState<string | null>(null)

  // The server's own rule, run locally for immediate feedback. Enforced again server-side.
  const noteCheck = validateDecisionNote(note, noteRequired)

  const submit = useCallback(async () => {
    setPhase('submitting')
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(
        `/api/admin/media-credits/refunds/${encodeURIComponent(target.refundId)}/decide`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          // No amount. The refund record already carries what it is worth.
          body: JSON.stringify({ approve, note: note.trim() || null }),
        },
      )
      const body = await res.json().catch(() => null) as
        { error?: string; pending?: boolean } | null

      // 202 · the credits LEFT the wallet but the gateway payout has not confirmed. Not a
      // failure, and it must never be reported as one — retrying an approval that already
      // debited is how a refund gets paid twice.
      if (res.status === 202 || body?.pending) {
        setPhase('pending')
        onDecided?.()
        return
      }
      if (res.status === 403) {
        throw new Error(body?.error ?? 'You do not have permission to decide this refund.')
      }
      if (res.status === 409 || res.status === 400) {
        // Already decided by someone else, or the organizer spent the credits while the
        // request sat in the queue.
        throw new Error(body?.error ?? 'This refund can no longer be decided.')
      }
      if (!res.ok) throw new Error(body?.error ?? 'The decision was not recorded.')

      setPhase('done')
      onDecided?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The decision was not recorded.')
      setPhase('error')
    }
  }, [getToken, target.refundId, approve, note, onDecided])

  const busy     = phase === 'submitting'
  const finished = phase === 'done' || phase === 'pending'
  const verb     = approve ? 'Approve' : 'Reject'

  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose() }}
      closeOnBackdrop={!busy}
      title={`${verb} refund`}
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-fs-2xs text-muted-foreground">
            {approve
              ? 'Debits the credits, then returns the money via Razorpay.'
              : 'Moves no money. The organizer keeps their credits.'}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              {finished ? 'Done' : 'Cancel'}
            </Button>
            {!finished && !busy && (
              <Button
                size="sm"
                variant={approve ? 'primary' : 'outline'}
                onClick={() => void submit()}
                disabled={!noteCheck.ok}
              >
                {approve
                  ? <ThumbsUp className="size-3.5" aria-hidden />
                  : <ThumbsDown className="size-3.5" aria-hidden />}
                {verb} {approve ? rupees(target.refundAmountPaise) : ''}
              </Button>
            )}
            {busy && (
              <Button size="sm" disabled>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {approve ? 'Approving…' : 'Rejecting…'}
              </Button>
            )}
          </div>
        </div>
      }
    >
      {phase === 'done' ? (
        <Outcome
          tone="success"
          title={approve ? 'Refund approved and paid' : 'Refund rejected'}
          body={approve
            ? `${num(target.credits)} credits were debited and ${rupees(target.refundAmountPaise)} returned to the organizer's original payment method.`
            : 'No money moved and no credits were touched. The organizer has been notified.'}
        />
      ) : phase === 'pending' ? (
        <Outcome
          tone="warning"
          title="Approved — payout pending"
          body={`The credits have been debited and ${rupees(target.refundAmountPaise)} is owed. The gateway has not confirmed the payout yet; the reconciler will retry it automatically. Do NOT approve again.`}
        />
      ) : (
        <div className="space-y-4">
          {/* ── The stored figures. Frozen at request time. ─────────────────── */}
          <Card className="p-3">
            <dl className="space-y-1.5 text-fs-sm">
              <Line label="Organizer" value={target.organizerUid} mono />
              <Line label="Purchase"  value={target.purchaseId} mono />
              {/* RD-MC-REFUND-V2-P3 · the credit story before the money story. An admin
                  approving a partial refund has to be able to see that Purchased − Used =
                  Remaining and that Held matches what is about to be debited; without those
                  lines the refund credits are a bare number to take on trust. */}
              <Line label="Purchased" value={num(target.purchaseCredits)} />
              <Line label="Used" value={`− ${num(target.creditsUsed)}`} tone="muted" />
              <Line label="Remaining" value={num(target.creditsRemaining)} />
              <Line
                label="Held for this refund"
                value={target.heldCredits > 0 ? num(target.heldCredits) : '—'}
              />
              <Line label="Wallet unused at request" value={num(target.unusedAtRequest)} />
              {/* RD-MC-REFUND-V2-P2 · the purchase amount is CONTEXT, shown separately from
                  the basis. Subtracting the service charge from it would not reconcile with
                  the net payout on a partial refund — ₹500 − ₹49.90 is not ₹449.10 — and an
                  admin approving money must be able to read the arithmetic down the column. */}
              {target.refundBasePaise !== target.purchaseAmountPaise && (
                <Line
                  label="Purchase amount (full)"
                  value={rupees(target.purchaseAmountPaise)}
                  tone="muted"
                />
              )}
              <Line label="Refund base" value={rupees(target.refundBasePaise)} />
              <Line
                label="Service charge"
                value={`− ${rupees(target.serviceChargePaise)}`}
                tone="muted"
              />
              <div className="flex items-baseline justify-between gap-3 border-t border-border/60 pt-1.5">
                <dt className="font-medium text-foreground">Net payout</dt>
                <dd className="text-fs-base font-semibold tabular-nums text-foreground">
                  {rupees(target.refundAmountPaise)}
                </dd>
              </div>
            </dl>
          </Card>

          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="text-fs-2xs uppercase tracking-wide text-muted-foreground">
              Organizer&rsquo;s reason
            </p>
            <p className="mt-1 text-fs-sm text-foreground">{target.reason || '—'}</p>
          </div>

          {approve && (
            <div className="flex gap-2.5 rounded-xl border border-warning/40 bg-warning/[0.06] p-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <p className="text-fs-2xs text-muted-foreground">
                Approving debits {num(target.credits)} credits immediately and then returns the
                money. The credits are re-checked against the live balance first — if the
                organizer has spent them since asking, the whole approval is refused.
              </p>
            </div>
          )}

          <label className="block">
            <span className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Decision note {noteRequired ? '' : '(optional)'}
            </span>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={3}
              maxLength={MAX_DECISION_NOTE}
              disabled={busy}
              placeholder={approve
                ? 'Recorded on the refund and in the admin audit log.'
                : 'Shown to the organizer in the rejection email.'}
              className={cn(
                'mt-1 w-full resize-y rounded-lg border border-border bg-background px-3 py-2',
                'text-fs-sm text-foreground placeholder:text-muted-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
            />
            <span className="mt-1 block text-fs-2xs text-muted-foreground">
              {noteCheck.ok
                ? 'Recorded permanently against this decision.'
                : noteCheck.message}
            </span>
          </label>
        </div>
      )}

      <div aria-live="assertive" aria-atomic="true">
        {phase === 'error' && error && (
          <Outcome tone="danger" title="Decision not recorded" body={error} className="mt-3" />
        )}
      </div>
    </Dialog>
  )
}

const TONE = {
  success: 'border-success/40 bg-success/[0.06]',
  warning: 'border-warning/40 bg-warning/[0.06]',
  danger:  'border-destructive/40 bg-destructive/[0.06]',
} as const

function Outcome({
  tone, title, body, className,
}: { tone: keyof typeof TONE; title: string; body: string; className?: string }) {
  const Icon = tone === 'success' ? CheckCircle2 : AlertTriangle
  return (
    <div className={cn('flex gap-2.5 rounded-xl border p-3', TONE[tone], className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="text-fs-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-fs-2xs text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

function Line({ label, value, mono, tone }: {
  label: string; value: string; mono?: boolean; tone?: 'muted'
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn(
        'min-w-0 break-all text-right tabular-nums',
        mono ? 'font-mono text-fs-2xs text-muted-foreground' : 'text-foreground',
        tone === 'muted' && 'text-muted-foreground',
      )}>
        {value}
      </dd>
    </div>
  )
}
