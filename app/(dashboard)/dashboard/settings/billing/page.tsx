'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import Link from 'next/link'
import {
  Loader2, CreditCard, Wallet, Ticket, Plus, ArrowRight, Activity,
  Mail, MessageSquare, Phone,
} from 'lucide-react'
import LicensesTab from './LicensesTab'
import { WALLET_TXN_TYPE_LABELS, type WalletTransaction, type WalletTxnType, type WalletOverview } from '@/lib/wallet/types'

// A subset of /api/organizer/licenses rows — only what the Billing Center needs.
interface LicenseRow { status: string; amountPaidPaise: number }

type Tab = 'overview' | 'wallet' | 'licenses' | 'usage'

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'wallet',   label: 'Wallet' },
  { key: 'licenses', label: 'Licenses' },
  { key: 'usage',    label: 'Usage' },
]

const CREDIT_TYPES = new Set<WalletTxnType>(['fund_added', 'refund'])
const rupees  = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

export default function BillingPage() {
  const userRef = useRef<User | null>(null)
  const [tab,          setTab]          = useState<Tab>('overview')
  const [overview,     setOverview]     = useState<WalletOverview | null>(null)
  const [licenses,     setLicenses]     = useState<LicenseRow[]>([])
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState<string | null>(null)

  async function reload() {
    const u = userRef.current; if (!u) return
    const token = await u.getIdToken()
    const h = { Authorization: `Bearer ${token}` }
    const [oRes, lRes, tRes] = await Promise.all([
      fetch('/api/organizer/wallet/overview',      { headers: h, cache: 'no-store' }),
      fetch('/api/organizer/licenses',             { headers: h, cache: 'no-store' }),
      fetch('/api/organizer/wallet/transactions',  { headers: h, cache: 'no-store' }),
    ])
    if (oRes.ok) setOverview(((await oRes.json()) as { overview: WalletOverview }).overview)
    if (lRes.ok) setLicenses(((await lRes.json()) as { licenses: LicenseRow[] }).licenses)
    if (tRes.ok) setTransactions(((await tRes.json()) as { transactions: WalletTransaction[] }).transactions)
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      userRef.current = user
      if (!user) { setError('You must be signed in.'); setLoading(false); return }
      reload().catch(e => setError(e instanceof Error ? e.message : 'Failed to load')).finally(() => setLoading(false))
    })
    return unsub
  }, [])

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error)   return <div className="p-6"><div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13.5px] text-destructive">{error}</div></div>

  const activeLicenses  = licenses.filter(l => l.status === 'active').length
  const pendingLicenses = licenses.filter(l => l.status === 'pending_approval').length
  const purchases       = licenses.filter(l => l.amountPaidPaise > 0).length
  const commUsage       = (overview?.emailsSent ?? 0) + (overview?.smsSent ?? 0) + (overview?.whatsappSent ?? 0)

  return (
    <div className="space-y-6 p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/[0.09] text-primary"><CreditCard className="size-5" aria-hidden /></div>
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">Billing Center</h1>
          <p className="text-[13.5px] text-muted-foreground">Your wallet, event licenses, and usage.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 overflow-x-auto border-b border-border">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              '-mb-px shrink-0 border-b-2 px-1 py-2 text-[13.5px] font-semibold transition-colors',
              tab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ─────────────────────────────────────────────────────────── */}
      {tab === 'overview' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Kpi icon={<Wallet className="size-4" />}  label="Wallet balance"          value={overview ? rupees(overview.balancePaise) : '—'} />
            <Kpi icon={<Ticket className="size-4" />}  label="Active event licenses"   value={activeLicenses} />
            <Kpi icon={<Activity className="size-4" />} label="Pending approval"        value={pendingLicenses} />
            <Kpi icon={<CreditCard className="size-4" />} label="License purchases"     value={purchases} />
            <Kpi icon={<Mail className="size-4" />}    label="Communication usage"      value={commUsage} />
          </div>

          <div>
            <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Quick actions</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <QuickAction href="/dashboard/wallet"      icon={<Plus className="size-4" />}   title="Top up wallet"  subtitle="Add funds for paid services" />
              <QuickAction href="/dashboard/events/new"  icon={<Ticket className="size-4" />} title="Create event"   subtitle="Start a new event + license" />
              <QuickAction onClick={() => setTab('licenses')} icon={<CreditCard className="size-4" />} title="View licenses" subtitle="See every event's license" />
            </div>
          </div>
        </div>
      )}

      {/* ── WALLET ───────────────────────────────────────────────────────────── */}
      {tab === 'wallet' && (
        <div className="space-y-5">
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-5">
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Current balance</p>
              <p className="mt-0.5 text-[26px] font-bold text-foreground">{overview ? rupees(overview.balancePaise) : '—'}</p>
            </div>
            <Link href="/dashboard/wallet" className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm" style={{ backgroundImage: 'var(--primary-gradient)' }}>
              <Plus className="size-4" /> Top up
            </Link>
          </section>

          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Recent transactions</h2>
              <Link href="/dashboard/wallet/transactions" className="text-[12px] font-semibold text-primary">View all</Link>
            </div>
            {transactions.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border py-8 text-center text-[13px] text-muted-foreground">No transactions yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[520px] text-[13px]">
                  <thead><tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
                    <th className="px-4 py-2.5">Date</th><th className="px-4 py-2.5">Type</th><th className="px-4 py-2.5">Description</th><th className="px-4 py-2.5 text-right">Amount</th><th className="px-4 py-2.5 text-right">Balance</th>
                  </tr></thead>
                  <tbody className="divide-y divide-border">
                    {transactions.slice(0, 25).map(t => {
                      const credit = CREDIT_TYPES.has(t.type)
                      return (
                        <tr key={t.id}>
                          <td className="px-4 py-2.5 text-muted-foreground">{fmtDate(t.createdAt)}</td>
                          <td className="px-4 py-2.5 text-foreground">{WALLET_TXN_TYPE_LABELS[t.type] ?? t.type}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">{t.description || '—'}</td>
                          <td className={cn('px-4 py-2.5 text-right font-semibold', credit ? 'text-emerald-600' : 'text-foreground')}>{credit ? '+' : '−'}{rupees(t.amountPaise)}</td>
                          <td className="px-4 py-2.5 text-right text-muted-foreground">{rupees(t.balancePaise)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-[12.5px] text-muted-foreground">Manage top-ups, usage, and full history on the <Link href="/dashboard/wallet" className="font-semibold text-primary">Wallet page</Link>.</p>
        </div>
      )}

      {/* ── LICENSES (F2.3, reused) ──────────────────────────────────────────── */}
      {tab === 'licenses' && <LicensesTab />}

      {/* ── USAGE ────────────────────────────────────────────────────────────── */}
      {tab === 'usage' && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">Platform usage for this workspace.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Kpi icon={<Mail className="size-4" />}          label="Emails sent"       value={overview?.emailsSent ?? 0} />
            <Kpi icon={<MessageSquare className="size-4" />} label="WhatsApp messages" value={overview?.whatsappSent ?? 0} />
            <Kpi icon={<Phone className="size-4" />}         label="SMS"               value={overview?.smsSent ?? 0} />
          </div>
        </div>
      )}

    </div>
  )
}

// ─── Small presentational helpers (reuse existing card/token style) ────────────

function Kpi({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <span className="text-muted-foreground/70">{icon}</span>{label}
      </div>
      <p className="mt-1 text-[20px] font-bold text-foreground">{value}</p>
    </div>
  )
}

function QuickAction({ href, onClick, icon, title, subtitle }: {
  href?: string; onClick?: () => void; icon: ReactNode; title: string; subtitle: string
}) {
  const inner = (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-border-strong hover:bg-muted/20">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.09] text-primary">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold text-foreground">{title}</p>
        <p className="truncate text-[12px] text-muted-foreground">{subtitle}</p>
      </div>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </div>
  )
  return href
    ? <Link href={href}>{inner}</Link>
    : <button type="button" onClick={onClick} className="w-full text-left">{inner}</button>
}
