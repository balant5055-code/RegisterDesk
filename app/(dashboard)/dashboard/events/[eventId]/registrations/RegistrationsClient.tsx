'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams }           from 'next/navigation'
import { onAuthStateChanged }    from 'firebase/auth'
import { auth }                  from '@/lib/firebase/auth'
import Link                      from 'next/link'
import { cn }                    from '@/lib/utils/cn'
import { csvCell as csvEscape }  from '@/lib/utils/csv'
import {
  Search, Filter, Download, Upload, X, ChevronLeft, ChevronRight,
  Users, CheckCircle, Clock, XCircle, RotateCcw,
  Ticket, Mail, Phone, Calendar, Tag, Eye, Send, Loader2,
  FileDown, BanIcon, Undo2, ChevronDown, ChevronUp,
  AlertTriangle, History, RotateCw, Pencil,
} from 'lucide-react'
import type { SerializedRegistration, RegistrationsApiResponse } from '@/app/api/organizer/events/[eventId]/registrations/route'
import { registrationStatusCls } from '@/lib/ui/statusColors'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import type { ResendEmailResponse } from '@/app/api/organizer/registrations/[registrationId]/resend-email/route'
import type { CancelRegistrationResponse } from '@/app/api/organizer/registrations/[registrationId]/cancel/route'
import type { RestoreRegistrationResponse } from '@/app/api/organizer/registrations/[registrationId]/restore/route'
import type { AuditLogResponse, SerializedAuditEntry } from '@/app/api/organizer/registrations/[registrationId]/audit/route'
import type { RefundRegistrationResponse } from '@/app/api/organizer/registrations/[registrationId]/refund/route'
import type { EditRegistrationResponse } from '@/app/api/organizer/registrations/[registrationId]/route'
import type { UndoCheckInResponse } from '@/app/api/organizer/registrations/[registrationId]/undo-checkin/route'
import type { BulkActionResponse }   from '@/app/api/organizer/events/[eventId]/registrations/bulk/route'
import type { CreateBulkJobResponse, SerializedBulkJob } from '@/app/api/organizer/events/[eventId]/registrations/bulk-jobs/route'
import type { ProcessBulkJobResponse } from '@/app/api/organizer/events/[eventId]/registrations/bulk-jobs/[jobId]/process/route'
import { ImportParticipantsDrawer }  from './ImportParticipantsDrawer'
import ParticipantWorkspace360       from './ParticipantWorkspace360'
import type { BulkApproveResponse }  from '@/app/api/organizer/registrations/bulk-approve/route'
import type { BulkRejectResponse }   from '@/app/api/organizer/registrations/bulk-reject/route'
import type { ApproveRegistrationResponse } from '@/app/api/organizer/registrations/[registrationId]/approve/route'
import type { RejectRegistrationResponse }  from '@/app/api/organizer/registrations/[registrationId]/reject/route'

// ─── Types ────────────────────────────────────────────────────────────────────

type SortKey = 'registeredAt' | 'name' | 'status'
type SortDir = 'asc' | 'desc'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const editInputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none focus:ring-2 focus:ring-primary/30'

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtDateShort(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

const STATUS_LABELS: Record<string, string> = {
  confirmed:  'Confirmed',
  pending:    'Pending',
  cancelled:  'Cancelled',
  waitlisted: 'Waitlisted',
  rejected:   'Rejected',
}

function statusMeta(status: string): { label: string; cls: string } {
  return {
    label: STATUS_LABELS[status] ?? status,
    cls:   registrationStatusCls[status] ?? 'bg-muted text-muted-foreground',
  }
}

function fmtINR(paise: number): string {
  if (paise === 0) return 'Free'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100)
}

function auditActionLabel(action: string): string {
  switch (action) {
    case 'created':     return 'Registration created'
    case 'email_sent':  return 'Ticket email sent'
    case 'email_resent': return 'Ticket email resent'
    case 'cancelled':   return 'Registration cancelled'
    case 'restored':    return 'Registration restored'
    case 'checked_in':       return 'Checked in'
    case 'check_in_undone':  return 'Check-in undone'
    case 'refunded':         return 'Refund issued'
    case 'approved':    return 'Registration approved'
    case 'rejected':    return 'Registration rejected'
    case 'updated':     return 'Details edited'
    default:            return action
  }
}

function auditActionColor(action: string): string {
  switch (action) {
    case 'cancelled':   return 'text-red-600'
    case 'restored':    return 'text-emerald-600'
    case 'checked_in':       return 'text-sky-600'
    case 'check_in_undone':  return 'text-sky-400'
    case 'refunded':         return 'text-amber-600'
    case 'email_sent':
    case 'email_resent': return 'text-violet-600'
    case 'approved':    return 'text-emerald-600'
    case 'rejected':    return 'text-rose-600'
    case 'updated':     return 'text-indigo-600'
    default:            return 'text-muted-foreground'
  }
}

