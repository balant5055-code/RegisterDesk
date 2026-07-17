'use client'

// Shared settlement history table (Phase H.5.1).
//
// Used by BOTH the finance overview (controls off → identical to the original
// inline table) and the Settlement Center (controls on → status filter + search).
// Filtering is in-memory over the ≤100 rows the existing GET /api/organizer/
// settlements returns — no new endpoint, no duplicate ledger.

import { useMemo, useState } from 'react'
import { Search, Send } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { EmptyState } from '@/components/ui'
import { formatCompactINR, formatShortDate } from '@/lib/finance/format'
import { SETTLEMENT_STATUSES } from '@/lib/settlements/statusMeta'
import { SettlementStatusBadge } from './SettlementStatusBadge'
import type { SettlementRequestSummary } from '@/lib/settlements/types'

interface Props {
  settlements: SettlementRequestSummary[]
  loading:     boolean
  /** Show the status-filter pills + search box (Settlement Center). */
  enableControls?: boolean
}

function SettleRowSkeleton() {
  return (
    <tr aria-hidden>
      {[100, 80, 72, 130, 180].map((w, i) => (
        <td key={i} className="px-4 py-3.5">
          <div className="h-3.5 animate-pulse rounded bg-muted" style={{ width: w }} />
        </td>
      ))}
    </tr>
  )
}

export function SettlementHistoryTable({ settlements, loading, enableControls = false }: Props) {
  const [statusFilter, setStatusFilter] = useState<'all' | string>('all')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return settlements.filter(s => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false
      if (!q) return true
      const hay = [
        s.utrNumber ?? '', s.bankReference ?? '', s.adminNote ?? '', s.status,
        formatCompactINR(s.amountPaise),
      ].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [settlements, statusFilter, search])

  return (
    <div>
      {enableControls && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div role="group" aria-label="Filter by status" className="flex flex-wrap items-center gap-px rounded-lg border border-border bg-muted p-0.5">
            {(['all', ...SETTLEMENT_STATUSES] as string[]).map(key => (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                aria-pressed={statusFilter === key}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-colors',
                  statusFilter === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {key}
              </button>
            ))}
          </div>
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search UTR, reference, note…"
              aria-label="Search settlements"
              className="h-8 w-full rounded-lg border border-border bg-card pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>
      )}

      {loading ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px]" aria-label="Settlement history loading">
            <tbody>{Array.from({ length: 3 }).map((_, i) => <SettleRowSkeleton key={i} />)}</tbody>
          </table>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Send}
          title={settlements.length === 0 ? 'No settlement requests yet' : 'No matching settlements'}
          description={
            settlements.length === 0
              ? 'Request a payout once funds are available in your revenue wallet.'
              : 'Adjust the filters or search to see more results.'
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13.5px]" aria-label="Settlement requests">
            <thead>
              <tr className="border-b border-border">
                {['Requested', 'Amount', 'Status', 'UTR / Reference', 'Note'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-5 last:pr-5">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={s.id} className={cn('transition-colors hover:bg-muted/40', i < filtered.length - 1 && 'border-b border-border')}>
                  <td className="px-4 py-3.5 pl-5 text-muted-foreground tabular-nums">
                    {formatShortDate(s.requestedAt)}
                    {s.paidAt && <span className="mt-0.5 block text-[12px]">Paid {formatShortDate(s.paidAt)}</span>}
                  </td>
                  <td className="px-4 py-3.5 font-semibold tabular-nums text-foreground">{formatCompactINR(s.amountPaise)}</td>
                  <td className="px-4 py-3.5"><SettlementStatusBadge status={s.status} /></td>
                  <td className="px-4 py-3.5 text-muted-foreground">
                    {s.utrNumber ? <span className="font-mono text-[12.5px] text-foreground">{s.utrNumber}</span> : '—'}
                    {s.bankReference && <span className="mt-0.5 block text-[12px]">{s.bankReference}</span>}
                  </td>
                  <td className="px-4 py-3.5 pr-5 text-muted-foreground">{s.adminNote || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
