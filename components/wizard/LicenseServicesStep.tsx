'use client'

// RD-EVENT-COMMERCE-03 · LICENSE & SERVICES — ONE page for every commercial choice and the
// payment for it, for a new draft AND for an already-submitted event. Nothing about capacity,
// services, cost or payment lives on another step, page or dashboard tab.
//
//   1 Registration capacity   draft: the activation target · submitted: a new target for the LIVE
//                             event, measured from the enforced capacity, never below sold
//   2 WhatsApp messages       the WhatsApp switch; ON reveals the prepaid allowance panel
//   3 Email notifications     included
//   4 SMS notifications       unavailable (no transport)
//   5 Certificates            the certificates switch; ON reveals the prepaid allowance panel
//   6 Photo storage            the event's PAID photo capacity (no free photos; max 3,000 per event)
//   7 Cost summary            ONE itemized server quote (/api/licensing/checkout/quote)
//   8 Payment                 one Razorpay payment, verified server-side (ActivationPaymentPanel)
//   + ID badges (published events only) — RD-PRINT-BILL-P6: a SEPARATE purchase with its own Pay
//                             button (BadgeUnitsPurchasePanel); never part of the cost summary above.
//
// The organizer controls QUANTITIES; RegisterDesk controls rates, ranges, GST and the quote. A
// prepaid service that is not configured for sale is shown with its controls disabled and
// "awaiting configuration" — never priced, never included.
//
// Draft mode: Continue to Review only when the server reports the selection fully paid (or free).
// Submitted mode: purchases are optional top-ups; Review (Save Changes) is always reachable.
//
// RD-EVENT-COMMERCE-05E — submitted mode starts LOCKED: one read-only panel shows what the event
// actually has (server records: enforced capacity + sold counter, allowance ledgers, media usage).
// ONE "Unlock to edit" reveals every quantity control; ONE "Cancel" discards the pending selection
// and re-locks. The fixed footer holds the ONE primary action (Unlock to edit / Pay ₹X via
// Razorpay / Done); the payment panel keeps status, Refresh status and history but no pay button.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, CheckCircle2, Mail, MessageSquare, Smartphone, Award, Image as ImageIcon, Info, Globe, Clock, ExternalLink, ShoppingCart, Lock, Pencil } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils/cn'
import { auth } from '@/lib/firebase/auth'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import {
  SERVICE_KINDS, EMPTY_SELECTION, type ServiceKind, type ServiceSelection,
} from '@/lib/licensing/serviceAllowances'
import { isSubmittedDraftStatus } from '@/lib/events/builder/stepRegistry'
import { EASE } from '@/lib/events/builder/constants'
import type { WizardStep } from '@/lib/events/builder/types'
import { ROUTES } from '@/config/navigation'
import { Stepper } from '@/components/event-builder/Stepper'
import { WizardFooter } from '@/components/wizard/WizardFooter'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/Toast'
import { readIntent, clearIntent, returnLabelFor, type PurchaseIntent } from '@/lib/wallet/purchaseIntent'
import { CapacitySelector } from '@/components/wizard/CapacitySelector'
import { ServiceQuantitySelector, SALE_STATE_BADGE } from '@/components/wizard/ServiceQuantitySelector'
import { LicenseCostSummary, type CheckoutQuoteResponse } from '@/components/wizard/LicenseCostSummary'
import { ActivationPaymentPanel, type PayOutcome } from '@/components/wizard/ActivationPaymentPanel'
import { BadgeUnitsPurchasePanel } from '@/components/wizard/BadgeUnitsPurchasePanel'
import type { PublishAgreementInput } from '@/lib/legal/organizerAgreement'
import { CAPACITY_FIGURE_LABELS, capacityBreakdown } from '@/lib/communications/capacityFigures'

export interface PaygServiceFlags { whatsappEnabled: boolean; smsEnabled: boolean; certEnabled: boolean }

export interface LicenseServicesStepProps {
  currentStep:      number
  completedValues:  (string | undefined)[]
  onNext:           (label?: string, data?: unknown) => void
  onBack:           () => void
  steps:            WizardStep[]
  selectedCapacity: number
  onSelectCapacity: (capacity: number) => void
  /**
   * RD-CAPACITY-DEFAULT — draft mode: reports, from the server quote, whether the draft's capacity is
   * still governed by a verified historical paid tier (true) or not (false). The page persists the
   * free default only after hearing false.
   */
  onLegacyEntitlement?: (legacy: boolean) => void
  initialServiceSelection:  ServiceSelection
  onServiceSelectionChange: (selection: ServiceSelection) => void
  onSettle?:        () => Promise<boolean>
  pricing:          Record<string, unknown> | null
  /**
   * RD-LICENSE-LOCK-02 — persists the service flags.
   *
   * For a SUBMITTED event this is an authenticated server call that writes the draft and the
   * live document together; for an unpublished draft it is the direct draft write it always was.
   * Resolves FALSE when nothing was saved, so the caller restores the previous switch state
   * rather than leaving the UI asserting a flag the server never accepted.
   */
  onServicesChange: (values: PaygServiceFlags) => Promise<boolean>
  /** Server-written draft status (clients cannot write it). */
  draftStatus:      string | null
  draftId:          string | null
  /**
   * RD-EVENT-COMMERCE-05B — License & Services is the FINAL new-event step. When set, the step is
   * EMBEDDED in the submission view: it renders no footer and no pay button of its own, and reports
   * its live, server-quoted payment context (plus an awaitable pay()) through `onContext`, so the
   * final "Pay & Submit Event" / "Submit Event" action can drive payment then submission.
   */
  embeddedFinal?:   { onContext: (ctx: FinalPayContext) => void }
  /**
   * RD-EVENT-COMMERCE-05D — the ONE live-status banner of the published-event wizard lives here
   * (moved off Review). `publicHref` is the event's canonical public URL, or null when unknown.
   */
  liveStatus?:      { publicHref: string | null }
  /**
   * RD-REVIEW-02 — the event's server-written lifecycle. `draftStatus` alone reads 'pending_review'
   * for an event whose changes were requested or that was closed, so the banner and its actions
   * follow this instead. Purchases for a closed event are refused by the server regardless.
   */
  lifecycle?:       { status: string | null; reviewClosed: boolean }
}

