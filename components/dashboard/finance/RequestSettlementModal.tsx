'use client'

// Shared "Request Settlement" modal (Phase H.5.1) — extracted verbatim from the
// finance page so the finance overview and the Settlement Center share ONE
// implementation and one POST flow (/api/organizer/settlements). No new logic:
// min ₹100, capped at available balance, requires a payout profile.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowRight, Clock, Loader2, Send, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatCompactINR } from '@/lib/finance/format'
import { useSettlementConfig } from '@/lib/settlements/settlementConfigClient'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'

interface RequestModalProps {
  availablePaise:   number
  hasPayoutProfile: boolean
  onClose:          () => void
  onSubmit:         (amountPaise: number) => Promise<void>
}

export function RequestSettlementModal({ availablePaise, hasPayoutProfile, onClose, onSubmit }: RequestModalProps) {
  const [amountStr,   setAmountStr]   = useState('')
  const [submitting,  setSubmitting]  = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // GA-7D S1: add the shared focus trap (Escape was already handled below).
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  // Minimum settlement amount from Business Configuration (matches the server).
  const settlements = useSettlementConfig()
  const minPaise    = settlements.minimumSettlementAmountPaise

  useEffect(() => {
    if (availablePaise > 0) inputRef.current?.focus()
  }, [availablePaise])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const maxRupees   = availablePaise / 100
  const parsed      = parseFloat(amountStr)
  const amountPaise = amountStr ? Math.round(parsed * 100) : 0

  const validationError =
    amountStr && isNaN(parsed)  ? 'Enter a valid amount.' :
    amountPaise > 0 && amountPaise < minPaise ? `Minimum settlement is ${formatCompactINR(minPaise)}.` :
    amountPaise > availablePaise ? `Maximum is ${formatCompactINR(availablePaise)}.` :
    null

  const canSubmit = availablePaise > 0 && amountPaise >= minPaise && amountPaise <= availablePaise && !validationError

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await onSubmit(amountPaise)
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit request.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      role="presentation"
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal
        aria-labelledby="settle-modal-title"
        className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 id="settle-modal-title" className="text-[16px] font-semibold text-foreground">Request Settlement</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="mb-5 flex items-center justify-between rounded-lg border border-border bg-muted/40 px-4 py-3">
          <span className="text-[13px] text-muted-foreground">Available balance</span>
          <span className={cn('text-[15px] font-bold tabular-nums', availablePaise > 0 ? 'text-emerald-600' : 'text-muted-foreground')}>
            {formatCompactINR(availablePaise)}
          </span>
        </div>

        {!hasPayoutProfile ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/[0.07]">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              <div>
                <p className="text-[13.5px] font-semibold text-amber-800 dark:text-amber-400">Payout profile required</p>
                <p className="mt-1 text-[13px] text-amber-700 dark:text-amber-500">
                  Please configure your payout profile before requesting a settlement.
                </p>
                <Link
                  href="/dashboard/finance/payout-profile"
                  onClick={onClose}
                  className="mt-2.5 inline-flex items-center gap-1 text-[13px] font-semibold text-amber-800 underline-offset-2 hover:underline dark:text-amber-300"
                >
                  Set up payout profile
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </div>
            </div>
          </div>
        ) : availablePaise === 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-500/[0.07]">
            <div className="flex items-start gap-2.5">
              <Clock className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              <div>
                <p className="text-[13.5px] font-semibold text-amber-800 dark:text-amber-400">No funds available yet</p>
                <p className="mt-1 text-[13px] text-amber-700 dark:text-amber-500">
                  Your revenue is currently in Pending Balance. Funds will move to Available Balance
                  when the settlement cycle runs.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <label htmlFor="settle-amount" className="mb-1.5 block text-[13px] font-medium text-foreground">Amount (₹)</label>
            <input
              ref={inputRef}
              id="settle-amount"
              type="number"
              min={minPaise / 100}
              max={maxRupees}
              step="0.01"
              placeholder="e.g. 500"
              value={amountStr}
              onChange={e => { setAmountStr(e.target.value); setSubmitError(null) }}
              className={cn(
                'w-full rounded-lg border bg-background px-3 py-2.5 text-[14px] text-foreground outline-none ring-offset-background transition-colors',
                'placeholder:text-muted-foreground',
                'focus:border-primary/50 focus:ring-2 focus:ring-primary/25',
                validationError ? 'border-destructive' : 'border-border',
              )}
            />
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              Minimum {formatCompactINR(minPaise)} · Maximum {formatCompactINR(availablePaise)}
            </p>

            {(validationError ?? submitError) && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                <p className="text-[13px] text-destructive">{validationError ?? submitError}</p>
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit || submitting}
                className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-colors disabled:opacity-50"
                style={{ backgroundImage: 'var(--primary-gradient)' }}
              >
                {submitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
                {submitting ? 'Submitting…' : 'Submit Request'}
              </button>
            </div>
          </form>
        )}

        {(!hasPayoutProfile || availablePaise === 0) && (
          <div className="mt-5 flex justify-end">
            <button
              onClick={onClose}
              className="rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
