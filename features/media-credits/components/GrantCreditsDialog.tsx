'use client'

// MC-09 · Issuing credits, from the operations console.
//
// The only surface in the platform that creates Media Credits without a payment. Everything
// here is shaped by that: the form asks for a justification before it will submit, the
// summary restates what is about to happen in words, and the confirm step is separate from
// the form so nobody grants by pressing Enter in a text field.
//
// ═══ THIS FILE DECIDES NOTHING ═══════════════════════════════════════════════
//   what is valid  → `utils/grantValidation`, pure and unit-tested, re-run on the server
//   what is stored → the server, from the request body
//   the balance    → the ledger's single writer, inside a transaction
//
// The client-side validation exists to explain a rejection immediately, not to be trusted.
// The identical rules run again in `grantService` before anything is written.
//
// ═══ THE IDEMPOTENCY KEY IS MINTED HERE ══════════════════════════════════════
// One key per form session, minted on the first submit and reused for every retry of THAT
// grant. A key minted per request would make a retry a second grant, which is precisely what
// it exists to prevent. It resets only when the dialog is reopened — which is why the caller
// mounts this component on open rather than toggling a prop.

import { useCallback, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Gift, Loader2 } from 'lucide-react'
import { Button, Card, Dialog } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import { CREDIT_GRANT_REASONS, type CreditGrantReason } from '@/features/media-credits/types'
import {
  MAX_GRANT_CREDITS, MAX_NOTE_LENGTH, MIN_NOTE_LENGTH, validateGrant,
} from '@/features/media-credits/utils/grantValidation'

const ENDPOINT = '/api/admin/media-credits/grants'

const num = (n: number) => n.toLocaleString('en-IN')

/** Human wording for each reason. The stored value is always the enum member. */
const REASON_LABEL: Record<CreditGrantReason, string> = {
  goodwill:     'Goodwill',
  compensation: 'Compensation',
  promotional:  'Promotional',
  migration:    'Migration',
  correction:   'Correction',
  support:      'Support',
}

type Phase = 'form' | 'confirm' | 'submitting' | 'done' | 'error'

export interface GrantCreditsDialogProps {
  onClose: () => void
  /** Pre-fills the recipient when the console already knows which workspace is in view. */
  organizerUid?: string
  /** Fired after a successful grant so the console re-reads its own data. */
  onGranted?: () => void
}

