'use client'

import { useCallback, useEffect, useState } from 'react'
import { onAuthStateChanged }               from 'firebase/auth'
import { auth }                             from '@/lib/firebase/auth'
import {
  Wallet, Mail, MessageSquare, MessagesSquare,
  TrendingUp, Plus, X, ChevronRight, Loader2,
  CheckCircle2, AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Button, Card, PageHeader } from '@/components/ui'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import { useWalletConfig } from '@/lib/wallet/walletConfigClient'
import type { WalletOverview } from '@/lib/wallet/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(paise: number): string {
  const r = paise / 100
  if (r >= 10_00_000) return `₹${(r / 10_00_000).toFixed(1)}L`
  if (r >= 1_000)     return `₹${(r / 1_000).toFixed(1)}K`
  return `₹${r.toFixed(0)}`
}

function formatNumber(n: number): string {
  if (n >= 1_00_000) return `${(n / 1_00_000).toFixed(1)}L`
  if (n >= 1_000)    return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="size-10 rounded-xl bg-muted" />
      </div>
      <div className="h-8 w-24 rounded-lg bg-muted" />
      <div className="h-4 w-32 rounded bg-muted" />
    </div>
  )
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

interface StatCardProps {
  icon:          React.ElementType
  label:         string
  value:         string
  sub?:          string
  gradient?:     string
  iconColor?:    string
  action?:       React.ReactNode
}

function StatCard({ icon: Icon, label, value, sub, gradient, iconColor, action }: StatCardProps) {
  return (
    <Card variant="elevated" padded={false} className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-2">
        <div
          className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', gradient)}
          aria-hidden
        >
          <Icon className={cn('size-5', iconColor ?? 'text-white')} />
        </div>
        {action}
      </div>
      <div>
        <p className="text-[26px] font-bold leading-none tracking-tight text-foreground">{value}</p>
        {sub && <p className="mt-1 text-[13px] text-muted-foreground">{sub}</p>}
      </div>
      <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
    </Card>
  )
}

// ─── Quick Link ───────────────────────────────────────────────────────────────

function QuickLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-4 py-3 text-[14px] font-medium text-foreground transition-all hover:bg-muted hover:shadow-sm"
    >
      <span className="flex-1">{label}</span>
      <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
    </a>
  )
}

// ─── Razorpay checkout (loaded dynamically from checkout.razorpay.com) ─────────

interface WalletRzpSuccess {
  razorpay_payment_id: string
  razorpay_order_id:   string
  razorpay_signature:  string
}
interface WalletRzpOptions {
  key:      string
  amount:   number
  currency: string
  order_id: string
  name?:    string
  description?: string
  handler:  (r: WalletRzpSuccess) => void
  modal?:   { ondismiss?: () => void }
  theme?:   { color?: string }
}

// Access the checkout constructor without augmenting the global Window type
// (other modules already declare it with a slightly different option shape).
type WalletRzpCtor = new (options: WalletRzpOptions) => { open(): void }
function getRazorpay(): WalletRzpCtor | null {
  const w = window as unknown as { Razorpay?: WalletRzpCtor }
  return w.Razorpay ?? null
}

function loadRazorpayScript(): Promise<void> {
  if (typeof window !== 'undefined' && getRazorpay()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed to load the payment gateway'))
    document.body.appendChild(s)
  })
}

// ─── Add Funds Modal ──────────────────────────────────────────────────────────

const PRESET_AMOUNTS = [
  { label: '₹100',   paise: 100_00 },
  { label: '₹500',   paise: 500_00 },
  { label: '₹1,000', paise: 1000_00 },
  { label: '₹5,000', paise: 5000_00 },
]

type TopupPhase = 'idle' | 'processing' | 'success' | 'pending' | 'error'

