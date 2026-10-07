'use client'

// The COMMUNICATION BALANCE card (organizerWallets) with the EXISTING top-up flow — moved here
// unchanged from the Wallet page (2026-10-02), which became event-wise and no longer funds anything.
// The balance pays for broadcasts, WhatsApp beyond a prepaid allowance and pay-as-you-go
// certificates; event capacity and prepaid services are bought per event (Wallet › Increase Limit).
//
// The modal below is the previous Wallet page's AddFundsModal, verbatim: same routes
// (/api/organizer/wallet/topup → Razorpay → /topup/verify), same shared outcome classifier, same
// "paid but not credited" hold handling — nothing about how money moves changed.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { useAuth } from '@/components/auth/AuthProvider'
import { Wallet, Plus, X, Loader2, CheckCircle2, AlertCircle, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Button, Card } from '@/components/ui'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import { useWalletConfig } from '@/lib/wallet/walletConfigClient'
import {
  classifyTopupVerifyResponse, describeTopupHold, TOPUP_OUTCOME_MESSAGES,
  type TopupHoldTone, type TopupVerifyOutcome,
} from '@/lib/wallet/topupVerifyOutcome'
import type { WalletOverview } from '@/lib/wallet/types'

function formatCurrency(paise: number): string {
  const r = paise / 100
  if (r >= 10_00_000) return `₹${(r / 10_00_000).toFixed(1)}L`
  if (r >= 1_000)     return `₹${(r / 1_000).toFixed(1)}K`
  return `₹${r.toFixed(0)}`
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

export function AddFundsModal({
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
  // RD-WALLET-W2.c — paid but not credited: what to tell the organizer (and never "pay again").
  const [hold,     setHold]      = useState<{ tone: TopupHoldTone; message: string; paymentId: string | null } | null>(null)

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

      // 3. Verify on the server (signature + amount + credit). RD-WALLET-W2.c — read through the
      // shared classifier (the same rules as the event wizard): only an explicit success is
      // "credited"; every other outcome after payment is a hold with a truthful message. A network
      // failure or an unreadable body here means the payment could not be confirmed.
      let outcome: TopupVerifyOutcome
      try {
        const verifyRes = await fetch('/api/organizer/wallet/topup/verify', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body:    JSON.stringify({
            orderId:   result.razorpay_order_id,
            paymentId: result.razorpay_payment_id,
            signature: result.razorpay_signature,
          }),
        })
        const body = await verifyRes.json().catch(() => null) as Parameters<typeof classifyTopupVerifyResponse>[1]
        outcome = classifyTopupVerifyResponse(verifyRes.status, body)
      } catch {
        outcome = { kind: 'unconfirmed', message: TOPUP_OUTCOME_MESSAGES.unconfirmed }
      }

      if (outcome.kind === 'credited') {
        const newBalance = outcome.newBalance
        setPhase('success')
        setTimeout(() => { onSuccess(newBalance); onClose() }, 1200)
        return
      }
      if (outcome.kind === 'failed') throw new Error(outcome.message)
      const presentation = describeTopupHold(outcome)
      setHold({
        tone: presentation.tone, message: presentation.message,
        paymentId: typeof result.razorpay_payment_id === 'string' && result.razorpay_payment_id ? result.razorpay_payment_id : null,
      })
      setPhase('pending')   // paid, not credited: Close only — never another payment from here
      return
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
        ) : phase === 'pending' && hold ? (
          <div className="space-y-3">
            <div role="status" className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-[13px] font-medium text-amber-700">
              {hold.tone === 'awaiting_credit'
                ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
                : <AlertCircle className="mt-0.5 size-4 shrink-0" />}
              <span>{hold.message}</span>
            </div>
            {hold.paymentId && (
              <p className="text-center text-[12px] text-muted-foreground">
                Payment reference: <span className="font-mono text-foreground">{hold.paymentId}</span>
              </p>
            )}
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


// ─── Card ─────────────────────────────────────────────────────────────────────

export function CommunicationBalanceCard() {
  const [overview, setOverview] = useState<WalletOverview | null>(null)
  const [error,    setError]    = useState<string | null>(null)
  const [showAdd,  setShowAdd]  = useState(false)
  const wallet = useWalletConfig()
  const { user } = useAuth()

  const load = useCallback(async () => {
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) return
      const r = await fetch('/api/organizer/wallet/overview', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      const data = await r.json().catch(() => null) as { success?: boolean; overview?: WalletOverview; error?: string } | null
      if (data?.success && data.overview) { setOverview(data.overview); setError(null) } else setError(data?.error ?? 'Could not load the balance.')
    } catch { setError('Network error — please try again.') }
  }, [])
  useEffect(() => {
    if (!user) return
    const t = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(t)
  }, [user, load])

  const lowBalance = !!overview && wallet.showLowBalanceWarning && overview.balancePaise < wallet.lowBalanceThresholdPaise
  const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <Card id="communication-balance" variant="elevated" padded={false} className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600" aria-hidden>
            <Wallet className="size-5 text-white" />
          </div>
          <div>
            <p className="text-[13px] font-medium text-muted-foreground">Communication balance</p>
            <p className="text-[24px] font-bold leading-tight tracking-tight text-foreground">{overview ? rupees(overview.balancePaise) : error ? '—' : '…'}</p>
            {overview && <p className="text-[12.5px] text-muted-foreground">{rupees(overview.thisMonthSpendPaise)} spent this month</p>}
          </div>
        </div>
        <Button variant="gradient" size="md" disabled={!wallet.enabled} onClick={() => setShowAdd(true)}>
          <Plus className="size-4" aria-hidden />Add funds
        </Button>
      </div>
      {error && <p className="flex items-center gap-2 text-[13px] text-destructive"><AlertCircle className="size-4" />{error}</p>}
      {lowBalance && (
        <p className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
          <AlertCircle className="size-4 shrink-0" />Your communication balance is low. Add funds to keep pay-as-you-go messages running.
        </p>
      )}
      <p className="text-[12.5px] text-muted-foreground">
        Pays for broadcasts, WhatsApp messages beyond an event&apos;s prepaid allowance and pay-as-you-go certificates. Email is free.
        Event capacity and prepaid services are bought per event from the Wallet.
      </p>
      <div className="flex flex-wrap gap-2">
        {[['Transaction history', '/dashboard/wallet/transactions'], ['Communication usage', '/dashboard/wallet/usage']].map(([label, href]) => (
          <Link key={href} href={href} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted">
            {label}<ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
          </Link>
        ))}
      </div>
      {showAdd && (
        <AddFundsModal
          onClose={() => setShowAdd(false)}
          onSuccess={b => setOverview(prev => (prev ? { ...prev, balancePaise: b } : prev))}
        />
      )}
    </Card>
  )
}
