'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth }                          from '@/components/auth/AuthProvider'
import { useEventContext }                  from '@/components/dashboard/EventContextProvider'
import {
  ArrowDownLeft, BarChart3,
  Clock, CreditCard, DollarSign,
  Loader2, RefreshCw, Send, TrendingUp,
} from 'lucide-react'
import { DashboardCard }        from '@/components/dashboard/DashboardCard'
import { KpiCardSkeleton }      from '@/components/dashboard/Skeleton'
import { EmptyState, ErrorState, Card } from '@/components/ui'
import { cn }                   from '@/lib/utils/cn'
import Link                      from 'next/link'
import { RequestSettlementModal } from '@/components/dashboard/finance/RequestSettlementModal'
import { SettlementHistoryTable } from '@/components/dashboard/finance/SettlementHistoryTable'
import { FinanceControlCenter }   from '@/components/dashboard/finance/FinanceControlCenter'
import { financeViewScope, financeScopeParam, createLatestGate } from '@/lib/finance/viewScope'
import { formatCompactINR, formatShortDate } from '@/lib/finance/format'
import type { FinanceOverview } from '@/app/api/organizer/finance/route'
import type { PayoutProfileGetResponse } from '@/lib/payout/types'
import type {
  FinanceTransaction,
  FinanceTransactionsResponse,
} from '@/app/api/organizer/finance/transactions/route'
import type {
  SettlementRequestSummary,
  SettlementsApiResponse,
} from '@/lib/settlements/types'

// ─── Local types ──────────────────────────────────────────────────────────────

type TxnFilter = 'all' | 'tickets' | 'donations' | 'refunds'

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Money/date formatting is shared via @/lib/finance/format (formatCompactINR,
// formatShortDate). The settlement badge/table/modal are shared components.

const TYPE_LABELS: Record<string, string> = {
  event_registration:    'Ticket',
  workshop_fee:          'Workshop',
  conference_ticket:     'Ticket',
  marathon_registration: 'Ticket',
  exhibition_booth:      'Booth',
  sponsorship_package:   'Sponsorship',
  donation:              'Donation',
  membership:            'Membership',
}

function txnLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ─── Transaction status badge ─────────────────────────────────────────────────

const TXN_STATUS_STYLES: Record<string, string> = {
  completed:  'bg-emerald-100 text-emerald-700',
  pending:    'bg-amber-100   text-amber-700',
  refunded:   'bg-blue-100    text-blue-700',
  disputed:   'bg-red-100     text-red-700',
  backfilled: 'bg-muted       text-muted-foreground',
}

function TxnStatusBadge({ status }: { status: string }) {
  const cls = TXN_STATUS_STYLES[status] ?? 'bg-muted text-muted-foreground'
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold capitalize', cls)}>
      {status}
    </span>
  )
}

// ─── Filter tabs ──────────────────────────────────────────────────────────────

const FILTERS: { key: TxnFilter; label: string }[] = [
  { key: 'all',       label: 'All'       },
  { key: 'tickets',   label: 'Tickets'   },
  { key: 'donations', label: 'Donations' },
  { key: 'refunds',   label: 'Refunds'   },
]

// ─── Row skeletons ────────────────────────────────────────────────────────────

