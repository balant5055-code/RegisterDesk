'use client'

// MC-08 · Media Credits operations console (Super Admin).
//
// ═══ READ-MOSTLY BY DESIGN ═══════════════════════════════════════════════════
// Exactly two mutations are reachable from this page, and both are decisions an admin has
// already been trusted with elsewhere: approving or rejecting a refund, and retrying a payout
// that is already owed. Everything else is observation.
//
// MC-09 added the third: issuing credits manually. It is the only action here that creates
// value rather than moving or observing it, so it is gated on `resolveSuperAdminUid` —
// ADMIN_UIDS membership, not the `admin: true` claim — and it is the one control on this
// page an ordinary platform admin can see but not use.
//
// ═══ SEVEN ENDPOINTS, EACH INDEPENDENTLY FALLIBLE ════════════════════════════
//   /admin/media-credits/overview        platform totals (bounded scan)
//   /admin/media-credits/reconciliation  pending grants, stuck refunds, orphans
//   /admin/media-credits/refunds         the refund queue, by status
//   /admin/media-credits/sessions        session rows behind the counts
//   /admin/media-credits/grants          grant history + issuing (MC-09)
//   /admin/operations                    scheduler health
//   /admin/audit-logs                    administrative actions
//
// A console that blanks because one panel failed is useless during the incident it exists to
// help with, so each section degrades alone.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ROUTES } from '@/config/navigation'
import Link from 'next/link'
import {
  Activity, AlertTriangle, Ban, CheckCircle2, Clock, Coins, Gift, Layers,
  RefreshCw, ThumbsDown, ThumbsUp, Timer, TrendingUp, Users, Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Badge, Button, Card, EmptyState, ErrorState, SectionHeading, Skeleton, StatusChip, useToast,
} from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import { GrantCreditsDialog } from './GrantCreditsDialog'
import { RefundDecisionDialog } from './RefundDecisionDialog'

// ─── Wire shapes ─────────────────────────────────────────────────────────────

interface Overview {
  credits: {
    organizers: number; creditsIssued: number; creditsConsumed: number
    creditsHeld: number; outstandingLiability: number
  }
  revenue: {
    purchasesGranted: number; revenuePaise: number; creditsSold: number
    averagePurchasePaise: number | null; purchasesPending: number; purchasesFailed: number
  }
  sessions: {
    activeSessions: number; sealedSessions: number; settledSessions: number
    expiredActive: number; pendingSettlement: number; quarantined: number
  }
  pricing: {
    creditsEnabled: boolean; creditsPerPhoto: number; unitPricePaise: number
    /** MC-12.1 · drives the decision dialog's note requirement. */
    refundNoteRequired?: boolean
  }
  scanned: { wallets: number; purchases: number; limit: number; truncated: boolean }
}
interface Reconciliation {
  pendingGrants: { count: number }
  pendingRefundPayouts: { count: number; items: { refundId: string; organizerUid: string; refundAmountPaise: number; attempts: number; lastError: string | null }[] }
  orphans: { unrecordedPaidPurchases: string[]; stuckRefunds: string[] }
}
/**
 * MC-11 · The refund queue row.
 *
 * The endpoint already returned every one of these fields — it serves `CreditRefundDetailDto`
 * — and the console simply declared four of them. Widening the type displays what was always
 * on the wire; no endpoint or service changed.
 *
 * Every money figure was computed and FROZEN when the request was created. The console shows
 * the stored values and derives nothing: re-deriving a service charge here would price an old
 * refund at today's rate.
 */
interface RefundRow {
  refundId: string; credits: number; refundAmountPaise: number
  status: string; purchaseId: string; createdAtMs: number
  organizerUid: string
  reason: string
  purchaseAmountPaise: number
  /**
   * RD-MC-REFUND-V2-P2 · unused credits × the purchase's unit price. What the service charge
   * is taken from. Optional on the row because refunds written before P2 have no such field —
   * their base was the whole purchase amount.
   */
  refundBasePaise?: number
  /**
   * RD-MC-REFUND-V2-P3 · the credit breakdown the decision screen shows. Optional because
   * refunds written before P3 have neither — both fall back to `credits`, which is exactly
   * what they were: a whole, wholly-unused purchase.
   */
  purchaseCreditsAtRequest?: number
  creditsRemainingAtRequest?: number
  serviceCharge: { amountPaise: number; method: string; percent: number }
  walletAtRequest: { balance: number; held: number; available: number }
  decisionNote: string | null
  gatewayRefundId: string | null
}
interface SessionRow {
  sessionId: string; status: string; allocatedCredits: number
  slotCount: number; consumedSlots: number | null
}
// MC-09 · richer than a ledger row: a grant carries the justification a ledger entry has
// no fields for, which is the whole reason the grant record exists beside it.
interface GrantRow {
  grantId: string; organizerUid: string; credits: number
  reason: string; note: string; reference: string | null
  actorUid: string; entryId: string; balanceAfter: number; createdAtMs: number
}
interface CronRow {
  cronName: string; lastRunAt: number | null; lastOk: boolean | null; stale: boolean
}
interface AuditRow {
  id?: string; adminUid: string; action: string; entityId: string
  entityType?: string; createdAt?: unknown
}

