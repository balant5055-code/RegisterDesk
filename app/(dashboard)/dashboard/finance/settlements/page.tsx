'use client'

// Organizer Settlement Center (Phase H.5.1) — the financial operations workspace.
//
// PURE aggregation over existing endpoints (zero new financial logic, no new
// ledger): balances from GET /api/organizer/finance, history from
// GET /api/organizer/settlements, bank from GET /api/organizer/payout-profile,
// request via POST /api/organizer/settlements, export via the existing reports
// endpoint. Shared components/status metadata keep it consistent with the
// finance overview.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { ArrowLeft, Clock, DollarSign, Download, Loader2, Send, Truck, Wallet } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Card, ErrorState } from '@/components/ui'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { KpiCardSkeleton } from '@/components/dashboard/Skeleton'
import { SettlementHistoryTable } from '@/components/dashboard/finance/SettlementHistoryTable'
import { BankSummaryCard } from '@/components/dashboard/finance/BankSummaryCard'
import { RequestSettlementModal } from '@/components/dashboard/finance/RequestSettlementModal'
import { formatCompactINR } from '@/lib/finance/format'
import type { FinanceOverview } from '@/app/api/organizer/finance/route'
import type { PayoutProfileGetResponse, PayoutProfileSummary } from '@/lib/payout/types'
import type { SettlementRequestSummary, SettlementsApiResponse } from '@/lib/settlements/types'

export default function SettlementCenterPage() {
  const [overview,    setOverview]    = useState<FinanceOverview | null>(null)
  const [settlements, setSettlements] = useState<SettlementRequestSummary[]>([])
  const [profile,     setProfile]     = useState<PayoutProfileSummary | null>(null)

  const [token,     setToken]     = useState('')
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [retryKey,  setRetryKey]  = useState(0)
  const [showModal, setShowModal] = useState(false)
  const [exporting, setExporting] = useState(false)

  const fetchSettlements = useCallback(async (tok: string) => {
    const res = await fetch('/api/organizer/settlements', { headers: { Authorization: `Bearer ${tok}` } })
    if (!res.ok) return
    const data = await res.json() as SettlementsApiResponse
    setSettlements(data.requests)
  }, [])

  useEffect(() => {
    // State resets happen inside the (async) auth callback, never synchronously
    // in the effect body — loading defaults to true on first mount.
    const unsub = onAuthStateChanged(auth, async user => {
      setLoading(true)
      setError(null)
      if (!user) { setLoading(false); return }
      try {
        const t = await user.getIdToken(retryKey > 0)
        setToken(t)
        const [finRes, setRes, payRes] = await Promise.all([
          fetch('/api/organizer/finance',        { headers: { Authorization: `Bearer ${t}` } }),
          fetch('/api/organizer/settlements',    { headers: { Authorization: `Bearer ${t}` } }),
          fetch('/api/organizer/payout-profile', { headers: { Authorization: `Bearer ${t}` } }),
        ])
        if (!finRes.ok) throw new Error(`Failed to load settlement data. (${finRes.status})`)
        const [finData, setData, payData] = await Promise.all([
          finRes.json() as Promise<FinanceOverview>,
          setRes.ok ? setRes.json() as Promise<SettlementsApiResponse> : Promise.resolve({ requests: [] } as SettlementsApiResponse),
          payRes.ok ? payRes.json() as Promise<PayoutProfileGetResponse> : Promise.resolve({ profile: null } as PayoutProfileGetResponse),
        ])
        setOverview(finData)
        setSettlements(setData.requests)
        setProfile(payData.profile)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load settlement data.')
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [retryKey])

  const handleSubmit = useCallback(async (amountPaise: number) => {
    const res = await fetch('/api/organizer/settlements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amountPaise }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(err.error ?? `Request failed (${res.status})`)
    }
    await fetchSettlements(token)
  }, [token, fetchSettlements])

  // Export reuses the existing reports endpoint — no new export code/backend.
  const handleExport = useCallback(async () => {
    if (!token || exporting) return
    setExporting(true)
    try {
      const res = await fetch('/api/organizer/reports/settlements?format=csv', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match = /filename="?([^"]+)"?/.exec(disposition)
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url
      a.download = match?.[1] ?? 'settlements.csv'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }, [token, exporting])

  const w = overview?.wallet
  const hasPendingRequest = settlements.some(s => s.status === 'pending')

  const kpis = [
    { label: 'Available',   value: formatCompactINR(w?.availablePaise ?? 0), sub: 'Ready to settle',    icon: DollarSign, color: 'text-emerald-600', bg: 'bg-emerald-500/[0.09]' },
    { label: 'Pending',     value: formatCompactINR(w?.pendingPaise   ?? 0), sub: 'Awaiting T+2',       icon: Clock,      color: 'text-amber-600',   bg: 'bg-amber-500/[0.09]'   },
    { label: 'Processing',  value: formatCompactINR(w?.inTransitPaise ?? 0), sub: 'Payout in progress', icon: Truck,      color: 'text-blue-600',    bg: 'bg-blue-500/[0.09]'    },
    { label: 'Settled',     value: formatCompactINR(w?.settledPaise   ?? 0), sub: 'Paid to bank',       icon: Wallet,     color: 'text-violet-600',  bg: 'bg-violet-500/[0.09]'  },
  ]

  return (
    <div className="space-y-5 pb-12">
      {/* Heading */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/dashboard/finance" className="mb-1 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden /> Finance
          </Link>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">Settlement Center</h1>
          <p className="mt-0.5 text-[14px] text-muted-foreground">Balances, payouts, and settlement history for your workspace.</p>
        </div>
        {!loading && !error && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => void handleExport()}
              disabled={exporting}
              className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {exporting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
              Export
            </button>
            <button
              onClick={() => setShowModal(true)}
              disabled={hasPendingRequest}
              title={hasPendingRequest ? 'A settlement request is already pending' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-opacity',
                hasPendingRequest ? 'cursor-not-allowed opacity-50' : 'hover:opacity-90',
              )}
              style={{ backgroundImage: 'var(--primary-gradient)' }}
            >
              <Send className="size-3.5" aria-hidden />
              Request Settlement
            </button>
          </div>
        )}
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => setRetryKey(k => k + 1)} />
      ) : (
        <>
          {/* Balance buckets */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Settlement balances" aria-busy={loading}>
            {loading
              ? Array.from({ length: 4 }).map((_, i) => <KpiCardSkeleton key={i} />)
              : kpis.map(({ label, value, sub, icon: Icon, color, bg }) => (
                  <Card key={label} padded={false} className="p-4" role="figure" aria-label={`${label}: ${value}`}>
                    <div className={cn('flex size-9 items-center justify-center rounded-lg', bg)}>
                      <Icon className={cn('size-[17px]', color)} aria-hidden />
                    </div>
                    <p className="mt-3 text-[26px] font-bold leading-none tracking-tight text-foreground">{value}</p>
                    <p className="mt-1.5 text-[13px] font-medium text-foreground">{label}</p>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">{sub}</p>
                  </Card>
                ))
            }
          </div>

          {/* Bank summary */}
          {!loading && <BankSummaryCard profile={profile} />}

          {/* History with filters + search */}
          <DashboardCard title="Settlement history">
            <SettlementHistoryTable settlements={settlements} loading={loading} enableControls />
          </DashboardCard>
        </>
      )}

      {showModal && (
        <RequestSettlementModal
          availablePaise={overview?.wallet.availablePaise ?? 0}
          hasPayoutProfile={profile !== null}
          onClose={() => setShowModal(false)}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  )
}