function TxnRowSkeleton() {
  return (
    <tr aria-hidden>
      {[120, 90, 70, 80, 70, 70, 80].map((w, i) => (
        <td key={i} className="px-4 py-3.5">
          <div className="h-3.5 animate-pulse rounded bg-muted" style={{ width: w }} />
        </td>
      ))}
    </tr>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FinancePage() {
  // ── Core state ───────────────────────────────────────────────────────────────
  const [overview,      setOverview]      = useState<FinanceOverview | null>(null)
  const [settlements,   setSettlements]   = useState<SettlementRequestSummary[]>([])
  const [transactions,  setTransactions]  = useState<FinanceTransaction[]>([])
  const [filter,        setFilter]        = useState<TxnFilter>('all')

  const [loadingPage,   setLoadingPage]   = useState(true)
  const [loadingSettle, setLoadingSettle] = useState(true)
  const [loadingTxns,   setLoadingTxns]   = useState(false)
  const [loadingMore,   setLoadingMore]   = useState(false)

  const [error,         setError]         = useState<string | null>(null)
  const [txnError,      setTxnError]      = useState<string | null>(null)

  const [hasMore,       setHasMore]       = useState(false)
  // RD-FIN-SCOPE-01 — an event whose ledger exceeds the server's per-event read cap lists only its newest rows.
  const [ledgerTruncated, setLedgerTruncated] = useState(false)
  const [cursor,        setCursor]        = useState<string | null>(null)

  const [token,            setToken]            = useState<string>('')
  const [retryKey,         setRetryKey]         = useState(0)
  const [showModal,        setShowModal]        = useState(false)
  const [hasPayoutProfile, setHasPayoutProfile] = useState(false)

  const handleRetry = useCallback(() => setRetryKey(k => k + 1), [])

  const { user, getToken } = useAuth()

  // ── RD-FIN-SCOPE-01 · the global Event Selector decides the EVENT-scoped sections ──────────
  // The page used to ignore it: every section showed workspace-wide figures under a header naming
  // one event. Now: All events → workspace totals; one event → that event only (resolved and
  // ownership-checked on the server); a link to an event this workspace cannot see → an explicit
  // "not available" state, never a silent fall-back to all events. The wallet, settlements and
  // payout profile are per WORKSPACE by design (payouts draw from one balance) and are labelled so.
  const { selectedEventId, isAllEvents, selectedEvent, loading: eventsLoading, urlEventMissing } = useEventContext()
  const viewScope = financeViewScope({
    loading: eventsLoading, urlEventMissing, selectedEventId, isAllEvents, selectedEventName: selectedEvent?.name ?? null,
  })
  const scopeKey = financeScopeParam(viewScope)
  const eventScoped = viewScope?.kind === 'event'
  // Only the latest ledger request may write: a slow response for the previous event is dropped.
  const txnGate = useRef(createLatestGate())

  // ── Fetch settlements (used both on initial load and after POST) ───────────

  const fetchSettlements = useCallback(async (tok: string) => {
    if (!tok) return
    setLoadingSettle(true)
    try {
      const res  = await fetch('/api/organizer/settlements', {
        headers: { Authorization: `Bearer ${tok}` },
      })
      if (!res.ok) return  // silent — page already loaded, don't kill the UI
      const data = await res.json() as SettlementsApiResponse
      setSettlements(data.requests)
    } finally {
      setLoadingSettle(false)
    }
  }, [])

  // ── Initial load: overview + settlements in parallel ──────────────────────

  useEffect(() => {
    if (user === undefined) return
    let cancelled = false
    const run = async () => {
      setLoadingPage(true)
      setLoadingSettle(true)
      setError(null)

      if (!user) { setLoadingPage(false); setLoadingSettle(false); return }
      try {
        const t = await getToken(retryKey > 0)
        if (cancelled || !t) return
        setToken(t)

        const [overviewRes, settlementsRes, payoutRes] = await Promise.all([
          fetch('/api/organizer/finance',        { headers: { Authorization: `Bearer ${t}` } }),
          fetch('/api/organizer/settlements',    { headers: { Authorization: `Bearer ${t}` } }),
          fetch('/api/organizer/payout-profile', { headers: { Authorization: `Bearer ${t}` } }),
        ])
        if (!overviewRes.ok) throw new Error(`Failed to load finance data. (${overviewRes.status})`)

        const [overviewData, settlementsData, payoutData] = await Promise.all([
          overviewRes.json()    as Promise<FinanceOverview>,
          settlementsRes.ok
            ? settlementsRes.json() as Promise<SettlementsApiResponse>
            : Promise.resolve({ requests: [] } as SettlementsApiResponse),
          payoutRes.ok
            ? payoutRes.json() as Promise<PayoutProfileGetResponse>
            : Promise.resolve({ profile: null } as PayoutProfileGetResponse),
        ])
        if (cancelled) return
        setOverview(overviewData)
        setSettlements(settlementsData.requests)
        setHasPayoutProfile(payoutData.profile !== null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load finance data.')
      } finally {
        if (!cancelled) { setLoadingPage(false); setLoadingSettle(false) }
      }
    }
    run()
    return () => { cancelled = true }
  }, [user, getToken, retryKey])

  // ── Fetch transactions (re-runs on filter change) ────────────────────────

  const fetchTransactions = useCallback(async (
    tok:    string,
    f:      TxnFilter,
    append: boolean,
    cur:    string | null,
    scope:  string | null,
  ) => {
    if (!tok || !scope) return
    const mine = txnGate.current.take()
    const setter = append ? setLoadingMore : setLoadingTxns
    setter(true)
    setTxnError(null)
    try {
      const url = new URL('/api/organizer/finance/transactions', window.location.origin)
      url.searchParams.set('filter', f)
      url.searchParams.set('limit', '50')
      url.searchParams.set('eventId', scope)
      if (cur) url.searchParams.set('cursor', cur)

      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${tok}` } })
      if (!txnGate.current.isLatest(mine)) return
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(res.status === 409 || res.status === 404 ? (body?.error ?? 'This event has no finance records.') : `Failed to load transactions. (${res.status})`)
      }
      const data = await res.json() as FinanceTransactionsResponse
      if (!txnGate.current.isLatest(mine)) return

      setTransactions(prev => append ? [...prev, ...data.transactions] : data.transactions)
      setHasMore(data.hasMore)
      setCursor(data.nextCursor)
      setLedgerTruncated(data.scope?.truncated === true)
    } catch (e) {
      if (!txnGate.current.isLatest(mine)) return
      // A failed request clears the list: the previous scope's rows must not read as current.
      if (!append) setTransactions([])
      setTxnError(e instanceof Error ? e.message : 'Failed to load transactions.')
    } finally {
      if (txnGate.current.isLatest(mine)) setter(false)
    }
  }, [])

  useEffect(() => {
    if (!token) return
    const run = async () => {
      setTransactions([])
      setCursor(null)
      setHasMore(false)
      fetchTransactions(token, filter, false, null, scopeKey)
    }
    void run()
  }, [token, filter, scopeKey, fetchTransactions])

  const handleLoadMore = useCallback(() => {
    if (!cursor || loadingMore) return
    fetchTransactions(token, filter, true, cursor, scopeKey)
  }, [token, filter, cursor, loadingMore, scopeKey, fetchTransactions])

  // ── Settlement request submission ─────────────────────────────────────────

  const handleSubmitSettlement = useCallback(async (amountPaise: number) => {
    const res = await fetch('/api/organizer/settlements', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ amountPaise }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(err.error ?? `Request failed (${res.status})`)
    }
    await fetchSettlements(token)
  }, [token, fetchSettlements])

  // ── KPI cards ────────────────────────────────────────────────────────────

  const w = overview?.wallet

  const kpiCards = [
    {
      label: 'Pending Balance',
      value: formatCompactINR(w?.pendingPaise ?? 0),
      sub:   'Awaiting T+2 release',
      icon:  Clock,
      color: 'text-amber-600',
      bg:    'bg-amber-500/[0.09]',
    },
    {
      label: 'Available Balance',
      value: formatCompactINR(w?.availablePaise ?? 0),
      sub:   'Ready for settlement',
      icon:  DollarSign,
      color: 'text-emerald-600',
      bg:    'bg-emerald-500/[0.09]',
    },
    {
      label: 'Lifetime Revenue',
      value: formatCompactINR(w?.lifetimeGrossPaise ?? 0),
      sub:   'Gross (all time)',
      icon:  TrendingUp,
      color: 'text-primary',
      bg:    'bg-primary/[0.09]',
    },
    {
      label: 'Platform Fees Paid',
      value: formatCompactINR(w?.lifetimeFeesPaise ?? 0),
      sub:   'Includes gateway fees',
      icon:  CreditCard,
      color: 'text-[var(--primary-from)]',
      bg:    'bg-[var(--primary-from)]/[0.09]',
    },
    {
      label: 'Net Earnings',
      value: formatCompactINR(w?.lifetimeNetPaise ?? 0),
      sub:   'After all fees',
      icon:  BarChart3,
      color: 'text-violet-600',
      bg:    'bg-violet-500/[0.09]',
    },
  ]

  // ── Derived ───────────────────────────────────────────────────────────────

  const hasPendingRequest = settlements.some(s => s.status === 'pending')

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5 pb-12">

      {/* ── Page heading + Request Settlement CTA ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">Finance</h1>
          <p className="mt-0.5 text-[14px] text-muted-foreground">
            Revenue balances and transaction history for your events.
          </p>
          {viewScope && (
            <p data-testid="finance-page-scope" className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/[0.06] px-2.5 py-0.5 text-[12.5px] font-medium text-foreground">
              {viewScope.kind === 'event' ? <>Showing: <strong className="font-semibold">{viewScope.name}</strong></> : 'Showing: All events'}
            </p>
          )}
        </div>
        {!loadingPage && !error && (
          <div className="flex shrink-0 items-center gap-2">
            {/* Detail workspaces. Same border-button treatment as Reports & Exports, so the
                header stays one visual group rather than acquiring a second style. */}
            {/* The event-wise Wallet has no sidebar row — it is a Finance surface (workspaceNav). */}
            <Link
              href="/dashboard/wallet"
              className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted"
            >
              Event Wallet
            </Link>
            <Link
              href="/dashboard/finance/ledger"
              className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted"
            >
              Ledger &amp; transactions
            </Link>
            <Link
              href="/dashboard/finance/payout-profile"
              className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted"
            >
              Payout Profile
            </Link>
            <Link
              href="/dashboard/finance/reports"
              className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted"
            >
              Reports &amp; Exports
            </Link>
            <button
              onClick={() => setShowModal(true)}
              disabled={hasPendingRequest}
              title={hasPendingRequest ? 'A settlement request is already pending' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-opacity',
                hasPendingRequest ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90',
              )}
              style={{ backgroundImage: 'var(--primary-gradient)' }}
            >
              <Send className="size-3.5" aria-hidden />
              Request Settlement
            </button>
          </div>
        )}
      </div>

      {/* RD-FIN-SCOPE-01 — a link naming an event this workspace cannot see: say so, never swap in other data. */}
      {urlEventMissing && (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-[13px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/[0.07] dark:text-amber-400">
          The event in this link isn’t available in this workspace. Choose an event — or All events — in the event selector to see its finance figures.
        </div>
      )}

      {/* ── KPI cards ── wallet balances are per WORKSPACE (one balance, one payout), labelled as such */}
      {!error && (
        <p data-testid="finance-wallet-scope" className="text-[12.5px] text-muted-foreground">
          <strong className="font-semibold text-foreground">Workspace wallet · all events.</strong>{' '}
          {eventScoped
            ? 'Balances and lifetime totals are held for your whole workspace — payouts draw from one balance, so they are not split by event. The selected event’s own figures are below.'
            : 'Balances and lifetime totals across every event in this workspace.'}
        </p>
      )}
      {error ? (
        <ErrorState message={error} onRetry={handleRetry} />
      ) : (
        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
          aria-label="Finance KPIs"
          aria-live="polite"
          aria-busy={loadingPage}
        >
          {loadingPage
            ? Array.from({ length: 5 }).map((_, i) => <KpiCardSkeleton key={i} />)
            : kpiCards.map(({ label, value, sub, icon: Icon, color, bg }) => (
                <Card
                  key={label}
                  padded={false}
                  className="p-4"
                  role="figure"
                  aria-label={`${label}: ${value}`}
                >
                  <div className={cn('flex size-9 items-center justify-center rounded-lg', bg)}>
                    <Icon className={cn('size-[17px]', color)} aria-hidden />
                  </div>
                  <p className="mt-3 text-[26px] font-bold leading-none tracking-tight text-foreground">
                    {value}
                  </p>
                  <p className="mt-1.5 text-[13px] font-medium text-foreground">{label}</p>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">{sub}</p>
                </Card>
              ))
          }
        </div>
      )}

      {/* ── Pending request notice ── */}
      {!loadingPage && !error && hasPendingRequest && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-[13px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/[0.07] dark:text-amber-400">
          <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <strong>Settlement request pending:</strong> Your request is under review.
            You cannot submit another until this one is processed.
          </span>
        </div>
      )}

      {/* ── Finance Control Center ────────────────────────────────────────
          RD-FINANCE-P3. Every figure below is aggregated SERVER-SIDE by
          lib/finance/financeAnalytics.ts and delivered through
          /api/organizer/finance/analytics. This page passes a token and nothing
          else — no analytics calculation is duplicated here, and the wallet KPIs
          above keep their own source (/api/organizer/finance) untouched.
      
          Gated on this page's OWN signals: `error` is set whenever
          /api/organizer/finance returns non-OK (a permission refusal included), and
          `token` stays empty until auth resolves — the same pair the settlement and
          ledger sections already depend on, so authorization behaviour is unchanged. */}
      {!error && token && viewScope && <FinanceControlCenter token={token} scope={viewScope} />}

      {/* ── Settlement History ── payouts are per workspace (one balance), never per event */}
      <DashboardCard title="Settlement Requests · all events">
        <SettlementHistoryTable settlements={settlements} loading={loadingSettle} />
      </DashboardCard>

      {/* ── Revenue Ledger ── RD-FIN-SCOPE-01: only with a known scope. Without one (an unavailable event link)
          an empty "· all events" table would read as "no transactions" — false — so it is not rendered. */}
      {viewScope && (
      <DashboardCard
        title={eventScoped && viewScope?.kind === 'event' ? `Revenue Ledger · ${viewScope.name}` : 'Revenue Ledger · all events'}
        action={
          <div className="flex items-center gap-2">
            <div
              role="group"
              aria-label="Filter transactions"
              className="flex items-center gap-px rounded-lg border border-border bg-muted p-0.5"
            >
              {FILTERS.map(f => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  aria-pressed={filter === f.key}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                    filter === f.key
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => fetchTransactions(token, filter, false, null, scopeKey)}
              disabled={loadingTxns}
              aria-label="Refresh transactions"
              className="flex size-7 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3.5', loadingTxns && 'animate-spin')} aria-hidden />
            </button>
          </div>
        }
      >
        {ledgerTruncated && !txnError && (
          <p className="mb-2 text-[12px] text-muted-foreground">
            This event has more transactions than this view reads at once; the newest are listed. Use Reports &amp; Exports for the complete ledger.
          </p>
        )}
        {txnError ? (
          <ErrorState message={txnError} onRetry={() => fetchTransactions(token, filter, false, null, scopeKey)} />
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full min-w-[680px] text-left text-[13.5px]"
              aria-label="Revenue ledger"
              aria-live="polite"
              aria-busy={loadingTxns}
            >
              <thead>
                <tr className="border-b border-border">
                  {['Date', 'Event / Campaign', 'Type', 'Gross', 'Fees', 'Net', 'Status'].map(h => (
                    <th
                      key={h}
                      className="px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-5 last:pr-5"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loadingTxns
                  ? Array.from({ length: 8 }).map((_, i) => <TxnRowSkeleton key={i} />)
                  : transactions.length === 0
                  ? (
                    <tr>
                      <td colSpan={7} className="py-0">
                        <EmptyState
                          icon={ArrowDownLeft}
                          title="No transactions yet"
                          description={
                            filter === 'all'
                              ? 'Revenue will appear here after your first paid registration or donation.'
                              : `No ${filter} transactions found.`
                          }
                        />
                      </td>
                    </tr>
                  )
                  : transactions.map((tx, i) => {
                    // RD-FIN-15: the fee total arrives from the server, already resolved
                    // (actual gateway fee where reconciled, estimate elsewhere). It used to be
                    // added up here from the ESTIMATE — a second, quietly diverging definition
                    // of "total fees" living in a React component.
                    return (
                      <tr
                        key={tx.id}
                        className={cn(
                          'transition-colors hover:bg-muted/40',
                          i < transactions.length - 1 && 'border-b border-border',
                        )}
                      >
                        <td className="px-4 py-3.5 pl-5 text-muted-foreground tabular-nums">
                          {formatShortDate(tx.paidAt)}
                        </td>
                        <td className="px-4 py-3.5 font-medium text-foreground">
                          <span className="line-clamp-1 max-w-[160px]" title={tx.entityId}>
                            {tx.entityId}
                          </span>
                          <span className="mt-0.5 block text-[12px] text-muted-foreground">
                            {tx.payerName}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 text-muted-foreground">
                          {txnLabel(tx.type)}
                        </td>
                        <td className="px-4 py-3.5 tabular-nums text-foreground">
                          {formatCompactINR(tx.grossAmountPaise)}
                        </td>
                        <td className="px-4 py-3.5 tabular-nums text-muted-foreground">
                          − {formatCompactINR(tx.totalFeesPaise)}
                        </td>
                        <td className="px-4 py-3.5 tabular-nums font-semibold text-foreground">
                          {formatCompactINR(tx.netSettlementPaise)}
                        </td>
                        <td className="px-4 py-3.5 pr-5">
                          <TxnStatusBadge status={tx.status} />
                        </td>
                      </tr>
                    )
                  })
                }
              </tbody>
            </table>

            {hasMore && !loadingTxns && (
              <div className="flex justify-center border-t border-border px-5 py-4">
                <button
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {loadingMore && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </div>
        )}
      </DashboardCard>
      )}

      {/* ── Request Settlement modal ── */}
      {showModal && (
        <RequestSettlementModal
          availablePaise={overview?.wallet.availablePaise ?? 0}
          hasPayoutProfile={hasPayoutProfile}
          onClose={() => setShowModal(false)}
          onSubmit={handleSubmitSettlement}
        />
      )}

    </div>
  )
}
