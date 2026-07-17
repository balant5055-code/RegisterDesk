'use client'

// Communication wallet panel (Phase H.5.2) — read-only.
// Reuses GET /wallet/overview, /wallet/transactions, /wallet/usage and the label
// maps in lib/wallet/types (via txnMeta). Distinct from the REVENUE wallet: this
// is the prepaid comms-credit wallet, spent down on email/SMS/WhatsApp.

import { Download, Loader2, Mail, MessageSquare, MessagesSquare, TrendingDown, TrendingUp, Wallet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Card, EmptyState } from '@/components/ui'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { KpiCardSkeleton } from '@/components/dashboard/Skeleton'
import { formatCompactINR, formatShortDate } from '@/lib/finance/format'
import {
  isWalletCredit, walletTxnTypeLabel, walletTxnStatusMeta, channelMeta,
} from '@/lib/finance/txnMeta'
import type { WalletOverview, WalletTransaction, CommunicationUsage } from '@/lib/wallet/types'

const CHANNEL_ICON: Record<string, LucideIcon> = {
  mail: Mail, 'message-square': MessageSquare, 'messages-square': MessagesSquare,
}

interface Props {
  overview:     WalletOverview | null
  transactions: WalletTransaction[]
  usage:        CommunicationUsage[]
  loading:      boolean
  onExport?:    () => void
  exporting?:   boolean
}

export function CommunicationWalletPanel({ overview, transactions, usage, loading, onExport, exporting }: Props) {
  const kpis = [
    { label: 'Comms balance',   value: formatCompactINR(overview?.balancePaise ?? 0),        sub: 'Prepaid credits',   icon: Wallet },
    { label: 'This-month spend', value: formatCompactINR(overview?.thisMonthSpendPaise ?? 0), sub: 'Current cycle',      icon: TrendingDown },
    { label: 'Emails',          value: String(overview?.emailsSent ?? 0),                     sub: 'Sent this month',   icon: Mail },
    { label: 'SMS',             value: String(overview?.smsSent ?? 0),                        sub: 'Sent this month',   icon: MessageSquare },
    { label: 'WhatsApp',        value: String(overview?.whatsappSent ?? 0),                   sub: 'Sent this month',   icon: MessagesSquare },
  ]

  return (
    <section className="space-y-4" aria-label="Communication wallet">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-busy={loading}>
        {loading
          ? Array.from({ length: 5 }).map((_, i) => <KpiCardSkeleton key={i} />)
          : kpis.map(({ label, value, sub, icon: Icon }) => (
              <Card key={label} padded={false} className="p-4" role="figure" aria-label={`${label}: ${value}`}>
                <div className="flex size-9 items-center justify-center rounded-lg bg-primary/[0.09]">
                  <Icon className="size-[17px] text-primary" aria-hidden />
                </div>
                <p className="mt-3 text-[22px] font-bold leading-none tracking-tight text-foreground">{value}</p>
                <p className="mt-1.5 text-[13px] font-medium text-foreground">{label}</p>
                <p className="mt-0.5 text-[13px] text-muted-foreground">{sub}</p>
              </Card>
            ))
        }
      </div>

      {/* Recharge / debit history */}
      <DashboardCard
        title="Recharge & usage charges"
        action={onExport && (
          <button
            onClick={onExport}
            disabled={exporting}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {exporting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
            Export
          </button>
        )}
      >
        {loading ? (
          <div className="space-y-2 py-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-muted" />)}</div>
        ) : transactions.length === 0 ? (
          <EmptyState icon={Wallet} title="No wallet transactions" description="Top-ups and communication charges will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13.5px]" aria-label="Wallet transactions">
              <thead>
                <tr className="border-b border-border">
                  {['Date', 'Type', 'Amount', 'Status', 'Description'].map(h => (
                    <th key={h} className="px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-5 last:pr-5">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {transactions.map((t, i) => {
                  const credit = isWalletCredit(t.type)
                  const st = walletTxnStatusMeta(t.status)
                  return (
                    <tr key={t.id} className={cn('transition-colors hover:bg-muted/40', i < transactions.length - 1 && 'border-b border-border')}>
                      <td className="px-4 py-3 pl-5 text-muted-foreground tabular-nums">{formatShortDate(t.createdAt)}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-foreground">
                          {credit ? <TrendingUp className="size-3.5 text-emerald-600" aria-hidden /> : <TrendingDown className="size-3.5 text-muted-foreground" aria-hidden />}
                          {walletTxnTypeLabel(t.type)}
                        </span>
                      </td>
                      <td className={cn('px-4 py-3 font-semibold tabular-nums', credit ? 'text-emerald-600' : 'text-foreground')}>
                        {credit ? '+' : '−'} {formatCompactINR(t.amountPaise)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[12px] font-semibold', st.badgeClass)}>{st.label}</span>
                      </td>
                      <td className="px-4 py-3 pr-5 text-muted-foreground"><span className="line-clamp-1 max-w-[220px]">{t.description || '—'}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </DashboardCard>

      {/* Usage history */}
      <DashboardCard title="Communication usage">
        {loading ? (
          <div className="space-y-2 py-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-muted" />)}</div>
        ) : usage.length === 0 ? (
          <EmptyState icon={Mail} title="No usage yet" description="Email, SMS, and WhatsApp usage will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13.5px]" aria-label="Communication usage">
              <thead>
                <tr className="border-b border-border">
                  {['Event', 'Channel', 'Quantity', 'Cost', 'Date'].map(h => (
                    <th key={h} className="px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground first:pl-5 last:pr-5">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {usage.map((u, i) => {
                  const ch = channelMeta(u.channel)
                  const Icon = CHANNEL_ICON[ch.iconKey] ?? Mail
                  return (
                    <tr key={u.id} className={cn('transition-colors hover:bg-muted/40', i < usage.length - 1 && 'border-b border-border')}>
                      <td className="px-4 py-3 pl-5 font-medium text-foreground"><span className="line-clamp-1 max-w-[200px]">{u.eventName || u.eventSlug || '—'}</span></td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold', ch.badgeClass)}>
                          <Icon className="size-3" aria-hidden /> {ch.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-foreground">{u.quantity}</td>
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">{formatCompactINR(u.costPaise)}</td>
                      <td className="px-4 py-3 pr-5 text-muted-foreground tabular-nums">{formatShortDate(u.createdAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </DashboardCard>
    </section>
  )
}
