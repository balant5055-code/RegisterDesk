'use client'

import { useState } from 'react'
import { ArrowLeft, CheckCircle, Download, Eye, Heart, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClientDonationSettings {
  suggestedAmountsRupees: number[]
  allowCustomAmount:      boolean
  minimumAmountRupees:    number
  maximumAmountRupees:    number | null
  allowAnonymous:         boolean
  allowDedications:       boolean
  allowMessages:          boolean
}

interface Props {
  settings:      ClientDonationSettings
  campaignSlug:  string
  campaignTitle: string
}

type Step = 'amount' | 'details' | 'processing' | 'success'

interface SuccessData {
  receiptId:     string
  receiptNumber: string
  receiptToken:  string
  transactionId: string
  amountRupees:  number
}

// ─── Razorpay SDK types ───────────────────────────────────────────────────────

interface RazorpayPaymentSuccess {
  razorpay_payment_id: string
  razorpay_order_id:   string
  razorpay_signature:  string
}

// Window.Razorpay is declared once, globally, in types/razorpay.d.ts.

function loadRazorpayScript(): Promise<void> {
  if (typeof window !== 'undefined' && window.Razorpay) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script   = document.createElement('script')
    script.src     = 'https://checkout.razorpay.com/v1/checkout.js'
    script.onload  = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Razorpay checkout script.'))
    document.body.appendChild(script)
  })
}

