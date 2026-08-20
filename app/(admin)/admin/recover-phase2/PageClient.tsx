'use client'

// RD-RECOVER-01 phase 2 · TEMPORARY. Delete this directory once all six have run.
//
// ═══ WHAT THIS PAGE IS ═══════════════════════════════════════════════════════
// Six buttons that attach the signed-in admin's Firebase ID token to ONE POST each. That is
// the whole of it. It holds no target: no payment id, no phone, no email, no pass and no
// amount-in-paise reaches the server from here. The only thing sent is an opaque KEY, which
// the route uses to look up a frozen server-side table. A caller who edits the key in the
// browser can at most select a different one of the same six pre-approved recoveries.
//
// The order id and rupee figure ARE shown, deliberately — the operator must be able to see
// which case they are about to settle. They are display strings: never sent, never compared.
//
// ═══ WHAT IT DELIBERATELY DOES NOT DO ════════════════════════════════════════
// No Razorpay call, no Firestore read or write, no amount arithmetic, no duplicate checking,
// no registration or ticket construction, no wallet or ledger effect. Every one of those is
// the server route's sole authority. PRITHIVIK is absent — he is already recovered, and a
// second settlement must not be reachable from here even by mistake.

import { useRef, useState } from 'react'
import { auth }             from '@/lib/firebase/auth'
import { StatusPill }       from '@/components/admin'
import type { PillTone }    from '@/components/admin'

/** The one endpoint family this page may call. A literal, not a variable and not a parameter. */
const RECOVERY_BASE = '/api/admin/recover-phase2'

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

/**
 * Display rows. `key` is the server lookup; `order` and `amount` are shown so the operator
 * can confirm the case before clicking. Nothing here is a target — the server owns those.
 */
const ROWS: ReadonlyArray<{ key: string; name: string; order: string; amount: string }> = Object.freeze([
  { key: 'vishnu-vk',     name: 'VISHNU VK',         order: 'order_TQtlyzWELP0jsL', amount: '₹518.40' },
  { key: 'elakiya-b',     name: 'Elakiya B',         order: 'order_TRBehMbYBLGVIm', amount: '₹518.40' },
  { key: 'paramasivam',   name: 'Paramasivam',       order: 'order_TRRvMasMUbgrP0', amount: '₹518.40' },
  { key: 'vishnu-kumar',  name: 'Vishnu Kumar',      order: 'order_TRxCGSJuLdssXd', amount: '₹518.40' },
  { key: 'kaaviyan',      name: 'Kaaviyan',          order: 'order_TS5ovIHIUySOtd', amount: '₹259.20' },
  { key: 'sampath-kumar', name: 'A N Sampath Kumar', order: 'order_TS7WLg0h7eCYqY', amount: '₹518.40' },
])

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
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})

  // The ref, not the state, is what makes a second request impossible. `setOutcomes` is
  // asynchronous, so between a double-click's two events React may not have re-rendered and
  // the `disabled` prop may not yet be applied. This set is written synchronously on the
  // first event and never cleared, so each key's POST is unreachable a second time in this
  // page's lifetime. `disabled` remains for the visible affordance.
  const fired = useRef<Set<string>>(new Set())

  async function handleRecover(key: string) {
    if (fired.current.has(key)) return
    fired.current.add(key)
    setOutcomes(o => ({ ...o, [key]: { state: 'running' } }))

    try {
      const token = await getToken()

      // Exactly one POST per key. No body: the route never reads one, and sending a
      // target-shaped payload would falsely imply the client can aim this.
      const res = await fetch(`${RECOVERY_BASE}/${key}`, {
        method:  'POST',
        headers: { authorization: `Bearer ${token}` },
      })

      const raw = await res.text()
      let pretty = raw
      try { pretty = JSON.stringify(JSON.parse(raw), null, 2) } catch { /* show raw */ }

      setOutcomes(o => ({ ...o, [key]: { state: 'done', ok: res.ok, status: res.status, body: pretty } }))
    } catch (err) {
      // NOT rethrown and NOT retried. A transport failure leaves the recovery in an UNKNOWN
      // state — it may have settled server-side — so the operator must verify in Firestore
      // rather than press again.
      setOutcomes(o => ({
        ...o,
        [key]: { state: 'error', message: err instanceof Error ? err.message : 'Request failed' },
      }))
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Recovery Phase 2</h1>
        <p className="text-[13.5px] text-muted-foreground">
          Temporary six-case recovery surface. Delete this page once every case is verified.
        </p>
      </header>

      <div className="space-y-2 rounded-xl border border-border bg-card p-5">
        <p className="text-[13.5px] font-medium">Confirmed captured — ready for recovery</p>
        <p className="text-[13px] text-muted-foreground">
          Each target is fixed inside the server route and cannot be changed from this page.
          The route verifies the capture at Razorpay, re-checks the stored intent, and refuses
          if a registration already exists. Run one at a time and verify before the next.
          Each button can be pressed only once.
        </p>
      </div>

      <div className="space-y-3">
        {ROWS.map((r, i) => {
          const o = outcomes[r.key] ?? { state: 'idle' as const }
          const label =
            o.state === 'done'    ? (o.ok ? 'Recovered' : 'Refused')
            : o.state === 'error'   ? 'Failed'
            : o.state === 'running' ? 'Recovering…'
            : 'Recover'

          return (
            <div key={r.key} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold">{i + 1}. {r.name} — {r.amount}</p>
                  <p className="truncate font-mono text-[12px] text-muted-foreground">{r.order}</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRecover(r.key)}
                  disabled={o.state !== 'idle'}
                  className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {label}
                </button>
              </div>

              {o.state === 'done' && (
                <div className="space-y-2 border-t border-border pt-3">
                  <div className="flex items-center gap-3">
                    <StatusPill tone={o.ok ? TONE.success : TONE.refused}>
                      {o.ok ? 'Success' : 'Refused'}
                    </StatusPill>
                    <span className="text-[13px] text-muted-foreground">HTTP {o.status}</span>
                  </div>
                  {/* The route's response only ever carries the outcome kind, a reason and a
                      registration id — no PII, no Razorpay payload, no configuration. */}
                  <pre className="overflow-x-auto rounded-lg bg-background p-3 text-[12.5px]">{o.body}</pre>
                </div>
              )}

              {o.state === 'error' && (
                <div className="space-y-2 border-t border-border pt-3">
                  <StatusPill tone={TONE.error}>Error</StatusPill>
                  <p className="text-[13.5px]">{o.message}</p>
                  <p className="text-[13px] text-muted-foreground">
                    The request did not complete, so this recovery&apos;s state is unknown — it may
                    still have settled. Verify the payment intent in Firestore before doing
                    anything else. Do not reload and press again.
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
