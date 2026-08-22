'use client'

// Transaction Explorer — read-only exploration of the revenue ledger. Reuses
// GET /api/organizer/finance/transactions (cursor-paginated, server-side filter) + the
// existing reports export. Search is client-side over loaded rows (the API has no
// text-search param).
//
// ═══ THIS COMPONENT PERFORMS NO FINANCIAL ARITHMETIC ═════════════════════════
// It used to, on one line:
//
//     const fees = t.platformFeeTotalPaise + t.gatewayFeeEstimatePaise
//
// rendered under a `Gross | Fees | Net` header. Under the live `customer_pays` model that
// reads as a subtraction that never happened — production rows show gross ₹250.00,
// fees ₹9.20, net ₹250.00, because the attendee paid the fees ON TOP and the organizer
// received the whole ticket. Three correct numbers, arranged into a false sum.
//
// Every figure now arrives already attributed from lib/finance/financeService.ts, including
// WHO bore each fee. This file formats paise, renders labels and badges, and nothing else.
// If a money value is needed that the server does not send, the server is where it belongs.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowUpRight, Download, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { EmptyState, ErrorState } from '@/components/ui'
import { formatCompactINR, formatShortDate } from '@/lib/finance/format'
import {
  TXN_FILTERS, financeTxnStatusMeta, financeTxnTypeLabel, txnDeepLink, type TxnFilter,
} from '@/lib/finance/txnMeta'
import type { FinanceTransaction, FinanceTransactionsResponse } from '@/app/api/organizer/finance/transactions/route'

const PAGE = 50

/**
 * The fee cell — the whole point of this change.
 *
 * It renders totals the SERVER attributed (`attendeeBorneFeePaise` / `organizerBorneFeePaise`)
 * and adds nothing together. A leading minus appears only for `organizer`, because only then
 * did the organizer actually lose the money; under `customer_pays` the fee was paid by the
 * attendee on top of the ticket and showing it as a deduction is what made the old table
 * read as 250 − 9.20 = 250.
 *
 * The gateway component is labelled by its BASIS. `gatewayFeeActualPaise` has no writer and
 * the Razorpay Settlements API is not integrated, so today this is always "est." — never
 * presented as a reconciled Razorpay charge.
 */
function FeeCell({ t }: { t: FinanceTransaction }) {
  const basis = t.gatewayFeeBasis === 'actual' ? 'actual' : 'est.'

  if (t.feeBearer === 'none') return <span className="text-muted-foreground">—</span>

  if (t.feeBearer === 'unknown') {
    // The stored fee model and the stored arithmetic disagree. Show the amounts without
    // asserting who paid them rather than pick one and be silently wrong.
    return (
      <span>
        {formatCompactINR(t.platformFeeTotalPaise)} + {formatCompactINR(t.gatewayFeeEstimatePaise)} {basis}
        <span className="mt-0.5 block text-[11.5px] text-amber-600">bearer unconfirmed</span>
      </span>
    )
  }

  const organizerBorne = t.feeBearer === 'organizer'
  const amount = organizerBorne ? t.organizerBorneFeePaise : t.attendeeBorneFeePaise

  return (
    <span>
      {organizerBorne ? '− ' : ''}{formatCompactINR(amount)}
      <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
        {t.feeBearer === 'attendee' ? 'paid by attendee' : t.feeBearer === 'split' ? 'split' : 'from payout'}
        {' · gateway '}{basis}
      </span>
    </span>
  )
}