function openRazorpayCheckout(opts: {
  keyId:         string
  orderId:       string
  amountPaise:   number
  campaignTitle: string
  donorName:     string
  donorEmail:    string
  donorPhone?:   string
}): Promise<RazorpayPaymentSuccess> {
  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay({
      key:         opts.keyId,
      amount:      opts.amountPaise,
      currency:    'INR',
      order_id:    opts.orderId,
      name:        opts.campaignTitle,
      description: 'Donation',
      prefill: {
        name:    opts.donorName  || undefined,
        email:   opts.donorEmail || undefined,
        contact: opts.donorPhone || undefined,
      },
      handler: resolve,
      modal:   { ondismiss: () => reject(new Error('PAYMENT_CANCELLED')) },
      theme:   { color: '#f97316' },
    })
    rzp.open()
  })
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CampaignDetailClient({ settings, campaignSlug, campaignTitle }: Props) {
  // Amount step
  const [selectedAmount, setSelectedAmount] = useState<number | null>(
    settings.suggestedAmountsRupees[1] ?? settings.suggestedAmountsRupees[0] ?? null,
  )
  const [customAmount,   setCustomAmount]   = useState('')
  const [isCustomActive, setIsCustomActive] = useState(false)

  // Donor details
  const [donorName,          setDonorName]          = useState('')
  const [donorEmail,         setDonorEmail]         = useState('')
  const [donorPhone,         setDonorPhone]         = useState('')
  const [isAnonymous,        setIsAnonymous]        = useState(false)
  const [showAmountPublicly, setShowAmountPublicly] = useState(true)
  const [message,            setMessage]            = useState('')
  const [dedication,         setDedication]         = useState('')

  // Flow
  const [step,        setStep]        = useState<Step>('amount')
  const [error,       setError]       = useState<string | null>(null)
  const [isLoading,   setIsLoading]   = useState(false)
  const [successData, setSuccessData] = useState<SuccessData | null>(null)

  const effectiveAmount = isCustomActive
    ? (parseInt(customAmount, 10) || null)
    : selectedAmount

  const isValidAmount =
    effectiveAmount !== null &&
    effectiveAmount >= settings.minimumAmountRupees &&
    (settings.maximumAmountRupees === null || effectiveAmount <= settings.maximumAmountRupees)

  // ─── Amount step handlers ──────────────────────────────────────────────────

  function handleSuggestedClick(amount: number) {
    setSelectedAmount(amount)
    setIsCustomActive(false)
    setCustomAmount('')
  }

  function handleCustomFocus() {
    setIsCustomActive(true)
    setSelectedAmount(null)
  }

  // ─── Donate handler ────────────────────────────────────────────────────────

  async function handleDonate() {
    if (!effectiveAmount || !isValidAmount) return
    setError(null)
    setIsLoading(true)

    try {
      // 1. Create Razorpay order server-side
      const orderRes = await fetch('/api/donations/create-order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          campaignSlug,
          amountRupees:       effectiveAmount,
          donorName:          donorName.trim(),
          donorEmail:         donorEmail.trim(),
          donorPhone:         donorPhone.trim() || null,
          isAnonymous,
          showAmountPublicly,
          message:            message.trim()    || undefined,
          dedication:         dedication.trim() || undefined,
        }),
      })

      const orderData = await orderRes.json() as {
        donationId?:      string
        razorpayOrderId?: string
        amountPaise?:     number
        keyId?:           string
        error?:           string
        code?:            string
      }

      if (!orderRes.ok || !orderData.donationId || !orderData.razorpayOrderId || !orderData.keyId) {
        throw new Error(orderData.error ?? 'Failed to create donation order.')
      }

      // 2. Load Razorpay script (no-op if already loaded)
      await loadRazorpayScript()
      setIsLoading(false)

      // 3. Open Razorpay checkout — resolves on payment, rejects on dismiss
      const payment = await openRazorpayCheckout({
        keyId:         orderData.keyId,
        orderId:       orderData.razorpayOrderId,
        amountPaise:   orderData.amountPaise!,
        campaignTitle,
        donorName:     isAnonymous ? '' : donorName.trim(),
        donorEmail:    donorEmail.trim(),
        donorPhone:    donorPhone.trim() || undefined,
      })

      // 4. Verify payment server-side
      setStep('processing')
      const verifyRes = await fetch('/api/donations/verify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          razorpay_payment_id: payment.razorpay_payment_id,
          razorpay_order_id:   payment.razorpay_order_id,
          razorpay_signature:  payment.razorpay_signature,
          donationId:          orderData.donationId,
        }),
      })

      const verifyData = await verifyRes.json() as {
        receiptId?:    string
        receiptNumber?: string
        receiptToken?:  string
        error?:         string
      }

      if (!verifyRes.ok) {
        throw new Error(verifyData.error ?? 'Payment verification failed.')
      }

      setSuccessData({
        receiptId:     verifyData.receiptId    ?? '',
        receiptNumber: verifyData.receiptNumber ?? '',
        receiptToken:  verifyData.receiptToken  ?? '',
        transactionId: payment.razorpay_payment_id,
        amountRupees:  effectiveAmount,
      })
      setStep('success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred.'
      if (msg === 'PAYMENT_CANCELLED') {
        setError('Payment was cancelled. You can try again.')
      } else {
        setError(msg)
      }
      setStep('details')
    } finally {
      setIsLoading(false)
    }
  }

  function handleReset() {
    setStep('amount')
    setError(null)
    setSuccessData(null)
    setDonorName('')
    setDonorEmail('')
    setDonorPhone('')
    setIsAnonymous(false)
    setShowAmountPublicly(true)
    setMessage('')
    setDedication('')
  }

  // ─── Render: processing ────────────────────────────────────────────────────

  if (step === 'processing') {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <Loader2 className="size-10 animate-spin text-orange-500" aria-hidden />
          <p className="font-medium text-foreground">Verifying your payment&hellip;</p>
          <p className="text-sm text-muted-foreground">Please do not close this window.</p>
        </div>
      </div>
    )
  }

  // ─── Render: success ───────────────────────────────────────────────────────

  if (step === 'success' && successData) {
    return (
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-emerald-100">
            <CheckCircle className="size-9 text-emerald-600" aria-hidden />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">Thank you!</h3>
            <p className="mt-1 text-sm text-muted-foreground">Your donation was successful.</p>
          </div>
          <div className="w-full rounded-xl bg-muted/60 p-4 text-left">
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">Amount</dt>
                <dd className="font-semibold text-foreground">
                  ₹{successData.amountRupees.toLocaleString('en-IN')}
                </dd>
              </div>
              {successData.receiptNumber && (
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Receipt</dt>
                  <dd className="font-mono text-xs text-foreground">
                    {successData.receiptNumber}
                  </dd>
                </div>
              )}
              <div className="flex items-start justify-between gap-2">
                <dt className="shrink-0 text-muted-foreground">Transaction</dt>
                <dd className="break-all font-mono text-xs text-muted-foreground">
                  {successData.transactionId}
                </dd>
              </div>
            </dl>
          </div>
          {/* Receipt actions */}
          {successData.receiptId && successData.receiptToken && (
            <div className="flex w-full gap-2">
              <a
                href={`/donations/receipt/${successData.receiptId}?token=${successData.receiptToken}`}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'flex-1 gap-1.5 text-sm',
                )}
              >
                <Eye className="size-3.5" aria-hidden />
                View
              </a>
              <a
                href={`/api/donations/receipt/${successData.receiptId}?token=${successData.receiptToken}`}
                download
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'flex-1 gap-1.5 text-sm',
                )}
              >
                <Download className="size-3.5" aria-hidden />
                Download PDF
              </a>
            </div>
          )}

          <button
            type="button"
            onClick={handleReset}
            className={cn(buttonVariants({ variant: 'outline' }), 'mt-1 w-full')}
          >
            Donate Again
          </button>
        </div>
      </div>
    )
  }

  // ─── Render: donor details form ────────────────────────────────────────────

  if (step === 'details') {
    return (
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        {/* Header */}
        <div className="mb-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setStep('amount'); setError(null) }}
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Back to amount selection"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </button>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Your Details</h3>
            <p className="text-xs font-medium text-orange-600">
              Donating ₹{effectiveAmount?.toLocaleString('en-IN')}
            </p>
          </div>
        </div>

        <form
          onSubmit={e => { e.preventDefault(); void handleDonate() }}
          className="space-y-3"
        >
          {/* Name */}
          <div>
            <label
              htmlFor="donor-name"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              {isAnonymous ? 'Your Name (kept private)' : 'Your Name'}
            </label>
            <input
              id="donor-name"
              type="text"
              required
              autoComplete="name"
              value={donorName}
              onChange={e => setDonorName(e.target.value)}
              placeholder="Full name"
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 transition-all focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
            />
          </div>

          {/* Email */}
          <div>
            <label
              htmlFor="donor-email"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Email{' '}
              <span className="text-muted-foreground/60">(receipt will be sent here)</span>
            </label>
            <input
              id="donor-email"
              type="email"
              required
              autoComplete="email"
              value={donorEmail}
              onChange={e => setDonorEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 transition-all focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
            />
          </div>

          {/* Phone */}
          <div>
            <label
              htmlFor="donor-phone"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Phone{' '}
              <span className="text-muted-foreground/60">(optional)</span>
            </label>
            <input
              id="donor-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              value={donorPhone}
              onChange={e => setDonorPhone(e.target.value)}
              placeholder="10-digit mobile number"
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 transition-all focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
            />
          </div>

          {/* Message */}
          {settings.allowMessages && (
            <div>
              <label
                htmlFor="donor-message"
                className="mb-1 block text-xs font-medium text-muted-foreground"
              >
                Message{' '}
                <span className="text-muted-foreground/60">(optional)</span>
              </label>
              <textarea
                id="donor-message"
                rows={2}
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Leave a message of support"
                className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 transition-all focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />
            </div>
          )}

          {/* Dedication */}
          {settings.allowDedications && (
            <div>
              <label
                htmlFor="donor-dedication"
                className="mb-1 block text-xs font-medium text-muted-foreground"
              >
                Dedication{' '}
                <span className="text-muted-foreground/60">(optional)</span>
              </label>
              <input
                id="donor-dedication"
                type="text"
                value={dedication}
                onChange={e => setDedication(e.target.value)}
                placeholder="In memory of / In honour of"
                className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 transition-all focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />
            </div>
          )}

          {/* Preference toggles */}
          <div className="space-y-2 pt-1">
            {settings.allowAnonymous && (
              <label className="flex cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={isAnonymous}
                  onChange={e => setIsAnonymous(e.target.checked)}
                  className="size-4 rounded border-border accent-orange-500"
                />
                <span className="text-xs text-muted-foreground">Donate anonymously</span>
              </label>
            )}
            <label className="flex cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={showAmountPublicly}
                onChange={e => setShowAmountPublicly(e.target.checked)}
                className="size-4 rounded border-border accent-orange-500"
              />
              <span className="text-xs text-muted-foreground">
                Show my donation amount publicly
              </span>
            </label>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={isLoading}
            className={cn(
              buttonVariants({ variant: 'primary' }),
              'mt-1 w-full gap-2 py-3 text-base disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {isLoading ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Preparing&hellip;
              </>
            ) : (
              <>
                <Heart className="size-4" aria-hidden />
                Donate ₹{effectiveAmount?.toLocaleString('en-IN')}
              </>
            )}
          </button>
        </form>

        <p className="mt-3 text-center text-xs text-muted-foreground">
          Secure payments powered by Razorpay
        </p>
      </div>
    )
  }

  // ─── Render: amount selection (default) ───────────────────────────────────

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <h3 className="mb-4 text-base font-semibold text-foreground">Make a Donation</h3>

      {/* Suggested amounts */}
      {settings.suggestedAmountsRupees.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-2">
          {settings.suggestedAmountsRupees.map(amount => (
            <button
              key={amount}
              type="button"
              onClick={() => handleSuggestedClick(amount)}
              className={cn(
                'rounded-xl border py-2.5 text-sm font-medium transition-all',
                selectedAmount === amount && !isCustomActive
                  ? 'border-orange-500 bg-orange-50 text-orange-700 ring-1 ring-orange-500'
                  : 'border-border bg-background text-foreground hover:border-orange-300 hover:bg-orange-50/50',
              )}
            >
              ₹{amount.toLocaleString('en-IN')}
            </button>
          ))}
        </div>
      )}

      {/* Custom amount */}
      {settings.allowCustomAmount && (
        <div className="mb-5">
          <div
            className={cn(
              'flex items-center rounded-xl border bg-background px-3 transition-all',
              isCustomActive ? 'border-orange-500 ring-1 ring-orange-500' : 'border-border',
            )}
          >
            <span className="mr-1 text-sm font-medium text-muted-foreground">₹</span>
            <input
              type="number"
              inputMode="numeric"
              placeholder={`Other amount (min ₹${settings.minimumAmountRupees})`}
              value={customAmount}
              onFocus={handleCustomFocus}
              onChange={e => setCustomAmount(e.target.value)}
              className="flex-1 bg-transparent py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
              min={settings.minimumAmountRupees}
              max={settings.maximumAmountRupees ?? undefined}
            />
          </div>
          {isCustomActive && customAmount && !isValidAmount && (
            <p className="mt-1.5 text-xs text-destructive">
              {settings.maximumAmountRupees &&
              effectiveAmount !== null &&
              effectiveAmount > settings.maximumAmountRupees
                ? `Maximum donation is ₹${settings.maximumAmountRupees.toLocaleString('en-IN')}`
                : `Minimum donation is ₹${settings.minimumAmountRupees}`}
            </p>
          )}
        </div>
      )}

      {/* Continue to details */}
      <button
        type="button"
        disabled={!isValidAmount}
        onClick={() => { if (isValidAmount) setStep('details') }}
        className={cn(
          buttonVariants({ variant: 'primary' }),
          'w-full gap-2 py-3 text-base disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <Heart className="size-4" aria-hidden />
        {isValidAmount && effectiveAmount
          ? `Donate ₹${effectiveAmount.toLocaleString('en-IN')}`
          : 'Donate Now'}
      </button>

      <p className="mt-3 text-center text-xs text-muted-foreground">
        Secure payments powered by Razorpay
      </p>
    </div>
  )
}
