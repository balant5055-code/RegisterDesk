'use client'

import { useEffect, useState }  from 'react'
import { onAuthStateChanged }   from 'firebase/auth'
import { auth }                 from '@/lib/firebase/auth'
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

const CREDIT_TYPES = new Set<WalletTxnType>(['fund_added', 'refund'])

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
      {Array.from({ length: 6 }).map((_, i) => (
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

  function load() {
    setLoading(true)
    setError(null)
    auth.currentUser?.getIdToken().then(token => {
      fetch('/api/organizer/wallet/transactions?limit=100', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then((data: { success: boolean; transactions?: WalletTransaction[]; error?: string }) => {
          if (data.success && data.transactions) setTransactions(data.transactions)
          else setError(data.error ?? 'Failed to load')
        })
        .catch(() => setError('Network error'))
        .finally(() => setLoading(false))
    }).catch(() => { setError('Auth error'); setLoading(false) })
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      if (user) load()
      else { setError('Not authenticated'); setLoading(false) }
    })
    return unsub
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <PageHeader
        title="Transaction History"
        subtitle="All wallet credits and charges."
        breadcrumb={[
          { label: 'Wallet', href: '/dashboard/wallet' },
          { label: 'Transaction History' },
        ]}
        action={
          <button
            onClick={load}
            className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </button>
        }
      />

      {/* ── Table ── */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-[14px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {['Date', 'Type', 'Amount', 'Status', 'Reference', 'Description'].map(h => (
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
                  <td colSpan={6} className="px-4 py-10 text-center">
                    <div className="flex flex-col items-center gap-2 text-destructive">
                      <AlertCircle className="size-5" />
                      <p className="text-[14px]">{error}</p>
                    </div>
                  </td>
                </tr>
              ) : transactions.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      icon={ArrowUpDown}
                      title="No transactions yet"
                      description="Add funds to get started."
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

    </div>
  )
}