export function GrantCreditsDialog({ onClose, organizerUid = '', onGranted }: GrantCreditsDialogProps) {
  const { getToken } = useAuth()

  // One key for this dialog's lifetime, minted on the FIRST submit and reused by every retry.
  //
  // Deliberately a ref assigned inside the handler rather than `useMemo`: useMemo may discard
  // and recompute its value, which for an idempotency key would silently turn a retry into a
  // second grant — the exact failure it exists to prevent. A ref is written once and never
  // recomputed, and assigning it outside render keeps the component pure.
  //
  // Reusing the key after a failure is correct in both directions. If the transaction never
  // committed, no grant holds the key and the retry creates one. If it committed and only the
  // response was lost, the server returns the original instead of granting again.
  const grantIdRef = useRef<string | null>(null)

  const [uid,       setUid]       = useState(organizerUid)
  const [credits,   setCredits]   = useState('')
  const [reason,    setReason]    = useState<CreditGrantReason>('goodwill')
  const [note,      setNote]      = useState('')
  const [reference, setReference] = useState('')

  const [phase, setPhase]   = useState<Phase>('form')
  const [error, setError]   = useState<string | null>(null)
  const [result, setResult] = useState<{ credits: number; balanceAfter: number } | null>(null)

  // The SAME rules the server runs. Shown as you type; enforced again server-side.
  const parsed = Number(credits)
  const check  = validateGrant({
    organizerUid: uid,
    credits: credits.trim() === '' ? NaN : parsed,
    reason, note, reference,
  })

  const submit = useCallback(async () => {
    setPhase('submitting')
    setError(null)
    // Minted here, not during render, and only once.
    grantIdRef.current ??= `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    const grantId = grantIdRef.current
    try {
      const token = await getToken()
      const res = await fetch(ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          grantId, organizerUid: uid, credits: Number(credits),
          reason, note, reference: reference.trim() || null,
        }),
      })
      const body = await res.json().catch(() => null) as {
        grant?: { credits: number; balanceAfter: number }; created?: boolean; error?: string
      } | null

      if (!res.ok) {
        if (res.status === 403) {
          throw new Error(
            body?.error
            ?? 'Granting credits requires super-admin access. Your account cannot issue credits.',
          )
        }
        throw new Error(body?.error ?? 'The grant was not completed. Nothing was credited.')
      }

      setResult(body?.grant ?? null)
      setPhase('done')
      onGranted?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The grant was not completed.')
      setPhase('error')
    }
  }, [getToken, uid, credits, reason, note, reference, onGranted])

  const busy = phase === 'submitting'

  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose() }}
      closeOnBackdrop={!busy}
      title="Issue Media Credits"
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="text-fs-2xs text-muted-foreground">
            Recorded in the ledger and the admin audit log.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              {phase === 'done' ? 'Done' : 'Cancel'}
            </Button>

            {(phase === 'form' || phase === 'error') && (
              <Button size="sm" onClick={() => setPhase('confirm')} disabled={!check.ok}>
                Review grant
              </Button>
            )}
            {phase === 'confirm' && (
              <>
                <Button variant="outline" size="sm" onClick={() => setPhase('form')}>
                  Back
                </Button>
                <Button size="sm" onClick={() => void submit()}>
                  <Gift className="size-3.5" aria-hidden />
                  Issue {num(Number(credits) || 0)} credits
                </Button>
              </>
            )}
            {busy && (
              <Button size="sm" disabled>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Issuing…
              </Button>
            )}
          </div>
        </div>
      }
    >
      {/* ── Success ──────────────────────────────────────────────────────────── */}
      {phase === 'done' ? (
        <div className="flex gap-2.5 rounded-xl border border-success/40 bg-success/[0.06] p-3">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <div className="min-w-0">
            <p className="text-fs-sm font-medium text-foreground">Credits issued</p>
            <p className="mt-0.5 text-fs-2xs text-muted-foreground">
              {result ? `${num(result.credits)} credits added. ` : ''}
              {result ? `The workspace balance is now ${num(result.balanceAfter)}. ` : ''}
              The grant is recorded in the ledger and the audit log.
            </p>
          </div>
        </div>
      ) : phase === 'confirm' ? (
        /* ── Confirmation ───────────────────────────────────────────────────── */
        /* A separate step, deliberately. The form has a text area, and a form that submits
           on Enter would let someone create value with a keystroke they did not aim. */
        <div className="space-y-3">
          <div className="flex gap-2.5 rounded-xl border border-warning/40 bg-warning/[0.06] p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0">
              <p className="text-fs-sm font-medium text-foreground">
                This creates {num(Number(credits) || 0)} credits from nothing
              </p>
              <p className="mt-0.5 text-fs-2xs text-muted-foreground">
                No payment is involved. The credits become an obligation the platform owes this
                workspace, and the grant cannot be edited afterwards.
              </p>
            </div>
          </div>
          <Card className="p-3">
            <dl className="space-y-1.5 text-fs-sm">
              <Line label="Organizer"  value={uid} mono />
              <Line label="Credits"    value={num(Number(credits) || 0)} />
              <Line label="Reason"     value={REASON_LABEL[reason]} />
              <Line label="Note"       value={note.trim()} />
              {reference.trim() && <Line label="Reference" value={reference.trim()} />}
            </dl>
          </Card>
        </div>
      ) : (
        /* ── Form ───────────────────────────────────────────────────────────── */
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <Field label="Organizer UID" hint="The workspace that receives the credits.">
            <input
              value={uid}
              onChange={e => setUid(e.target.value)}
              placeholder="Firebase UID"
              className={inputCls}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            label="Credits"
            hint={`Whole credits, up to ${num(MAX_GRANT_CREDITS)} in one grant.`}
          >
            <input
              value={credits}
              onChange={e => setCredits(e.target.value)}
              inputMode="numeric"
              placeholder="500"
              className={inputCls}
            />
          </Field>

          <Field label="Reason" hint="Categorised so grants can be counted and reviewed.">
            <select
              value={reason}
              onChange={e => setReason(e.target.value as CreditGrantReason)}
              className={inputCls}
            >
              {CREDIT_GRANT_REASONS.map(r => (
                <option key={r} value={r}>{REASON_LABEL[r]}</option>
              ))}
            </select>
          </Field>

          <Field
            label="Note"
            hint={`Why this grant, in your own words. ${note.trim().length}/${MAX_NOTE_LENGTH}`}
          >
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={3}
              maxLength={MAX_NOTE_LENGTH}
              placeholder={`At least ${MIN_NOTE_LENGTH} characters — whoever reads this in six months will not have your context.`}
              className={cn(inputCls, 'resize-y')}
            />
          </Field>

          <Field label="Reference" hint="Optional. A ticket, invoice or thread id.">
            <input
              value={reference}
              onChange={e => setReference(e.target.value)}
              placeholder="ZD-9182"
              className={inputCls}
              autoComplete="off"
            />
          </Field>

          {/* The first unmet rule, rather than a list — one thing to fix at a time. */}
          <div aria-live="polite" className="min-h-[1rem]">
            {!check.ok && (credits !== '' || uid !== '' || note !== '') && (
              <p className="text-fs-2xs text-muted-foreground">{check.message}</p>
            )}
          </div>
        </fieldset>
      )}

      <div aria-live="assertive" aria-atomic="true">
        {phase === 'error' && error && (
          <div className="mt-3 flex gap-2.5 rounded-xl border border-destructive/40 bg-destructive/[0.06] p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0">
              <p className="text-fs-sm font-medium text-foreground">Grant not completed</p>
              <p className="mt-0.5 text-fs-2xs text-muted-foreground">{error}</p>
              <p className="mt-1 text-fs-2xs text-muted-foreground">
                Retrying is safe — this grant has a single identity, so a repeat cannot issue
                credits twice.
              </p>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}

const inputCls =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-fs-sm text-foreground '
  + 'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 '
  + 'focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60'

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-fs-2xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

function Line({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words text-right text-foreground', mono && 'font-mono text-fs-2xs')}>
        {value}
      </dd>
    </div>
  )
}
