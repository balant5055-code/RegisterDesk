'use client'

// Wallet Ledger & Transaction Explorer (Phase H.5.2) — a read-first financial
// workspace. PURE aggregation over existing endpoints (no writes, no new ledger,
// no fee recalculation): revenue wallet (/api/organizer/finance), communication
// wallet (/wallet/overview + /transactions + /usage), and the transaction
// explorer (/finance/transactions). Sections are permission-gated INDEPENDENTLY:
// a section whose endpoint returns 403 is hidden (revenue → 'transactions' perm,
// comms → 'wallet' perm).

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { ErrorState } from '@/components/ui'
import { RevenueWalletSummary } from '@/components/dashboard/finance/RevenueWalletSummary'
import { CommunicationWalletPanel } from '@/components/dashboard/finance/CommunicationWalletPanel'
import { TransactionExplorer } from '@/components/dashboard/finance/TransactionExplorer'
import type { FinanceOverview } from '@/app/api/organizer/finance/route'
import type { GetWalletOverviewResponse } from '@/app/api/organizer/wallet/overview/route'
import type { GetWalletTransactionsResponse } from '@/app/api/organizer/wallet/transactions/route'
import type { GetCommUsageResponse } from '@/app/api/organizer/wallet/usage/route'
import type { WalletOverview, WalletTransaction, CommunicationUsage } from '@/lib/wallet/types'

export default function WalletLedgerPage() {
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const [revenueOk, setRevenueOk] = useState<boolean | null>(null)
  const [commsOk, setCommsOk]     = useState<boolean | null>(null)

  const [overview, setOverview] = useState<FinanceOverview | null>(null)
  const [walletOverview, setWalletOverview] = useState<WalletOverview | null>(null)
  const [walletTxns, setWalletTxns] = useState<WalletTransaction[]>([])
  const [usage, setUsage] = useState<CommunicationUsage[]>([])
  const [exportingComms, setExportingComms] = useState(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      setLoading(true)
      setError(null)
      if (!user) { setLoading(false); return }
      try {
        const t = await user.getIdToken(retryKey > 0)
        setToken(t)
        const h = { Authorization: `Bearer ${t}` }
        const [finRes, ovRes, txRes, usRes] = await Promise.all([
          fetch('/api/organizer/finance',              { headers: h }),
          fetch('/api/organizer/wallet/overview',      { headers: h }),
          fetch('/api/organizer/wallet/transactions?limit=100', { headers: h }),
          fetch('/api/organizer/wallet/usage?limit=200',        { headers: h }),
        ])

        // Revenue section (gated on 'transactions').
        if (finRes.ok) { setOverview(await finRes.json() as FinanceOverview); setRevenueOk(true) }
        else setRevenueOk(false)

        // Communication section (gated on 'wallet').
        if (ovRes.ok) {
          const ov = await ovRes.json() as GetWalletOverviewResponse
          if (ov.success) { setWalletOverview(ov.overview); setCommsOk(true) } else setCommsOk(false)
          if (txRes.ok) { const d = await txRes.json() as GetWalletTransactionsResponse; if (d.success) setWalletTxns(d.transactions) }
          if (usRes.ok) { const d = await usRes.json() as GetCommUsageResponse;         if (d.success) setUsage(d.usage) }
        } else {
          setCommsOk(false)
        }

        if (!finRes.ok && !ovRes.ok) setError('You don’t have permission to view financial data.')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load wallet data.')
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [retryKey])

  const handleExportComms = useCallback(async () => {
    if (!token || exportingComms) return
    setExportingComms(true)
    try {
      const res = await fetch('/api/organizer/reports/wallet-ledger?format=csv', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return
      const blob = await res.blob()
      const match = /filename="?([^"]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = match?.[1] ?? 'wallet-ledger.csv'
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setExportingComms(false)
    }
  }, [token, exportingComms])

  return (
    <div className="space-y-6 pb-12">
      <div>
        <Link href="/dashboard/finance" className="mb-1 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden /> Finance
        </Link>
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">Wallet Ledger &amp; Transactions</h1>
        <p className="mt-0.5 text-[14px] text-muted-foreground">Revenue and communication wallets, with a full transaction explorer.</p>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => setRetryKey(k => k + 1)} />
      ) : loading && revenueOk === null && commsOk === null ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
      ) : (
        <>
          {/* Revenue wallet */}
          {revenueOk !== false && (
            <section className="space-y-4" aria-label="Revenue wallet">
              <h2 className="text-[15px] font-semibold text-foreground">Revenue wallet</h2>
              <RevenueWalletSummary overview={overview} loading={loading} />
            </section>
          )}

          {/* Communication wallet */}
          {commsOk !== false && (
            <section className="space-y-4" aria-label="Communication wallet">
              <h2 className="text-[15px] font-semibold text-foreground">Communication wallet</h2>
              <CommunicationWalletPanel
                overview={walletOverview}
                transactions={walletTxns}
                usage={usage}
                loading={loading}
                onExport={() => void handleExportComms()}
                exporting={exportingComms}
              />
            </section>
          )}

          {/* Transaction explorer (revenue permission) */}
          {revenueOk !== false && token && (
            <section aria-label="Transaction explorer">
              <TransactionExplorer token={token} />
            </section>
          )}
        </>
      )}
    </div>
  )
}
