'use client'

// FinalCostSummary — the SINGLE source of truth for everything an organizer pays
// on the wizard's Review step (Phase F2.5).
//
// This component replaces the three overlapping panels the Review step used to
// render (the F2.1 "Payment summary", the "Registration Plan" slider, and the
// old "Billing Summary"). It performs NO payment and writes nothing — it reads
// the frozen Event License model + the live communication toggles passed down
// from the wizard and presents one consolidated, always-consistent breakdown.
//
// Pricing rules mirrored here (display only — the server recalculates):
//   • License fee  — one-time, per event; wallet-first, Razorpay for the remainder.
//   • Communication — pay-as-you-use. Paid events deduct from settlement; free
//     events deduct from the wallet before publishing.
//   • GST          — placeholder, not applied yet.

import {
  Wallet, CreditCard, CheckCircle2, Clock, Send, Globe,
  AlertTriangle, RefreshCw, MessageSquare, Smartphone, Award,
  Tag, X, Loader2,
} from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import {
  isUnlimited,
  type EventLicenseTier,
} from '@/lib/licensing/eventLicense'
import { useLicenseCatalog } from '@/lib/licensing/licenseCatalogClient'
import { auth } from '@/lib/firebase/auth'

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2,
})
const inr        = (rupees: number) => INR.format(rupees)
const fromPaise  = (paise: number) => INR.format(paise / 100)

export interface FinalCostSummaryProps {
  tier:               EventLicenseTier
  isFreeEvent:        boolean
  walletBalancePaise: number | null
  walletLoading:      boolean
  // License-coupon wiring (EA-4 S2 backend). `eventId` is the draft/event id used
  // by the preview API; `onCouponChange` reports the applied code to the parent so
  // it is sent to POST /api/licensing/purchase (the server re-validates + charges).
  eventId?:           string
  onCouponChange?:    (couponCode: string | null) => void
  // Live communication state — toggling these upstream re-renders this summary.
  whatsappEnabled:    boolean
  smsEnabled:         boolean
  certEnabled:        boolean
  whatsappCostRupees: number
  smsCostRupees:      number
  certCostRupees:     number
  // Free events with paid channels must top up before publishing.
  needsWalletCheck:   boolean
  walletReady:        boolean
  onAddFunds:         () => void
}

function Row({
  label, value, muted = false, strong = false,
}: {
  label: ReactNode; value: ReactNode; muted?: boolean; strong?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-[12.5px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(
        strong ? 'font-bold text-foreground' : 'font-semibold',
        muted && !strong ? 'text-muted-foreground/40' : 'text-foreground',
      )}>{value}</span>
    </div>
  )
}

