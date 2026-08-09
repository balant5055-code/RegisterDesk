'use client'

// RD-FINANCE-CLOSURE-02 · Read-only payout-profile change history.
//
// Additive: a sibling section below the existing form. Nothing about the form, its
// validation, its save flow or its styling changes — this component only reads
// GET /api/organizer/payout-profile/history and renders it in the page's own idiom
// (the same rounded-xl / border-border / text-[13px] scale the form uses).
//
// Every value shown is already masked SERVER-SIDE (lib/payout/mask.ts). This component
// never receives an account number, a UPI id or a PAN, so there is nothing here that could
// leak one into the DOM, a screenshot or a browser extension.

import { useEffect, useState } from 'react'
import { AlertCircle, History, Loader2 } from 'lucide-react'
import { useAuth } from '@/components/auth/AuthProvider'
import type { PayoutHistoryResponse } from '@/app/api/organizer/payout-profile/history/route'
import type { PayoutProfileHistoryEntry } from '@/lib/payout/history'

/** Reloads whenever the parent saves, so a change appears without a page refresh. */
export interface PayoutHistoryPanelProps { reloadKey: number }

const FIELD_LABEL: Record<string, string> = {
  accountHolderName: 'Account holder',
  payoutMethod:      'Payout method',
  bankName:          'Bank',
  accountNumber:     'Account number',
  ifscCode:          'IFSC',
  upiId:             'UPI ID',
  panNumber:         'PAN',
  gstNumber:         'GST',
}

function when(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

export function PayoutHistoryPanel({ reloadKey }: PayoutHistoryPanelProps) {
  const { user, getToken } = useAuth()
  const [entries, setEntries] = useState<PayoutProfileHistoryEntry[] | null>(null)
  const [error,   setError]   = useState<string | null>(null)

  // The runner is defined INSIDE the effect on purpose. Hoisting it into a `useCallback`
  // and calling it here is traced by `react-hooks/set-state-in-effect` as a synchronous
  // setState in an effect body; declaring it inline makes the async boundary explicit and
  // satisfies the rule without suppressing it.
  useEffect(() => {
    if (!user) return
    let cancelled = false

    const run = async () => {
      try {
        const t = await getToken()
        if (cancelled || !t) return
        const res = await fetch('/api/organizer/payout-profile/history', {
          headers: { Authorization: `Bearer ${t}` },
          cache:   'no-store',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as PayoutHistoryResponse
        if (cancelled) return
        setEntries(data.entries)
        setError(null)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Could not load change history.')
        setEntries([])
      }
    }

    void run()
    return () => { cancelled = true }
  }, [user, getToken, reloadKey])

  if (user === undefined || entries === null) {
    return (
      <div className="rounded-xl border border-border bg-card p-5" aria-busy="true">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Loading change history…
        </div>
      </div>
    )
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5" aria-labelledby="payout-history-heading">
      <div className="flex items-start gap-2.5">
        <History className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <h2 id="payout-history-heading" className="text-[15px] font-semibold text-foreground">
            Change history
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Every change to your payout destination is recorded permanently and cannot be
            edited or removed. Account numbers are shown masked.
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
          <p className="text-[13px] text-destructive">{error}</p>
        </div>
      )}

      {!error && entries.length === 0 && (
        <p className="mt-4 text-[13px] text-muted-foreground">
          No changes recorded yet. Your first saved payout profile will appear here.
        </p>
      )}

      {entries.length > 0 && (
        <ol className="mt-4 space-y-3">
          {entries.map(e => (
            <li key={e.id} className="rounded-lg border border-border bg-background px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[13px] font-semibold text-foreground">
                  {e.action === 'created' ? 'Payout profile created' : 'Payout details changed'}
                </p>
                <p className="text-[12px] tabular-nums text-muted-foreground">{when(e.createdAt)}</p>
              </div>

              <p className="mt-1 text-[12.5px] text-muted-foreground">
                {e.previous
                  ? <>Destination: <span className="font-medium text-foreground">{e.previous.label}</span> → <span className="font-medium text-foreground">{e.next.label}</span></>
                  : <>Destination: <span className="font-medium text-foreground">{e.next.label}</span></>}
              </p>

              {e.changedFields.length > 0 && (
                <p className="mt-1 text-[12px] text-muted-foreground">
                  Changed: {e.changedFields.map(f => FIELD_LABEL[f] ?? f).join(', ')}
                </p>
              )}

              {e.verificationReset && (
                <p className="mt-1 text-[12px] font-medium text-amber-700 dark:text-amber-400">
                  Verification was reset by this change.
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
