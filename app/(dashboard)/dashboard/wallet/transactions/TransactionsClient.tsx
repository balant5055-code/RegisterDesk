'use client'

import { COMMUNICATION_BALANCE_HREF } from '@/lib/wallet/communicationBalance'
import { useEffect, useState }  from 'react'
import Link                     from 'next/link'
import { useSearchParams }      from 'next/navigation'
import { auth }                 from '@/lib/firebase/auth'
import { txnEventRef }          from '@/lib/wallet/eventWalletView'
import { ActivityFilters, activityParams, EMPTY_FILTERS, type ActivityFilterValue } from '../ActivityFilters'
import { useAuth }              from '@/components/auth/AuthProvider'
import { AlertCircle, TrendingUp, TrendingDown, RefreshCw, ArrowUpDown } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  WALLET_TXN_TYPE_LABELS,
  WALLET_TXN_STATUS_LABELS,
  type WalletTransaction,
  type WalletTxnStatus,
  type WalletTxnType,
} from '@/lib/wallet/types'
import { walletTxnStatusCls } from '@/lib/ui/statusColors'
import { EmptyState, PageHeader } from '@/components/ui'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(paise: number): string {
  const r = paise / 100
  return `₹${r.toFixed(2)}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ─── Badges ───────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: WalletTxnStatus }) {
  const cls = walletTxnStatusCls[status] ?? 'bg-muted text-muted-foreground border-border'
  return (
    <span className={cn('rounded-full border px-2.5 py-0.5 text-[12px] font-semibold', cls)}>
      {WALLET_TXN_STATUS_LABELS[status]}
    </span>
  )
}

const CREDIT_TYPES = new Set<WalletTxnType>(['fund_added', 'license_refund', 'refund'])   // = WALLET_CREDIT_TXN_TYPES (server filter)
const DIRECTION_OPTIONS = [{ value: '', label: 'All' }, { value: 'credit', label: 'Credits' }, { value: 'debit', label: 'Charges' }] as const
const PAGE = 50

function TypeBadge({ type }: { type: WalletTxnType }) {
  const isCredit = CREDIT_TYPES.has(type)
  return (
    <div className={cn(
      'flex items-center gap-1.5 text-[13px] font-medium',
      isCredit ? 'text-emerald-600' : 'text-foreground',
    )}>
      {isCredit
        ? <TrendingUp  className="size-3.5 shrink-0" />
        : <TrendingDown className="size-3.5 shrink-0 text-muted-foreground" />}
      {WALLET_TXN_TYPE_LABELS[type]}
    </div>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <tr className="animate-pulse border-b border-border">
      {Array.from({ length: 7 }).map((_, i) => (
        <td key={i} className="px-4 py-3.5">
          <div className="h-4 rounded bg-muted" style={{ width: `${60 + (i % 3) * 20}%` }} />
        </td>
      ))}
    </tr>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function TransactionsClient() {
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  // RD-WALLET-EVT-01 — optional event filter (?event=<draftId>), resolved and enforced server-side.
  // RD-WALLET-REQ — plus direction and date filters, and cursor pages ("Load more").
  const urlEvent = useSearchParams().get('event')
  const [filters, setFilters] = useState<ActivityFilterValue>({ ...EMPTY_FILTERS, event: urlEvent ?? '' })
  const eventId = filters.event || null
  const [eventInfo,   setEventInfo]   = useState<{ draftId: string; name: string } | null>(null)
  const [scanLimited, setScanLimited] = useState(false)
  const [nextCursor,  setNextCursor]  = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  function load(cursor: string | null = null) {
    if (cursor) setLoadingMore(true); else setLoading(true)
    setError(null)
    auth.currentUser?.getIdToken().then(token => {
      const qs = activityParams(filters, 'direction', cursor)
      qs.set('limit', String(PAGE))
      fetch(`/api/organizer/wallet/transactions?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then((data: { success: boolean; transactions?: WalletTransaction[]; error?: string; event?: { draftId: string; name: string }; scanLimited?: boolean; nextCursor?: string | null }) => {
          if (data.success && data.transactions) {
            const rows = data.transactions
            setTransactions(prev => (cursor ? [...prev, ...rows] : rows))
            setEventInfo(data.event ?? null)
            setScanLimited(data.scanLimited === true)
            setNextCursor(data.nextCursor ?? null)
          } else setError(data.error ?? 'Failed to load')
        })
        .catch(() => setError('Network error'))
        .finally(() => { setLoading(false); setLoadingMore(false) })
    }).catch(() => { setError('Auth error'); setLoading(false); setLoadingMore(false) })
  }

  const { user } = useAuth()

  useEffect(() => {
    if (user === undefined) return
    const run = async () => {
      if (user) { load(); return }
      setError('Not authenticated')
      setLoading(false)
    }
    void run()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, filters])

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <PageHeader
        title="Transaction History"
        subtitle="Communication balance credits and charges (top-ups, pay-as-you-go messages, broadcasts)."
        // This is the COMMUNICATION BALANCE ledger, not the event-wise Wallet.
        breadcrumb={[
          { label: 'Communication balance', href: COMMUNICATION_BALANCE_HREF },
          { label: 'Transaction History' },
        ]}
        action={
          <button
            onClick={() => load()}
            className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </button>
        }
      />

      <ActivityFilters value={filters} onChange={setFilters} kindLabel="Type" kindOptions={DIRECTION_OPTIONS} currentEvent={eventInfo} />

      {eventId && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/30 px-4 py-3 text-[13px]">
          <span className="text-foreground">
            Showing communication-balance entries for <span className="font-semibold">{eventInfo?.name ?? 'this event'}</span> — charges and returns that record the event.
          </span>
          <span className="flex flex-wrap items-center gap-3">
            {/* RD-INTEG — the way back to the event's Wallet this view was opened from. */}
            <Link href={`/dashboard/wallet?eventId=${encodeURIComponent(eventId)}`} className="font-semibold text-primary hover:underline">Back to event Wallet</Link>
            <Link href="/dashboard/wallet/transactions" onClick={() => setFilters(EMPTY_FILTERS)} className="font-semibold text-primary hover:underline">Show all</Link>
          </span>
        </div>
      )}

      {/* ── Table ── */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[14px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {['Date', 'Type', 'Amount', 'Status', 'Event', 'Reference', 'Description'].map(h => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => <RowSkeleton key={i} />)
              ) : error ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center">
                    <div className="flex flex-col items-center gap-2 text-destructive">
                      <AlertCircle className="size-5" />
                      <p className="text-[14px]">{error}</p>
                    </div>
                  </td>
                </tr>
              ) : transactions.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      icon={ArrowUpDown}
                      title={eventId || filters.kind || filters.from || filters.to ? 'No matching transactions' : 'No transactions yet'}
                      description={eventId || filters.kind || filters.from || filters.to ? 'Try a different filter.' : 'Add funds under Communications › Billing.'}
                    />
                  </td>
                </tr>
              ) : (
                transactions.map(txn => {
                  const isCredit = CREDIT_TYPES.has(txn.type)
                  return (
                    <tr key={txn.id} className="border-b border-border/60 transition-colors hover:bg-muted/20 last:border-0">
                      <td className="px-4 py-3.5 text-[13px] text-muted-foreground whitespace-nowrap">
                        {formatDate(txn.createdAt)}
                      </td>
                      <td className="px-4 py-3.5">
                        <TypeBadge type={txn.type} />
                      </td>
                      <td className={cn(
                        'px-4 py-3.5 font-semibold whitespace-nowrap',
                        isCredit ? 'text-emerald-600' : 'text-foreground',
                      )}>
                        {isCredit ? '+' : '−'}{formatCurrency(txn.amountPaise)}
                      </td>
                      <td className="px-4 py-3.5">
                        <StatusBadge status={txn.status} />
                      </td>
                      <td className="px-4 py-3.5 text-[12.5px] text-muted-foreground">
                        {/* RD-WALLET-EVT-01 — only a reference the writer stored; never inferred. */}
                        {(() => {
                          const ref = txnEventRef(txn)
                          if (!ref) return <span className="italic">Unattributed</span>
                          if (eventInfo) return eventInfo.name
                          return ref.slug ? <span className="font-mono text-[12px]">{ref.slug}</span> : 'Event certificate'
                        })()}
                      </td>
                      <td className="px-4 py-3.5 text-[13px] text-muted-foreground capitalize">
                        {txn.referenceType}
                      </td>
                      <td className="px-4 py-3.5 text-[13px] text-muted-foreground max-w-[200px] truncate">
                        {txn.description || '—'}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && !error && (nextCursor || scanLimited) && (
        <div className="flex flex-col items-center gap-1.5">
          {scanLimited && <p className="text-[12.5px] text-muted-foreground">Older entries have not been searched yet.</p>}
          {nextCursor && (
            <button type="button" onClick={() => load(nextCursor)} disabled={loadingMore}
              className="rounded-xl border border-border bg-card px-4 py-2 text-[13px] font-semibold text-foreground hover:bg-muted disabled:opacity-60">
              {loadingMore ? 'Loading…' : scanLimited ? 'Search older entries' : 'Load more'}
            </button>
          )}
        </div>
      )}

    </div>
  )
}