/** RD-EVENT-COMMERCE-05B — what the final action needs to know about the payment. */
export interface FinalPayContext {
  /** The server quote matches the current selection and nothing is being re-quoted. */
  quoteReady:   boolean
  /** Nothing payable now: free, or already paid (server's coverage-aware quote). */
  covered:      boolean
  /** Amount payable now (paise), when quoted. */
  payablePaise: number | null
  /** Why the selection cannot be paid for / submitted, when it cannot. */
  blockedReason: string | null
  /** Starts the Razorpay checkout; resolves from the SERVER's verification only. */
  pay:          (agreement?: PublishAgreementInput) => Promise<PayOutcome>
  /** Re-reads the coverage-aware quote (after a payment / failed submission). */
  refresh:      () => void
  /**
   * RD-LICENSE-LOCK-01 — true while a SUBMITTED event's purchase surface is read-only
   * (before "Unlock to edit"). Reported upward because the final step renders ONE control
   * outside this component — the Fee Collection Method — which must obey the same lock.
   * Always false for an unpublished draft, which is never locked.
   */
  locked:       boolean
  /**
   * RD-PUBLISH-PLAN — the server quote for the CURRENT selection (null while re-quoting or when it
   * does not match), and the organizer's service switches. The publish confirmation lists the plan
   * from these; it never prices anything itself.
   */
  quote:        CheckoutQuoteResponse | null
  payg:         PaygServiceFlags
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn('relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-muted-foreground/25')}>
      <span className={cn('inline-block size-5 rounded-full bg-white shadow-sm transition-transform duration-200', checked ? 'translate-x-5' : 'translate-x-0')} />
    </button>
  )
}