function exportToCsv(rows: SerializedRegistration[], slug: string, fieldLabels: Record<string, string>) {
  const formFieldIds = Object.keys(fieldLabels)
  const headers = [
    'Ticket Code', 'Name', 'Email', 'Phone', 'Pass',
    'Status', 'Payment Status', 'Check-In', 'Checked-In At',
    'Refund Status', 'Refund Amount (INR)', 'Registered At',
    ...formFieldIds.map(id => fieldLabels[id] ?? id),
  ]
  const body = rows.map(r => {
    const isRefunded = r.paymentStatus === 'refunded'
    const baseRow = [
      r.ticketCode,
      r.attendee.name,
      r.attendee.email,
      r.attendee.phone ?? '',
      r.passName,
      r.status,
      r.paymentStatus,
      r.checkedIn ? 'Yes' : 'No',
      r.checkedInAt ?? '',
      isRefunded ? 'Yes' : 'No',
      isRefunded && r.refundAmount ? String(r.refundAmount / 100) : '',
      r.registeredAt ?? '',
    ]
    const formCols = formFieldIds.map(id => {
      const responses = r.attendee.formResponses as Record<string, unknown> | undefined
      return responses?.[id] ?? ''
    })
    return [...baseRow, ...formCols].map(csvEscape).join(',')
  })
  const csv  = [headers.join(','), ...body].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `registrations-${slug}-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function recomputeStats(registrations: SerializedRegistration[]) {
  return {
    total:      registrations.length,
    confirmed:  registrations.filter(r => r.status === 'confirmed').length,
    pending:    registrations.filter(r => r.status === 'pending').length,
    cancelled:  registrations.filter(r => r.status === 'cancelled').length,
    waitlisted: registrations.filter(r => r.status === 'waitlisted').length,
    rejected:   registrations.filter(r => r.status === 'rejected').length,
    checkedIn:  registrations.filter(r => r.checkedIn).length,
  }
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatChip({
  icon: Icon, label, value, color,
}: {
  icon: React.ElementType; label: string; value: number; color: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 shadow-sm">
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-4" aria-hidden />
      </div>
      <div>
        <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="text-[22px] font-bold tabular-nums text-foreground">{value}</p>
      </div>
    </div>
  )
}

// ─── Confirmation Dialog ──────────────────────────────────────────────────────

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Keep Registration',
  confirmCls,
  onConfirm,
  onCancel,
  loading,
}: {
  title:         string
  body:          React.ReactNode
  confirmLabel:  string
  cancelLabel?:  string
  confirmCls:    string
  onConfirm:     () => void
  onCancel:      () => void
  loading:       boolean
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>()
  return (
    <>
      {/* Backdrop — z-40 beneath the modal at z-50 */}
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onCancel} aria-hidden />
      {/* Modal — z-50 */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="pointer-events-auto w-full max-w-sm rounded-2xl border border-border bg-background p-6 shadow-2xl"
      >
        <div className="mb-3 flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-red-100">
            <AlertTriangle className="size-4 text-red-600" aria-hidden />
          </div>
          <div>
            <p className="text-[14.5px] font-bold text-foreground">{title}</p>
            <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{body}</div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-xl border border-border px-4 py-2 text-[14px] font-medium hover:bg-muted/50 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'flex items-center gap-1.5 rounded-xl px-4 py-2 text-[14px] font-semibold text-white disabled:opacity-50',
              confirmCls,
            )}
          >
            {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {confirmLabel}
          </button>
        </div>
      </div>
      </div>
    </>
  )
}

// ─── Registration Drawer ──────────────────────────────────────────────────────

function RegistrationDrawer({
  reg,
  eventId,
  fieldLabels,
  token,
  onClose,
  onUpdate,
}: {
  reg:         SerializedRegistration
  eventId:     string
  fieldLabels: Record<string, string>
  token:       string
  onClose:     () => void
  onUpdate:    (updates: Partial<SerializedRegistration>) => void
}) {
  const formResponses = reg.attendee.formResponses as Record<string, unknown> | null | undefined
  const { confirm } = useConfirm()

  // ── Local state (updates immediately after actions) ───────────────────────
  const [localStatus,        setLocalStatus]        = useState(reg.status)
  const [localPaymentStatus, setLocalPaymentStatus] = useState(reg.paymentStatus)

  // Sync if parent re-renders with different values (e.g., after re-fetch)
  /* eslint-disable react-hooks/set-state-in-effect -- prop→state sync */
  useEffect(() => { setLocalStatus(reg.status) },        [reg.status])
  useEffect(() => { setLocalPaymentStatus(reg.paymentStatus) }, [reg.paymentStatus])

  const [localCheckedIn, setLocalCheckedIn] = useState(reg.checkedIn)
  useEffect(() => { setLocalCheckedIn(reg.checkedIn) }, [reg.checkedIn])
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Edit attendee details ──────────────────────────────────────────────────
  const responseEntries = Object.entries(formResponses ?? {})
    .filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v))
  const [editing,   setEditing]   = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [eName,  setEName]  = useState(reg.attendee.name)
  const [eEmail, setEEmail] = useState(reg.attendee.email)
  const [ePhone, setEPhone] = useState(reg.attendee.phone ?? '')
  const [eResp,  setEResp]  = useState<Record<string, string>>(
    () => Object.fromEntries(responseEntries.map(([k, v]) => [k, v == null ? '' : String(v)])),
  )

  const editDirty =
    eName !== reg.attendee.name ||
    eEmail !== reg.attendee.email ||
    ePhone !== (reg.attendee.phone ?? '') ||
    responseEntries.some(([k, v]) => eResp[k] !== (v == null ? '' : String(v)))

  function resetEdit() {
    setEName(reg.attendee.name)
    setEEmail(reg.attendee.email)
    setEPhone(reg.attendee.phone ?? '')
    setEResp(Object.fromEntries(responseEntries.map(([k, v]) => [k, v == null ? '' : String(v)])))
    setEditError(null)
  }

  async function cancelEdit() {
    if (editDirty && !(await confirm({ message: 'Discard your unsaved changes?', tone: 'danger' }))) return
    resetEdit()
    setEditing(false)
  }

  // Warn on tab close while there are unsaved edits.
  useEffect(() => {
    if (!editing || !editDirty) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [editing, editDirty])

  async function handleSaveEdit() {
    if (savingEdit || !token) return
    setSavingEdit(true)
    setEditError(null)
    try {
      // Send only changed primitive responses, merged over the originals.
      const mergedResponses: Record<string, unknown> = { ...(formResponses ?? {}) }
      for (const [k] of responseEntries) mergedResponses[k] = eResp[k]

      const res = await fetch(`/api/organizer/registrations/${reg.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          name:  eName,
          email: eEmail,
          phone: ePhone,
          responses: mergedResponses,
          expectedUpdatedAt: reg.updatedAt,
        }),
      })
      const body = await res.json() as EditRegistrationResponse
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? 'Could not save changes')
      }
      if (body.registration) {
        onUpdate({ attendee: body.registration.attendee, updatedAt: body.registration.updatedAt })
      }
      setEditing(false)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Could not save changes')
    } finally {
      setSavingEdit(false)
    }
  }

  // ── Undo Check-In ─────────────────────────────────────────────────────────
  const [confirmUndo, setConfirmUndo] = useState(false)
  const [undoing,     setUndoing]     = useState(false)
  const [undoError,   setUndoError]   = useState<string | null>(null)

  async function handleUndoCheckIn() {
    if (undoing || !token) return
    setUndoing(true)
    setUndoError(null)
    try {
      const res  = await fetch(`/api/organizer/registrations/${reg.id}/undo-checkin`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json() as UndoCheckInResponse
      if (body.success) {
        setLocalCheckedIn(false)
        onUpdate({ checkedIn: false, checkedInAt: null })
        setConfirmUndo(false)
      } else {
        setUndoError(body.error ?? 'Failed to undo check-in.')
        setConfirmUndo(false)
      }
    } catch {
      setUndoError('Network error. Please try again.')
      setConfirmUndo(false)
    } finally {
      setUndoing(false)
    }
  }

  const sm = statusMeta(localStatus)

  // ── Email ───────────────────────────────────────────────────────────────────
  const [emailSending,  setEmailSending]  = useState(false)
  const [emailFeedback, setEmailFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  async function handleResendEmail() {
    if (emailSending || !token) return
    setEmailSending(true)
    setEmailFeedback(null)
    try {
      const res  = await fetch(`/api/organizer/registrations/${reg.id}/resend-email`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json() as ResendEmailResponse
      setEmailFeedback(
        body.success
          ? { ok: true,  msg: 'Email sent successfully.' }
          : { ok: false, msg: body.error ?? 'Failed to send email.' },
      )
    } catch {
      setEmailFeedback({ ok: false, msg: 'Network error. Please try again.' })
    } finally {
      setEmailSending(false)
    }
  }

  // ── PDF download ────────────────────────────────────────────────────────────
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfError,   setPdfError]   = useState<string | null>(null)

  async function handleDownloadPdf() {
    if (pdfLoading || !token) return
    setPdfLoading(true)
    setPdfError(null)
    try {
      const res = await fetch(`/api/tickets/${reg.id}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        setPdfError('Could not generate ticket PDF.')
        return
      }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `ticket-${reg.ticketCode}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setPdfError('Network error. Please try again.')
    } finally {
      setPdfLoading(false)
    }
  }

  // ── Receipt download (paid registrations only) ───────────────────────────
  const [receiptLoading, setReceiptLoading] = useState(false)
  const [receiptError,   setReceiptError]   = useState<string | null>(null)

  async function handleDownloadReceipt() {
    if (receiptLoading || !token) return
    setReceiptLoading(true)
    setReceiptError(null)
    try {
      const res = await fetch(`/api/receipts/${reg.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        setReceiptError('Could not generate receipt.')
        return
      }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `receipt-${reg.ticketCode}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setReceiptError('Network error. Please try again.')
    } finally {
      setReceiptLoading(false)
    }
  }

  const showReceipt = reg.amount > 0 && (reg.paymentStatus === 'paid' || reg.paymentStatus === 'refunded')

  // ── Cancel ──────────────────────────────────────────────────────────────────
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelling,    setCancelling]    = useState(false)
  const [cancelError,   setCancelError]   = useState<string | null>(null)

  async function handleCancel() {
    setCancelling(true)
    setCancelError(null)
    try {
      const res  = await fetch(`/api/organizer/registrations/${reg.id}/cancel`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json() as CancelRegistrationResponse
      if (body.success) {
        setLocalStatus('cancelled')
        onUpdate({ status: 'cancelled' })
        setConfirmCancel(false)
      } else {
        setCancelError(body.error ?? 'Failed to cancel registration.')
        setConfirmCancel(false)
      }
    } catch {
      setCancelError('Network error. Please try again.')
      setConfirmCancel(false)
    } finally {
      setCancelling(false)
    }
  }

  // ── Approve ─────────────────────────────────────────────────────────────────
  const [approving,     setApproving]     = useState(false)
  const [approveError,  setApproveError]  = useState<string | null>(null)

  async function handleApprove() {
    if (approving || !token) return
    setApproving(true)
    setApproveError(null)
    try {
      const res  = await fetch(`/api/organizer/registrations/${reg.id}/approve`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json() as ApproveRegistrationResponse
      if (body.success) {
        setLocalStatus('confirmed')
        onUpdate({ status: 'confirmed' })
      } else {
        setApproveError(body.error ?? 'Failed to approve registration.')
      }
    } catch {
      setApproveError('Network error. Please try again.')
    } finally {
      setApproving(false)
    }
  }

  // ── Reject ──────────────────────────────────────────────────────────────────
  const [confirmReject, setConfirmReject] = useState(false)
  const [rejecting,     setRejecting]     = useState(false)
  const [rejectError,   setRejectError]   = useState<string | null>(null)

  async function handleReject() {
    if (rejecting || !token) return
    setRejecting(true)
    setRejectError(null)
    try {
      const res  = await fetch(`/api/organizer/registrations/${reg.id}/reject`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json() as RejectRegistrationResponse
      if (body.success) {
        setLocalStatus('rejected')
        onUpdate({ status: 'rejected' })
        setConfirmReject(false)
      } else {
        setRejectError(body.error ?? 'Failed to reject registration.')
        setConfirmReject(false)
      }
    } catch {
      setRejectError('Network error. Please try again.')
      setConfirmReject(false)
    } finally {
      setRejecting(false)
    }
  }

  // ── Restore ─────────────────────────────────────────────────────────────────
  const [restoring,    setRestoring]    = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  async function handleRestore() {
    if (restoring || !token) return
    setRestoring(true)
    setRestoreError(null)
    try {
      const res  = await fetch(`/api/organizer/registrations/${reg.id}/restore`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json() as RestoreRegistrationResponse
      if (body.success) {
        setLocalStatus('confirmed')
        onUpdate({ status: 'confirmed' })
      } else {
        setRestoreError(body.error ?? 'Failed to restore registration.')
      }
    } catch {
      setRestoreError('Network error. Please try again.')
    } finally {
      setRestoring(false)
    }
  }

  // ── Refund ──────────────────────────────────────────────────────────────────
  const [confirmRefund, setConfirmRefund] = useState(false)
  const [refunding,     setRefunding]     = useState(false)
  const [refundError,   setRefundError]   = useState<string | null>(null)

  async function handleRefund() {
    setRefunding(true)
    setRefundError(null)
    try {
      const res  = await fetch(`/api/organizer/registrations/${reg.id}/refund`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json() as RefundRegistrationResponse
      if (body.success) {
        setLocalPaymentStatus('refunded')
        onUpdate({ paymentStatus: 'refunded' })
        setConfirmRefund(false)
      } else {
        setRefundError(body.error ?? 'Failed to issue refund.')
        setConfirmRefund(false)
      }
    } catch {
      setRefundError('Network error. Please try again.')
      setConfirmRefund(false)
    } finally {
      setRefunding(false)
    }
  }

  // ── Audit history ────────────────────────────────────────────────────────────
  const [auditOpen,    setAuditOpen]    = useState(false)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditEntries, setAuditEntries] = useState<SerializedAuditEntry[] | null>(null)
  const [auditError,   setAuditError]   = useState<string | null>(null)

  async function loadAuditLog() {
    if (auditLoading) return
    setAuditLoading(true)
    setAuditError(null)
    try {
      const res  = await fetch(`/api/organizer/registrations/${reg.id}/audit`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json() as AuditLogResponse | { error: string }
      if ('error' in body) {
        setAuditError(body.error)
      } else {
        setAuditEntries(body.entries)
      }
    } catch {
      setAuditError('Network error. Please try again.')
    } finally {
      setAuditLoading(false)
    }
  }

  function toggleAudit() {
    const next = !auditOpen
    setAuditOpen(next)
    if (next && auditEntries === null) {
      void loadAuditLog()
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />

      {/* Panel */}
      <div
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-background shadow-2xl"
        role="dialog"
        aria-modal
        aria-label="Registration details"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div>
            <p className="text-[15px] font-bold text-foreground">{reg.attendee.name}</p>
            <p className="text-[13px] text-muted-foreground">{reg.attendee.email}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="flex flex-col gap-5">

            {/* ── Edit attendee details ── */}
            {editing ? (
              <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/[0.03] p-4">
                <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Edit Registration</p>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-muted-foreground">Name</span>
                  <input value={eName} onChange={e => setEName(e.target.value)} className={editInputCls} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-muted-foreground">Email</span>
                  <input type="email" value={eEmail} onChange={e => setEEmail(e.target.value)} className={editInputCls} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-muted-foreground">Phone</span>
                  <input value={ePhone} onChange={e => setEPhone(e.target.value)} className={editInputCls} />
                </label>
                {responseEntries.map(([k]) => (
                  <label key={k} className="block">
                    <span className="mb-1 block text-[12px] font-medium text-muted-foreground">{fieldLabels[k] ?? k}</span>
                    <input value={eResp[k] ?? ''} onChange={e => setEResp(prev => ({ ...prev, [k]: e.target.value }))} className={editInputCls} />
                  </label>
                ))}
                {editError && <p className="text-[13px] text-destructive">{editError}</p>}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={cancelEdit} disabled={savingEdit}
                    className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
                    Cancel
                  </button>
                  <button type="button" onClick={handleSaveEdit} disabled={!editDirty || savingEdit}
                    className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60">
                    {savingEdit ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => { resetEdit(); setEditing(true) }}
                className="flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-[13px] font-semibold text-foreground hover:bg-muted">
                <Pencil className="size-3.5" aria-hidden /> Edit Registration
              </button>
            )}

            {/* Ticket code */}
            <div className="flex flex-col items-center rounded-xl border border-border bg-muted/[0.03] px-5 py-5 text-center">
              <Ticket className="mb-2 size-5 text-muted-foreground" aria-hidden />
              <p className="text-[12px] font-semibold uppercase tracking-widest text-muted-foreground">
                Ticket Code
              </p>
              <p className="mt-1 font-mono text-[22px] font-bold tracking-[0.12em] text-foreground">
                {reg.ticketCode}
              </p>
            </div>

            {/* Status row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border bg-card p-3">
                <p className="mb-1 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Status
                </p>
                <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${sm.cls}`}>
                  {sm.label}
                </span>
              </div>
              <div className="rounded-xl border border-border bg-card p-3">
                <p className="mb-1 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Payment
                </p>
                <span className="text-[13px] font-medium capitalize text-foreground">
                  {reg.paymentStatus.replace('_', ' ')}
                </span>
              </div>
            </div>

            {/* Core metadata */}
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {[
                { icon: Tag,      label: 'Pass',       value: reg.passName },
                { icon: Mail,     label: 'Email',      value: reg.attendee.email },
                { icon: Phone,    label: 'Phone',      value: reg.attendee.phone || '—' },
                { icon: Calendar, label: 'Registered', value: fmtDate(reg.registeredAt) },
                { icon: Ticket,   label: 'Amount',     value: fmtINR(reg.amount) },
              ].map(({ icon: Icon, label, value }) => (
                <div key={label} className="flex items-start gap-3 border-b border-border/40 px-4 py-3 last:border-0">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {label}
                    </p>
                    <p className="mt-0.5 truncate text-[13px] font-medium text-foreground">{value}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Form responses */}
            {formResponses && Object.keys(formResponses).length > 0 && (
              <div>
                <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Form Responses
                </p>
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  {Object.entries(formResponses).map(([id, value]) => (
                    <div key={id} className="border-b border-border/40 px-4 py-3 last:border-0">
                      <p className="text-[13px] font-medium text-muted-foreground">
                        {fieldLabels[id] ?? id}
                      </p>
                      <p className="mt-0.5 text-[13px] text-foreground">
                        {value == null || value === ''
                          ? <span className="italic text-muted-foreground/50">—</span>
                          : String(value)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Actions panel ── */}
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                Actions
              </p>

              {/* Email row */}
              <div className="mb-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <p className="text-[12px] font-medium text-muted-foreground">Ticket Email</p>
                    {reg.emailStatus && (
                      <span className={cn(
                        'inline-flex rounded-full px-2 py-0.5 text-[12px] font-semibold',
                        reg.emailStatus === 'sent'    && 'bg-emerald-100 text-emerald-700',
                        reg.emailStatus === 'failed'  && 'bg-red-100 text-red-600',
                        reg.emailStatus === 'pending' && 'bg-amber-100 text-amber-700',
                      )}>
                        {reg.emailStatus}
                      </span>
                    )}
                  </div>
                  {reg.emailSentAt && (
                    <p className="text-[13px] text-muted-foreground">{fmtDate(reg.emailSentAt)}</p>
                  )}
                </div>

                {/* Action buttons grid */}
                <div className="grid grid-cols-2 gap-2">
                  {/* Resend email */}
                  {localStatus !== 'cancelled' && (
                    <button
                      type="button"
                      onClick={handleResendEmail}
                      disabled={emailSending || !token}
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[14px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                    >
                      {emailSending
                        ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        : <Send className="size-3.5" aria-hidden />
                      }
                      {emailSending ? 'Sending…' : 'Resend Email'}
                    </button>
                  )}

                  {/* Download PDF */}
                  <button
                    type="button"
                    onClick={handleDownloadPdf}
                    disabled={pdfLoading || !token}
                    className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[14px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                  >
                    {pdfLoading
                      ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      : <FileDown className="size-3.5" aria-hidden />
                    }
                    {pdfLoading ? 'Generating…' : 'Download PDF'}
                  </button>
                </div>

                {/* Receipt download (paid only) */}
                {showReceipt && (
                  <button
                    type="button"
                    onClick={handleDownloadReceipt}
                    disabled={receiptLoading || !token}
                    className="col-span-2 flex items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[14px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                  >
                    {receiptLoading
                      ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      : <FileDown className="size-3.5" aria-hidden />
                    }
                    {receiptLoading ? 'Generating…' : 'Download Receipt'}
                  </button>
                )}

                {/* Email / PDF / Receipt feedback */}
                {emailFeedback && (
                  <p className={cn(
                    'text-center text-[12px] font-medium',
                    emailFeedback.ok ? 'text-emerald-600' : 'text-red-600',
                  )}>
                    {emailFeedback.msg}
                  </p>
                )}
                {pdfError && (
                  <p className="text-center text-[12px] font-medium text-red-600">{pdfError}</p>
                )}
                {receiptError && (
                  <p className="text-center text-[12px] font-medium text-red-600">{receiptError}</p>
                )}
              </div>

              {/* Pending approval actions */}
              {localStatus === 'pending' && (
                <div className="border-t border-border/50 pt-3">
                  <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-amber-600">
                    Pending Approval
                  </p>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => void handleApprove()}
                      disabled={approving || !token}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-[14px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {approving
                        ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        : <CheckCircle className="size-3.5" aria-hidden />
                      }
                      {approving ? 'Approving…' : 'Approve Registration'}
                    </button>
                    {approveError && (
                      <p className="text-center text-[12px] font-medium text-red-600">{approveError}</p>
                    )}
                    <button
                      type="button"
                      onClick={() => { setRejectError(null); setConfirmReject(true) }}
                      disabled={rejecting || !token}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-[14px] font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:opacity-50"
                    >
                      <XCircle className="size-3.5" aria-hidden />
                      Reject Registration
                    </button>
                    {rejectError && (
                      <p className="text-center text-[12px] font-medium text-red-600">{rejectError}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Rejected badge */}
              {localStatus === 'rejected' && (
                <div className="border-t border-border/50 pt-3">
                  <div className="flex items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5">
                    <XCircle className="size-3.5 text-rose-600" aria-hidden />
                    <span className="text-[14px] font-semibold text-rose-700">Registration Rejected</span>
                  </div>
                </div>
              )}

              {/* Check-In status */}
              <div className="border-t border-border/50 pt-3">
                <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Check-In
                </p>
                {localCheckedIn ? (
                  <div className="space-y-2">
                    <div className="text-[13px]">
                      <span className="font-semibold text-emerald-700">✓ Checked in</span>
                      {reg.checkedInAt && (
                        <span className="ml-2 text-muted-foreground">{fmtDate(reg.checkedInAt)}</span>
                      )}
                      {reg.checkedInSource && (
                        <span className="ml-2 capitalize text-muted-foreground/60">
                          via {reg.checkedInSource}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => { setUndoError(null); setConfirmUndo(true) }}
                      disabled={undoing || !token}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[14px] font-semibold text-sky-700 hover:bg-sky-100 disabled:opacity-50"
                    >
                      {undoing
                        ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        : <Undo2 className="size-3.5" aria-hidden />
                      }
                      {undoing ? 'Undoing…' : 'Undo Check-In'}
                    </button>
                    {undoError && (
                      <p className="text-center text-[12px] font-medium text-red-600">{undoError}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-[13px] text-muted-foreground/60">Not yet checked in</p>
                )}
              </div>

              {/* Restore button (only for cancelled) */}
              {localStatus === 'cancelled' && (
                <div className="border-t border-border/50 pt-3">
                  <button
                    type="button"
                    onClick={handleRestore}
                    disabled={restoring || !token}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-[14px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                  >
                    {restoring
                      ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      : <Undo2 className="size-3.5" aria-hidden />
                    }
                    {restoring ? 'Restoring…' : 'Restore Registration'}
                  </button>
                  {restoreError && (
                    <p className="mt-1.5 text-center text-[12px] font-medium text-red-600">{restoreError}</p>
                  )}
                </div>
              )}

              {/* Refund button (only when paid and not yet refunded) */}
              {localStatus !== 'cancelled' && localPaymentStatus === 'paid' && (
                <div className="border-t border-border/50 pt-3">
                  <button
                    type="button"
                    onClick={() => { setRefundError(null); setConfirmRefund(true) }}
                    disabled={refunding || !token}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[14px] font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50"
                  >
                    <RotateCw className="size-3.5" aria-hidden />
                    Issue Refund
                  </button>
                  {refundError && (
                    <p className="mt-1.5 text-center text-[12px] font-medium text-red-600">{refundError}</p>
                  )}
                </div>
              )}

              {/* Refunded badge (read-only once processed) */}
              {localPaymentStatus === 'refunded' && (
                <div className="border-t border-border/50 pt-3">
                  <div className="flex items-center justify-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                    <RotateCw className="size-3.5 text-amber-600" aria-hidden />
                    <span className="text-[14px] font-semibold text-amber-700">Refund Issued</span>
                  </div>
                </div>
              )}

              {/* Danger zone (only for non-cancelled, non-rejected) */}
              {localStatus !== 'cancelled' && localStatus !== 'rejected' && localStatus !== 'pending' && (
                <div className="border-t border-border/50 pt-3">
                  <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-red-500">
                    Danger Zone
                  </p>
                  <button
                    type="button"
                    onClick={() => { setCancelError(null); setConfirmCancel(true) }}
                    disabled={cancelling || !token}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[14px] font-semibold text-red-600 transition-colors hover:bg-red-100 disabled:opacity-50"
                  >
                    <BanIcon className="size-3.5" aria-hidden />
                    Cancel Registration
                  </button>
                  {cancelError && (
                    <p className="mt-1.5 text-center text-[12px] font-medium text-red-600">{cancelError}</p>
                  )}
                </div>
              )}
            </div>

            {/* ── Participant 360° — cross-domain orchestration (Phase H.4.4) ── */}
            <ParticipantWorkspace360
              reg={reg}
              eventId={eventId}
              token={token}
              onIdentifierChange={(v) => onUpdate({ bibNumber: v })}
            />

            {/* ── Audit history ── */}
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <button
                type="button"
                onClick={toggleAudit}
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/30"
              >
                <div className="flex items-center gap-2">
                  <History className="size-4 text-muted-foreground" aria-hidden />
                  <p className="text-[14px] font-semibold text-foreground">Audit History</p>
                  {auditEntries !== null && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[12px] font-semibold text-muted-foreground">
                      {auditEntries.length}
                    </span>
                  )}
                </div>
                {auditOpen
                  ? <ChevronUp className="size-4 text-muted-foreground" aria-hidden />
                  : <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
                }
              </button>

              {auditOpen && (
                <div className="border-t border-border">
                  {auditLoading && (
                    <div className="flex items-center justify-center gap-2 py-6">
                      <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
                      <p className="text-[13px] text-muted-foreground">Loading history…</p>
                    </div>
                  )}
                  {auditError && (
                    <div className="flex items-center justify-between px-4 py-3">
                      <p className="text-[13px] text-red-600">{auditError}</p>
                      <button
                        type="button"
                        onClick={loadAuditLog}
                        className="text-[12px] font-medium text-primary hover:underline"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {!auditLoading && !auditError && auditEntries !== null && (
                    auditEntries.length === 0 ? (
                      <p className="px-4 py-4 text-[13px] italic text-muted-foreground/60">
                        No audit entries yet.
                      </p>
                    ) : (
                      <div className="divide-y divide-border/40">
                        {auditEntries.map(entry => (
                          <div key={entry.id} className="px-4 py-3">
                            <div className="flex items-start justify-between gap-2">
                              <p className={cn(
                                'text-[14px] font-semibold',
                                auditActionColor(entry.action),
                              )}>
                                {auditActionLabel(entry.action)}
                              </p>
                              <p className="shrink-0 text-[13px] text-muted-foreground">
                                {entry.timestamp ? fmtDate(entry.timestamp) : '—'}
                              </p>
                            </div>
                            <p className="mt-0.5 text-[13px] text-muted-foreground">
                              {entry.actorType === 'system'
                                ? 'System'
                                : `Organizer · ${entry.actor.slice(0, 8)}…`}
                            </p>
                          </div>
                        ))}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>

            {/* Internal ID */}
            <p className="text-center font-mono text-[12px] text-muted-foreground/40">
              ID: {reg.id}
            </p>
          </div>
        </div>
      </div>

      {/* Refund confirmation dialog */}
      {confirmRefund && (
        <ConfirmDialog
          title="Issue a full refund?"
          body={
            <>
              <p>
                A full refund of <strong>{fmtINR(reg.amount)}</strong> will be sent to{' '}
                <strong>{reg.attendee.name}</strong> via Razorpay.
              </p>
              <ul className="mt-2 space-y-1 text-[12px]">
                <li>• Refunds are processed within 5–7 business days.</li>
                <li>• This action cannot be undone.</li>
                <li>• The registration will remain in confirmed status.</li>
              </ul>
            </>
          }
          confirmLabel="Yes, Issue Refund"
          confirmCls="bg-amber-500 hover:bg-amber-600"
          onConfirm={handleRefund}
          onCancel={() => setConfirmRefund(false)}
          loading={refunding}
        />
      )}

      {/* Cancel confirmation dialog (rendered above drawer) */}
      {confirmCancel && (
        <ConfirmDialog
          title="Cancel this registration?"
          body={
            <>
              <p>
                This will cancel <strong>{reg.attendee.name}</strong>&apos;s registration
                ({reg.passName}).
              </p>
              <ul className="mt-2 space-y-1 text-[12px]">
                <li>• Ticket becomes invalid — attendee cannot check in.</li>
                <li>• Pass capacity is restored immediately.</li>
                <li>• Attendee will <em>not</em> be notified automatically.</li>
              </ul>
            </>
          }
          confirmLabel="Yes, Cancel Registration"
          confirmCls="bg-red-600 hover:bg-red-700"
          onConfirm={handleCancel}
          onCancel={() => setConfirmCancel(false)}
          loading={cancelling}
        />
      )}

      {/* Undo check-in confirmation dialog */}
      {confirmUndo && (
        <ConfirmDialog
          title="Undo check-in?"
          body={
            <>
              <p>
                This will mark <strong>{reg.attendee.name}</strong> as not checked in.
                The attendance counter will be decremented.
              </p>
              <ul className="mt-2 space-y-1 text-[12px]">
                <li>• The attendee can be checked in again.</li>
                <li>• This action is recorded in the audit log.</li>
              </ul>
            </>
          }
          confirmLabel="Yes, Undo Check-In"
          confirmCls="bg-sky-600 hover:bg-sky-700"
          cancelLabel="Keep Check-In"
          onConfirm={handleUndoCheckIn}
          onCancel={() => setConfirmUndo(false)}
          loading={undoing}
        />
      )}

      {/* Reject confirmation dialog */}
      {confirmReject && (
        <ConfirmDialog
          title="Reject this registration?"
          body={
            <>
              <p>
                This will reject <strong>{reg.attendee.name}</strong>&apos;s registration
                ({reg.passName}).
              </p>
              <ul className="mt-2 space-y-1 text-[12px]">
                <li>• Status will change to Rejected.</li>
                <li>• The attendee will not receive an automatic notification.</li>
                {reg.paymentStatus === 'paid' && (
                  <li>• This registration was paid. Refunds must be handled separately.</li>
                )}
              </ul>
            </>
          }
          confirmLabel="Yes, Reject Registration"
          confirmCls="bg-rose-600 hover:bg-rose-700"
          cancelLabel="Keep Pending"
          onConfirm={handleReject}
          onCancel={() => setConfirmReject(false)}
          loading={rejecting}
        />
      )}
    </>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function RegistrationsClient({ eventId }: { eventId: string }) {
  const searchParams = useSearchParams()

  // ── Core state ────────────────────────────────────────────────────────────
  const [data,          setData]          = useState<RegistrationsApiResponse | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [pageLoading,   setPageLoading]   = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  const [authToken,     setAuthToken]     = useState('')

  // ── Filters ───────────────────────────────────────────────────────────────
  const [search,          setSearch]          = useState('')
  const [passFilter,      setPassFilter]      = useState('')
  const [statusFilter,    setStatusFilter]    = useState(() => searchParams.get('status') ?? '')
  const [checkinFilter,   setCheckinFilter]   = useState('')
  const [paymentFilter,   setPaymentFilter]   = useState('')
  const [dateFrom,        setDateFrom]        = useState('')
  const [dateTo,          setDateTo]          = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // ── Sort ──────────────────────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>('registeredAt')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // ── Drawer ────────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<SerializedRegistration | null>(null)

  // ── Import Participants drawer (RM-2.1) ─────────────────────────────────────
  const [importOpen, setImportOpen] = useState(false)

  // ── Pagination ────────────────────────────────────────────────────────────
  const [pageSize,    setPageSize]    = useState<25 | 50 | 100>(50)
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [nextCursor,  setNextCursor]  = useState<string | null>(null)
  const [hasMore,     setHasMore]     = useState(false)
  const [totalCount,  setTotalCount]  = useState(0)
  const [isAllMode,   setIsAllMode]   = useState(false)

  // ── Bulk selection ─────────────────────────────────────────────────────────
  const [selectedIds,  setSelectedIds]  = useState<Set<string>>(new Set())
  const [bulkLoading,  setBulkLoading]  = useState<string | null>(null)
  const [bulkFeedback, setBulkFeedback] = useState<string | null>(null)
  // OE-1 — background bulk check-in/restore job (progress dialog).
  const [bulkJob,      setBulkJob]      = useState<SerializedBulkJob | null>(null)
  const bulkRunning = useRef(false)

  const searchRef        = useRef<HTMLInputElement>(null)
  const authTokenRef     = useRef('')
  const isFirstFilterRun = useRef(true)

  // eslint-disable-next-line react-hooks/refs -- keep the ref in sync with the latest token
  authTokenRef.current = authToken

  // ── Fetch ─────────────────────────────────────────────────────────────────

  async function doFetch(opts: { cursor?: string | null; allMode?: boolean; limit?: number } = {}) {
    const token = authTokenRef.current
    if (!token) return
    const { cursor = null, allMode = false, limit = pageSize } = opts
    setPageLoading(true)
    setSelectedIds(new Set())
    try {
      const p = new URLSearchParams()
      if (allMode) { p.set('all', 'true') }
      else         { p.set('limit', String(limit)); if (cursor) p.set('cursor', cursor) }
      const res = await fetch(`/api/organizer/events/${eventId}/registrations?${p}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const j = await res.json() as { error?: string }
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json() as RegistrationsApiResponse
      setData(json)
      setNextCursor(json.nextCursor)
      setHasMore(json.hasMore)
      setTotalCount(json.totalCount)
      setIsAllMode(allMode)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load registrations')
    } finally {
      setLoading(false)
      setPageLoading(false)
    }
  }

  // ── Auth + initial load ────────────────────────────────────────────────────

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) {
        setError('You must be signed in to view registrations.')
        setLoading(false)
        return
      }
      try {
        const token = await user.getIdToken()
        setAuthToken(token)
        authTokenRef.current = token
        await doFetch({ allMode: false, limit: 50 })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load registrations')
        setLoading(false)
      }
    })
    return unsub
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId])

  // ── Search debounce ────────────────────────────────────────────────────────

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), search ? 300 : 0)
    return () => clearTimeout(t)
  }, [search])

  // ── Filter-change re-fetch ─────────────────────────────────────────────────
  // Skips initial mount. Loads all records when any filter is active; paginates otherwise.

  useEffect(() => {
    if (isFirstFilterRun.current) { isFirstFilterRun.current = false; return }
    if (!authTokenRef.current) return
    const anyActive = !!(debouncedSearch || passFilter || statusFilter || checkinFilter || paymentFilter || dateFrom || dateTo)
    setCursorStack([])
    if (anyActive) { doFetch({ allMode: true }) }
    else           { doFetch({ allMode: false, limit: pageSize }) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, passFilter, statusFilter, checkinFilter, paymentFilter, dateFrom, dateTo])

  // ── Handle drawer updates ──────────────────────────────────────────────────

  function handleRegistrationUpdate(id: string, updates: Partial<SerializedRegistration>) {
    setData(prev => {
      if (!prev) return prev
      const updated = prev.registrations.map(r => r.id === id ? { ...r, ...updates } : r)
      // Incremental stats update — correct even on partial (paginated) pages
      const old = prev.registrations.find(r => r.id === id)
      const s   = { ...prev.stats }
      if (old && updates.status && old.status !== updates.status) {
        if (old.status === 'confirmed')  s.confirmed  = Math.max(0, s.confirmed  - 1)
        if (old.status === 'cancelled')  s.cancelled  = Math.max(0, s.cancelled  - 1)
        if (old.status === 'pending')    s.pending    = Math.max(0, s.pending    - 1)
        if (old.status === 'waitlisted') s.waitlisted = Math.max(0, s.waitlisted - 1)
        if (old.status === 'rejected')   s.rejected   = Math.max(0, (s.rejected ?? 0) - 1)
        if (updates.status === 'confirmed')  s.confirmed++
        if (updates.status === 'cancelled')  s.cancelled++
        if (updates.status === 'pending')    s.pending++
        if (updates.status === 'waitlisted') s.waitlisted++
        if (updates.status === 'rejected')   s.rejected = (s.rejected ?? 0) + 1
        s.total = s.confirmed + s.pending + s.cancelled + s.waitlisted + (s.rejected ?? 0)
      }
      if (old && typeof updates.checkedIn === 'boolean' && old.checkedIn !== updates.checkedIn) {
        s.checkedIn = updates.checkedIn
          ? (s.checkedIn ?? 0) + 1
          : Math.max(0, (s.checkedIn ?? 0) - 1)
      }
      return { ...prev, registrations: updated, stats: s }
    })
    setSelected(prev => prev?.id === id ? { ...prev, ...updates } : prev)
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    if (!data) return []
    const q = search.toLowerCase().trim()
    return data.registrations
      .filter(r => {
        if (passFilter    && r.passId        !== passFilter)    return false
        if (statusFilter  && r.status        !== statusFilter)  return false
        if (paymentFilter && r.paymentStatus !== paymentFilter) return false
        if (checkinFilter === 'checked_in'     && !r.checkedIn) return false
        if (checkinFilter === 'not_checked_in' && r.checkedIn)  return false
        if (dateFrom) {
          const from = new Date(dateFrom + 'T00:00:00')
          if (!r.registeredAt || new Date(r.registeredAt) < from) return false
        }
        if (dateTo) {
          const to = new Date(dateTo + 'T23:59:59')
          if (!r.registeredAt || new Date(r.registeredAt) > to)   return false
        }
        if (q) return (
          r.attendee.name.toLowerCase().includes(q)  ||
          r.attendee.email.toLowerCase().includes(q) ||
          r.ticketCode.toLowerCase().includes(q)     ||
          (r.attendee.phone ?? '').includes(q)
        )
        return true
      })
      .sort((a, b) => {
        let av = '', bv = ''
        if (sortKey === 'name')        { av = a.attendee.name; bv = b.attendee.name }
        else if (sortKey === 'status') { av = a.status;        bv = b.status        }
        else                           { av = a.registeredAt ?? ''; bv = b.registeredAt ?? '' }
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      })
  }, [data, search, passFilter, statusFilter, checkinFilter, paymentFilter, dateFrom, dateTo, sortKey, sortDir])

  // GA-7C S2/P5: bound the number of RENDERED rows. all-mode (search/filter) can load
  // up to 2000 rows; rendering them all — across BOTH the mobile-card and desktop-table
  // layouts — produces thousands of DOM nodes and janky per-keystroke filtering. The
  // full `filtered` set still drives the counts and select-all; only the rendered slice
  // is capped, reusing the existing table/card markup (no virtualization dependency).
  const RENDER_CAP = 250
  const visible = filtered.length > RENDER_CAP ? filtered.slice(0, RENDER_CAP) : filtered
  const renderCapped = filtered.length > RENDER_CAP

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function selectPage()     { setSelectedIds(new Set(filtered.map(r => r.id))) }
  function clearSelection() { setSelectedIds(new Set()) }

  const hasActiveFilters = !!(search || passFilter || statusFilter || checkinFilter || paymentFilter || dateFrom || dateTo)
  const currentPage      = cursorStack.length + 1
  // Pending registrations among the current selection — drives Approve/Reject visibility
  const pendingSelected  = filtered.filter(r => selectedIds.has(r.id) && r.status === 'pending').length

  // ── Loading / error states ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6">
        <div className="mb-6 h-7 w-48 animate-pulse rounded-lg bg-muted" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)}
        </div>
        <div className="mt-6 h-10 animate-pulse rounded-xl bg-muted" />
        <div className="mt-3 h-64 animate-pulse rounded-xl bg-muted" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <XCircle className="size-6 text-destructive" aria-hidden />
        </div>
        <div>
          <p className="text-[16px] font-bold text-foreground">Failed to load registrations</p>
          <p className="mt-1 text-[13.5px] text-muted-foreground">{error}</p>
        </div>
        <button
          type="button"
          onClick={() => { setError(null); setLoading(true); window.location.reload() }}
          className="flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-[13px] font-semibold hover:bg-muted/50"
        >
          <RotateCcw className="size-3.5" aria-hidden /> Retry
        </button>
      </div>
    )
  }

  if (!data) return null

  const { eventName, eventSlug, passes, fieldLabels, stats } = data

  function handleBulkExport() {
    const rows = filtered.filter(r => selectedIds.has(r.id))
    if (rows.length > 0) exportToCsv(rows, eventSlug, fieldLabels)
  }

  function refreshList() {
    const anyActive = !!(debouncedSearch || passFilter || statusFilter || checkinFilter || paymentFilter || dateFrom || dateTo)
    void (anyActive
      ? doFetch({ allMode: true })
      : doFetch({ allMode: false, limit: pageSize, cursor: cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : null }))
  }

  async function handleBulkAction(action: 'check_in' | 'cancel' | 'restore' | 'resend_email') {
    if (!authToken || selectedIds.size === 0) return
    // OE-1: check-in & restore run as background jobs (chunked, resumable, capacity-safe).
    if (action === 'check_in' || action === 'restore') { await createBulkJob(action); return }
    setBulkLoading(action)
    setBulkFeedback(null)
    try {
      const res  = await fetch(`/api/organizer/events/${eventId}/registrations/bulk`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action, registrationIds: [...selectedIds] }),
      })
      const body = await res.json() as BulkActionResponse
      if (!res.ok || !body.success) { setBulkFeedback(body.error ?? 'Bulk action failed.'); return }
      const label = { check_in: 'checked in', cancel: 'cancelled', restore: 'restored', resend_email: 'emailed' }[action]
      setBulkFeedback(`${body.succeeded} of ${body.processed} ${label} successfully.`)
      clearSelection()
      refreshList()
    } catch {
      setBulkFeedback('Network error. Please try again.')
    } finally {
      setBulkLoading(null)
    }
  }

  // ── OE-1: bulk check-in / restore background job (create → drive → progress) ──
  const bulkSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

  async function createBulkJob(kind: 'check_in' | 'restore') {
    setBulkLoading(kind); setBulkFeedback(null)
    try {
      const res  = await fetch(`/api/organizer/events/${eventId}/registrations/bulk-jobs`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ kind, registrationIds: [...selectedIds] }),
      })
      const body = await res.json() as CreateBulkJobResponse
      if (!res.ok || !body.success) {
        setBulkFeedback((!body.success && body.error) ? body.error : 'Could not start the bulk job.')
        return
      }
      setBulkJob(body.job)
      void driveBulkJob(body.jobId)
    } catch {
      setBulkFeedback('Network error. Please try again.')
    } finally { setBulkLoading(null) }
  }

  async function driveBulkJob(jobId: string) {
    if (bulkRunning.current) return
    bulkRunning.current = true
    try {
      for (let i = 0; i < 100_000; i++) {
        const res  = await fetch(`/api/organizer/events/${eventId}/registrations/bulk-jobs/${jobId}/process`, { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } })
        const json = await res.json() as ProcessBulkJobResponse
        if (!res.ok || !json.success) break
        if (json.job) setBulkJob(json.job)
        if (json.result.done) break
        if (json.result.reason === 'busy') { await bulkSleep(1500); continue }
        await bulkSleep(300)
      }
    } catch { /* the dialog's last snapshot remains; cron finishes the rest */ }
    finally { bulkRunning.current = false; refreshList() }
  }

  async function cancelBulkJob(jobId: string) {
    try {
      await fetch(`/api/organizer/events/${eventId}/registrations/bulk-jobs/${jobId}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } })
      setBulkJob(prev => prev ? { ...prev, status: 'cancelled' } : prev)
    } catch { /* next poll reflects it */ }
  }

  function closeBulkJob() { setBulkJob(null); clearSelection(); refreshList() }

  async function handleBulkApprove() {
    if (!authToken || pendingSelected === 0) return
    const ids = filtered.filter(r => selectedIds.has(r.id) && r.status === 'pending').map(r => r.id)
    setBulkLoading('bulk_approve')
    setBulkFeedback(null)
    try {
      const res  = await fetch('/api/organizer/registrations/bulk-approve', {
        method:  'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ registrationIds: ids }),
      })
      const body = await res.json() as BulkApproveResponse
      if (!res.ok || !body.success) { setBulkFeedback(body.error ?? 'Bulk approve failed.'); return }
      setBulkFeedback(`${body.succeeded} of ${body.processed} approved successfully.`)
      clearSelection()
      const anyActive = !!(debouncedSearch || passFilter || statusFilter || checkinFilter || paymentFilter || dateFrom || dateTo)
      void (anyActive
        ? doFetch({ allMode: true })
        : doFetch({ allMode: false, limit: pageSize, cursor: cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : null }))
    } catch {
      setBulkFeedback('Network error. Please try again.')
    } finally {
      setBulkLoading(null)
    }
  }

  async function handleBulkReject() {
    if (!authToken || pendingSelected === 0) return
    const ids = filtered.filter(r => selectedIds.has(r.id) && r.status === 'pending').map(r => r.id)
    setBulkLoading('bulk_reject')
    setBulkFeedback(null)
    try {
      const res  = await fetch('/api/organizer/registrations/bulk-reject', {
        method:  'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ registrationIds: ids }),
      })
      const body = await res.json() as BulkRejectResponse
      if (!res.ok || !body.success) { setBulkFeedback(body.error ?? 'Bulk reject failed.'); return }
      setBulkFeedback(`${body.succeeded} of ${body.processed} rejected.`)
      clearSelection()
      const anyActive = !!(debouncedSearch || passFilter || statusFilter || checkinFilter || paymentFilter || dateFrom || dateTo)
      void (anyActive
        ? doFetch({ allMode: true })
        : doFetch({ allMode: false, limit: pageSize, cursor: cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : null }))
    } catch {
      setBulkFeedback('Network error. Please try again.')
    } finally {
      setBulkLoading(null)
    }
  }

  return (
    <div className="p-4 sm:p-6">
      {/* OE-1 — bulk check-in/restore progress dialog */}
      {bulkJob && (() => {
        const j = bulkJob
        const total     = j.counts.total || 0
        const pct       = total ? Math.round((j.counts.processed / total) * 100) : 0
        const active    = j.status === 'pending' || j.status === 'processing'
        const remaining = Math.max(0, total - j.counts.processed)
        const verb      = j.kind === 'restore' ? 'Restore' : 'Check-in'
        const doneLabel = j.kind === 'restore' ? 'Restored' : 'Checked in'
        const statusText: Record<string, string> = { pending: 'Queued', processing: 'Processing', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-[15px] font-bold text-foreground">Bulk {verb}</h3>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[12px] font-semibold text-muted-foreground">{statusText[j.status] ?? j.status}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground tabular-nums">
                <span>Processed {j.counts.processed}/{total} ({pct}%)</span>
                <span className="text-emerald-600">✓ {j.counts.succeeded} {doneLabel.toLowerCase()}</span>
                <span className="text-rose-600">✗ {j.counts.failed} failed</span>
                {active && <span>~{remaining} remaining</span>}
              </div>
              {j.error && <p className="mt-2 text-[12px] text-rose-600">{j.error}</p>}
              <div className="mt-4 flex items-center justify-end gap-2">
                {active
                  ? (
                    <>
                      <button type="button" onClick={() => void driveBulkJob(j.jobId)} className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-semibold text-foreground hover:bg-muted/50">Resume</button>
                      <button type="button" onClick={() => void cancelBulkJob(j.jobId)} className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-semibold text-rose-600 hover:bg-rose-50">Cancel</button>
                    </>
                  )
                  : <button type="button" onClick={closeBulkJob} className="rounded-lg bg-primary px-4 py-1.5 text-[13px] font-semibold text-white hover:opacity-90">Done</button>}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Page header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link
            href="/dashboard/events"
            className="mb-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            Events
          </Link>
          <h1 className="text-[22px] font-bold text-foreground">{eventName}</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Registrations</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="flex shrink-0 items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-[13px] font-semibold text-foreground shadow-sm hover:bg-muted/50"
          >
            <Upload className="size-4" aria-hidden />
            Import
          </button>
          <button
            type="button"
            onClick={() => exportToCsv(filtered, eventSlug, fieldLabels)}
            disabled={filtered.length === 0}
            className="flex shrink-0 items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-[13px] font-semibold text-foreground shadow-sm hover:bg-muted/50 disabled:opacity-40"
          >
            <Download className="size-4" aria-hidden />
            Export CSV
          </button>
        </div>
      </div>

      <ImportParticipantsDrawer
        open={importOpen}
        onClose={() => setImportOpen(false)}
        eventId={eventId}
        eventSlug={eventSlug}
        token={authToken}
        eventName={eventName}
      />

      {/* Stats — always from server (reflect full event, not just loaded page) */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatChip icon={Users}       label="Total"     value={stats.total}     color="bg-muted/50 text-foreground"       />
        <StatChip icon={CheckCircle} label="Confirmed" value={stats.confirmed} color="bg-emerald-100 text-emerald-600"   />
        <StatChip icon={Clock}       label="Pending"   value={stats.pending}   color="bg-amber-100 text-amber-600"       />
        <StatChip icon={XCircle}     label="Cancelled" value={stats.cancelled} color="bg-red-100 text-red-500"           />
        {(stats.rejected ?? 0) > 0 && (
          <StatChip icon={XCircle}   label="Rejected"  value={stats.rejected ?? 0} color="bg-rose-100 text-rose-600"  />
        )}
      </div>

      {/* Toolbar row 1: Search + filter dropdowns */}
      <div className="mb-2 flex flex-wrap gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search name, email, ticket code…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3.5 text-[13px] text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(''); searchRef.current?.focus() }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>

        {passes.length > 1 && (
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" aria-hidden />
            <select
              value={passFilter}
              onChange={e => setPassFilter(e.target.value)}
              className="h-10 rounded-xl border border-border bg-background pl-8 pr-3 text-[13px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
              aria-label="Filter by pass"
            >
              <option value="">All Passes</option>
              {passes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}

        <div className="relative">
          <Filter className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" aria-hidden />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="h-10 rounded-xl border border-border bg-background pl-8 pr-3 text-[13px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            aria-label="Filter by registration status"
          >
            <option value="">All Statuses</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending">Pending</option>
            <option value="waitlisted">Waitlisted</option>
            <option value="cancelled">Cancelled</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>

        <div className="relative">
          <Filter className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" aria-hidden />
          <select
            value={checkinFilter}
            onChange={e => setCheckinFilter(e.target.value)}
            className="h-10 rounded-xl border border-border bg-background pl-8 pr-3 text-[13px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            aria-label="Filter by check-in status"
          >
            <option value="">Check-In: All</option>
            <option value="checked_in">Checked In</option>
            <option value="not_checked_in">Not Checked In</option>
          </select>
        </div>

        <div className="relative">
          <Filter className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" aria-hidden />
          <select
            value={paymentFilter}
            onChange={e => setPaymentFilter(e.target.value)}
            className="h-10 rounded-xl border border-border bg-background pl-8 pr-3 text-[13px] text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            aria-label="Filter by payment status"
          >
            <option value="">Payment: All</option>
            <option value="not_required">Free</option>
            <option value="paid">Paid</option>
            <option value="pending">Payment Pending</option>
            <option value="refunded">Refunded</option>
          </select>
        </div>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => {
              setSearch(''); setPassFilter(''); setStatusFilter('')
              setCheckinFilter(''); setPaymentFilter(''); setDateFrom(''); setDateTo('')
              searchRef.current?.focus()
            }}
            className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted/50"
          >
            <X className="size-3" aria-hidden /> Clear filters
          </button>
        )}
      </div>

      {/* Toolbar row 2: Date range */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Calendar className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
        <span className="text-[12px] text-muted-foreground">Registered:</span>
        <input
          type="date"
          value={dateFrom}
          onChange={e => setDateFrom(e.target.value)}
          className="h-8 rounded-lg border border-border bg-background px-2.5 text-[12px] text-foreground outline-none focus:border-primary/60"
          aria-label="From date"
        />
        <span className="text-[12px] text-muted-foreground">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={e => setDateTo(e.target.value)}
          className="h-8 rounded-lg border border-border bg-background px-2.5 text-[12px] text-foreground outline-none focus:border-primary/60"
          aria-label="To date"
        />
      </div>

      {/* Selection controls */}
      {filtered.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={filtered.every(r => selectedIds.has(r.id)) ? clearSelection : selectPage}
            className="text-[12px] font-medium text-primary hover:underline"
          >
            {filtered.every(r => selectedIds.has(r.id)) ? 'Deselect page' : `Select page (${filtered.length})`}
          </button>
          {selectedIds.size > 0 && (
            <>
              <span className="text-muted-foreground/30" aria-hidden>·</span>
              <span className="text-[12px] text-muted-foreground">{selectedIds.size} selected</span>
              <button type="button" onClick={clearSelection}
                className="text-[12px] font-medium text-muted-foreground hover:text-foreground">
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {/* Bulk action toolbar — sticky so it stays visible while scrolling the table */}
      {selectedIds.size > 0 && (
        <div className="sticky top-4 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/20 bg-card/95 px-3 py-2.5 shadow-md backdrop-blur-sm">
          <span className="mr-1 text-[14px] font-semibold text-foreground">
            {selectedIds.size} selected
            {pendingSelected > 0 && (
              <span className="ml-1.5 text-[13px] font-medium text-amber-600">
                ({pendingSelected} pending)
              </span>
            )}
          </span>

          {/* Approve / Reject — shown only when pending registrations are selected */}
          {pendingSelected > 0 && (
            <>
              <button
                type="button"
                disabled={!!bulkLoading}
                onClick={() => void handleBulkApprove()}
                className="flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-[12px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
              >
                {bulkLoading === 'bulk_approve'
                  ? <Loader2 className="size-3 animate-spin" aria-hidden />
                  : <CheckCircle className="size-3 shrink-0" aria-hidden />
                }
                Approve Selected
              </button>
              <button
                type="button"
                disabled={!!bulkLoading}
                onClick={() => void handleBulkReject()}
                className="flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-[12px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
              >
                {bulkLoading === 'bulk_reject'
                  ? <Loader2 className="size-3 animate-spin" aria-hidden />
                  : <XCircle className="size-3 shrink-0" aria-hidden />
                }
                Reject Selected
              </button>
            </>
          )}

          <button type="button" disabled={!!bulkLoading} onClick={handleBulkExport}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-foreground hover:bg-muted/50 disabled:opacity-50">
            <Download className="size-3 shrink-0" aria-hidden /> Export CSV
          </button>
          <button type="button" disabled={!!bulkLoading} onClick={() => void handleBulkAction('resend_email')}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-foreground hover:bg-muted/50 disabled:opacity-50">
            {bulkLoading === 'resend_email' && <Loader2 className="size-3 animate-spin" aria-hidden />}
            Resend Email
          </button>
          <button type="button" disabled={!!bulkLoading} onClick={() => void handleBulkAction('check_in')}
            className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
            {bulkLoading === 'check_in' && <Loader2 className="size-3 animate-spin" aria-hidden />}
            Check In
          </button>
          <button type="button" disabled={!!bulkLoading} onClick={() => void handleBulkAction('restore')}
            className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
            {bulkLoading === 'restore' && <Loader2 className="size-3 animate-spin" aria-hidden />}
            Restore
          </button>
          <button type="button" disabled={!!bulkLoading} onClick={() => void handleBulkAction('cancel')}
            className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-[12px] font-semibold text-red-600 hover:bg-red-100 disabled:opacity-50">
            {bulkLoading === 'cancel' && <Loader2 className="size-3 animate-spin" aria-hidden />}
            Cancel
          </button>
          <button type="button" onClick={clearSelection} disabled={!!bulkLoading}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
            aria-label="Clear selection">
            <X className="size-3.5" aria-hidden />
            Clear Selection
          </button>
        </div>
      )}
      {bulkFeedback && (
        <div className="mb-3 flex items-center justify-between rounded-xl border border-border bg-muted/20 px-4 py-2">
          <span className="text-[13px] text-muted-foreground">{bulkFeedback}</span>
          <button type="button" onClick={() => setBulkFeedback(null)}
            className="ml-2 text-muted-foreground/50 hover:text-foreground" aria-label="Dismiss">
            <X className="size-3" aria-hidden />
          </button>
        </div>
      )}

      {/* Cap warning in all-mode */}
      {isAllMode && data.registrations.length >= 2000 && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-800">
          Showing first 2,000 registrations. Use CSV export for the complete list.
        </div>
      )}

      {/* GA-7C S2/P5: render-cap note — fewer rows are painted than match, to keep the DOM light */}
      {renderCapped && (
        <div className="mb-3 rounded-xl border border-border bg-muted/30 px-4 py-2.5 text-[13px] text-muted-foreground">
          Showing the first {RENDER_CAP} of {filtered.length.toLocaleString('en-IN')} matching registrations. Refine your search, or export to CSV for the full list.
        </div>
      )}

      {/* Result count */}
      <div className="mb-2 flex items-center gap-2 text-[12px] text-muted-foreground">
        {pageLoading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        <span>
          {isAllMode ? (
            <>Showing <span className="font-semibold text-foreground">{filtered.length}</span> of <span className="font-semibold text-foreground">{totalCount}</span> total</>
          ) : (
            <>Page <span className="font-semibold text-foreground">{currentPage}</span> · showing <span className="font-semibold text-foreground">{filtered.length}</span> of <span className="font-semibold text-foreground">{totalCount}</span> total</>
          )}
        </span>
      </div>

      {/* Content */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-card py-16 text-center">
          <Users className="size-10 text-muted-foreground/20" aria-hidden />
          <p className="text-[14px] font-semibold text-foreground">
            {totalCount === 0 ? 'No registrations yet' : 'No results for your search'}
          </p>
          <p className="text-[13px] text-muted-foreground">
            {totalCount === 0
              ? 'Registrations will appear here once attendees sign up.'
              : 'Try adjusting your search or filters.'}
          </p>
        </div>
      ) : (
        <div className="relative">
          {pageLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-background/60 backdrop-blur-[1px]">
              <Loader2 className="size-7 animate-spin text-primary" aria-hidden />
            </div>
          )}

          {/* Mobile card list — shown below md */}
          <div className="space-y-2 md:hidden">
            {visible.map(reg => {
              const sm = statusMeta(reg.status)
              return (
                <div key={reg.id} className={cn('rounded-2xl border border-border bg-card p-4 shadow-sm', selectedIds.has(reg.id) && 'border-primary/30 bg-primary/[0.02]')}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold text-foreground">{reg.attendee.name}</p>
                      <p className="truncate text-[12px] text-muted-foreground">{reg.attendee.email}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${sm.cls}`}>
                        {sm.label}
                      </span>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(reg.id)}
                        onChange={e => { e.stopPropagation(); toggleSelect(reg.id) }}
                        aria-label={`Select ${reg.attendee.name}`}
                        className="size-4 cursor-pointer"
                      />
                    </div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-muted-foreground">
                    <span className="font-mono">{reg.ticketCode}</span>
                    <span aria-hidden>·</span>
                    <span>{reg.passName}</span>
                    <span aria-hidden>·</span>
                    <span>{fmtDateShort(reg.registeredAt)}</span>
                    {reg.checkedIn && (
                      <><span aria-hidden>·</span><span className="font-medium text-emerald-600">Checked in</span></>
                    )}
                    {reg.paymentStatus === 'refunded' && (
                      <><span aria-hidden>·</span><span className="font-medium text-amber-600">Refunded</span></>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelected(reg)}
                    className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/20 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted/50"
                  >
                    <Eye className="size-3.5" aria-hidden />
                    View Details
                  </button>
                </div>
              )
            })}
          </div>

          {/* Desktop table — shown md and above */}
          <div className="hidden overflow-hidden rounded-2xl border border-border bg-card shadow-sm md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" role="table">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/[0.03]">
                    <th className="w-10 px-3 py-3">
                      <input
                        type="checkbox"
                        checked={filtered.length > 0 && filtered.every(r => selectedIds.has(r.id))}
                        onChange={e => e.target.checked ? selectPage() : clearSelection()}
                        aria-label="Select all on page"
                        className="cursor-pointer"
                      />
                    </th>
                    {[
                      { key: null,                      label: 'Ticket'    },
                      { key: 'name'        as SortKey,  label: 'Name'      },
                      { key: null,                      label: 'Email'     },
                      { key: null,                      label: 'Phone'     },
                      { key: null,                      label: 'Pass'      },
                      { key: 'registeredAt' as SortKey, label: 'Date'      },
                      { key: 'status'      as SortKey,  label: 'Status'    },
                      { key: null,                      label: 'Check-In'  },
                      { key: null,                      label: ''          },
                    ].map(({ key, label }) => (
                      <th
                        key={label || 'actions'}
                        className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {key ? (
                          <button type="button" onClick={() => toggleSort(key)} className="flex items-center gap-1 hover:text-foreground">
                            {label}
                            <span className="text-muted-foreground/30">
                              {sortKey === key ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                            </span>
                          </button>
                        ) : label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map(reg => {
                    const sm = statusMeta(reg.status)
                    return (
                      <tr key={reg.id} className={cn('border-b border-border/30 transition-colors last:border-0', selectedIds.has(reg.id) ? 'bg-primary/[0.03]' : 'hover:bg-muted/[0.03]')}>
                        <td className="px-3 py-3">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(reg.id)}
                            onChange={() => toggleSelect(reg.id)}
                            aria-label={`Select ${reg.attendee.name}`}
                            className="cursor-pointer"
                          />
                        </td>
                        <td className="px-4 py-3 font-mono text-[12px] text-muted-foreground">{reg.ticketCode}</td>
                        <td className="px-4 py-3 font-medium text-foreground">{reg.attendee.name}</td>
                        <td className="px-4 py-3 text-muted-foreground">{reg.attendee.email}</td>
                        <td className="px-4 py-3 text-muted-foreground">{reg.attendee.phone || '—'}</td>
                        <td className="px-4 py-3 text-muted-foreground">{reg.passName}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{fmtDateShort(reg.registeredAt)}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${sm.cls}`}>
                            {sm.label}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {reg.checkedIn ? (
                            <span className="inline-flex items-center gap-1 text-[13px] font-medium text-emerald-600">
                              <CheckCircle className="size-3.5" aria-hidden /> Yes
                            </span>
                          ) : (
                            <span className="text-[13px] text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => setSelected(reg)}
                            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground/50 hover:bg-muted/60 hover:text-foreground"
                            aria-label={`View details for ${reg.attendee.name}`}
                          >
                            <Eye className="size-3.5" aria-hidden />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Pagination controls — hidden when search/filter is active (all-mode) */}
      {!isAllMode && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <span>Per page:</span>
            {([25, 50, 100] as const).map(n => (
              <button
                key={n}
                type="button"
                disabled={pageLoading}
                onClick={() => {
                  setPageSize(n)
                  setCursorStack([])
                  doFetch({ allMode: false, limit: n, cursor: null })
                }}
                className={cn(
                  'rounded-lg border px-2.5 py-1 text-[12px] font-medium transition-colors',
                  pageSize === n
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border bg-card text-foreground hover:bg-muted/50',
                )}
              >
                {n}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[13px] text-muted-foreground">
              Page <span className="font-semibold text-foreground">{currentPage}</span>
              {totalCount > 0 && (
                <> · <span className="font-semibold text-foreground">{totalCount}</span> total</>
              )}
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={cursorStack.length === 0 || pageLoading}
                onClick={() => {
                  const newStack  = cursorStack.slice(0, -1)
                  setCursorStack(newStack)
                  const prevCursor = newStack.length > 0 ? newStack[newStack.length - 1] : null
                  doFetch({ allMode: false, limit: pageSize, cursor: prevCursor })
                }}
                className="flex h-8 items-center gap-1 rounded-lg border border-border bg-card px-3 text-[12px] font-medium text-foreground hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="size-3.5" aria-hidden /> Prev
              </button>
              <button
                type="button"
                disabled={!hasMore || pageLoading}
                onClick={() => {
                  if (!nextCursor) return
                  const cur = nextCursor
                  setCursorStack(prev => [...prev, cur])
                  doFetch({ allMode: false, limit: pageSize, cursor: cur })
                }}
                className="flex h-8 items-center gap-1 rounded-lg border border-border bg-card px-3 text-[12px] font-medium text-foreground hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next <ChevronRight className="size-3.5" aria-hidden />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Registration details drawer */}
      {selected && (
        <RegistrationDrawer
          reg={selected}
          eventId={eventId}
          fieldLabels={fieldLabels}
          token={authToken}
          onClose={() => setSelected(null)}
          onUpdate={updates => handleRegistrationUpdate(selected.id, updates)}
        />
      )}
    </div>
  )
}
