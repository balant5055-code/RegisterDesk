'use client'

// RD-RECOVER-01 · TEMPORARY. Delete this directory once the recovery has run.
//
// ═══ WHAT THIS PAGE IS ═══════════════════════════════════════════════════════
// A button that attaches the signed-in admin's Firebase ID token to ONE POST. That is the
// whole of it. It carries no knowledge of which payment is being recovered, because it holds
// no target: `order_TS6MJY6uL9NgCw` appears nowhere in this file, and neither does the
// payment id, amount, event, pass or phone. The server route owns a frozen constant, so the
// only thing a compromised or mistyped client could do is fire the same fixed recovery again
// — which the intent check then refuses.
//
// ═══ WHAT IT DELIBERATELY DOES NOT DO ════════════════════════════════════════
// No Razorpay call, no Firestore read or write, no amount arithmetic, no duplicate checking,
// no registration or ticket construction, no wallet or ledger effect. Every one of those is
// the server route's sole authority. If this file ever grows one of them, the verification
// story splits in two and the client half is the one nobody audits.
//
// The ₹518.40 in the confirmation line is a DISPLAY STRING for the operator's benefit. It is
// not sent, not compared, and not trusted: the route re-verifies 51840 paise against Razorpay
// and against the stored intent independently.

import { useRef, useState } from 'react'
import { auth }             from '@/lib/firebase/auth'
import { StatusPill }       from '@/components/admin'
import type { PillTone }    from '@/components/admin'

/** The one endpoint this page may call. A literal, not a variable and not a parameter. */
const RECOVERY_ENDPOINT = '/api/admin/recover-orphaned-capture'

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

type Outcome =
  | { state: 'idle' }
  | { state: 'running' }
  /** The route answered. `ok` distinguishes a settlement from a refused verification. */
  | { state: 'done'; ok: boolean; status: number; body: string }
  /** The request itself never completed — the recovery state is UNKNOWN, not failed. */
  | { state: 'error'; message: string }

const TONE: Record<'success' | 'refused' | 'error', PillTone> = {
  success: 'success',
  refused: 'warning',
  error:   'danger',
}

export default function PageClient() {
  const [outcome, setOutcome] = useState<Outcome>({ state: 'idle' })

  // The ref, not the state, is what makes a second request impossible. `setOutcome` is
  // asynchronous, so between a double-click's two events React may not have re-rendered and
  // the `disabled` prop may not yet be applied. This flag flips synchronously on the first
  // event and is never reset, so the POST below is unreachable a second time in this page's
  // lifetime. `disabled` remains for the visible affordance.
  const fired = useRef(false)

  async function handleRecover() {
    if (fired.current) return
    fired.current = true
    setOutcome({ state: 'running' })

    try {
      const token = await getToken()

      // Exactly one POST. No body: the route never reads one, and sending a target-shaped
      // payload would falsely imply the client can aim this.
      const res = await fetch(RECOVERY_ENDPOINT, {
        method:  'POST',
        headers: { authorization: `Bearer ${token}` },
      })

      const body = await res.text()
      let pretty = body
      try { pretty = JSON.stringify(JSON.parse(body), null, 2) } catch { /* show raw */ }

      setOutcome({ state: 'done', ok: res.ok, status: res.status, body: pretty })
    } catch (err) {
      // NOT rethrown and NOT retried. A transport failure leaves the recovery in an UNKNOWN
      // state — it may have settled server-side — so the operator must verify in Firestore
      // rather than press again.
      setOutcome({ state: 'error', message: err instanceof Error ? err.message : 'Request failed' })
    }
  }

  const label =
    outcome.state === 'done'  ? (outcome.ok ? 'Recovered' : 'Refused')
    : outcome.state === 'error' ? 'Failed'
    : outcome.state === 'running' ? 'Recovering…'
    : 'Recover PRITHIVIK'

  return (
    <div className="max-w-2xl space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Recover PRITHIVIK</h1>
        <p className="text-[13.5px] text-muted-foreground">
          Temporary single-case recovery surface. Delete this page once the recovery is verified.
        </p>
      </header>

      <div className="space-y-4 rounded-xl border border-border bg-card p-5">
        <p className="text-[13.5px] font-medium">
          This will attempt recovery for S.P. PRITHIVIK — ₹518.40.
        </p>
        <p className="text-[13px] text-muted-foreground">
          The target is fixed inside the server route and cannot be changed from this page.
          The route verifies the capture at Razorpay, re-checks the stored intent, and refuses
          if a registration already exists. Pressing this once is safe; it cannot be pressed twice.
        </p>

        <button
          type="button"
          onClick={handleRecover}
          disabled={outcome.state !== 'idle'}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {label}
        </button>
      </div>

      {outcome.state === 'done' && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-3">
            <StatusPill tone={outcome.ok ? TONE.success : TONE.refused}>
              {outcome.ok ? 'Success' : 'Refused'}
            </StatusPill>
            <span className="text-[13.5px] text-muted-foreground">HTTP {outcome.status}</span>
          </div>
          {/* The route's response only ever carries the outcome kind, a reason and a
              registration id — no PII, no Razorpay payload, no configuration. */}
          <pre className="overflow-x-auto rounded-lg bg-background p-3 text-[12.5px]">{outcome.body}</pre>
        </div>
      )}

      {outcome.state === 'error' && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-5">
          <StatusPill tone={TONE.error}>Error</StatusPill>
          <p className="text-[13.5px]">{outcome.message}</p>
          <p className="text-[13px] text-muted-foreground">
            The request did not complete, so the recovery state is unknown — it may still have
            settled. Verify the payment intent in Firestore before doing anything else. Do not
            reload and press again.
          </p>
        </div>
      )}
    </div>
  )
}