function ServiceCard({ icon: Icon, title, badge, description, control, children, open, anchor }: {
  icon: React.ElementType; title: string; badge: React.ReactNode; description: React.ReactNode
  control?: React.ReactNode; children?: React.ReactNode; open?: boolean
  /** Scroll target for the Wallet's "Increase Limit" hand-off. */
  anchor?: string
}) {
  return (
    <div id={anchor} className="scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-start gap-3.5 px-4 py-4 sm:px-5">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/[0.08]">
          <Icon className="size-4 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13.5px] font-semibold text-foreground">{title}</p>
            {badge}
          </div>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</div>
        </div>
        {control}
      </div>
      <AnimatePresence initial={false}>
        {open && children && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
            <div className="border-t border-border/50 bg-muted/[0.15] px-3 py-3 sm:px-4 sm:py-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const Badge = ({ tone, children }: { tone: 'ok' | 'muted' | 'warn' | 'opt'; children: React.ReactNode }) => (
  <span className={cn('rounded-full px-2 py-0.5 text-[11.5px] font-semibold',
    tone === 'ok' ? 'bg-emerald-100 text-emerald-700' : tone === 'warn' ? 'bg-muted text-muted-foreground' : tone === 'opt' ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground')}>{children}</span>
)

// RD-COMMS-P1 — one rule for every allowance: when it is used up, nothing more is sent until more
// capacity is bought here. (A stored 'wallet_payg' no longer creates a pay-as-you-go charge.)
const EXHAUSTED_TEXT = 'When it is used up, nothing more is sent (each is recorded in the communication log) until you buy more here.'
const EXHAUSTION_TEXT: Record<string, string> = { block: EXHAUSTED_TEXT, wallet_payg: EXHAUSTED_TEXT }

export function LicenseServicesStep({
  currentStep, completedValues, onNext, onBack, steps, selectedCapacity, onSelectCapacity, onLegacyEntitlement,
  initialServiceSelection, onServiceSelectionChange, onSettle, pricing, onServicesChange, draftStatus, draftId, embeddedFinal, liveStatus, lifecycle,
}: LicenseServicesStepProps) {
  const isSubmitted     = isSubmittedDraftStatus(draftStatus)
  // ── RD-EVENT-COMMERCE-05E · locked by default (submitted events) ──────────────────────
  //
  // RD-LICENSE-LOCK-01 moved this ABOVE the handlers rather than leaving it beside the purchase
  // state below. `setFlag` now refuses while locked, and a `const` read by a callback declared
  // earlier in the body defeats the React Compiler's analysis — it answers "Compilation Skipped:
  // Existing memoization could not be preserved" and drops memoization for the whole component,
  // which on this step means re-rendering the quote panel on every keystroke.
  const [editing, setEditing] = useState(false)
  const locked = isSubmitted && !editing
  const isPendingReview = draftStatus === 'pending_review'
  // RD-REVIEW-02 — a closed review is final: no purchase is offered (the server refuses one anyway).
  const reviewClosed     = lifecycle?.reviewClosed === true
  const changesRequested = !reviewClosed && lifecycle?.status === 'changes_requested'
  const mode: 'draft' | 'published' = isSubmitted ? 'published' : 'draft'

  // Draft: the activation target + TOTAL service units (persisted on the draft as intent).
  // Submitted: a new capacity TARGET for the live event + ADDITIONAL units (never persisted).
  const [capacity, setCapacity]   = useState<number>(selectedCapacity)
  const [target, setTarget]       = useState<number | null>(null)
  const [selection, setSelection] = useState<ServiceSelection>(isSubmitted ? { ...EMPTY_SELECTION } : initialServiceSelection)
  const [payg, setPayg] = useState<PaygServiceFlags>(() => ({
    whatsappEnabled: pricing?.whatsappEnabled === true,
    smsEnabled:      pricing?.smsEnabled      === true,
    certEnabled:     pricing?.certEnabled     === true,
  }))
  const [mediaOpen, setMediaOpen] = useState<boolean>(initialServiceSelection.media > 0)

  const setFlag = (field: keyof PaygServiceFlags, value: boolean) => {
    // RD-LICENSE-LOCK-01 · the lock enforced at the WRITE, not only on each control.
    //
    // Two switches shipped without `disabled={locked}` and persisted straight through here, so
    // the one disabled attribute per control was never a sufficient guard — a third control
    // added later would have the same hole. `setQty` already refuses for a submitted event on
    // the same principle (`if (!isSubmitted)`); this is its flag equivalent.
    //
    // RD-LICENSE-LOCK-02 · for a submitted event the write now goes through PATCH /edit, which
    // re-checks the caller and the event's ownership server-side. This client guard stays as the
    // affordance's own backstop; it is no longer the only thing standing between a flipped
    // switch and a persisted flag.
    if (locked) return
    const previous = payg
    const next = { ...payg, [field]: value }   // the full set every time — no stale merge
    setPayg(next)
    void (async () => {
      const saved = await onServicesChange(next)
      if (!saved) {
        // Nothing was persisted — restore the switch rather than show a service as on when the
        // server does not have it. Quantities below are untouched on this path.
        setPayg(previous)
        showToast('That service setting could not be saved. Nothing was changed — please try again.', 'error')
      }
    })()
    // Switching a service OFF collapses its panel and stops buying it. Anything already
    // purchased (and its usage) is untouched — it lives in the server ledger, not here.
    if (!value && field === 'whatsappEnabled') setQty('whatsapp', 0)
    if (!value && field === 'certEnabled') setQty('certificates', 0)
  }
  function setQty(k: ServiceKind, n: number) {
    const next = { ...selection, [k]: n }
    setSelection(next)
    if (!isSubmitted) onServiceSelectionChange(next)
  }

  // ── The ONE server quote (debounced) ─────────────────────────────────────────────
  const [quote, setQuote]     = useState<CheckoutQuoteResponse | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [lastCurrent, setLastCurrent] = useState<number | null>(null)
  const effectiveCapacity = isSubmitted ? target : capacity
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      void (async () => {
        setQuoting(true)
        try {
          const token = await auth.currentUser?.getIdToken()
          if (!token) return
          const res = await fetch('/api/licensing/checkout/quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ eventId: draftId, ...(effectiveCapacity !== null ? { capacity: effectiveCapacity } : {}), services: selection }),
          })
          const data = await res.json() as CheckoutQuoteResponse & { error?: string }
          if (!alive) return
          if (res.ok) { setQuote(data); setNetworkError(null) } else { setQuote(null); setNetworkError(data.error ?? 'Could not price this selection.') }
        } catch {
          if (alive) { setQuote(null); setNetworkError('Could not reach the pricing service. Check your connection and try again.') }
        } finally { if (alive) setQuoting(false) }
      })()
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [effectiveCapacity, selection, draftId, refreshKey])

  const legacyVerdict = quote && quote.mode === 'draft' ? quote.legacyEntitlement != null : null
  useEffect(() => { if (legacyVerdict !== null) onLegacyEntitlement?.(legacyVerdict) }, [legacyVerdict, onLegacyEntitlement])

  // Submitted events start at — and after every purchase return to — the ENFORCED capacity.
  const current = quote?.published?.currentCapacity ?? null
  if (isSubmitted && current !== null && current !== lastCurrent) {
    setLastCurrent(current)
    setTarget(current)
  }
  // RD-EVENT-COMMERCE-05E — a server-side payment change only RE-READS the quote. The pending
  // selection is cleared only by a VERIFIED payment (payPurchase) or by a grant observed below —
  // never by a failed / cancelled / unverified attempt, so the organizer can simply retry.
  const onSettled = useCallback(() => { setRefreshKey(k => k + 1) }, [])

  const [purchaseStage, setPurchaseStage] = useState<'paying' | null>(null)
  const purchaseInFlight = useRef(false)
  // What the event HAS (capacity + purchased units). When it changes after the first read — a
  // payment verified here, via Refresh status, or elsewhere — the pending selection is spent:
  // clear it and re-lock, so the same units can never be offered (and charged) twice.
  const grantKey = isSubmitted && quote?.coverage && current !== null
    ? [current, ...SERVICE_KINDS.map(k => quote.coverage!.purchased[k])].join('|') : null
  const [lastGrantKey, setLastGrantKey] = useState<string | null>(null)
  // The Wallet's "Increase Limit" hand-off (lib/wallet/purchaseIntent) — read after mount.
  const [walletIntent, setWalletIntent] = useState<PurchaseIntent | null>(null)
  const [returnAfterPurchase, setReturnAfterPurchase] = useState<string | null>(null)
  if (grantKey !== null && grantKey !== lastGrantKey) {
    if (lastGrantKey !== null) { setSelection({ ...EMPTY_SELECTION }); setEditing(false) }
    // A purchase was VERIFIED and applied (the grant changed): back to the same event's Wallet.
    if (lastGrantKey !== null && walletIntent) setReturnAfterPurchase(walletIntent.returnTo)
    setLastGrantKey(grantKey)
  }
  const intentApplied = useRef(false)
  useEffect(() => {
    const t = setTimeout(() => {
      const i = readIntent(draftId)
      setWalletIntent(i)
      // Published events start locked: open the purchase controls and bring the service into view.
      if (!i || !isSubmitted || intentApplied.current) return
      intentApplied.current = true
      setEditing(true)
      setTimeout(() => {
        const id = i.service && i.service !== 'registrations' ? `license-service-${i.service}` : 'license-capacity-heading'
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 150)
    }, 0)
    return () => clearTimeout(t)
  }, [draftId, isSubmitted])
  const unlockAndFocus = useCallback(() => {
    setEditing(true)
    // After the controls render: bring the capacity control into view and focus it.
    setTimeout(() => {
      document.getElementById('license-capacity-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      document.getElementById('capacity-input')?.focus({ preventScroll: true })
    }, 60)
  }, [])
  /** Discards ONLY the pending purchase selection. Writes nothing, anywhere. */
  const cancelEditing = useCallback(() => {
    if (purchaseInFlight.current) return
    setSelection({ ...EMPTY_SELECTION })
    setTarget(current)
    setEditing(false)
  }, [current])

  const quoteMatches = !!quote && quote.capacity.ok && (isSubmitted ? target !== null && quote.capacity.quote.capacity === target : quote.capacity.quote.capacity === capacity)
  const payable = quoteMatches ? quote!.payable : null
  const [couponCode, setCouponCode]   = useState<string | null>(null)
  const [payNowPaise, setPayNowPaise] = useState<number | null>(null)
  const blockedReason = networkError
    ?? (quote && !quote.capacity.ok ? quote.capacity.error : null)
    ?? (quote ? (SERVICE_KINDS.map(k => { const r = quote.services[k]; return r.ok ? null : r.error }).find(e => e !== null) ?? null) : null)
    ?? (quote?.published && !quote.published.eligible ? 'This event is no longer live, so nothing can be bought for it.' : null)

  const canContinue = isSubmitted || (quoteMatches && !quoting && payable?.kind === 'covered')

  // ── RD-EVENT-COMMERCE-05B · final-step context (embedded in the submission view) ─────────
  const payRef = useRef<((agreement?: PublishAgreementInput) => Promise<PayOutcome>) | null>(null)
  const registerPay = useCallback((fn: (agreement?: PublishAgreementInput) => Promise<PayOutcome>) => { payRef.current = fn }, [])
  // RD-EVENT-COMMERCE-05E — a submitted event's ONE purchase action (fixed footer). The outcome
  // comes from the SERVER's verification only; anything but 'paid' leaves the selection for retry.
  const payPurchase = useCallback(async () => {
    if (purchaseInFlight.current || !payRef.current) return
    purchaseInFlight.current = true
    setPurchaseStage('paying')
    const outcome = await payRef.current()
    purchaseInFlight.current = false
    setPurchaseStage(null)
    if (outcome === 'paid') {
      setSelection({ ...EMPTY_SELECTION })
      setEditing(false)
      setRefreshKey(k => k + 1)
    }
  }, [])
  // RD-EVENT-COMMERCE-05F — the final step hands over the Publish Agreement; the panel sends it.
  const payViaPanel = useCallback((agreement?: PublishAgreementInput): Promise<PayOutcome> => (payRef.current ? payRef.current(agreement) : Promise.resolve<PayOutcome>('failed')), [])
  const refreshQuote = useCallback(() => setRefreshKey(k => k + 1), [])
  const finalOnContext = embeddedFinal?.onContext
  const ctxReady = quoteMatches && !quoting && payable !== null
  const ctxCovered = ctxReady && payable?.kind === 'covered'
  const ctxPayable = ctxReady ? (payNowPaise ?? payable?.totalPaise ?? null) : null
  useEffect(() => {
    finalOnContext?.({ quoteReady: ctxReady, covered: ctxCovered, payablePaise: ctxPayable, blockedReason, pay: payViaPanel, refresh: refreshQuote, locked,
      quote: ctxReady ? quote : null, payg })
  }, [finalOnContext, ctxReady, ctxCovered, ctxPayable, blockedReason, payViaPanel, refreshQuote, locked, quote, payg])
  const router = useRouter()
  const { showToast } = useToast()
  useEffect(() => {
    if (!returnAfterPurchase) return
    clearIntent()
    router.push(returnAfterPurchase)
  }, [returnAfterPurchase, router])


  const selectCapacity = (n: number) => {
    if (isSubmitted) { setTarget(n); return }
    setCapacity(n); onSelectCapacity(n)
  }
  const handleNext = () => {
    if (!canContinue) return
    if (!isSubmitted) { onSelectCapacity(capacity); onServiceSelectionChange(selection) }
    onNext(`${(isSubmitted ? (current ?? selectedCapacity) : capacity).toLocaleString('en-IN')} registrations`, capacity)
  }

  const coverage = quote?.coverage ?? null
  const item  = (k: ServiceKind) => { const s = quote?.services[k]; return s && s.ok ? s.item : null }
  const error = (k: ServiceKind) => { const s = quote?.services[k]; return s && !s.ok ? s.error : null }
  const policy = (k: ServiceKind) => { const p = quote?.catalog[k]?.onExhausted; return p ? ` ${EXHAUSTION_TEXT[p]}` : '' }
  const qtyMode = isSubmitted ? 'additional' as const : 'total' as const
  const sectionHeading = 'mb-2.5 text-[15px] font-bold tracking-tight text-foreground'
  // RD-PHOTO-01 — paid photo capacity only (no free base), at most 3,000 per event (server figures).
  const mediaCapacity = quote?.media.capacity ?? null
  const mediaUsed = quote?.media.used ?? null
  const mediaMaxTotal = quote?.media.maxTotal ?? 3000
  // The selector's ceiling: published = ADDITIONAL units (3,000 − capacity); draft = the TOTAL bought
  // here, so units already bought on this event count toward it.
  const mediaCeiling = quote ? (isSubmitted ? quote.media.maxAdditional : quote.media.maxAdditional + quote.media.purchased) : mediaMaxTotal

  // ── RD-EVENT-COMMERCE-05E · the submitted event's footer: exactly ONE primary action ─────
  // ── RD-LICENSE-ZEROCAP-01 · a service that cannot possibly run is switched OFF on Done ──────
  //
  // An organizer could leave this step with WhatsApp ON, nothing bought and nothing left to send
  // with. The switch said the service was on; every send would then fail for want of capacity.
  // Done saves nothing of its own (it is a navigation), so the stale ON had already been written
  // the moment the switch was flipped — which is why the correction happens here rather than in
  // a save handler.
  //
  // Three deliberate limits:
  //   • it fires ONLY on a service with zero USABLE capacity AND zero additional selected. A
  //     service with an existing allowance stays on, whatever the purchase quantity is.
  //   • it needs real coverage data. `coverage` is null while the quote is loading or after a
  //     network error, and treating that as "no capacity" would switch a working service off
  //     because a request failed — so an absent quote changes nothing.
  //   • it touches the FLAG only. Purchased capacity, the allowance ledger and every billing
  //     record are server-side and are not read or written here.
  //
  // Photos are deliberately absent: `mediaOpen` is local UI state derived from the pending
  // selection, not a persisted flag, so there is no stored "photos on" to contradict.
  //
  // It runs even while locked, on purpose: this is a correction of an impossible state, not an
  // organizer edit, and leaving it uncorrected is what produces failed sends.
  const goDone = () => {
    if (!coverage) { router.push(ROUTES.DASHBOARD_EVENTS); return }

    const off: string[] = []
    const next = { ...payg }
    if (payg.whatsappEnabled && (coverage.remaining.whatsapp ?? 0) <= 0 && selection.whatsapp <= 0) {
      next.whatsappEnabled = false
      off.push('WhatsApp notifications')
    }
    if (payg.certEnabled && (coverage.remaining.certificates ?? 0) <= 0 && selection.certificates <= 0) {
      next.certEnabled = false
      off.push('Participation certificates')
    }
    if (off.length === 0) { router.push(ROUTES.DASHBOARD_EVENTS); return }

    // RD-LICENSE-LOCK-02 · AWAIT the persist before navigating.
    //
    // The correction must reach the LIVE document, because that is what every sender reads —
    // and for a submitted event `onServicesChange` is the authenticated PATCH that writes the
    // draft and the live event together. Navigating first (the previous shape) could abandon
    // that request mid-flight and leave the organizer on the events list believing WhatsApp was
    // off while the event still had it on.
    //
    // A failure navigates anyway: this is a correction, not an edit the organizer asked for, so
    // trapping them on the step would be worse than telling them it did not stick.
    setPayg(next)
    void (async () => {
      const saved = await onServicesChange(next)
      showToast(
        saved
          ? `${off.join(' and ')} switched off — there is no capacity left to use, and none was added. Buy capacity here to switch it back on.`
          : `${off.join(' and ')} has no capacity left, but the change could not be saved. Open License & Services and switch it off, or buy capacity.`,
        saved ? 'info' : 'error',
      )
      if (!saved) setPayg(payg)
      router.push(ROUTES.DASHBOARD_EVENTS)
    })()
  }
  const fm = submittedPurchaseFooter({
    locked, paying: purchaseStage !== null, quoting, quoteReady: ctxReady,
    payableKind: payable?.kind ?? null, payablePaise: ctxPayable, blocked: !!blockedReason,
    eligible: !quote?.published || quote.published.eligible,
  })
  // A closed event's only action is leaving — `goDone` would try to save PAYG switches the server
  // now refuses for a closed event.
  const submittedFooter = reviewClosed ? {
    label: 'Done', disabled: false, onNext: () => router.push(ROUTES.DASHBOARD_EVENTS), secondary: undefined,
  } : {
    label:    fm.label,
    disabled: fm.disabled,
    onNext:   fm.primary === 'unlock' ? unlockAndFocus
            : fm.primary === 'pay' || fm.primary === 'apply' ? () => { void payPurchase() }
            : fm.primary === 'done' ? goDone
            : () => undefined,
    secondary: fm.secondary === 'done'
      ? { label: 'Done', onClick: goDone, arrow: false }
      : { label: 'Cancel', onClick: cancelEditing, disabled: fm.secondaryDisabled, arrow: false },
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }} className="flex min-h-full flex-col">
      <Link href={ROUTES.DASHBOARD}
        className="mb-5 inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <ArrowLeft className="size-4" aria-hidden />Back to Dashboard
      </Link>

      <Stepper currentStep={currentStep} completedValues={completedValues} steps={steps} />

      <div className="mt-6">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">License &amp; Services</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {reviewClosed
            ? 'The capacity and services purchased for this event.'
            : isSubmitted
            ? 'Buy more capacity or prepaid services for this event. Changes apply only after RegisterDesk verifies the payment.'
            : 'Choose your registration capacity and services, check the exact cost, then pay and publish — all on this page.'}
        </p>
      </div>

      {/* RD-EVENT-COMMERCE-05D — the published / pending event's status: ONE banner, at the top of the
          final step (it used to sit at the bottom of Review). Purchases here ADD to this event. */}
      {isSubmitted && liveStatus && (
        // RD-REVIEW-02 — a review-closed event gets the same ONE banner in a neutral tone, with no purchase action.
        <div role="status" className={cn('mt-4 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3.5 shadow-sm',
          reviewClosed ? 'border-border bg-muted/50' : isPendingReview ? 'border-amber-200/70 bg-amber-50/60' : 'border-emerald-200/60 bg-emerald-50/60')}>
          <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', reviewClosed ? 'bg-muted' : isPendingReview ? 'bg-amber-100' : 'bg-emerald-100')}>
            {reviewClosed ? <Lock className="size-4 text-muted-foreground" aria-hidden />
              : isPendingReview ? <Clock className="size-4 text-amber-600" aria-hidden /> : <Globe className="size-4 text-emerald-600" aria-hidden />}
          </div>
          <div className="min-w-0 flex-1 basis-56">
            <p className={cn('text-[13.5px] font-bold', reviewClosed ? 'text-foreground' : isPendingReview ? 'text-amber-800' : 'text-emerald-800')}>
              {reviewClosed ? 'Event closed' : changesRequested ? 'Changes requested — update the event and resubmit' : isPendingReview ? 'Submitted — awaiting approval' : 'Event is Live'}
            </p>
            <p className={cn('text-[12px]', reviewClosed ? 'text-muted-foreground' : isPendingReview ? 'text-amber-700' : 'text-emerald-700')}>
              {reviewClosed
                ? 'This event’s review is closed, so capacity and services can no longer be bought for it. Purchases you already made are listed below.'
                : 'Buying capacity or services adds to this event — it doesn’t create a new event or republish it.'}
            </p>
          </div>
          {!reviewClosed && (
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {!isPendingReview && liveStatus.publicHref && (
              <Link href={liveStatus.publicHref} target="_blank" rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <ExternalLink className="size-3.5" aria-hidden />View Live
              </Link>
            )}
            <button type="button"
              // RD-EVENT-COMMERCE-05E — the same single unlock; the current selection is kept.
              onClick={unlockAndFocus}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <ShoppingCart className="size-3.5" aria-hidden />Buy capacity or services
            </button>
          </div>
          )}
        </div>
      )}

      {walletIntent && (
        <Link href={walletIntent.returnTo} onClick={() => clearIntent()}
          className="mt-4 inline-flex min-h-11 items-center gap-1.5 self-start rounded-lg px-1 text-[13px] font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {/* RD-PURCHASE-RETURN-01 — named after where it goes (Wallet / Certificates / Broadcasts). */}
          <ArrowLeft className="size-3.5" aria-hidden />{returnLabelFor(walletIntent.returnTo)}
        </Link>
      )}

      <div className="mt-5 grid flex-1 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {/* RD-EVENT-COMMERCE-05E — what this event ACTUALLY has, from server records only. */}
          {isSubmitted && (
            <PurchasedPanel
              editing={editing}
              capacity={quote?.published ? { total: quote.published.currentCapacity, used: quote.published.sold } : null}
              coverage={coverage}
              media={{ purchased: mediaCapacity, base: 0, used: mediaUsed }}
              unavailable={!quote && !quoting}
              closed={reviewClosed}
            />
          )}

          {/* 1 · Registration capacity (a submitted event: only while unlocked) */}
          {!locked && <section aria-labelledby="license-capacity-heading">
            <h2 id="license-capacity-heading" className={sectionHeading}>Registration capacity</h2>
            {isSubmitted && quote?.published && (
              <p className="mb-3 text-[12px] text-muted-foreground">
                Set the new total capacity. Only the increase is charged. It can’t go below the {quote.published.sold.toLocaleString('en-IN')} registrations already taken; a reduction follows the platform’s reduction charge and is never refunded.
              </p>
            )}
            {isSubmitted && target === null ? (
              <p className="rounded-xl border border-border bg-card p-5 text-[12.5px] text-muted-foreground">Loading this event’s capacity…</p>
            ) : (
              <>
              {!isSubmitted && (coverage?.paidCapacity ?? 0) > 0 && (
                <p className="mb-3 text-[12px] text-muted-foreground">
                  You’ve paid for {coverage!.paidCapacity!.toLocaleString('en-IN')} registrations, so capacity can’t go below that. Unused paid capacity can be refunded from the Wallet after the event closes.
                </p>
              )}
              <CapacitySelector
                capacity={isSubmitted ? (target ?? selectedCapacity) : capacity}
                onChange={selectCapacity}
                showCost={false}
                {...(!isSubmitted && coverage?.paidCapacity ? { minCapacity: coverage.paidCapacity } : {})}
                {...(isSubmitted && draftId ? { eventId: draftId } : {})}
              />
              </>
            )}
          </section>}

          {/* 2 · WhatsApp */}
          <section aria-labelledby="license-whatsapp-heading">
            <h2 id="license-whatsapp-heading" className={sectionHeading}>WhatsApp messages</h2>
            <ServiceCard anchor="license-service-whatsapp" icon={MessageSquare} title="WhatsApp notifications" open={payg.whatsappEnabled && !locked}
              badge={<Badge tone="opt">Optional</Badge>}
              description={<>Registration confirmations and updates on WhatsApp, sent from the WhatsApp messages you buy here. Without WhatsApp capacity, attendees receive email only.</>}
              // RD-LICENSE-LOCK-01 · `disabled={locked}` was missing here (and on certificates),
              // while the media switch below has always had it. `open={… && !locked}` only
              // collapses the card BODY, so the toggle itself stayed live: a submitted event
              // showed "Unlock to edit" and yet let WhatsApp be switched on or off, and `setFlag`
              // persisted that to the draft immediately. The documented rule for submitted mode is
              // one read-only panel until Unlock, so the flag belongs behind the same gate as the
              // quantity it controls.
              control={<Switch checked={payg.whatsappEnabled} disabled={locked} onChange={v => setFlag('whatsappEnabled', v)} label={`${payg.whatsappEnabled ? 'Disable' : 'Enable'} WhatsApp notifications`} />}>
              <ServiceQuantitySelector
                title="Prepaid WhatsApp messages" unit="message" units="messages" mode={qtyMode}
                usageRule={`One message is used when WhatsApp accepts a message to an attendee — a registration confirmation, a certificate-ready notice, a retry of a failed confirmation, or one per recipient when a broadcast starts. A message WhatsApp rejects is not counted.${policy('whatsapp')}`}
                quantity={selection.whatsapp} onChange={n => setQty('whatsapp', n)}
                catalog={quote?.catalog.whatsapp ?? null} item={item('whatsapp')} error={error('whatsapp')} unavailable={!quote && !!networkError}
                purchased={coverage?.purchased.whatsapp ?? 0} consumed={coverage?.consumed.whatsapp ?? 0} capacity={coverage?.communication?.whatsapp ?? null}
              />
            </ServiceCard>
            {!payg.whatsappEnabled && (coverage?.purchased.whatsapp ?? 0) > 0 && (
              <p className="mt-2 flex items-start gap-1.5 text-[12px] text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />WhatsApp is off. Your purchased allowance is kept: {(coverage?.remaining.whatsapp ?? 0).toLocaleString('en-IN')} messages available.</p>
            )}
          </section>

          {/* 3 · Email */}
          <section aria-labelledby="license-email-heading">
            <h2 id="license-email-heading" className={sectionHeading}>Email notifications</h2>
            <ServiceCard icon={Mail} title="Email notifications" badge={<Badge tone="ok">Included</Badge>}
              description="Registration confirmations, reminders, updates and certificate emails — included at no extra charge."
              control={<span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[12px] font-semibold text-emerald-700"><CheckCircle2 className="size-3.5" aria-hidden />Active</span>} />
          </section>

          {/* 4 · SMS */}
          <section aria-labelledby="license-sms-heading">
            <h2 id="license-sms-heading" className={sectionHeading}>SMS notifications</h2>
            <ServiceCard icon={Smartphone} title="SMS notifications" badge={<Badge tone="warn">Unavailable</Badge>}
              description="SMS delivery is not available yet — no SMS is sent and none can be purchased."
              control={<Switch checked={false} onChange={() => undefined} label="SMS notifications (unavailable)" disabled />} />
          </section>

          {/* 5 · Certificates */}
          <section aria-labelledby="license-certs-heading">
            <h2 id="license-certs-heading" className={sectionHeading}>Certificates</h2>
            <ServiceCard anchor="license-service-certificates" icon={Award} title="Participation certificates" open={payg.certEnabled && !locked}
              badge={<Badge tone="opt">Optional</Badge>}
              description={<>Issue certificates from the event’s Certificates tab. Each certificate uses one unit of the certificate capacity you buy here — certificates cannot be issued without it.</>}
              // RD-LICENSE-LOCK-01 · see the WhatsApp switch above — same missing gate.
              control={<Switch checked={payg.certEnabled} disabled={locked} onChange={v => setFlag('certEnabled', v)} label={`${payg.certEnabled ? 'Disable' : 'Enable'} participation certificates`} />}>
              <ServiceQuantitySelector
                title="Prepaid certificates" unit="certificate" units="certificates" mode={qtyMode}
                usageRule={`One is used when a certificate is issued to a participant. Re-downloading, emailing or re-issuing the same certificate uses nothing.${policy('certificates')}`}
                quantity={selection.certificates} onChange={n => setQty('certificates', n)}
                catalog={quote?.catalog.certificates ?? null} item={item('certificates')} error={error('certificates')} unavailable={!quote && !!networkError}
                purchased={coverage?.purchased.certificates ?? 0} consumed={coverage?.consumed.certificates ?? 0} capacity={coverage?.communication?.certificates ?? null}
              />
            </ServiceCard>
          </section>

          {/* 6 · Media */}
          <section aria-labelledby="license-media-heading">
            <h2 id="license-media-heading" className={sectionHeading}>Photo storage</h2>
            <ServiceCard anchor="license-service-media" icon={ImageIcon} title="Event photo capacity" open={mediaOpen && !locked}
              badge={quote && !quote.catalog.media.purchasable ? <Badge tone="warn">{SALE_STATE_BADGE[quote.catalog.media.state ?? 'not_configured']}</Badge> : <Badge tone="opt">Optional</Badge>}
              description={<>Paid photo capacity for this event. Every photo uploaded in Media Studio uses one unit — there are no free photos. Maximum {mediaMaxTotal.toLocaleString('en-IN')} photos per event.</>}
              control={<Switch checked={mediaOpen && !locked} disabled={locked} onChange={v => { setMediaOpen(v); if (!v) setQty('media', 0) }} label={`${mediaOpen ? 'Hide' : 'Show'} event photo capacity`} />}>
              <ServiceQuantitySelector
                title="Photos to purchase" unit="photo" units="photos" mode={qtyMode}
                usageRule="Each unit lets this event store one photo in Media Studio. Used = photos stored for the event (and uploads in progress); deleting a photo frees its place. Only unused paid photos can be refunded."
                ceiling={mediaCeiling} maxReachedMessage={`Maximum photo capacity reached (${mediaMaxTotal.toLocaleString('en-IN')})`}
                quantity={selection.media} onChange={n => setQty('media', n)}
                catalog={quote?.catalog.media ?? null} item={item('media')} error={error('media')} unavailable={!quote && !!networkError}
                purchased={0} consumed={null}
                note={mediaCapacity !== null ? <>Purchased {mediaCapacity.toLocaleString('en-IN')} · Used {mediaUsed === null ? '—' : mediaUsed.toLocaleString('en-IN')} · Remaining {mediaUsed === null ? '—' : Math.max(0, mediaCapacity - mediaUsed).toLocaleString('en-IN')} · Maximum event capacity {mediaMaxTotal.toLocaleString('en-IN')}</> : null}
              />
            </ServiceCard>
          </section>

          {/* RD-PRINT-BILL-P6 · ID badges — published events only; its own order and Pay button. */}
          {isSubmitted && !embeddedFinal && draftId && (
            <section aria-labelledby="license-badges-heading">
              <h2 id="license-badges-heading" className={sectionHeading}>ID badges</h2>
              <BadgeUnitsPurchasePanel draftId={draftId}
                onPurchased={() => { if (walletIntent) setReturnAfterPurchase(walletIntent.returnTo) }} />
            </section>
          )}
        </div>

        {/* 7 · Cost summary + 8 · Payment — stack below the sections on mobile */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-10 lg:self-start">
          <LicenseCostSummary
            quote={quoteMatches ? quote : null}
            quoting={quoting}
            draftId={draftId}
            capacity={isSubmitted ? (target ?? 0) : capacity}
            onCouponChange={setCouponCode}
            onPayableAmount={setPayNowPaise}
          />
          <ActivationPaymentPanel
            mode={mode}
            draftId={draftId}
            capacity={isSubmitted ? (target ?? 0) : capacity}
            services={selection}
            payable={quoting ? null : payable}
            amountPaise={payNowPaise}
            blockedReason={blockedReason}
            couponCode={couponCode}
            activationPaid={quote?.coverage?.activationPaid === true}
            onSettle={onSettle}
            onSettled={onSettled}
            hidePayButton={!!embeddedFinal || isSubmitted}
            onRegisterPay={embeddedFinal || isSubmitted ? registerPay : undefined}
            coveredNote={reviewClosed
              ? <>Nothing to pay. This event is closed, so no more capacity or services can be bought.</>
              : locked
              ? <>Nothing to pay. Your purchases are locked — select “Unlock to edit” below to buy more capacity or services.</>
              : <>Nothing to pay yet. Raise the capacity or add service units above.</>}
          />
        </div>
      </div>

      {!canContinue && !quoting && quoteMatches && (
        <p role="status" className="mt-4 text-right text-[12.5px] text-muted-foreground">
          {embeddedFinal ? null : payable ? 'Complete the payment above to continue.' : 'Resolve the highlighted selection to continue.'}
        </p>
      )}

      {isSubmitted ? (
        // RD-EVENT-COMMERCE-05E — ONE primary action for a submitted event, in the fixed footer.
        <WizardFooter
          onBack={onBack}
          onNext={submittedFooter.onNext}
          nextLabel={submittedFooter.label}
          isFinalStep
          isNextDisabled={submittedFooter.disabled}
          secondaryAction={submittedFooter.secondary}
          stepContext={`Step ${currentStep + 1} of ${steps.length} · ${steps[currentStep]?.name ?? ''}`}
        />
      ) : !embeddedFinal && (
        <WizardFooter
          onBack={onBack}
          onNext={handleNext}
          isNextDisabled={!canContinue}
          stepContext={`Step ${currentStep + 1} of ${steps.length} · ${steps[currentStep]?.name ?? ''}`}
        />
      )}
    </motion.div>
  )
}

/**
 * RD-EVENT-COMMERCE-05E — the ONE primary footer action of a submitted event's License & Services
 * (PURE, unit-tested). Locked → Unlock to edit (secondary Done). Unlocked → Pay ₹X via Razorpay
 * when the server quote has an amount, Apply capacity change for a no-charge change, Done when
 * nothing is selected — always with the ONE Cancel as secondary. Never two payable actions.
 */
export function submittedPurchaseFooter(s: {
  locked: boolean; paying: boolean; quoting: boolean; quoteReady: boolean
  payableKind: 'activation' | 'addon' | 'covered' | 'capacity_change' | null
  payablePaise: number | null; blocked: boolean; eligible: boolean
}): { primary: 'unlock' | 'processing' | 'pay' | 'apply' | 'done' | 'waiting'; label: string; disabled: boolean; secondary: 'done' | 'cancel'; secondaryDisabled: boolean } {
  if (s.locked) return { primary: 'unlock', label: 'Unlock to edit', disabled: !s.eligible, secondary: 'done', secondaryDisabled: false }
  if (s.paying) return { primary: 'processing', label: 'Processing payment…', disabled: true, secondary: 'cancel', secondaryDisabled: true }
  if (s.quoteReady && s.payableKind !== null && s.payableKind !== 'covered') {
    const paise = s.payablePaise ?? 0
    return paise > 0
      ? { primary: 'pay', label: `Pay ${formatPaise(paise)} via Razorpay`, disabled: s.blocked, secondary: 'cancel', secondaryDisabled: false }
      : { primary: 'apply', label: 'Apply capacity change', disabled: s.blocked, secondary: 'cancel', secondaryDisabled: false }
  }
  if (s.quoteReady && s.payableKind === 'covered') return { primary: 'done', label: 'Done', disabled: false, secondary: 'cancel', secondaryDisabled: false }
  return { primary: 'waiting', label: s.quoting ? 'Calculating…' : 'Pay via Razorpay', disabled: true, secondary: 'cancel', secondaryDisabled: false }
}

/**
 * RD-EVENT-COMMERCE-05E — a submitted event's ACTUAL capacity and prepaid allowances, read-only.
 * Every figure comes from the server quote (enforced capacity + sold counter, allowance ledgers,
 * Media Studio usage); a figure the server did not return is shown as unavailable ("—"), never
 * guessed. `editing` swaps the Locked state for the "Editing additional capacity and services"
 * indicator — these stay the ACTUAL values while the proposed additions are chosen below.
 */
export function PurchasedPanel({ editing, capacity, coverage, media, unavailable, closed = false }: {
  editing:     boolean
  /** RD-REVIEW-02 — a review-closed event: nothing more can be bought, so no unlock hint. */
  closed?:     boolean
  capacity:    { total: number; used: number } | null
  coverage:    CheckoutQuoteResponse['coverage']
  media:       { purchased: number | null; base: number | null; used: number | null }
  unavailable: boolean
}) {
  const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-IN') : null)
  const cell = (v: number | null | undefined) => {
    const t = n(v)
    return t ?? <span className="text-muted-foreground" aria-label="unavailable">—</span>
  }
  const limit = media.base !== null && media.purchased !== null ? media.base + media.purchased : null
  // RD-COMMS-L2 — WhatsApp / certificates use the ONE organizer definition (capacityFigures), as
  // on Communications › Usage: Used = settled use (held units are In progress), Available = the
  // ledger's own figure, and the breakdown (In progress · Returned · Refunded · Carried in / out)
  // under the label. Without those figures the cells are "—", never a guessed number.
  const comm = (k: 'whatsapp' | 'certificates') => {
    const f = coverage?.communication?.[k] ?? null
    return {
      purchased: f?.purchased ?? null, used: f?.used ?? null, remaining: f?.available ?? null,
      note: f ? capacityBreakdown(f).map(({ key, value }) => `${CAPACITY_FIGURE_LABELS[key]} ${value === null ? '—' : value.toLocaleString('en-IN')}`).join(' · ') : undefined,
    }
  }
  const rows: { label: string; purchased: number | null; used: number | null; remaining: number | null; note?: string }[] = [
    { label: 'Registration capacity', purchased: capacity?.total ?? null, used: capacity?.used ?? null,
      remaining: capacity ? Math.max(0, capacity.total - capacity.used) : null },
    { label: 'WhatsApp messages', ...comm('whatsapp') },
    { label: 'Certificates', ...comm('certificates') },
    { label: 'Photo capacity', purchased: media.purchased, used: media.used,
      remaining: limit !== null && media.used !== null ? Math.max(0, limit - media.used) : null,
      note: 'Paid photos only · used = photos stored · maximum 3,000 per event' },
  ]
  return (
    <section aria-labelledby="license-purchases-heading" className={cn('overflow-hidden rounded-xl border bg-card', editing ? 'border-primary/40' : 'border-border')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-3">
        {editing ? <Pencil className="size-4 text-primary" aria-hidden /> : <Lock className="size-4 text-muted-foreground" aria-hidden />}
        <h2 id="license-purchases-heading" className="text-[14px] font-bold tracking-tight text-foreground">Purchased capacity &amp; services</h2>
        <span role="status" className={cn('ml-auto rounded-full px-2 py-0.5 text-[11.5px] font-semibold',
          editing ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
          {editing ? 'Editing additional capacity and services' : 'Locked'}
        </span>
      </div>
      {unavailable && (
        <p className="px-4 pt-3 text-[12px] text-muted-foreground">These figures couldn’t be loaded right now. Nothing has changed — use Refresh status in the payment panel to try again.</p>
      )}
      <table className="w-full text-[12.5px]">
        <caption className="sr-only">Actual purchased, used and available quantities for this event</caption>
        <thead>
          <tr className="text-left text-[11.5px] text-muted-foreground">
            <th scope="col" className="px-4 pb-1 pt-3 font-medium">Item</th>
            <th scope="col" className="px-2 pb-1 pt-3 text-right font-medium">Purchased</th>
            <th scope="col" className="px-2 pb-1 pt-3 text-right font-medium">Used</th>
            <th scope="col" className="px-4 pb-1 pt-3 text-right font-medium">Available</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label} className="border-t border-border/50 align-top">
              <th scope="row" className="px-4 py-2 text-left font-medium text-foreground">
                {r.label}
                {r.note && <span className="block text-[11px] font-normal text-muted-foreground">{r.note}</span>}
              </th>
              <td className="px-2 py-2 text-right tabular-nums font-semibold text-foreground">{cell(r.purchased)}</td>
              <td className="px-2 py-2 text-right tabular-nums text-foreground">{cell(r.used)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-foreground">{cell(r.remaining)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border/50 px-4 py-2.5 text-[11.5px] text-muted-foreground">
        {closed
          ? 'These are the purchases made for this event. It is closed, so nothing more can be bought.'
          : editing
          ? 'These are your actual purchases. What you choose below is added only after RegisterDesk verifies the payment.'
          : 'Select “Unlock to edit” to buy more capacity or services. Nothing changes until a payment is verified.'}
      </p>
    </section>
  )
}
