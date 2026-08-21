'use client'

// Payment Issues — captured payments whose registration is missing.
//
// ═══ WHAT THIS PAGE IS FOR ═══════════════════════════════════════════════════
// One question: "did an attendee pay us and get nothing?" A Razorpay order accepts several
// attempts, so a first attempt can fail, the attendee retry on the same order and succeed,
// and the retry's capture arrive after the intent was already marked failed. The
// reconciliation sweep settles most of those automatically within ten minutes; what reaches
// this page is what it could not settle on its own.
//
// ═══ WHAT THIS PAGE DOES NOT DO ══════════════════════════════════════════════
// It sends no payment identity of any kind. The only value it posts is the case id, and the
// server re-derives the payment, amount, currency, event, pass and attendee from its own
// data before touching the settlement. Nothing here can widen what the organizer sees or
// force a settlement — the workspace comes from the verified token, never from this client.
//
// A refused case shows no Recover button at all, rather than a button that fails: an action
// that cannot succeed should not look available.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, ShieldAlert, Wallet } from 'lucide-react'
import { useAuth } from '@/components/auth/AuthProvider'
import { Card, EmptyState, ErrorState, PageHeader } from '@/components/ui'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/utils/cn'
import type { PaymentIssuesResponse } from '@/app/api/organizer/payment-issues/route'
import type { RecoverResponse } from '@/app/api/organizer/payment-issues/[orderId]/recover/route'

type Issue = NonNullable<PaymentIssuesResponse['issues']>[number]

const inr = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`

const when = (iso: string | null) => {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Severity, in the existing semantic tokens — no new colours.
 *   actionable      → destructive: money is out there and the organizer can fix it
 *   requires_review → warning:     visible, but not theirs to force
 *   resolved        → success
 */
function Severity({ issue }: { issue: Issue }) {
  const map = {
    actionable:      { label: 'Registration Missing',    cls: 'bg-destructive/10 text-destructive', Icon: AlertCircle },
    requires_review: { label: 'Requires Platform Review', cls: 'bg-warning/10 text-warning',        Icon: ShieldAlert },
    resolved:        { label: 'Recovered',                cls: 'bg-success/10 text-success',        Icon: CheckCircle2 },
  } as const
  const { label, cls, Icon } = map[issue.status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold', cls)}>
      <Icon className="size-3.5" aria-hidden /> {label}
    </span>
  )
}

export default function PaymentIssuesPage() {
  const { getToken } = useAuth()
  const { confirm } = useConfirm()
  const { showToast } = useToast()

  const [issues,  setIssues]  = useState<Issue[] | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch('/api/organizer/payment-issues', {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      const body = await res.json() as PaymentIssuesResponse
      if (!res.ok) throw new Error(body.error ?? 'Could not load payment issues.')
      setIssues(body.issues ?? [])
    } catch (e) {
      setIssues(null)
      setError(e instanceof Error ? e.message : 'Could not load payment issues.')
    }
  }, [getToken])

  // Load on mount. Same pattern — and the same disable — as every other dashboard list page
  // (see AssetLibraryClient): the effect only kicks off a fetch, which then sets state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  async function recover(issue: Issue) {
    // Explicit confirmation, naming what the server will re-check — so "Recover" never reads
    // as "force". Reusing the shared dialog rather than a bespoke modal.
    const okToGo = await confirm({
      title:        'Recover this registration?',
      message:      'RegisterDesk will revalidate the payment, event, pass, attendee and duplicate protections before creating the registration.',
      confirmLabel: 'Recover Registration',
    })
    if (!okToGo) return

    setWorking(issue.orderId)
    try {
      // The case id is the ONLY thing sent. No body at all.
      const token = await getToken()
      const res = await fetch(
        `/api/organizer/payment-issues/${encodeURIComponent(issue.orderId)}/recover`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      )
      const body = await res.json() as RecoverResponse

      if (body.ok) {
        showToast(
          body.ticketCode ? `${body.message} Ticket ${body.ticketCode}.` : body.message,
          'success',
        )
      } else {
        showToast(body.message, 'error')
      }
      await load()   // reflect the server's new state rather than guessing at it
    } catch {
      showToast('Could not complete the recovery. Please try again.', 'error')
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payment Issues"
        subtitle="Attendees whose payment succeeded but whose registration is missing."
      />

      {error && (
        <ErrorState message={error} onRetry={() => { void load() }} />
      )}

      {!error && issues === null && (
        <Card className="flex items-center gap-3 p-6 text-[13.5px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading payment issues…
        </Card>
      )}

      {!error && issues?.length === 0 && (
        <EmptyState
          icon={Wallet}
          title="No payment issues"
          description="RegisterDesk automatically checks every captured payment against its registration and recovers what it safely can. Anything it cannot resolve on its own appears here."
        />
      )}

      {!error && issues && issues.length > 0 && (
        <div className="space-y-3">
          {issues.map(issue => {
            const busy = working === issue.orderId
            return (
              <Card key={issue.orderId} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <Severity issue={issue} />
                    <p className="text-[15px] font-bold text-foreground">{issue.attendeeName || 'Attendee'}</p>
                    <p className="text-[13px] text-muted-foreground">{issue.eventName}</p>
                    <p className="text-[15px] font-semibold text-foreground">{inr(issue.amountPaise)}</p>
                    <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12.5px] text-muted-foreground">
                      <div className="flex gap-1">
                        <dt>Payment:</dt>
                        <dd className="font-medium text-foreground">
                          {issue.paymentState === 'captured' ? 'Captured' : 'Unverified'}
                        </dd>
                      </div>
                      <div className="flex gap-1"><dt>Registration:</dt><dd className="font-medium text-foreground">Missing</dd></div>
                      <div className="flex gap-1"><dt>Detected:</dt><dd>{when(issue.detectedAt)}</dd></div>
                    </dl>
                  </div>

                  <div className="shrink-0">
                    {issue.status === 'actionable' ? (
                      <button
                        type="button"
                        onClick={() => { void recover(issue) }}
                        disabled={busy}
                        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy
                          ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Recovering…</>
                          : <>Review &amp; Recover</>}
                      </button>
                    ) : (
                      // Deliberately NOT a disabled Recover button: this case is not the
                      // organizer's to force, and a greyed-out action invites a support ticket.
                      <p className="max-w-[220px] text-right text-[12.5px] text-muted-foreground">
                        Our team is reviewing this payment. No action is needed from you.
                      </p>
                    )}
                  </div>
                </div>

                {issue.status === 'resolved' && issue.registrationId && (
                  <div className="mt-3 border-t border-border pt-3">
                    <Link
                      href={`/dashboard/attendees?registrationId=${encodeURIComponent(issue.registrationId)}`}
                      className="text-[13px] font-semibold text-primary hover:underline"
                    >
                      View Registration
                    </Link>
                  </div>
                )}
              </Card>
            )
          })}

          <button
            type="button"
            onClick={() => { void load() }}
            className="inline-flex items-center gap-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </button>
        </div>
      )}
    </div>
  )
}