export function TransactionExplorer({ token }: { token: string }) {
  const router = useRouter()
  const [rows, setRows]           = useState<FinanceTransaction[]>([])
  const [filter, setFilter]       = useState<TxnFilter>('all')
  const [search, setSearch]       = useState('')
  const [loading, setLoading]     = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const cursorRef = useRef<string | null>(null)

  // await-first (first statement is the fetch) so no setState runs synchronously
  // in the effect that calls it; network rejections are handled via .catch below.
  const load = useCallback(async (reset: boolean) => {
    const res = await fetch(
      `/api/organizer/finance/transactions?filter=${filter}&limit=${PAGE}` +
        (!reset && cursorRef.current ? `&cursor=${encodeURIComponent(cursorRef.current)}` : ''),
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) { setError(`Failed to load transactions. (${res.status})`); setLoading(false); setLoadingMore(false); return }
    const data = await res.json() as FinanceTransactionsResponse
    cursorRef.current = data.nextCursor
    setHasMore(data.hasMore)
    setRows(prev => (reset ? data.transactions : [...prev, ...data.transactions]))
    setError(null)
    setLoading(false)
    setLoadingMore(false)
  }, [token, filter])

  const onLoadError = useCallback(() => { setError('Failed to load transactions.'); setLoading(false); setLoadingMore(false) }, [])

  useEffect(() => { void load(true).catch(onLoadError) }, [load, onLoadError])

  const loadMore = useCallback(() => { setLoadingMore(true); void load(false).catch(onLoadError) }, [load, onLoadError])

  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting && hasMore && !loadingMore) loadMore()
    }, { rootMargin: '200px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, loadingMore, loadMore])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(t =>
      `${t.payerName} ${t.payerEmail} ${t.entityId} ${financeTxnTypeLabel(t.type)} ${formatCompactINR(t.grossAmountPaise)}`
        .toLowerCase().includes(q),
    )
  }, [rows, search])

  const handleExport = useCallback(async () => {
    if (!token || exporting) return
    setExporting(true)
    try {
      const res = await fetch('/api/organizer/reports/transactions?format=csv', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return
      const blob = await res.blob()
      const match = /filename="?([^"]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = match?.[1] ?? 'transactions.csv'
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }, [token, exporting])

  return (
    <DashboardCard
      title="Transaction Explorer"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Filter transactions" className="flex items-center gap-px rounded-lg border border-border bg-muted p-0.5">
            {TXN_FILTERS.map(f => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                  filter === f.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search payer, entity…"
              aria-label="Search transactions"
              className="h-8 w-44 rounded-lg border border-border bg-card pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <button
            onClick={() => void handleExport()}
            disabled={exporting}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {exporting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
            Export
          </button>
        </div>
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={() => { setLoading(true); void load(true).catch(onLoadError) }} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[13.5px]" aria-label="Transactions" aria-busy={loading}>
            <thead>
              <tr className="border-b border-border">
                {['Date', 'Entity', 'Pass', 'Ticket', 'Attendee paid', 'Fees', 'Organizer payable', 'Status'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-5 last:pr-5">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} aria-hidden>{[120, 140, 110, 80, 90, 110, 100, 80].map((w, j) => (
                    <td key={j} className="px-4 py-3.5"><div className="h-3.5 animate-pulse rounded bg-muted" style={{ width: w }} /></td>
                  ))}</tr>
                ))
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="py-0">
                  <EmptyState icon={ArrowUpRight} title="No transactions" description={search ? 'No matches for your search.' : filter === 'all' ? 'Revenue will appear here after your first paid registration or donation.' : `No ${filter} transactions found.`} />
                </td></tr>
              ) : (
                filtered.map((t, i) => {
                  const st = financeTxnStatusMeta(t.status)
                  const link = txnDeepLink(t.entityType, t.entityId)
                  return (
                    <tr
                      key={t.id}
                      onClick={link ? () => router.push(link) : undefined}
                      className={cn('transition-colors hover:bg-muted/40', i < filtered.length - 1 && 'border-b border-border', link && 'cursor-pointer')}
                    >
                      <td className="px-4 py-3.5 pl-5 text-muted-foreground tabular-nums">{formatShortDate(t.paidAt)}</td>
                      <td className="px-4 py-3.5 font-medium text-foreground">
                        <span className="flex items-center gap-1">
                          <span className="line-clamp-1 max-w-[160px]" title={t.entityId}>{t.entityId}</span>
                          {link && <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
                        </span>
                        <span className="mt-0.5 block text-[12px] text-muted-foreground">{t.payerName}</span>
                      </td>
                      {/* Pass name comes from the registration — never a hardcoded category. */}
                      <td className="px-4 py-3.5 text-muted-foreground">
                        <span className="line-clamp-1 max-w-[130px]" title={t.passName ?? undefined}>
                          {t.passName ?? financeTxnTypeLabel(t.type)}
                        </span>
                        {t.couponCode && (
                          <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                            {t.couponCode}
                            {t.discountAmountPaise > 0 && <> · −{formatCompactINR(t.discountAmountPaise)}</>}
                          </span>
                        )}
                      </td>

                      {/* Ticket value the platform fee was charged on (post-discount). */}
                      <td className="px-4 py-3.5 tabular-nums text-foreground">{formatCompactINR(t.grossAmountPaise)}</td>

                      {/* What the attendee actually paid. Under customer_pays this EXCEEDS the
                          ticket — the number that was missing while the table implied a
                          deduction. Null when the join could not source it; never invented. */}
                      <td className="px-4 py-3.5 tabular-nums text-foreground">
                        {t.chargeAmountPaise === null
                          ? <span className="text-muted-foreground">—</span>
                          : formatCompactINR(t.chargeAmountPaise)}
                      </td>

                      {/* Fees, WITH who bore them. A minus sign is shown only when the
                          organizer actually lost the money. */}
                      <td className="px-4 py-3.5 tabular-nums text-muted-foreground">
                        <FeeCell t={t} />
                      </td>

                      <td className="px-4 py-3.5 tabular-nums font-semibold text-foreground">{formatCompactINR(t.organizerNetPaise)}</td>
                      <td className="px-4 py-3.5 pr-5">
                        <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold', st.badgeClass)}>{st.label}</span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>

          {hasMore && !loading && !search && (
            <div ref={sentinelRef} className="flex justify-center border-t border-border px-5 py-4">
              <button
                onClick={loadMore}
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
  )
}