function AddFundsModal({
  onClose,
  onSuccess,
}: {
  onClose:   () => void
  onSuccess: (newBalance: number) => void
}) {
  const [selected, setSelected]  = useState<number | null>(null)
  const [custom,   setCustom]    = useState('')
  const [phase,    setPhase]     = useState<TopupPhase>('idle')
  const [error,    setError]     = useState<string | null>(null)

  // Top-up limits from Business Configuration (single source; matches the server).
  const wallet    = useWalletConfig()
  const dialogRef = useFocusTrap<HTMLDivElement>()

  const amountPaise = selected !== null
    ? selected
    : Math.round(parseFloat(custom || '0') * 100)

  const amountValid = amountPaise >= wallet.minimumTopupPaise && amountPaise <= wallet.maximumTopupPaise
  const saving      = phase === 'processing'
  const done        = phase === 'success'

  async function handleSubmit() {
    if (!amountValid) return
    setPhase('processing')
    setError(null)
    try {
      const tkn = await auth.currentUser?.getIdToken()
      if (!tkn) throw new Error('Not authenticated')
      const authHeader = { Authorization: `Bearer ${tkn}` }

      // 1. Create the Razorpay order + persisted top-up intent.
      const orderRes  = await fetch('/api/organizer/wallet/topup', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body:    JSON.stringify({ amountPaise }),
      })
      const order = await orderRes.json() as { orderId?: string; amount?: number; currency?: string; keyId?: string; error?: string }
      if (!orderRes.ok || !order.orderId || !order.keyId) {
        throw new Error(order.error ?? 'Could not start the top-up')
      }

      // 2. Open Razorpay checkout.
      await loadRazorpayScript()
      const Razorpay = getRazorpay()
      if (!Razorpay) throw new Error('Failed to load the payment gateway')
      const result = await new Promise<WalletRzpSuccess>((resolve, reject) => {
        const rzp = new Razorpay({
          key:         order.keyId!,
          amount:      order.amount!,
          currency:    order.currency ?? 'INR',
          order_id:    order.orderId!,
          name:        'RegisterDesk',
          description: 'Wallet top-up',
          handler:     resolve,
          modal:       { ondismiss: () => reject(new Error('PAYMENT_CANCELLED')) },
          theme:       { color: '#7C3AED' },
        })
        rzp.open()
      })

      // 3. Verify on the server (signature + amount + credit).
      const verifyRes = await fetch('/api/organizer/wallet/topup/verify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body:    JSON.stringify({
          orderId:   result.razorpay_order_id,
          paymentId: result.razorpay_payment_id,
          signature: result.razorpay_signature,
        }),
      })
      const verify = await verifyRes.json() as { success: boolean; newBalance?: number; pending?: boolean; error?: string }

      if (verify.success) {
        setPhase('success')
        setTimeout(() => { onSuccess(verify.newBalance ?? 0); onClose() }, 1200)
        return
      }
      if (verify.pending) {
        setPhase('pending')   // payment captured; credit will reconcile shortly
        return
      }
      throw new Error(verify.error ?? 'Payment verification failed')
    } catch (err) {
      if (err instanceof Error && err.message === 'PAYMENT_CANCELLED') {
        setPhase('idle')   // user closed checkout — let them retry
        return
      }
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setPhase('error')
    }
  }

  return (
    <>
      {/* Backdrop — z-40 so toasts at z-60 sit above */}
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      {/* Dialog — z-50 */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-funds-title"
        className="pointer-events-auto w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl"
      >

        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 id="add-funds-title" className="text-[18px] font-bold text-foreground">Add Funds</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">Select or enter an amount to add to your wallet</p>
          </div>
          <button
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Preset amounts */}
        <div className="mb-4 grid grid-cols-4 gap-2">
          {PRESET_AMOUNTS.map(p => (
            <button
              key={p.paise}
              type="button"
              onClick={() => { setSelected(p.paise); setCustom('') }}
              className={cn(
                'rounded-xl border py-2.5 text-[14px] font-semibold transition-all',
                selected === p.paise
                  ? 'border-primary bg-primary/10 text-primary shadow-sm'
                  : 'border-border bg-muted/40 text-foreground hover:bg-muted',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Custom amount */}
        <div className="mb-5">
          <label className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
            Custom amount (₹)
          </label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px] font-semibold text-muted-foreground">₹</span>
            <input
              type="number"
              min={wallet.minimumTopupPaise / 100}
              max={wallet.maximumTopupPaise / 100}
              placeholder="Enter amount"
              value={custom}
              onChange={e => { setCustom(e.target.value); setSelected(null) }}
              className="w-full rounded-xl border border-border bg-background py-2.5 pl-8 pr-4 text-[15px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          {amountPaise > 0 && !amountValid && (
            <p className="mt-1.5 text-[12px] text-destructive">Amount must be between ₹{(wallet.minimumTopupPaise / 100).toLocaleString('en-IN')} and ₹{(wallet.maximumTopupPaise / 100).toLocaleString('en-IN')}.</p>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Action */}
        {done ? (
          <div className="flex items-center justify-center gap-2 rounded-xl bg-emerald-50 py-3 text-[14px] font-semibold text-emerald-700">
            <CheckCircle2 className="size-4" />
            Funds added successfully
          </div>
        ) : phase === 'pending' ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-[13px] font-medium text-amber-700">
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
              <span>Payment received. Your wallet will be credited shortly — you can close this window.</span>
            </div>
            <Button variant="secondary" onClick={onClose} className="w-full rounded-xl py-3 text-[14px]">Close</Button>
          </div>
        ) : (
          <Button
            variant={amountValid && !saving ? 'gradient' : 'secondary'}
            onClick={handleSubmit}
            disabled={!amountValid || saving}
            isLoading={saving}
            className="w-full rounded-xl py-3 text-[14px]"
          >
            {saving ? 'Processing…' : `Add ${amountPaise > 0 ? formatCurrency(amountPaise) : 'Funds'}`}
          </Button>
        )}

        <p className="mt-3 text-center text-[12px] text-muted-foreground">
          Secure payment via Razorpay. Funds are credited to your communications wallet.
        </p>
      </div>
      </div>
    </>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function WalletOverviewClient() {
  const [overview, setOverview] = useState<WalletOverview | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [showAdd,  setShowAdd]  = useState(false)

  const load = useCallback((uid: string) => {
    auth.currentUser?.getIdToken().then(token => {
      fetch('/api/organizer/wallet/overview', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then((data: { success: boolean; overview?: WalletOverview; error?: string }) => {
          if (data.success && data.overview) setOverview(data.overview)
          else setError(data.error ?? 'Failed to load')
        })
        .catch(() => setError('Network error'))
        .finally(() => setLoading(false))
    }).catch(() => { setError('Auth error'); setLoading(false) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      if (user) load(user.uid)
      else { setError('Not authenticated'); setLoading(false) }
    })
    return unsub
  }, [load])

  // Wallet policy (Business Configuration): enabled gate + low-balance warning.
  const wallet     = useWalletConfig()
  const lowBalance = !!overview && wallet.showLowBalanceWarning && overview.balancePaise < wallet.lowBalanceThresholdPaise

  function handleAddSuccess(newBalancePaise: number) {
    setOverview(prev => prev ? { ...prev, balancePaise: newBalancePaise } : prev)
  }

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <PageHeader
        title="Wallet"
        subtitle="Manage your balance and track communication spend."
        action={
          <Button
            variant="gradient"
            size="md"
            disabled={!wallet.enabled}
            onClick={() => setShowAdd(true)}
          >
            <Plus className="size-4" aria-hidden />
            Add Funds
          </Button>
        }
      />

      {lowBalance && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertCircle className="size-4 shrink-0" />
          Your wallet balance is low. Add funds to keep communications running.
        </div>
      )}

      {/* ── KPI Cards ── */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-5 py-4 text-[14px] text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      ) : overview ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard
            icon={Wallet}
            label="Available Balance"
            value={formatCurrency(overview.balancePaise)}
            sub={`${(overview.balancePaise / 100).toFixed(2)} INR`}
            gradient="bg-gradient-to-br from-indigo-500 to-violet-600"
            action={
              <button
                onClick={() => setShowAdd(true)}
                className="flex items-center gap-1 rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-[12px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-3" />
                Add
              </button>
            }
          />
          <StatCard
            icon={Mail}
            label="Emails Sent"
            value={formatNumber(overview.emailsSent)}
            sub="this month"
            gradient="bg-gradient-to-br from-sky-500 to-blue-600"
          />
          <StatCard
            icon={MessageSquare}
            label="SMS Sent"
            value={formatNumber(overview.smsSent)}
            sub="this month"
            gradient="bg-gradient-to-br from-amber-500 to-orange-600"
          />
          <StatCard
            icon={MessagesSquare}
            label="WhatsApp Sent"
            value={formatNumber(overview.whatsappSent)}
            sub="this month"
            gradient="bg-gradient-to-br from-emerald-500 to-teal-600"
          />
          <StatCard
            icon={TrendingUp}
            label="This Month Spend"
            value={formatCurrency(overview.thisMonthSpendPaise)}
            sub={overview.thisMonthSpendPaise === 0 ? 'No charges yet' : 'communication cost'}
            gradient="bg-gradient-to-br from-rose-500 to-pink-600"
          />
        </div>
      ) : null}

      {/* ── Quick Nav ── */}
      <div>
        <h2 className="mb-3 text-[15px] font-semibold text-foreground">Quick Access</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <QuickLink href="/dashboard/wallet/transactions" label="Transaction History" />
          <QuickLink href="/dashboard/wallet/usage"        label="Communication Usage" />
        </div>
      </div>

      {/* ── Info strip ── */}
      <div className="rounded-xl border border-border bg-muted/30 px-5 py-4">
        <p className="text-[13px] font-medium text-foreground">About your wallet</p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Your wallet balance is used to pay for SMS, WhatsApp, and email communication charges.
          Top-ups are processed securely via Razorpay.
        </p>
      </div>

      {/* ── Add Funds Modal ── */}
      {showAdd && (
        <AddFundsModal
          onClose={()   => setShowAdd(false)}
          onSuccess={handleAddSuccess}
        />
      )}
    </div>
  )
}