export function FinalCostSummary({
  tier, isFreeEvent, walletBalancePaise, walletLoading,
  whatsappEnabled, smsEnabled, certEnabled,
  whatsappCostRupees, smsCostRupees, certCostRupees,
  needsWalletCheck, walletReady, onAddFunds,
  eventId, onCouponChange,
}: FinalCostSummaryProps) {
  const catalog      = useLicenseCatalog()
  const def          = catalog[tier]
  const maxReg       = def.limits.maxRegistrations
  const regLimit     = isUnlimited(maxReg) ? 'Unlimited' : maxReg.toLocaleString('en-IN')

  // ── License payment (Pay Now) — wallet-first split, mirrors the purchase route.
  const payablePaise = def.contactSales ? null : def.licensePricePaise   // null = contact sales
  const balancePaise = walletBalancePaise ?? 0
  const payNowPaise  = payablePaise ?? 0
  const isPaid       = payNowPaise > 0

  // ── License coupon (preview only — the server re-validates + is authoritative) ──
  const [code, setCode]       = useState('')
  const [applied, setApplied] = useState<{ code: string; discountPaise: number; finalPricePaise: number } | null>(null)
  const [validating, setValidating] = useState(false)
  const [couponError, setCouponError] = useState('')

  const clearCoupon = useCallback(() => {
    setApplied(null); setCode(''); setCouponError(''); onCouponChange?.(null)
  }, [onCouponChange])

  // A coupon is tier-specific; reset it whenever the selected tier changes. Deferred
  // so the state update never runs synchronously inside the effect body.
  useEffect(() => {
    const t = setTimeout(() => { setApplied(null); setCode(''); setCouponError(''); onCouponChange?.(null) }, 0)
    return () => clearTimeout(t)
  }, [tier, onCouponChange])

  const applyCoupon = useCallback(async () => {
    const c = code.trim().toUpperCase()
    if (!c || !eventId) return
    setValidating(true); setCouponError('')
    try {
      const token = await auth.currentUser?.getIdToken()
      const res = await fetch('/api/licensing/coupons/validate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body:    JSON.stringify({ eventId, tier, couponCode: c }),
      })
      const j = await res.json() as { valid?: boolean; message?: string; discountPaise?: number; finalPricePaise?: number }
      if (!res.ok || !j.valid) { setCouponError(j.message ?? 'This coupon is not valid.'); return }
      setApplied({ code: c, discountPaise: j.discountPaise ?? 0, finalPricePaise: j.finalPricePaise ?? payNowPaise })
      onCouponChange?.(c)
    } catch {
      setCouponError('Could not validate the coupon. Please try again.')
    } finally {
      setValidating(false)
    }
  }, [code, eventId, tier, payNowPaise, onCouponChange])

  // Effective (discounted) amounts drive the display; the server recomputes on purchase.
  const effectivePayNow = applied ? applied.finalPricePaise : payNowPaise
  const walletUsed  = Math.min(balancePaise, effectivePayNow)
  const razorpayDue = Math.max(0, effectivePayNow - walletUsed)

  // ── Communication (pay-as-you-use) — informational, never part of Pay Now.
  const commRupees   =
    (whatsappEnabled ? whatsappCostRupees : 0) +
    (smsEnabled      ? smsCostRupees      : 0) +
    (certEnabled     ? certCostRupees     : 0)
  // ── Approval-flow timeline (display only). Free events skip the payment node.
  const timeline: Array<{ Icon: typeof Send; label: string; sub: string }> = [
    { Icon: CreditCard,   label: isPaid ? 'Payment' : 'No payment', sub: isPaid ? 'License fee collected' : 'Free license' },
    { Icon: Send,         label: 'Submitted',      sub: 'Event sent for review' },
    { Icon: Clock,        label: 'Pending Review', sub: 'Team verifies details' },
    { Icon: CheckCircle2, label: 'Approved',       sub: 'Cleared to go live' },
    { Icon: Globe,        label: 'Live',           sub: 'Public & taking registrations' },
  ]

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-4 sm:px-5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
          <Wallet className="size-4 text-primary" aria-hidden />
        </div>
        <div>
          <p className="text-[14px] font-bold tracking-tight text-foreground">Final Cost Summary</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">Everything you pay for this event</p>
        </div>
      </div>

      {/* ── License ── */}
      <div className="px-5 pt-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">License</p>
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-bold text-primary">{def.name}</span>
        </div>
        <div className="mt-1 divide-y divide-border/30">
          <Row label="License fee" value={def.contactSales ? 'Contact Sales' : isPaid ? fromPaise(def.licensePricePaise) : 'Free'} />
          <Row label="Registration limit" value={regLimit} />
        </div>
      </div>

      {/* ── Communication (pay-as-you-use) ── */}
      <div className="px-5 pt-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">Communication</p>
          <span className="text-[10px] font-medium text-muted-foreground/60">pay-as-you-use</span>
        </div>
        <div className="mt-1 divide-y divide-border/30">
          <Row
            label={<span className="inline-flex items-center gap-1.5"><MessageSquare className="size-3 text-muted-foreground/60" aria-hidden />WhatsApp</span>}
            value={whatsappEnabled ? inr(whatsappCostRupees) : 'Off'}
            muted={!whatsappEnabled}
          />
          <Row
            label={<span className="inline-flex items-center gap-1.5"><Smartphone className="size-3 text-muted-foreground/60" aria-hidden />SMS</span>}
            value={smsEnabled ? inr(smsCostRupees) : 'Off'}
            muted={!smsEnabled}
          />
          <Row
            label={<span className="inline-flex items-center gap-1.5"><Award className="size-3 text-muted-foreground/60" aria-hidden />Certificates</span>}
            value={certEnabled ? inr(certCostRupees) : 'Off'}
            muted={!certEnabled}
          />
        </div>
        <p className="pt-1.5 text-[11px] leading-relaxed text-muted-foreground/70">
          {isFreeEvent
            ? 'Charged from your wallet as messages are sent.'
            : 'Charged from event settlement as messages are sent — nothing upfront.'}
        </p>
      </div>

      {/* ── License coupon (paid licenses only) ── */}
      {isPaid && eventId && (
        <div className="px-5 pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">Coupon</p>
          {applied ? (
            <div className="mt-1 flex items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-800/40 dark:bg-emerald-950/30">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-emerald-700 dark:text-emerald-400">
                <Tag className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{applied.code} applied · −{fromPaise(applied.discountPaise)}</span>
              </span>
              <button type="button" onClick={clearCoupon} aria-label="Remove coupon"
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100 dark:text-emerald-400 dark:hover:bg-emerald-900/40">
                <X className="size-3.5" aria-hidden />Remove
              </button>
            </div>
          ) : (
            <div className="mt-1">
              <div className="flex items-center gap-2">
                <input
                  value={code}
                  onChange={e => { setCode(e.target.value.toUpperCase()); if (couponError) setCouponError('') }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void applyCoupon() } }}
                  placeholder="Have a coupon? Enter code"
                  aria-label="Coupon code"
                  className="h-9 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-[12.5px] font-semibold uppercase tracking-wide text-foreground placeholder:font-normal placeholder:normal-case placeholder:tracking-normal placeholder:text-muted-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15"
                />
                <button type="button" onClick={() => void applyCoupon()} disabled={!code.trim() || validating}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-[12.5px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50">
                  {validating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : 'Apply'}
                </button>
              </div>
              {couponError && (
                <p role="alert" className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-rose-600">
                  <AlertTriangle className="size-3 shrink-0" aria-hidden />{couponError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Total Pay Now ── */}
      <div className="mt-3 border-t border-border bg-muted/30 px-5 py-3.5">
        {/* Discount breakdown — original fee then the coupon reduction */}
        {applied && (
          <div className="mb-1.5 divide-y divide-border/30">
            <Row label="License fee" value={fromPaise(payNowPaise)} muted />
            <Row
              label={<span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400"><Tag className="size-3" aria-hidden />Coupon ({applied.code})</span>}
              value={<span className="text-emerald-700 dark:text-emerald-400">−{fromPaise(applied.discountPaise)}</span>}
            />
          </div>
        )}
        <div className="flex items-end justify-between">
          <div>
            <p className="text-[12px] font-semibold text-foreground">Total Pay Now</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {def.contactSales ? 'Custom pricing' : isPaid ? 'One-time license fee' : 'No payment required'}
            </p>
          </div>
          <span className={cn('text-[18px] font-extrabold tabular-nums', isPaid ? 'text-primary' : 'text-foreground')}>
            {def.contactSales ? 'Contact Sales' : isPaid ? fromPaise(effectivePayNow) : '₹0'}
          </span>
        </div>

        {/* Wallet + Razorpay split — only when there's a remaining fee to collect */}
        {effectivePayNow > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-border/60 bg-card px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Wallet className="size-3" aria-hidden />From wallet</p>
              <p className="mt-0.5 text-[13px] font-bold text-foreground">{fromPaise(walletUsed)}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-card px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><CreditCard className="size-3" aria-hidden />Via Razorpay</p>
              <p className="mt-0.5 text-[13px] font-bold text-foreground">{fromPaise(razorpayDue)}</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Wallet status — free events needing a top-up before publishing ── */}
      {needsWalletCheck && (
        <div className="border-t border-border px-5 py-3.5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">Wallet</p>
            {!walletLoading && (
              <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold',
                walletReady ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700')}>
                {walletReady ? 'Ready' : 'Top-up needed'}
              </span>
            )}
          </div>
          {walletLoading ? (
            <div className="flex items-center gap-2 py-1.5 text-[12px] text-muted-foreground">
              <RefreshCw className="size-3.5 animate-spin" aria-hidden />Checking balance…
            </div>
          ) : (
            <>
              <div className="divide-y divide-border/30">
                <Row label="Wallet balance" value={walletBalancePaise == null ? '—' : fromPaise(balancePaise)} />
                <Row label="Communication est." value={inr(commRupees)} />
              </div>
              {!walletReady && (
                <button
                  type="button"
                  onClick={onAddFunds}
                  className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-[12px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <AlertTriangle className="size-3.5" aria-hidden />Add funds to publish
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Approval flow timeline ── */}
      <div className="border-t border-border px-5 py-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">Approval flow</p>
        <ol className="relative flex flex-col gap-0">
          {timeline.map(({ Icon, label, sub }, i) => (
            <li key={label} className="relative flex gap-3 pb-3.5 last:pb-0">
              {i < timeline.length - 1 && (
                <span className="absolute left-[11px] top-6 h-full w-px bg-border/60" aria-hidden />
              )}
              <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card">
                <Icon className="size-3 text-muted-foreground" aria-hidden />
              </span>
              <div className="min-w-0 pt-0.5">
                <p className="text-[12px] font-semibold text-foreground">{label}</p>
                <p className="text-[11px] text-muted-foreground">{sub}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
