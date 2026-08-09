'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuth }    from 'firebase/auth'
import { cn }         from '@/lib/utils/cn'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import { useToast }   from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui'
import {
  CheckCircle2, Clock, DollarSign, AlertCircle,
  RefreshCw, ChevronDown, ChevronUp, X, Zap, ShieldCheck, ShieldX, RotateCcw,
} from 'lucide-react'
import type { AdminSettlement, AdminSettlementsStats, AdminSettlementsResponse }
  from '@/app/api/admin/settlements/route'
import type { AdminTransaction, AdminTransactionsResponse }
  from '@/app/api/admin/transactions/route'
import type { ReleasePreviewResponse } from '@/app/api/admin/finance/release-preview/route'
import type { ReleaseFundsResponse }   from '@/app/api/admin/finance/release-funds/route'
import type {
  AdminPayoutProfileSummary,
  AdminPayoutProfilesResponse,
} from '@/lib/payout/types'
import type {
  FailedRefundSummary,
  FailedRefundsStats,
  FailedRefundsResponse,
} from '@/app/api/admin/failed-refunds/route'

// ─── Utilities ────────────────────────────────────────────────────────────────

function paise(n: number) {
  return `₹${(n / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtDateTime(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function relativeAge(iso: string | null): string {
  if (!iso) return '—'
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (hours < 1)  return 'just now'
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

async function getToken() {
  const user = getAuth().currentUser
  return user ? user.getIdToken() : ''
}

// ─── Sub-components ───────────────────────────────────────────────────────────

type TabId = 'overview' | 'settlements' | 'transactions' | 'release' | 'payout-profiles' | 'failed-refunds'
type SettlementFilter = 'all' | 'pending' | 'approved' | 'paid' | 'rejected'

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending:  'bg-amber-100  text-amber-800  dark:bg-amber-900/30  dark:text-amber-300',
    approved: 'bg-blue-100   text-blue-800   dark:bg-blue-900/30   dark:text-blue-300',
    paid:     'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    rejected: 'bg-red-100    text-red-800    dark:bg-red-900/30    dark:text-red-300',
    completed:'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    refunded: 'bg-blue-100   text-blue-800   dark:bg-blue-900/30   dark:text-blue-300',
    disputed: 'bg-red-100    text-red-800    dark:bg-red-900/30    dark:text-red-300',
    open:     'bg-red-100    text-red-800    dark:bg-red-900/30    dark:text-red-300',
    retried:  'bg-blue-100   text-blue-800   dark:bg-blue-900/30   dark:text-blue-300',
    resolved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    ignored:  'bg-muted      text-muted-foreground',
  }
  return (
    <span className={cn('inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize', map[status] ?? 'bg-muted text-muted-foreground')}>
      {status}
    </span>
  )
}

function KpiCard({ label, value, sub, icon: Icon, accent }: {
  label: string; value: string; sub?: string
  icon: React.ElementType; accent: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 text-[22px] font-bold leading-tight tracking-tight text-foreground">{value}</p>
          {sub && <p className="mt-0.5 text-[12px] text-muted-foreground">{sub}</p>}
        </div>
        <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', accent)}>
          <Icon className="size-4" aria-hidden />
        </div>
      </div>
    </div>
  )
}

// ─── Mark Paid modal ──────────────────────────────────────────────────────────

interface MarkPaidModalProps {
  settlement: AdminSettlement
  onClose:    () => void
  onConfirm:  (proof: PayoutProof, note: string) => Promise<void>
}

interface PayoutProof {
  utrNumber:     string
  bankReference: string
  paidBy:        string
  paymentNotes:  string
}

function MarkPaidModal({ settlement, onClose, onConfirm }: MarkPaidModalProps) {
  const [utrNumber,     setUtrNumber]     = useState('')
  const [bankReference, setBankReference] = useState('')
  const [paidBy,        setPaidBy]        = useState('')
  const [paymentNotes,  setPaymentNotes]  = useState('')
  const [adminNote,     setAdminNote]     = useState(settlement.adminNote)
  const [submitting,    setSubmitting]    = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  const utrRef = useRef<HTMLInputElement>(null)
  const trapRef = useFocusTrap<HTMLDivElement>(true)   // GA-8 P1-5: focus trap + restore

  useEffect(() => { utrRef.current?.focus() }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const canSubmit = utrNumber.trim().length > 0 && !submitting

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onConfirm(
        { utrNumber: utrNumber.trim(), bankReference: bankReference.trim(),
          paidBy: paidBy.trim(), paymentNotes: paymentNotes.trim() },
        adminNote,
      )
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark paid.')
    } finally {
      setSubmitting(false)
    }
  }

  const paise = (n: number) =>
    `₹${(n / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

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
        aria-labelledby="mark-paid-title"
        className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 id="mark-paid-title" className="text-[16px] font-semibold text-foreground">
              Mark as Paid
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              {settlement.organizerName || settlement.organizerEmail} · {paise(settlement.amountPaise)}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* UTR Number — required */}
          <div>
            <label htmlFor="utr-number" className="mb-1 block text-[13px] font-medium text-foreground">
              UTR Number <span className="text-destructive">*</span>
            </label>
            <input
              ref={utrRef}
              id="utr-number"
              type="text"
              value={utrNumber}
              onChange={e => setUtrNumber(e.target.value)}
              placeholder="e.g. HDFC24061700012345"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {/* Bank Reference — optional */}
          <div>
            <label htmlFor="bank-ref" className="mb-1 block text-[13px] font-medium text-foreground">
              Bank Reference <span className="text-[12px] font-normal text-muted-foreground">(optional)</span>
            </label>
            <input
              id="bank-ref"
              type="text"
              value={bankReference}
              onChange={e => setBankReference(e.target.value)}
              placeholder="e.g. Transfer ref #NEFT12345"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {/* Paid By — optional */}
          <div>
            <label htmlFor="paid-by" className="mb-1 block text-[13px] font-medium text-foreground">
              Paid By <span className="text-[12px] font-normal text-muted-foreground">(optional)</span>
            </label>
            <input
              id="paid-by"
              type="text"
              value={paidBy}
              onChange={e => setPaidBy(e.target.value)}
              placeholder="e.g. Accounts team / Razorpay"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {/* Payment Notes — optional */}
          <div>
            <label htmlFor="payment-notes" className="mb-1 block text-[13px] font-medium text-foreground">
              Payment Notes <span className="text-[12px] font-normal text-muted-foreground">(optional)</span>
            </label>
            <input
              id="payment-notes"
              type="text"
              value={paymentNotes}
              onChange={e => setPaymentNotes(e.target.value)}
              placeholder="e.g. Transferred in two batches"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {/* Admin Note — optional */}
          <div>
            <label htmlFor="admin-note-paid" className="mb-1 block text-[13px] font-medium text-foreground">
              Admin Note <span className="text-[12px] font-normal text-muted-foreground">(optional)</span>
            </label>
            <input
              id="admin-note-paid"
              type="text"
              value={adminNote}
              onChange={e => setAdminNote(e.target.value)}
              placeholder="Internal note visible to admin only"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5 text-[13px] text-destructive">
              <AlertCircle className="size-3.5 shrink-0" aria-hidden />
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
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
              disabled={!canSubmit}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
            >
              {submitting ? 'Confirming…' : 'Confirm Paid'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Release Funds confirmation modal ────────────────────────────────────────

interface ReleaseFundsModalProps {
  preview:   ReleasePreviewResponse
  onClose:   () => void
  onConfirm: () => Promise<void>
}

function ReleaseFundsModal({ preview, onClose, onConfirm }: ReleaseFundsModalProps) {
  const [running, setRunning] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const trapRef = useFocusTrap<HTMLDivElement>(true)   // GA-8 P1-5: focus trap + restore

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleRelease() {
    setRunning(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Release failed.')
      setRunning(false)
    }
  }

  const fmt = (n: number) =>
    `₹${(n / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

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
        aria-labelledby="release-modal-title"
        className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 id="release-modal-title" className="text-[16px] font-semibold text-foreground">
            Release Eligible Funds
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {/* Summary */}
        <div className="mb-4 rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between text-[13.5px]">
            <span className="text-muted-foreground">Eligible Transactions</span>
            <span className="font-semibold text-foreground">{preview.eligibleTransactions}</span>
          </div>
          <div className="flex items-center justify-between text-[13.5px]">
            <span className="text-muted-foreground">Eligible Amount</span>
            <span className="font-semibold text-foreground">{fmt(preview.eligibleAmountPaise)}</span>
          </div>
        </div>

        {/* Warning */}
        <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-[13px] text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          This action moves funds from pending balance to available balance.
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5 text-[13px] text-destructive">
            <AlertCircle className="size-3.5 shrink-0" aria-hidden />
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleRelease()}
            disabled={running}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
          >
            <Zap className="size-3.5" aria-hidden />
            {running ? 'Releasing…' : 'Release Funds'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Verify Profile modal ────────────────────────────────────────────────────

interface VerifyProfileModalProps {
  profile:   AdminPayoutProfileSummary
  onClose:   () => void
  onConfirm: () => Promise<void>
}

function VerifyProfileModal({ profile, onClose, onConfirm }: VerifyProfileModalProps) {
  const [running, setRunning] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const trapRef = useFocusTrap<HTMLDivElement>(true)   // GA-8 P1-5: focus trap + restore

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleConfirm() {
    setRunning(true); setError(null)
    try { await onConfirm(); onClose() }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed.'); setRunning(false) }
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
        aria-labelledby="verify-profile-title"
        className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 id="verify-profile-title" className="text-[16px] font-semibold text-foreground">
            Verify Payout Profile
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="mb-5 rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-1.5 text-[13.5px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Organizer</span>
            <span className="font-medium text-foreground">{profile.organizerName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Account Holder</span>
            <span className="font-medium text-foreground">{profile.accountHolderName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Method</span>
            <span className="font-medium text-foreground capitalize">{profile.payoutMethod}</span>
          </div>
          {profile.payoutMethod === 'bank' && profile.accountNumberMasked && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Account</span>
              <span className="font-mono text-foreground">{profile.accountNumberMasked}</span>
            </div>
          )}
          {profile.payoutMethod === 'upi' && profile.upiId && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">UPI ID</span>
              <span className="font-mono text-foreground">{profile.upiId}</span>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5 text-[13px] text-destructive">
            <AlertCircle className="size-3.5 shrink-0" aria-hidden />{error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={running} className="rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={() => void handleConfirm()} disabled={running} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50">
            <ShieldCheck className="size-3.5" aria-hidden />
            {running ? 'Verifying…' : 'Verify Profile'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Reject Profile modal ────────────────────────────────────────────────────

interface RejectProfileModalProps {
  profile:   AdminPayoutProfileSummary
  onClose:   () => void
  onConfirm: (note: string) => Promise<void>
}

function RejectProfileModal({ profile, onClose, onConfirm }: RejectProfileModalProps) {
  const [note,    setNote]    = useState('')
  const [running, setRunning] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const trapRef = useFocusTrap<HTMLDivElement>(true)   // GA-8 P1-5: focus trap + restore

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault()
    if (!note.trim()) return
    setRunning(true); setError(null)
    try { await onConfirm(note.trim()); onClose() }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed.'); setRunning(false) }
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
        aria-labelledby="reject-profile-title"
        className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 id="reject-profile-title" className="text-[16px] font-semibold text-foreground">
            Reject Payout Profile
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <p className="mb-4 text-[13.5px] text-muted-foreground">
          Rejecting <strong className="text-foreground">{profile.organizerName}</strong>&apos;s profile.
          The organizer will be notified by email.
        </p>

        <form onSubmit={handleConfirm} className="space-y-4">
          <div>
            <label htmlFor="reject-note" className="mb-1 block text-[13px] font-medium text-foreground">
              Reason for rejection <span className="text-destructive">*</span>
            </label>
            <input
              ref={inputRef}
              id="reject-note"
              type="text"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. PAN number does not match bank records"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5 text-[13px] text-destructive">
              <AlertCircle className="size-3.5 shrink-0" aria-hidden />{error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={running} className="rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={!note.trim() || running} className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50">
              <ShieldX className="size-3.5" aria-hidden />
              {running ? 'Rejecting…' : 'Reject Profile'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Retry Refund modal ───────────────────────────────────────────────────────

interface RetryRefundModalProps {
  refund:    FailedRefundSummary
  onClose:   () => void
  onConfirm: () => Promise<void>
}

function RetryRefundModal({ refund, onClose, onConfirm }: RetryRefundModalProps) {
  const [running, setRunning] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const trapRef = useFocusTrap<HTMLDivElement>(true)   // GA-8 P1-5: focus trap + restore
  const fmt = (n: number) =>
    `₹${(n / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleConfirm() {
    setRunning(true); setError(null)
    try { await onConfirm(); onClose() }
    catch (err) { setError(err instanceof Error ? err.message : 'Retry failed.'); setRunning(false) }
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
        aria-labelledby="retry-refund-title"
        className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 id="retry-refund-title" className="text-[16px] font-semibold text-foreground">
            Retry Refund
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="mb-5 rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-1.5 text-[13.5px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Payment ID</span>
            <span className="font-mono text-[12px] text-foreground">{refund.paymentId}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-semibold text-foreground">{fmt(refund.amountPaise)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Attendee</span>
            <span className="text-foreground truncate max-w-[180px]">{refund.attendeeEmail}</span>
          </div>
        </div>

        <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-[13px] text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          This calls the Razorpay API. Ensure the payment is in a refundable state before retrying.
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5 text-[13px] text-destructive">
            <AlertCircle className="size-3.5 shrink-0" aria-hidden />{error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={running} className="rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={() => void handleConfirm()} disabled={running} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50">
            <RotateCcw className="size-3.5" aria-hidden />
            {running ? 'Retrying…' : 'Retry Refund'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function AdminFinancePage() {
  const { confirm } = useConfirm()   // GA-7D S2: gate money-moving approve
  const [activeTab,    setActiveTab]    = useState<TabId>('overview')
  const [settlements,  setSettlements]  = useState<AdminSettlement[]>([])
  const [stats,        setStats]        = useState<AdminSettlementsStats | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState<string | null>(null)
  const { showToast } = useToast()

  // Transactions (lazy — loaded on first activation)
  const [transactions,  setTransactions]  = useState<AdminTransaction[]>([])
  const [txnsLoaded,    setTxnsLoaded]    = useState(false)
  const [txnsLoading,   setTxnsLoading]   = useState(false)
  const [txnsCursor,    setTxnsCursor]    = useState<string | null>(null)
  const [txnsHasMore,   setTxnsHasMore]   = useState(false)

  // Release engine state
  const [releasePreview,        setReleasePreview]        = useState<ReleasePreviewResponse | null>(null)
  const [releasePreviewLoading, setReleasePreviewLoading] = useState(false)
  const [releaseModal,          setReleaseModal]          = useState(false)
  const [releaseResult,         setReleaseResult]         = useState<ReleaseFundsResponse | null>(null)
  const [releaseError,          setReleaseError]          = useState<string | null>(null)

  // Payout profiles state
  const [payoutProfiles,        setPayoutProfiles]        = useState<AdminPayoutProfileSummary[]>([])
  const [payoutProfilesLoaded,  setPayoutProfilesLoaded]  = useState(false)
  const [payoutProfilesLoading, setPayoutProfilesLoading] = useState(false)
  const [payoutProfilesTotal,   setPayoutProfilesTotal]   = useState(0)
  const [payoutProfilesPage,    setPayoutProfilesPage]    = useState(1)
  const [payoutProfilesFilter,  setPayoutProfilesFilter]  = useState<'all' | 'pending' | 'verified'>('pending')
  const [verifyModal,           setVerifyModal]           = useState<AdminPayoutProfileSummary | null>(null)
  const [rejectModal,           setRejectModal]           = useState<AdminPayoutProfileSummary | null>(null)

  // Failed refunds state
  const [failedRefunds,        setFailedRefunds]        = useState<FailedRefundSummary[]>([])
  const [failedRefundsLoaded,  setFailedRefundsLoaded]  = useState(false)
  const [failedRefundsLoading, setFailedRefundsLoading] = useState(false)
  const [failedRefundsTotal,   setFailedRefundsTotal]   = useState(0)
  const [failedRefundsPage,    setFailedRefundsPage]    = useState(1)
  const [failedRefundsFilter,  setFailedRefundsFilter]  = useState<'open' | 'retried' | 'resolved' | 'ignored' | 'all'>('open')
  const [failedRefundsStats,   setFailedRefundsStats]   = useState<FailedRefundsStats | null>(null)
  const [retryModal,           setRetryModal]           = useState<FailedRefundSummary | null>(null)
  const [frProcessing,         setFrProcessing]         = useState<string | null>(null)

  // Settlements UI state
  const [filter,         setFilter]         = useState<SettlementFilter>('all')
  const [expanded,       setExpanded]       = useState<{ id: string; action: 'reject' } | null>(null)
  const [noteText,       setNoteText]       = useState('')
  const [processing,     setProcessing]     = useState<string | null>(null) // settlement id being processed
  const [markPaidModal,  setMarkPaidModal]  = useState<AdminSettlement | null>(null)

  // ── Fetch settlements ────────────────────────────────────────────────────────

  const fetchSettlements = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const token = await getToken()
      const res   = await fetch('/api/admin/settlements', {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as AdminSettlementsResponse
      setSettlements(data.settlements)
      setStats(data.stats)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load settlements')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchSettlements() }, [fetchSettlements])

  // ── Fetch transactions (lazy) ─────────────────────────────────────────────────

  const fetchTransactions = useCallback(async (cursor?: string) => {
    setTxnsLoading(true)
    try {
      const token  = await getToken()
      const params = new URLSearchParams({ limit: '50' })
      if (cursor) params.set('cursor', cursor)
      const res  = await fetch(`/api/admin/transactions?${params}`, {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as AdminTransactionsResponse
      setTransactions(prev => cursor ? [...prev, ...data.transactions] : data.transactions)
      setTxnsCursor(data.nextCursor)
      setTxnsHasMore(data.hasMore)
      setTxnsLoaded(true)
    } catch {
      // non-fatal; leave existing list
    } finally {
      setTxnsLoading(false)
    }
  }, [])

  // ── Release engine ────────────────────────────────────────────────────────────

  const fetchReleasePreview = useCallback(async () => {
    setReleasePreviewLoading(true)
    try {
      const token = await getToken()
      const res   = await fetch('/api/admin/finance/release-preview', {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setReleasePreview(await res.json() as ReleasePreviewResponse)
    } catch {
      // non-fatal — leave existing preview data visible
    } finally {
      setReleasePreviewLoading(false)
    }
  }, [])

  const fetchPayoutProfiles = useCallback(async (
    page    = payoutProfilesPage,
    status  = payoutProfilesFilter,
  ) => {
    setPayoutProfilesLoading(true)
    try {
      const token  = await getToken()
      const params = new URLSearchParams({ page: String(page), pageSize: '20', status })
      const res    = await fetch(`/api/admin/payout-profiles?${params}`, {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as AdminPayoutProfilesResponse
      setPayoutProfiles(data.profiles)
      setPayoutProfilesTotal(data.total)
      setPayoutProfilesLoaded(true)
    } catch {
      // non-fatal
    } finally {
      setPayoutProfilesLoading(false)
    }
  }, [payoutProfilesPage, payoutProfilesFilter])

  // Light stats fetch — runs on page load to populate the overview alert card.
  const fetchFailedRefundsStats = useCallback(async () => {
    try {
      const token = await getToken()
      const res   = await fetch('/api/admin/failed-refunds?status=open&pageSize=1', {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) return
      const data = await res.json() as FailedRefundsResponse
      setFailedRefundsStats(data.stats)
    } catch {
      // non-fatal
    }
  }, [])

  const fetchFailedRefunds = useCallback(async (
    page   = failedRefundsPage,
    status = failedRefundsFilter,
  ) => {
    setFailedRefundsLoading(true)
    try {
      const token  = await getToken()
      const params = new URLSearchParams({ page: String(page), pageSize: '20', status })
      const res    = await fetch(`/api/admin/failed-refunds?${params}`, {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as FailedRefundsResponse
      setFailedRefunds(data.refunds)
      setFailedRefundsTotal(data.total)
      setFailedRefundsStats(data.stats)
      setFailedRefundsLoaded(true)
    } catch {
      // non-fatal
    } finally {
      setFailedRefundsLoading(false)
    }
  }, [failedRefundsPage, failedRefundsFilter])

  // Load stats on page mount so the overview alert card is populated immediately.
  useEffect(() => { void fetchFailedRefundsStats() }, [fetchFailedRefundsStats])

  async function runRetry(fr: FailedRefundSummary) {
    const token = await getToken()
    const res   = await fetch(`/api/admin/failed-refunds/${fr.id}/retry`, {
      method:  'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const body = await res.json() as { error?: string }
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    setFailedRefunds(prev => prev.map(r => r.id !== fr.id ? r : { ...r, status: 'retried' as const }))
    setFailedRefundsStats(prev => prev
      ? { ...prev, openCount: Math.max(0, prev.openCount - 1), openAmountPaise: Math.max(0, prev.openAmountPaise - fr.amountPaise) }
      : prev,
    )
  }

  async function runFrAction(id: string, action: 'resolved' | 'ignored') {
    setFrProcessing(id)
    try {
      const token = await getToken()
      const res   = await fetch(`/api/admin/failed-refunds/${id}`, {
        method:  'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body:    JSON.stringify({ action }),
      })
      if (!res.ok) {
        const body = await res.json() as { error?: string }
        showToast(body.error ?? `Action failed (${res.status})`, 'error')
        return
      }
      const fr = failedRefunds.find(r => r.id === id)
      setFailedRefunds(prev => prev.map(r => r.id !== id ? r : { ...r, status: action }))
      if (fr) {
        setFailedRefundsStats(prev => prev
          ? { ...prev, openCount: Math.max(0, prev.openCount - 1), openAmountPaise: Math.max(0, prev.openAmountPaise - fr.amountPaise) }
          : prev,
        )
      }
    } catch {
      showToast('Network error — please try again.', 'error')
    } finally {
      setFrProcessing(null)
    }
  }

  async function runPayoutAction(uid: string, action: 'verify' | 'reject', note?: string) {
    const token = await getToken()
    const res   = await fetch(`/api/admin/payout-profiles/${uid}`, {
      method:  'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body:    JSON.stringify({ action, rejectionNote: note }),
    })
    if (!res.ok) {
      const body = await res.json() as { error?: string }
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    // Optimistic update: remove from list or update isVerified
    setPayoutProfiles(prev => prev.map(p =>
      p.uid !== uid ? p : {
        ...p,
        isVerified:    action === 'verify',
        verifiedAt:    action === 'verify' ? new Date().toISOString() : null,
        verifiedBy:    action === 'verify' ? 'admin' : null,
        rejectionNote: action === 'reject' ? (note ?? null) : null,
      },
    ))
  }

  async function runRelease() {
    setReleaseError(null)
    const token = await getToken()
    const res   = await fetch('/api/admin/finance/release-funds', {
      method:  'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const body = await res.json() as { error?: string }
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    const result = await res.json() as ReleaseFundsResponse
    setReleaseResult(result)
    void fetchReleasePreview()   // refresh counts after release
  }

  const prevTab = useRef<TabId>('overview')
  useEffect(() => {
    if (activeTab === 'transactions' && !txnsLoaded && prevTab.current !== 'transactions') {
      void fetchTransactions()
    }
    prevTab.current = activeTab
  }, [activeTab, txnsLoaded, fetchTransactions])

  useEffect(() => {
    if (activeTab === 'release') {
      void fetchReleasePreview()
    }
  }, [activeTab, fetchReleasePreview])

  useEffect(() => {
    if (activeTab === 'payout-profiles' && !payoutProfilesLoaded) {
      void fetchPayoutProfiles()
    }
  }, [activeTab, payoutProfilesLoaded, fetchPayoutProfiles])

  useEffect(() => {
    if (activeTab === 'failed-refunds' && !failedRefundsLoaded) {
      void fetchFailedRefunds()
    }
  }, [activeTab, failedRefundsLoaded, fetchFailedRefunds])

  // ── Settlement actions ────────────────────────────────────────────────────────

  async function runAction(
    id:     string,
    action: 'approve' | 'reject' | 'paid',
    note?:  string,
    proof?: PayoutProof,
  ) {
    setProcessing(id)
    try {
      const token = await getToken()
      const res   = await fetch(`/api/admin/settlements/${id}`, {
        method:  'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body:    JSON.stringify({ action, adminNote: note ?? '', ...proof }),
      })
      if (!res.ok) {
        const body = await res.json() as { error?: string }
        showToast(body.error ?? `Action failed (${res.status})`, 'error')
        return
      }
      // Optimistic update
      setSettlements(prev => prev.map(s => {
        if (s.id !== id) return s
        const now = new Date().toISOString()
        return {
          ...s,
          status:        action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'paid',
          approvedAt:    action === 'approve' ? now : s.approvedAt,
          paidAt:        action === 'paid'    ? now : s.paidAt,
          adminNote:     note ?? s.adminNote,
          ...(action === 'paid' && proof ? proof : {}),
        } satisfies AdminSettlement
      }))
      setStats(prev => {
        if (!prev) return prev
        const settlement = settlements.find(s => s.id === id)
        if (!settlement) return prev
        const next = { ...prev }
        // Remove from old bucket
        if (settlement.status === 'pending') {
          next.pendingCount--; next.pendingPaise -= settlement.amountPaise
        } else if (settlement.status === 'approved') {
          next.approvedCount--; next.approvedPaise -= settlement.amountPaise
        }
        // Add to new bucket
        if (action === 'approve') { next.approvedCount++; next.approvedPaise += settlement.amountPaise }
        if (action === 'paid')    { next.paidCount++;     next.paidPaise     += settlement.amountPaise }
        if (action === 'reject')  { next.rejectedCount++ }
        next.outstandingPaise = next.pendingPaise + next.approvedPaise
        return next
      })
      setExpanded(null); setNoteText('')
    } catch {
      showToast('Network error — please try again.', 'error')
    } finally {
      setProcessing(null)
    }
  }

  // ─── Derived data ─────────────────────────────────────────────────────────────

  const filtered = settlements.filter(s => filter === 'all' || s.status === filter)

  // ─── Render ───────────────────────────────────────────────────────────────────

  const TABS: { id: TabId; label: string }[] = [
    { id: 'overview',        label: 'Overview' },
    { id: 'settlements',     label: `Settlements${stats ? ` (${stats.pendingCount + stats.approvedCount} active)` : ''}` },
    { id: 'transactions',    label: 'Transactions' },
    { id: 'release',         label: 'Release Engine' },
    { id: 'payout-profiles', label: 'Payout Profiles' },
    {
      id:    'failed-refunds',
      label: failedRefundsStats && failedRefundsStats.openCount > 0
        ? `Failed Refunds (${failedRefundsStats.openCount})`
        : 'Failed Refunds',
    },
  ]

  return (
    <div className="space-y-6">

      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">Finance Console</h1>
          <p className="mt-0.5 text-[13.5px] text-muted-foreground">
            Manage settlement requests and review platform transactions.
          </p>
        </div>
        <button
          onClick={() => { void fetchSettlements() }}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden />
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="border-b border-border">
        <nav className="-mb-px flex gap-1" aria-label="Finance tabs">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={cn(
                'px-4 py-2.5 text-[13.5px] font-medium transition-colors border-b-2',
                activeTab === t.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* ── Error state ── */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          <AlertCircle className="size-4 shrink-0" aria-hidden />
          {error}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* OVERVIEW TAB                                                          */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Failed refunds alert — always visible when there are open records */}
          {failedRefundsStats && failedRefundsStats.openCount > 0 && (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-4 dark:border-red-800 dark:bg-red-900/20">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
                <div>
                  <p className="text-[14px] font-semibold text-red-800 dark:text-red-300">
                    {failedRefundsStats.openCount} Failed Refund{failedRefundsStats.openCount !== 1 ? 's' : ''} Require Attention
                  </p>
                  <p className="mt-0.5 text-[13px] text-red-700 dark:text-red-400">
                    {paise(failedRefundsStats.openAmountPaise)} total outstanding
                    {failedRefundsStats.oldestOpenCreatedAt && (
                      <> · Oldest: {relativeAge(failedRefundsStats.oldestOpenCreatedAt)}</>
                    )}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setActiveTab('failed-refunds')}
                className="shrink-0 rounded-lg border border-red-300 bg-red-100 px-3 py-1.5 text-[12.5px] font-semibold text-red-800 transition-colors hover:bg-red-200 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
              >
                View →
              </button>
            </div>
          )}

          {loading ? (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-[100px] animate-pulse rounded-xl bg-muted" />
              ))}
            </div>
          ) : stats ? (
            <>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <KpiCard
                  label="Pending Requests"
                  value={String(stats.pendingCount)}
                  sub={paise(stats.pendingPaise)}
                  icon={Clock}
                  accent="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                />
                <KpiCard
                  label="Approved (awaiting payment)"
                  value={String(stats.approvedCount)}
                  sub={paise(stats.approvedPaise)}
                  icon={CheckCircle2}
                  accent="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                />
                <KpiCard
                  label="Total Paid Out"
                  value={String(stats.paidCount)}
                  sub={paise(stats.paidPaise)}
                  icon={DollarSign}
                  accent="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                />
                <KpiCard
                  label="Outstanding Liability"
                  value={paise(stats.outstandingPaise)}
                  sub="pending + approved"
                  icon={AlertCircle}
                  accent="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                />
              </div>

              {/* Recent pending settlements */}
              {stats.pendingCount > 0 && (
                <div className="rounded-xl border border-border bg-card shadow-sm">
                  <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
                    <p className="text-[13.5px] font-semibold text-foreground">Needs Attention</p>
                    <button
                      onClick={() => setActiveTab('settlements')}
                      className="text-[12.5px] font-medium text-primary hover:underline"
                    >
                      View all →
                    </button>
                  </div>
                  <div className="divide-y divide-border">
                    {settlements
                      .filter(s => s.status === 'pending')
                      .slice(0, 5)
                      .map(s => (
                        <div key={s.id} className="flex items-center justify-between px-5 py-3.5">
                          <div className="min-w-0">
                            <p className="truncate text-[13.5px] font-medium text-foreground">
                              {s.organizerName || s.organizerEmail || s.organizerUid}
                            </p>
                            <p className="text-[12px] text-muted-foreground">
                              {s.organizationName} · Requested {fmtDate(s.requestedAt)}
                            </p>
                          </div>
                          <div className="ml-4 flex items-center gap-3">
                            <span className="text-[14px] font-semibold text-foreground">{paise(s.amountPaise)}</span>
                            <button
                              onClick={() => { setActiveTab('settlements'); setFilter('pending') }}
                              className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:opacity-90"
                            >
                              Review
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {stats.pendingCount === 0 && stats.approvedCount === 0 && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-14 text-center">
                  <CheckCircle2 className="mb-3 size-8 text-emerald-500" aria-hidden />
                  <p className="text-[14px] font-medium text-foreground">All clear</p>
                  <p className="mt-1 text-[13px] text-muted-foreground">No pending or approved settlement requests.</p>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* SETTLEMENTS TAB                                                       */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'settlements' && (
        <div className="space-y-4">

          {/* Filter pills */}
          <div className="flex flex-wrap gap-2">
            {(['all', 'pending', 'approved', 'paid', 'rejected'] as SettlementFilter[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-full px-3.5 py-1 text-[12.5px] font-medium capitalize transition-colors',
                  filter === f
                    ? 'bg-primary text-primary-foreground'
                    : 'border border-border bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                {f === 'all' ? `All (${settlements.length})` : (
                  f === 'pending'  ? `Pending (${stats?.pendingCount ?? 0})` :
                  f === 'approved' ? `Approved (${stats?.approvedCount ?? 0})` :
                  f === 'paid'     ? `Paid (${stats?.paidCount ?? 0})` :
                                     `Rejected (${stats?.rejectedCount ?? 0})`
                )}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-[72px] animate-pulse rounded-xl bg-muted" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-14 text-center">
              <DollarSign className="mb-3 size-8 text-muted-foreground/40" aria-hidden />
              <p className="text-[13.5px] text-muted-foreground">No {filter !== 'all' ? filter : ''} settlements found.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <table className="w-full text-left text-[13.5px]">
                <thead className="border-b border-border bg-muted/40">
                  <tr>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">Organizer</th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">Amount</th>
                    <th className="hidden px-4 py-3 font-semibold text-muted-foreground md:table-cell">Requested</th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">Status</th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map(s => {
                    const isExpanded = expanded?.id === s.id
                    const busy = processing === s.id
                    return (
                      <>
                        <tr key={s.id} className="transition-colors hover:bg-muted/30">
                          <td className="px-4 py-3.5">
                            <p className="font-medium text-foreground">
                              {s.organizerName || s.organizerEmail || s.organizerUid}
                            </p>
                            {s.organizationName && (
                              <p className="text-[12px] text-muted-foreground">{s.organizationName}</p>
                            )}
                          </td>
                          <td className="px-4 py-3.5 font-semibold text-foreground">{paise(s.amountPaise)}</td>
                          <td className="hidden px-4 py-3.5 text-muted-foreground md:table-cell">
                            {fmtDate(s.requestedAt)}
                          </td>
                          <td className="px-4 py-3.5">
                            <StatusBadge status={s.status} />
                          </td>
                          <td className="px-4 py-3.5">
                            <div className="flex items-center gap-2">
                              {/* pending actions */}
                              {s.status === 'pending' && (
                                <>
                                  <button
                                    disabled={busy}
                                    onClick={async () => {
                                      const ok = await confirm({
                                        title: 'Approve settlement?',
                                        message: `Approve ${paise(s.amountPaise)} to ${s.organizerName || s.organizerEmail}? This authorises the payout for processing.`,
                                        confirmLabel: 'Approve',
                                        tone: 'danger',
                                      })
                                      if (ok) await runAction(s.id, 'approve')
                                    }}
                                    className="rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    disabled={busy}
                                    onClick={() => {
                                      if (isExpanded && expanded?.action === 'reject') {
                                        setExpanded(null)
                                      } else {
                                        setExpanded({ id: s.id, action: 'reject' })
                                        setNoteText(s.adminNote)
                                      }
                                    }}
                                    className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                                  >
                                    Reject
                                    {isExpanded && expanded?.action === 'reject'
                                      ? <ChevronUp className="size-3" />
                                      : <ChevronDown className="size-3" />}
                                  </button>
                                </>
                              )}
                              {/* approved actions */}
                              {s.status === 'approved' && (
                                <>
                                  <button
                                    disabled={busy}
                                    onClick={() => setMarkPaidModal(s)}
                                    className="rounded-md bg-emerald-600 px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                                  >
                                    Mark Paid
                                  </button>
                                  <button
                                    disabled={busy}
                                    onClick={() => {
                                      if (isExpanded && expanded?.action === 'reject') {
                                        setExpanded(null)
                                      } else {
                                        setExpanded({ id: s.id, action: 'reject' })
                                        setNoteText(s.adminNote)
                                      }
                                    }}
                                    className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                                  >
                                    Reject
                                    {isExpanded && expanded?.action === 'reject'
                                      ? <ChevronUp className="size-3" />
                                      : <ChevronDown className="size-3" />}
                                  </button>
                                </>
                              )}
                              {/* terminal states */}
                              {(s.status === 'paid' || s.status === 'rejected') && (
                                <div className="text-[12px] text-muted-foreground">
                                  {s.status === 'paid' ? (
                                    <>
                                      <span>Paid {fmtDate(s.paidAt)}</span>
                                      {s.utrNumber && (
                                        <span className="mt-0.5 block font-mono text-[11px]">
                                          UTR: {s.utrNumber}
                                        </span>
                                      )}
                                    </>
                                  ) : 'Rejected'}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>

                        {/* Inline expanded note input — reject only */}
                        {isExpanded && (
                          <tr key={`${s.id}-expand`} className="bg-muted/20">
                            <td colSpan={5} className="px-4 pb-4 pt-2">
                              <div className="flex items-end gap-3">
                                <div className="flex-1">
                                  <label className="mb-1 block text-[12px] font-medium text-muted-foreground">
                                    Reason for rejection
                                  </label>
                                  <input
                                    type="text"
                                    value={noteText}
                                    onChange={e => setNoteText(e.target.value)}
                                    placeholder="e.g. Insufficient documentation"
                                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                  />
                                </div>
                                <button
                                  disabled={busy}
                                  onClick={() => runAction(s.id, 'reject', noteText)}
                                  className="shrink-0 rounded-lg bg-red-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                                >
                                  {busy ? 'Processing…' : 'Confirm Reject'}
                                </button>
                                <button
                                  disabled={busy}
                                  onClick={() => { setExpanded(null); setNoteText('') }}
                                  className="shrink-0 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
                                >
                                  Cancel
                                </button>
                              </div>
                              {s.adminNote && (
                                <p className="mt-2 text-[12px] text-muted-foreground">
                                  Existing note: {s.adminNote}
                                </p>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* TRANSACTIONS TAB                                                      */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'transactions' && (
        <div className="space-y-4">
          {txnsLoading && !txnsLoaded ? (
            <div className="space-y-2">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="h-[64px] animate-pulse rounded-xl bg-muted" />
              ))}
            </div>
          ) : transactions.length === 0 && !txnsLoading ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-14 text-center">
              <DollarSign className="mb-3 size-8 text-muted-foreground/40" aria-hidden />
              <p className="text-[13.5px] text-muted-foreground">No platform transactions found.</p>
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                <table className="w-full text-left text-[13.5px]">
                  <thead className="border-b border-border bg-muted/40">
                    <tr>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Date</th>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Organizer</th>
                      <th className="hidden px-4 py-3 font-semibold text-muted-foreground md:table-cell">Payer</th>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Gross</th>
                      <th className="hidden px-4 py-3 font-semibold text-muted-foreground lg:table-cell">Platform Fee</th>
                      <th className="hidden px-4 py-3 font-semibold text-muted-foreground lg:table-cell">Net</th>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {transactions.map(t => (
                      <tr key={t.id} className="transition-colors hover:bg-muted/30">
                        <td className="px-4 py-3 text-muted-foreground">{fmtDateTime(t.paidAt)}</td>
                        <td className="px-4 py-3">
                          <span className="font-mono text-[12px] text-muted-foreground">{t.organizerUid.slice(0, 8)}…</span>
                        </td>
                        <td className="hidden px-4 py-3 text-foreground md:table-cell">{t.payerName}</td>
                        <td className="px-4 py-3 font-semibold text-foreground">{paise(t.grossAmountPaise)}</td>
                        <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">
                          {paise(t.platformFeeTotalPaise)}
                        </td>
                        <td className="hidden px-4 py-3 font-medium text-emerald-700 dark:text-emerald-400 lg:table-cell">
                          {paise(t.netSettlementPaise)}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={t.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {txnsHasMore && (
                <div className="flex justify-center">
                  <button
                    onClick={() => { if (txnsCursor) void fetchTransactions(txnsCursor) }}
                    disabled={txnsLoading}
                    className="rounded-lg border border-border bg-card px-5 py-2.5 text-[13px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    {txnsLoading ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* RELEASE ENGINE TAB                                                   */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'release' && (
        <div className="space-y-4">

          {/* Success banner */}
          {releaseResult && (
            <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4 dark:border-emerald-800 dark:bg-emerald-900/20">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <div>
                <p className="text-[14px] font-semibold text-emerald-800 dark:text-emerald-300">Release Complete</p>
                <p className="mt-0.5 text-[13px] text-emerald-700 dark:text-emerald-400">
                  Released {releaseResult.releasedTransactions} transaction{releaseResult.releasedTransactions !== 1 ? 's' : ''} · {paise(releaseResult.releasedAmountPaise)}
                  {releaseResult.skippedTransactions > 0 && ` · ${releaseResult.skippedTransactions} skipped`}
                </p>
              </div>
            </div>
          )}

          {/* Error banner */}
          {releaseError && (
            <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-5 py-4 text-[13.5px] text-destructive">
              <AlertCircle className="size-4 shrink-0" aria-hidden />
              {releaseError}
            </div>
          )}

          {/* Engine card */}
          <div className="rounded-xl border border-border bg-card shadow-sm">
            {/* Card header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Zap className="size-4" aria-hidden />
                </div>
                <div>
                  <p className="text-[14px] font-semibold text-foreground">T+2 Release Engine</p>
                  <p className="text-[12px] text-muted-foreground">
                    Moves net proceeds held ≥ 48 h from pending → available balance.
                  </p>
                </div>
              </div>
              <button
                onClick={() => void fetchReleasePreview()}
                disabled={releasePreviewLoading}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                <RefreshCw className={cn('size-3', releasePreviewLoading && 'animate-spin')} aria-hidden />
                Refresh
              </button>
            </div>

            {/* Card body */}
            <div className="px-5 py-5">
              {releasePreviewLoading && !releasePreview ? (
                <div className="grid grid-cols-3 gap-4">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="h-[76px] animate-pulse rounded-lg bg-muted" />
                  ))}
                </div>
              ) : releasePreview ? (
                <div className="space-y-5">
                  {/* Metric tiles */}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3.5">
                      <p className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                        Eligible Transactions
                      </p>
                      <p className="mt-1.5 text-[24px] font-bold leading-none text-foreground">
                        {releasePreview.eligibleTransactions}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3.5">
                      <p className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                        Eligible Amount
                      </p>
                      <p className="mt-1.5 text-[24px] font-bold leading-none text-foreground">
                        {paise(releasePreview.eligibleAmountPaise)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3.5">
                      <p className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                        Last Release Run
                      </p>
                      <p className={cn(
                        'mt-1.5 text-[13.5px] font-medium leading-snug',
                        releasePreview.latestReleaseAt ? 'text-foreground' : 'text-muted-foreground',
                      )}>
                        {fmtDateTime(releasePreview.latestReleaseAt)}
                      </p>
                    </div>
                  </div>

                  {/* Action row */}
                  <div className="flex items-center justify-end">
                    <button
                      disabled={releasePreview.eligibleTransactions === 0}
                      onClick={() => setReleaseModal(true)}
                      className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-[13.5px] font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Zap className="size-4" aria-hidden />
                      Release Eligible Funds
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* PAYOUT PROFILES TAB                                                  */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'payout-profiles' && (
        <div className="space-y-4">

          {/* Filter pills + refresh */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {(['pending', 'verified', 'all'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => {
                    setPayoutProfilesFilter(f)
                    setPayoutProfilesPage(1)
                    setPayoutProfilesLoaded(false)
                    void fetchPayoutProfiles(1, f)
                  }}
                  className={cn(
                    'rounded-full px-3.5 py-1 text-[12.5px] font-medium capitalize transition-colors',
                    payoutProfilesFilter === f
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border bg-card text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f === 'pending' ? 'Pending Review' : f === 'verified' ? 'Verified' : 'All'}
                </button>
              ))}
            </div>
            <button
              onClick={() => { setPayoutProfilesLoaded(false); void fetchPayoutProfiles(payoutProfilesPage, payoutProfilesFilter) }}
              disabled={payoutProfilesLoading}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3', payoutProfilesLoading && 'animate-spin')} aria-hidden />
              Refresh
            </button>
          </div>

          {payoutProfilesLoading && !payoutProfilesLoaded ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-[72px] animate-pulse rounded-xl bg-muted" />
              ))}
            </div>
          ) : payoutProfiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-14 text-center">
              <ShieldCheck className="mb-3 size-8 text-muted-foreground/40" aria-hidden />
              <p className="text-[13.5px] text-muted-foreground">
                No {payoutProfilesFilter !== 'all' ? payoutProfilesFilter : ''} payout profiles found.
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                <table className="w-full text-left text-[13.5px]">
                  <thead className="border-b border-border bg-muted/40">
                    <tr>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Organizer</th>
                      <th className="hidden px-4 py-3 font-semibold text-muted-foreground md:table-cell">Account</th>
                      <th className="hidden px-4 py-3 font-semibold text-muted-foreground lg:table-cell">PAN</th>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Status</th>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {payoutProfiles.map(p => (
                      <tr key={p.uid} className="transition-colors hover:bg-muted/30">
                        <td className="px-4 py-3.5">
                          <p className="font-medium text-foreground">{p.organizerName}</p>
                          <p className="text-[12px] text-muted-foreground">{p.organizerEmail}</p>
                          <p className="text-[12px] text-muted-foreground">{p.accountHolderName}</p>
                        </td>
                        <td className="hidden px-4 py-3.5 md:table-cell">
                          {p.payoutMethod === 'bank' ? (
                            <div className="space-y-0.5">
                              <p className="font-mono text-[12.5px] text-foreground">{p.accountNumberMasked ?? '—'}</p>
                              {p.bankName && <p className="text-[12px] text-muted-foreground">{p.bankName}</p>}
                              {p.ifscCode && <p className="font-mono text-[11.5px] text-muted-foreground">{p.ifscCode}</p>}
                            </div>
                          ) : (
                            <p className="font-mono text-[12.5px] text-foreground">{p.upiId ?? '—'}</p>
                          )}
                        </td>
                        <td className="hidden px-4 py-3.5 font-mono text-[12.5px] text-foreground lg:table-cell">
                          {p.panNumberMasked ?? '—'}
                        </td>
                        <td className="px-4 py-3.5">
                          {p.isVerified ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                              <ShieldCheck className="size-3" aria-hidden /> Verified
                            </span>
                          ) : p.rejectionNote ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-[11px] font-semibold text-red-800 dark:bg-red-900/30 dark:text-red-300">
                              <ShieldX className="size-3" aria-hidden /> Rejected
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                              <Clock className="size-3" aria-hidden /> Pending
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2">
                            {!p.isVerified && (
                              <button
                                onClick={() => setVerifyModal(p)}
                                className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-700"
                              >
                                <ShieldCheck className="size-3" aria-hidden /> Verify
                              </button>
                            )}
                            <button
                              onClick={() => setRejectModal(p)}
                              className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground"
                            >
                              <ShieldX className="size-3" aria-hidden /> Reject
                            </button>
                          </div>
                          {p.rejectionNote && (
                            <p className="mt-1 text-[11.5px] text-muted-foreground line-clamp-1" title={p.rejectionNote}>
                              Note: {p.rejectionNote}
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {payoutProfilesTotal > 20 && (
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-muted-foreground">
                    Showing {(payoutProfilesPage - 1) * 20 + 1}–{Math.min(payoutProfilesPage * 20, payoutProfilesTotal)} of {payoutProfilesTotal}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={payoutProfilesPage <= 1 || payoutProfilesLoading}
                      onClick={() => {
                        const p = payoutProfilesPage - 1
                        setPayoutProfilesPage(p)
                        void fetchPayoutProfiles(p, payoutProfilesFilter)
                      }}
                      className="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      Previous
                    </button>
                    <button
                      disabled={payoutProfilesPage * 20 >= payoutProfilesTotal || payoutProfilesLoading}
                      onClick={() => {
                        const p = payoutProfilesPage + 1
                        setPayoutProfilesPage(p)
                        void fetchPayoutProfiles(p, payoutProfilesFilter)
                      }}
                      className="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* FAILED REFUNDS TAB                                                   */}
      {/* ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'failed-refunds' && (
        <div className="space-y-4">

          {/* Filter pills + refresh */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {(['open', 'retried', 'resolved', 'ignored', 'all'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => {
                    setFailedRefundsFilter(f)
                    setFailedRefundsPage(1)
                    setFailedRefundsLoaded(false)
                    void fetchFailedRefunds(1, f)
                  }}
                  className={cn(
                    'rounded-full px-3.5 py-1 text-[12.5px] font-medium capitalize transition-colors',
                    failedRefundsFilter === f
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border bg-card text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            <button
              onClick={() => { setFailedRefundsLoaded(false); void fetchFailedRefunds(failedRefundsPage, failedRefundsFilter) }}
              disabled={failedRefundsLoading}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3', failedRefundsLoading && 'animate-spin')} aria-hidden />
              Refresh
            </button>
          </div>

          {failedRefundsLoading && !failedRefundsLoaded ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-[72px] animate-pulse rounded-xl bg-muted" />
              ))}
            </div>
          ) : failedRefunds.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-14 text-center">
              <CheckCircle2 className="mb-3 size-8 text-emerald-500" aria-hidden />
              <p className="text-[14px] font-medium text-foreground">
                {failedRefundsFilter === 'open' ? 'No open failed refunds' : `No ${failedRefundsFilter} records`}
              </p>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {failedRefundsFilter === 'open' ? 'All refund failures have been addressed.' : 'Nothing to show for this filter.'}
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                <table className="w-full text-left text-[13.5px]">
                  <thead className="border-b border-border bg-muted/40">
                    <tr>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Created</th>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Attendee</th>
                      <th className="hidden px-4 py-3 font-semibold text-muted-foreground md:table-cell">Event</th>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Amount</th>
                      <th className="hidden px-4 py-3 font-semibold text-muted-foreground lg:table-cell">Reason</th>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Status</th>
                      <th className="px-4 py-3 font-semibold text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {failedRefunds.map(fr => {
                      const busy = frProcessing === fr.id
                      return (
                        <tr key={fr.id} className="transition-colors hover:bg-muted/30">
                          <td className="px-4 py-3.5 text-[12px] text-muted-foreground">
                            {fmtDate(fr.createdAt)}
                          </td>
                          <td className="px-4 py-3.5">
                            <p className="text-[13px] text-foreground">{fr.attendeeEmail}</p>
                            <p className="font-mono text-[11px] text-muted-foreground">{fr.paymentId}</p>
                          </td>
                          <td className="hidden px-4 py-3.5 text-[13px] text-muted-foreground md:table-cell">
                            {fr.eventSlug}
                          </td>
                          <td className="px-4 py-3.5 font-semibold text-foreground">{paise(fr.amountPaise)}</td>
                          <td className="hidden px-4 py-3.5 text-[12.5px] text-muted-foreground lg:table-cell">
                            <span className="line-clamp-2" title={fr.reason}>{fr.reason}</span>
                          </td>
                          <td className="px-4 py-3.5">
                            <StatusBadge status={fr.status} />
                          </td>
                          <td className="px-4 py-3.5">
                            {fr.status === 'open' && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <button
                                  disabled={busy}
                                  onClick={() => setRetryModal(fr)}
                                  className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                                >
                                  <RotateCcw className="size-3" aria-hidden /> Retry
                                </button>
                                <button
                                  disabled={busy}
                                  onClick={() => void runFrAction(fr.id, 'resolved')}
                                  className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                                >
                                  <CheckCircle2 className="size-3" aria-hidden /> Resolve
                                </button>
                                <button
                                  disabled={busy}
                                  onClick={() => void runFrAction(fr.id, 'ignored')}
                                  className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                                >
                                  <X className="size-3" aria-hidden /> Ignore
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {failedRefundsTotal > 20 && (
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-muted-foreground">
                    Showing {(failedRefundsPage - 1) * 20 + 1}–{Math.min(failedRefundsPage * 20, failedRefundsTotal)} of {failedRefundsTotal}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={failedRefundsPage <= 1 || failedRefundsLoading}
                      onClick={() => {
                        const p = failedRefundsPage - 1
                        setFailedRefundsPage(p)
                        void fetchFailedRefunds(p, failedRefundsFilter)
                      }}
                      className="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      Previous
                    </button>
                    <button
                      disabled={failedRefundsPage * 20 >= failedRefundsTotal || failedRefundsLoading}
                      onClick={() => {
                        const p = failedRefundsPage + 1
                        setFailedRefundsPage(p)
                        void fetchFailedRefunds(p, failedRefundsFilter)
                      }}
                      className="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Mark Paid modal ── */}
      {markPaidModal && (
        <MarkPaidModal
          settlement={markPaidModal}
          onClose={() => setMarkPaidModal(null)}
          onConfirm={async (proof, note) => {
            await runAction(markPaidModal.id, 'paid', note, proof)
          }}
        />
      )}

      {/* ── Release Funds confirmation modal ── */}
      {releaseModal && releasePreview && (
        <ReleaseFundsModal
          preview={releasePreview}
          onClose={() => setReleaseModal(false)}
          onConfirm={runRelease}
        />
      )}

      {/* ── Verify Payout Profile modal ── */}
      {verifyModal && (
        <VerifyProfileModal
          profile={verifyModal}
          onClose={() => setVerifyModal(null)}
          onConfirm={() => runPayoutAction(verifyModal.uid, 'verify')}
        />
      )}

      {/* ── Reject Payout Profile modal ── */}
      {rejectModal && (
        <RejectProfileModal
          profile={rejectModal}
          onClose={() => setRejectModal(null)}
          onConfirm={(note) => runPayoutAction(rejectModal.uid, 'reject', note)}
        />
      )}

      {/* ── Retry Refund modal ── */}
      {retryModal && (
        <RetryRefundModal
          refund={retryModal}
          onClose={() => setRetryModal(null)}
          onConfirm={() => runRetry(retryModal)}
        />
      )}
    </div>
  )
}