type Loadable<T> = { data: T | null; loading: boolean; error: string | null }
const initial = <T,>(): Loadable<T> => ({ data: null, loading: true, error: null })

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const num = (n: number) => n.toLocaleString('en-IN')

const REFUND_TABS = ['requested', 'approved', 'settled', 'rejected'] as const
type RefundTab = (typeof REFUND_TABS)[number]

export function AdminCreditsConsole() {
  const { getToken } = useAuth()
  const { showToast } = useToast()

  const [overview, setOverview] = useState<Loadable<Overview>>(initial)
  const [recon,    setRecon]    = useState<Loadable<Reconciliation>>(initial)
  const [refunds,  setRefunds]  = useState<Loadable<RefundRow[]>>(initial)
  const [sessions, setSessions] = useState<Loadable<SessionRow[]>>(initial)
  const [grants,   setGrants]   = useState<Loadable<GrantRow[]>>(initial)

  // MC-09 · the grant dialog. Mounted only while true, so each opening mints a fresh
  // idempotency key — see GrantCreditsDialog.
  const [granting, setGranting] = useState(false)
  const [crons,    setCrons]    = useState<Loadable<CronRow[]>>(initial)
  const [auditLog, setAuditLog] = useState<Loadable<AuditRow[]>>(initial)

  const [refundTab, setRefundTab] = useState<RefundTab>('requested')
  const [sessionView, setSessionView] = useState<'sealed' | 'quarantined' | 'expired'>('sealed')
  const [busyRefund, setBusyRefund] = useState<string | null>(null)
  // MC-12.1 · The refund awaiting a decision, and which way. Null when no dialog is open.
  const [deciding, setDeciding] = useState<{ row: RefundRow; approve: boolean } | null>(null)
  // From Business Configuration, so the dialog gates its note field the same way the route
  // does. Read off the overview endpoint, which already resolves the policy.
  const noteRequired = Boolean(overview.data?.pricing?.refundNoteRequired)

  const load = useCallback(async <T,>(
    path: string,
    pick: (body: Record<string, unknown>) => T,
    set: (v: Loadable<T>) => void,
  ) => {
    set({ data: null, loading: true, error: null })
    try {
      const token = await getToken()
      const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } })
      if (res.status === 403) throw new Error('Super Admin access required.')
      if (!res.ok) throw new Error('Could not load this section.')
      set({ data: pick(await res.json() as Record<string, unknown>), loading: false, error: null })
    } catch (e) {
      set({ data: null, loading: false, error: e instanceof Error ? e.message : 'Could not load.' })
    }
  }, [getToken])

  const loadOverview = useCallback(() => {
    void load('/api/admin/media-credits/overview', b => b as unknown as Overview, setOverview)
    void load('/api/admin/media-credits/reconciliation', b => b as unknown as Reconciliation, setRecon)
  }, [load])

  const loadRefunds = useCallback((tab: RefundTab) => {
    void load(`/api/admin/media-credits/refunds?status=${tab}&limit=50`,
      b => (b.refunds ?? []) as RefundRow[], setRefunds)
  }, [load])

  const loadSessions = useCallback((view: typeof sessionView) => {
    const q = view === 'quarantined' ? 'quarantined=true'
      : view === 'expired' ? 'status=ACTIVE' : 'status=SEALED'
    void load(`/api/admin/media-credits/sessions?${q}&limit=50`,
      b => (b.sessions ?? []) as SessionRow[], setSessions)
  }, [load])

  // MC-09 · the grants endpoint, not the ledger: only it carries the reason, note and
  // reference an admin needs to review WHY a grant happened. Named so the dialog can
  // refresh the table after issuing without reloading the page.
  const loadGrants = useCallback(() => {
    void load('/api/admin/media-credits/grants?limit=25',
      b => (b.grants ?? []) as GrantRow[], setGrants)
  }, [load])

  // MC-09 · BOTH media-credit entity types. The endpoint filters on one entityType at a
  // time, so filtering to either would hide half of this module's financial actions from the
  // panel that exists to show them. Two requests, merged newest-first.
  const loadAudit = useCallback(() => {
    void load('/api/admin/audit-logs?pageSize=50', b => {
      const rows = (b.logs ?? b.items ?? []) as AuditRow[]
      return rows.filter(r => r.entityType?.startsWith('media_credit_')).slice(0, 25)
    }, setAuditLog)
  }, [load])

  useEffect(() => {
    loadOverview()
    loadGrants()
    void load('/api/admin/operations', b => {
      const health = (b.health ?? b) as Record<string, unknown>
      return ((health.crons ?? []) as CronRow[])
        // Only this module's crons — the console is about credits, not the whole platform.
        .filter(c => c.cronName.startsWith('media-credit'))
    }, setCrons)
    loadAudit()
  }, [load, loadOverview, loadGrants, loadAudit])

  useEffect(() => { loadRefunds(refundTab) }, [loadRefunds, refundTab])
  useEffect(() => { loadSessions(sessionView) }, [loadSessions, sessionView])

  async function retryRefund(refundId: string) {
    setBusyRefund(refundId)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/media-credits/refunds/${refundId}/retry`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      // 202 is not a failure — the payout is queued and still owed.
      if (res.status === 202) showToast('Payout is still processing. It will retry.', 'info')
      else if (!res.ok) throw new Error('Retry failed.')
      else showToast('Refund settled.', 'success')
      loadRefunds(refundTab)
      loadOverview()
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Retry failed.', 'error')
    } finally {
      setBusyRefund(null)
    }
  }

  const o = overview.data
  const liabilityRupees = useMemo(
    () => (o ? o.credits.outstandingLiability * (o.pricing.unitPricePaise / 100) : 0),
    [o],
  )

  return (
    <div className="space-y-6">
      {/* ═══ 1 · Platform overview ═══ */}
      <section aria-labelledby="mc-overview">
        <SectionHeading id="mc-overview" title="Platform overview" />
        {overview.loading ? (
          <StatGridSkeleton />
        ) : overview.error ? (
          <div className="mt-3"><ErrorState message={overview.error} /></div>
        ) : o && (
          <>
            {o.scanned.truncated && (
              <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/[0.05] p-2.5 text-fs-2xs text-warning-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  Totals below cover the first {num(o.scanned.limit)} records and are a{' '}
                  <strong>floor, not a total</strong> — more exist beyond the scan limit.
                </span>
              </p>
            )}
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              <Stat icon={Coins}    label="Credits issued"   value={num(o.credits.creditsIssued)} />
              <Stat icon={TrendingUp} label="Credits consumed" value={num(o.credits.creditsConsumed)} />
              <Stat icon={Clock}    label="Credits held"     value={num(o.credits.creditsHeld)}
                    hint={o.credits.creditsHeld > 0 ? 'Open sessions' : undefined} />
              <Stat icon={Wallet}   label="Outstanding liability" value={num(o.credits.outstandingLiability)}
                    hint={`≈ ${rupees(liabilityRupees * 100)}`} emphasis />
              <Stat icon={Users}    label="Organizers"       value={num(o.credits.organizers)} />
              <Stat icon={Activity} label="Active sessions"  value={num(o.sessions.activeSessions)}
                    hint={o.sessions.expiredActive > 0 ? `${num(o.sessions.expiredActive)} past expiry` : undefined}
                    tone={o.sessions.expiredActive > 0 ? 'warning' : undefined} />
              <Stat icon={Ban}      label="Quarantined"      value={num(o.sessions.quarantined)}
                    tone={o.sessions.quarantined > 0 ? 'danger' : undefined} />
              <Stat icon={RefreshCw} label="Pending settlement" value={num(o.sessions.pendingSettlement)} />
            </div>
          </>
        )}

        {/* Reconciliation debts sit with the overview: each is money owed to someone. */}
        {recon.data && (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Stat icon={AlertTriangle} label="Pending grants"
                  value={num(recon.data.pendingGrants.count)}
                  hint="Paid, credits not yet issued"
                  tone={recon.data.pendingGrants.count > 0 ? 'warning' : undefined} />
            <Stat icon={AlertTriangle} label="Pending payouts"
                  value={num(recon.data.pendingRefundPayouts.count)}
                  hint="Debited, money not yet sent"
                  tone={recon.data.pendingRefundPayouts.count > 0 ? 'warning' : undefined} />
            <Stat icon={Ban} label="Orphans"
                  value={num(recon.data.orphans.unrecordedPaidPurchases.length + recon.data.orphans.stuckRefunds.length)}
                  hint="Need a human"
                  tone={(recon.data.orphans.unrecordedPaidPurchases.length + recon.data.orphans.stuckRefunds.length) > 0 ? 'danger' : undefined} />
          </div>
        )}
      </section>

      {/* ═══ 6 · Financial ═══ */}
      <section aria-labelledby="mc-financial">
        <SectionHeading id="mc-financial" title="Financial" />
        {o && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat icon={Wallet} label="Revenue" value={rupees(o.revenue.revenuePaise)} emphasis />
            <Stat icon={Coins}  label="Credits sold" value={num(o.revenue.creditsSold)} />
            <Stat icon={TrendingUp} label="Average purchase"
                  value={o.revenue.averagePurchasePaise === null ? '—' : rupees(o.revenue.averagePurchasePaise)} />
            <Stat icon={Layers} label="Purchases"
                  value={num(o.revenue.purchasesGranted)}
                  hint={o.revenue.purchasesPending > 0 ? `${num(o.revenue.purchasesPending)} pending` : undefined} />
          </div>
        )}
      </section>

      {/* ═══ 2 · Pricing (read-only) ═══ */}
      <section aria-labelledby="mc-pricing">
        <SectionHeading id="mc-pricing" title="Pricing" />
        <Card className="mt-3 p-4">
          {o ? (
            <>
              <dl className="grid gap-3 sm:grid-cols-3">
                <Line label="Credit price" value={rupees(o.pricing.unitPricePaise)} />
                <Line label="Credits per photo" value={num(o.pricing.creditsPerPhoto)} />
                <Line label="Credits" value={o.pricing.creditsEnabled ? 'Enabled' : 'Disabled'} />
              </dl>
              {/* Deliberately not editable here. Business Configuration is the single
                  writable surface for every media policy; a second editor would be a second
                  source of truth for pricing. */}
              <p className="mt-3 border-t border-border/60 pt-3 text-fs-2xs text-muted-foreground">
                Read-only. Change these in{' '}
                <Link href={ROUTES.ADMIN_BUSINESS_CONFIG} className="text-primary underline-offset-2 hover:underline">
                  Business Configuration
                </Link>, which owns every media policy.
              </p>
            </>
          ) : <Skeleton className="h-16 w-full rounded-md" />}
        </Card>
      </section>

      {/* ═══ 4 · Refund operations ═══ */}
      <section aria-labelledby="mc-refunds">
        <SectionHeading id="mc-refunds" title="Refund operations" />
        <Tabs
          value={refundTab}
          options={REFUND_TABS.map(t => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))}
          onChange={v => setRefundTab(v as RefundTab)}
          ariaLabel="Refund status"
        />
        <Card className="mt-3 overflow-hidden">
          <Body state={refunds} emptyIcon={CheckCircle2} emptyTitle={`No ${refundTab} refunds`}
                emptyDescription="Nothing in this queue right now.">
            {rows => (
              <Table head={[
                'Organizer', 'Credits', 'Unused', 'Purchase', 'Charge', 'Net payout',
                'Reason', 'Age', 'Status', '',
              ]}>
                {rows.map(r => (
                  <tr key={r.refundId} className="border-b border-border/50 last:border-0">
                    <td className="px-4 py-2.5 font-mono text-fs-2xs text-muted-foreground" title={r.organizerUid}>
                      {r.refundId.slice(0, 12)}…
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{num(r.credits)}</td>
                    {/* Unused credits AT THE MOMENT OF REQUEST — the snapshot the decision was
                        based on, not a live figure that would move under the reviewer. */}
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {num(r.walletAtRequest?.available ?? 0)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{rupees(r.purchaseAmountPaise ?? 0)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      − {rupees(r.serviceCharge?.amountPaise ?? 0)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                      {rupees(r.refundAmountPaise)}
                    </td>
                    <td className="px-4 py-2.5 max-w-[16rem] text-fs-2xs text-muted-foreground">
                      <span className="line-clamp-2">{r.reason || '—'}</span>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-fs-2xs text-muted-foreground">
                      {ageOf(r.createdAtMs)}
                    </td>
                    <td className="px-4 py-2.5"><StatusChip tone={refundTone(r.status)}>{r.status}</StatusChip></td>
                    <td className="px-4 py-2.5 text-right">
                      {/* MC-12.1 · Approve and Reject. Both call the existing decide endpoint,
                          which has been there since MC-05 with no caller — the gap MC-12
                          found. Shown only on `requested`, because every other status is
                          already decided and the endpoint would refuse. */}
                      {r.status === 'requested' && (
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant="outline"
                                  onClick={() => setDeciding({ row: r, approve: false })}>
                            <ThumbsDown className="size-3.5" aria-hidden />
                            Reject
                          </Button>
                          <Button size="sm"
                                  onClick={() => setDeciding({ row: r, approve: true })}>
                            <ThumbsUp className="size-3.5" aria-hidden />
                            Approve
                          </Button>
                        </div>
                      )}
                      {r.status === 'approved' && (
                        <Button size="sm" variant="secondary"
                                disabled={busyRefund === r.refundId}
                                onClick={() => void retryRefund(r.refundId)}>
                          <RefreshCw className={cn('size-3.5', busyRefund === r.refundId && 'animate-spin')} aria-hidden />
                          Retry payout
                        </Button>
                      )}
                      {/* settled / rejected / settling carry no action — the row's status
                          chip already says why, and a disabled button would say less. */}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Body>
        </Card>
      </section>

      {/* ═══ 5 · Session monitoring ═══ */}
      <section aria-labelledby="mc-sessions">
        <SectionHeading id="mc-sessions" title="Session monitoring" />
        <Tabs
          value={sessionView}
          options={[
            { value: 'sealed',      label: 'Awaiting settlement' },
            { value: 'expired',     label: 'Expired, still active' },
            { value: 'quarantined', label: 'Quarantined' },
          ]}
          onChange={v => setSessionView(v as typeof sessionView)}
          ariaLabel="Session view"
        />
        <Card className="mt-3 overflow-hidden">
          <Body state={sessions} emptyIcon={CheckCircle2} emptyTitle="Nothing here"
                emptyDescription="No sessions match this view — the scheduler is keeping up.">
            {rows => (
              <Table head={['Session', 'Status', 'Slots', 'Held', 'Used']}>
                {rows.map(s => (
                  <tr key={s.sessionId} className="border-b border-border/50 last:border-0">
                    <td className="px-4 py-2.5 font-mono text-fs-2xs text-muted-foreground">
                      {s.sessionId.slice(0, 16)}…
                    </td>
                    <td className="px-4 py-2.5"><StatusChip tone="neutral">{s.status}</StatusChip></td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{num(s.slotCount)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{num(s.allocatedCredits)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {s.consumedSlots === null ? '—' : num(s.consumedSlots)}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Body>
        </Card>
      </section>

      {/* ═══ 3 · Manual credit grants ═══ */}
      <section aria-labelledby="mc-grants">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeading id="mc-grants" title="Manual credit grants" />
          <Button size="sm" onClick={() => setGranting(true)}>
            <Gift className="size-3.5" aria-hidden />
            Issue credits
          </Button>
        </div>
        <p className="mt-1 text-fs-sm text-muted-foreground">
          Credits issued without a payment. Every grant is recorded here, in the ledger and in
          the admin audit log, and requires super-admin access.
        </p>
        <Card className="mt-3 overflow-hidden">
          <Body state={grants} emptyIcon={Gift} emptyTitle="No grants issued"
                emptyDescription="No credits have been issued outside of a purchase.">
            {rows => (
              <Table head={['Date', 'Organizer', 'Credits', 'Reason', 'Justification', 'Issued by']}>
                {rows.map(g => (
                  <tr key={g.grantId} className="border-b border-border/50 last:border-0">
                    <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">{date(g.createdAtMs)}</td>
                    <td className="px-4 py-2.5 font-mono text-fs-2xs text-muted-foreground">
                      {g.organizerUid.slice(0, 14)}…
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-success">+{num(g.credits)}</td>
                    <td className="px-4 py-2.5">
                      <StatusChip tone="neutral">{g.reason}</StatusChip>
                    </td>
                    {/* The note is the whole point of the record — shown, not hidden behind
                        a row expander nobody opens during an audit. */}
                    <td className="px-4 py-2.5 max-w-[22rem] text-fs-2xs text-muted-foreground">
                      <span className="line-clamp-2">{g.note}</span>
                      {g.reference && (
                        <span className="mt-0.5 block font-mono opacity-70">{g.reference}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-fs-2xs text-muted-foreground">
                      {g.actorUid.slice(0, 12)}…
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Body>
        </Card>
      </section>

      {/* ═══ 7 · Scheduler health ═══ */}
      <section aria-labelledby="mc-scheduler">
        <SectionHeading id="mc-scheduler" title="Scheduler health" />
        <Card className="mt-3 overflow-hidden">
          <Body state={crons} emptyIcon={Timer} emptyTitle="No scheduler data"
                emptyDescription="Neither credits cron has recorded a run yet.">
            {rows => (
              <Table head={['Cron', 'Last run', 'Result', 'State']}>
                {rows.map(c => (
                  <tr key={c.cronName} className="border-b border-border/50 last:border-0">
                    <td className="px-4 py-2.5 font-medium">{c.cronName}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">
                      {c.lastRunAt ? date(c.lastRunAt) : 'Never'}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusChip tone={c.lastOk === null ? 'neutral' : c.lastOk ? 'success' : 'danger'}>
                        {c.lastOk === null ? 'Unknown' : c.lastOk ? 'OK' : 'Failed'}
                      </StatusChip>
                    </td>
                    <td className="px-4 py-2.5">
                      {/* Stale is the alarming state: a cron that stopped firing records no
                          failure at all, so "OK" alone would look healthy. */}
                      {c.stale
                        ? <StatusChip tone="danger">Stale — not firing</StatusChip>
                        : <StatusChip tone="success">Running</StatusChip>}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Body>
        </Card>
      </section>

      {/* ═══ 8 · Audit log ═══ */}
      <section aria-labelledby="mc-audit">
        <SectionHeading id="mc-audit" title="Administrative actions" />
        <Card className="mt-3 overflow-hidden">
          <Body state={auditLog} emptyIcon={Layers} emptyTitle="No admin actions yet"
                emptyDescription="Refund decisions and retries will be recorded here.">
            {rows => (
              <Table head={['Action', 'Entity', 'Admin']}>
                {rows.map((a, i) => (
                  <tr key={a.id ?? `${a.action}-${i}`} className="border-b border-border/50 last:border-0">
                    <td className="px-4 py-2.5"><Badge variant="secondary">{a.action}</Badge></td>
                    <td className="px-4 py-2.5 font-mono text-fs-2xs text-muted-foreground">
                      {a.entityId?.slice(0, 16)}…
                    </td>
                    <td className="px-4 py-2.5 font-mono text-fs-2xs text-muted-foreground">
                      {a.adminUid?.slice(0, 12)}…
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Body>
        </Card>
      </section>

      {/* MC-09 · Mounted only while open, so every opening mints a fresh idempotency key and
          starts from an empty form. On success the grants table and the platform totals both
          re-read — a grant moves outstanding liability, so a stale headline figure would
          contradict the row that was just added. */}
      {/* MC-12.1 · Mounted only while open, so each decision starts from a clean note field.
          On success the queue AND the overview reload — an approval moves outstanding
          liability, so a stale headline would contradict the row that just changed. */}
      {deciding && (
        <RefundDecisionDialog
          approve={deciding.approve}
          noteRequired={noteRequired}
          target={{
            refundId:            deciding.row.refundId,
            organizerUid:        deciding.row.organizerUid,
            purchaseId:          deciding.row.purchaseId,
            credits:             deciding.row.credits,
            // RD-MC-REFUND-V2-P3 · the credit breakdown. `creditsRemainingAtRequest` is the
            // frozen figure the refund was priced on; `purchaseCreditsAtRequest` comes from the
            // purchase snapshot the refund already carries, so no extra fetch is needed.
            purchaseCredits:     deciding.row.purchaseCreditsAtRequest ?? deciding.row.credits,
            creditsRemaining:    deciding.row.creditsRemainingAtRequest ?? deciding.row.credits,
            creditsUsed:         Math.max(0,
              (deciding.row.purchaseCreditsAtRequest ?? deciding.row.credits)
              - (deciding.row.creditsRemainingAtRequest ?? deciding.row.credits)),
            // Held only while the request is still pending. Once decided the hold is gone —
            // released by a rejection or cancellation, converted to a debit by an approval.
            heldCredits:         deciding.row.status === 'requested' ? deciding.row.credits : 0,
            unusedAtRequest:     deciding.row.walletAtRequest?.available ?? 0,
            purchaseAmountPaise: deciding.row.purchaseAmountPaise ?? 0,
            // RD-MC-REFUND-V2-P2 · falls back to the purchase amount, which is exactly what
            // the base WAS for any refund written before partial refunds existed.
            refundBasePaise:     deciding.row.refundBasePaise ?? deciding.row.purchaseAmountPaise ?? 0,
            serviceChargePaise:  deciding.row.serviceCharge?.amountPaise ?? 0,
            refundAmountPaise:   deciding.row.refundAmountPaise,
            reason:              deciding.row.reason,
          }}
          onClose={() => setDeciding(null)}
          onDecided={() => { loadRefunds(refundTab); loadOverview(); loadAudit() }}
        />
      )}

      {granting && (
        <GrantCreditsDialog
          onClose={() => setGranting(false)}
          onGranted={() => { loadGrants(); loadOverview(); loadAudit() }}
        />
      )}
    </div>
  )
}

// ─── Shared pieces ───────────────────────────────────────────────────────────

function Stat({
  icon: Icon, label, value, hint, tone, emphasis,
}: {
  icon: LucideIcon; label: string; value: string; hint?: string
  tone?: 'warning' | 'danger'; emphasis?: boolean
}) {
  return (
    <Card className={cn(
      'p-4',
      // A faint wash only — a saturated card in a grid of eight would read as an error state
      // rather than as one figure needing attention.
      tone === 'danger'  && 'border-destructive/30 bg-destructive/[0.04]',
      tone === 'warning' && 'border-warning/30 bg-warning/[0.04]',
    )}>
      <p className="flex items-center gap-1.5 text-fs-2xs uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </p>
      <p className={cn(
        'mt-1 tabular-nums font-semibold leading-none text-foreground',
        emphasis ? 'text-[1.5rem]' : 'text-fs-xl',
      )}>
        {value}
      </p>
      {hint && <p className="mt-1 text-fs-2xs text-muted-foreground">{hint}</p>}
    </Card>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-fs-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-fs-base font-medium text-foreground">{value}</dd>
    </div>
  )
}

function Tabs({
  value, options, onChange, ariaLabel,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  ariaLabel: string
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="mt-2 flex flex-wrap gap-1.5">
      {options.map(o => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md border px-2.5 py-1 text-fs-sm transition-colors',
            value === o.value
              ? 'border-primary/40 bg-primary/[0.06] font-medium text-foreground'
              : 'border-border text-muted-foreground hover:border-border-strong',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-fs-sm">
        <thead>
          <tr className="border-b border-border text-left text-fs-2xs uppercase tracking-wide text-muted-foreground">
            {head.map((h, i) => (
              <th key={h || i} scope="col"
                  className={cn('px-4 py-2 font-medium', i > 1 && i < head.length - 1 && 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Body<T>({
  state, emptyIcon, emptyTitle, emptyDescription, children,
}: {
  state: Loadable<T[]>
  emptyIcon: LucideIcon; emptyTitle: string; emptyDescription: string
  children: (rows: T[]) => React.ReactNode
}) {
  if (state.loading) {
    return (
      <div className="space-y-2 p-4" aria-busy="true">
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-9 w-full rounded-md" />)}
      </div>
    )
  }
  if (state.error) return <div className="p-4"><ErrorState message={state.error} /></div>
  if (!state.data || state.data.length === 0) {
    return (
      <div className="p-4">
        <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyDescription} />
      </div>
    )
  }
  return <>{children(state.data)}</>
}

function StatGridSkeleton() {
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true">
      {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
    </div>
  )
}

function refundTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  return status === 'settled' ? 'success'
    : status === 'rejected' ? 'danger'
    : status === 'approved' || status === 'settling' ? 'warning'
    : 'neutral'
}

/** MC-11 · How long a request has been waiting. The queue is triaged by age. */
function ageOf(ms: number): string {
  if (!ms) return '—'
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days >= 1) return `${days}d`
  const hours = Math.floor((Date.now() - ms) / 3_600_000)
  return hours >= 1 ? `${hours}h` : '<1h'
}

function date(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}
