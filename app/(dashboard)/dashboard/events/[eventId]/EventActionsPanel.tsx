'use client'

import { useState }   from 'react'
import { useRouter }  from 'next/navigation'
import { cn }         from '@/lib/utils/cn'
import {
  LockOpen, Lock, CheckCircle, XCircle, Archive,
  Copy, AlertTriangle, X, Loader2, Link2, EyeOff,
} from 'lucide-react'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type { EventLifecycleStatus } from '@/types/events'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  event:     EventDetailResponse
  token:     string
  onSuccess: () => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function callAction(
  eventId: string,
  route:   string,
  token:   string,
  body:    Record<string, unknown> = {},
): Promise<{ success: boolean; error?: string }> {
  const res  = await fetch(`/api/organizer/events/${eventId}/${route}`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  const json = await res.json() as { success: boolean; error?: string }
  return json
}

// ─── Cancellation Modal ───────────────────────────────────────────────────────

function CancellationModal({
  eventId, token, onSuccess, onClose,
}: {
  eventId: string; token: string; onSuccess: () => void; onClose: () => void
}) {
  const [reason,  setReason]  = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  async function handleCancel() {
    if (reason.trim().length < 5) {
      setError('Please enter a reason (at least 5 characters)')
      return
    }
    setLoading(true)
    setError(null)
    const result = await callAction(eventId, 'cancel', token, { cancelReason: reason })
    setLoading(false)
    if (result.success) {
      onSuccess()
      onClose()
    } else {
      setError(result.error ?? 'Failed to cancel event')
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-100">
              <XCircle className="size-5 text-red-600" />
            </div>
            <div>
              <p className="text-[15px] font-semibold text-foreground">Cancel Event</p>
              <p className="text-[12px] text-muted-foreground">This action cannot be undone easily</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-muted/60">
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>

        {/* Warning */}
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-[12.5px] text-amber-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            Cancelling this event will stop all new registrations immediately and notify attendees
            via the public event page.
          </span>
        </div>

        {/* Reason textarea */}
        <label className="block space-y-1.5">
          <span className="text-[12.5px] font-medium text-foreground">
            Cancellation Reason <span className="text-red-500">*</span>
          </span>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Explain why this event is being cancelled…"
            rows={3}
            className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-red-400/40"
          />
          <span className="text-[11px] text-muted-foreground">{reason.length} / 5 min characters</span>
        </label>

        {error && (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-600">{error}</p>
        )}

        {/* Actions */}
        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-border bg-card px-4 py-2.5 text-[13px] font-medium text-foreground hover:bg-muted/60"
          >
            Keep Event
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={loading || reason.trim().length < 5}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
            {loading ? 'Cancelling…' : 'Cancel Event'}
          </button>
        </div>
      </div>
    </>
  )
}

// ─── Confirm Modal (generic) ──────────────────────────────────────────────────

function ConfirmModal({
  title, description, confirmLabel, confirmCls, icon: Icon,
  onConfirm, onClose, loading,
}: {
  title:       string
  description: string
  confirmLabel: string
  confirmCls:  string
  icon:        React.ElementType
  onConfirm:   () => void
  onClose:     () => void
  loading:     boolean
}) {
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
            <Icon className="size-5 text-foreground" />
          </div>
          <div>
            <p className="text-[15px] font-semibold text-foreground">{title}</p>
            <p className="text-[12px] text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-border bg-card px-4 py-2.5 text-[13px] font-medium hover:bg-muted/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white transition-colors disabled:opacity-50',
              confirmCls,
            )}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
            {loading ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </>
  )
}

// ─── Action Button ────────────────────────────────────────────────────────────

function ActionBtn({
  icon: Icon, label, onClick, variant = 'default',
}: {
  icon:     React.ElementType
  label:    string
  onClick:  () => void
  variant?: 'default' | 'danger' | 'primary'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-xl border px-3.5 py-2 text-[12.5px] font-medium transition-colors',
        variant === 'primary' && 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20',
        variant === 'danger'  && 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100',
        variant === 'default' && 'border-border bg-card text-foreground hover:bg-muted/60',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {label}
    </button>
  )
}

// ─── Copy Registration Link ───────────────────────────────────────────────────

function CopyLinkButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false)
  const url = typeof window !== 'undefined'
    ? `${window.location.origin}/events/${slug}/register`
    : `/events/${slug}/register`

  async function handle() {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      onClick={handle}
      className="flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted/60"
    >
      <Link2 className="size-3.5" />
      {copied ? 'Copied!' : 'Copy Reg Link'}
    </button>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

type ModalState = 'none' | 'cancel' | 'close_reg' | 'reopen_reg' | 'complete' | 'archive' | 'duplicate' | 'unpublish'

export default function EventActionsPanel({ event, token, onSuccess }: Props) {
  const router              = useRouter()
  const [modal, setModal]   = useState<ModalState>('none')
  const [loading, setLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const ls: EventLifecycleStatus = event.lifecycleStatus

  async function callStatus(action: string) {
    setLoading(true)
    setActionError(null)
    const result = await callAction(event.draftId, 'status', token, { action })
    setLoading(false)
    setModal('none')
    if (result.success) onSuccess()
    else setActionError(result.error ?? 'Action failed')
  }

  async function handleDuplicate() {
    setLoading(true)
    setActionError(null)
    const res  = await fetch(`/api/organizer/events/${event.draftId}/duplicate`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json() as { success: boolean; draftId?: string; error?: string }
    setLoading(false)
    setModal('none')
    if (json.success && json.draftId) {
      router.push(`/dashboard/events/new/visibility?draftId=${json.draftId}`)
    } else {
      setActionError(json.error ?? 'Duplication failed')
    }
  }

  // ── Derive available actions from lifecycle status ─────────────────────────

  // Archived events show nothing — the manage page is read-only
  if (ls === 'archived') return null

  const canCloseReg    = ls === 'published'
  const canReopenReg   = ls === 'registration_closed'
  const canComplete    = ls === 'published'
  const canCancel      = ls === 'published' || ls === 'registration_closed'
  const canArchive     = ls === 'completed' || ls === 'cancelled'
  const canUnpublish   = ls === 'published'
  const canDuplicate   = true
  const showRegLink    = (ls === 'published' || ls === 'registration_closed') && !!event.slug
  const isReadOnly     = false

  return (
    <div className="flex flex-col gap-3">
      {/* Error banner */}
      {actionError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-600">
          <AlertTriangle className="size-3.5 shrink-0" />
          {actionError}
          <button type="button" onClick={() => setActionError(null)} className="ml-auto">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* Registration state badge */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold',
          ls === 'published'           && 'bg-emerald-100 text-emerald-700',
          ls === 'registration_closed' && 'bg-amber-100 text-amber-700',
          ls === 'completed'           && 'bg-sky-100 text-sky-700',
          ls === 'cancelled'           && 'bg-red-100 text-red-600',
          ls === 'draft'               && 'bg-muted text-muted-foreground',
        )}>
          <span className={cn(
            'size-1.5 rounded-full',
            ls === 'published'           && 'bg-emerald-500',
            ls === 'registration_closed' && 'bg-amber-500',
            ls === 'completed'           && 'bg-sky-500',
            ls === 'cancelled'           && 'bg-red-500',
            ls === 'draft'               && 'bg-muted-foreground',
          )} />
          {ls === 'published'           && 'Registrations Open'}
          {ls === 'registration_closed' && 'Registrations Closed'}
          {ls === 'completed'           && 'Event Completed'}
          {ls === 'cancelled'           && 'Event Cancelled'}
          {ls === 'draft'               && 'Draft'}
        </span>

        {showRegLink && event.slug && <CopyLinkButton slug={event.slug} />}
      </div>

      {/* Action buttons */}
      {!isReadOnly && (
        <div className="flex flex-wrap gap-2">
          {canCloseReg && (
            <ActionBtn icon={Lock}        label="Close Registrations" onClick={() => setModal('close_reg')} />
          )}
          {canUnpublish && (
            <ActionBtn icon={EyeOff}      label="Unpublish Event"     onClick={() => setModal('unpublish')} />
          )}
          {canReopenReg && (
            <ActionBtn icon={LockOpen}    label="Reopen Registrations" onClick={() => setModal('reopen_reg')} variant="primary" />
          )}
          {canComplete && (
            <ActionBtn icon={CheckCircle} label="Mark Complete"        onClick={() => setModal('complete')} />
          )}
          {canArchive && (
            <ActionBtn icon={Archive}     label="Archive"              onClick={() => setModal('archive')} />
          )}
          {canDuplicate && (
            <ActionBtn icon={Copy}        label="Duplicate Event"       onClick={() => setModal('duplicate')} />
          )}
          {canCancel && (
            <ActionBtn icon={XCircle}     label="Cancel Event"          onClick={() => setModal('cancel')} variant="danger" />
          )}
        </div>
      )}

      {/* Archived — duplicate only */}
      {isReadOnly && canDuplicate && (
        <div className="flex flex-wrap gap-2">
          <ActionBtn icon={Copy} label="Duplicate Event" onClick={() => setModal('duplicate')} />
        </div>
      )}

      {/* ── Modals ── */}

      {modal === 'cancel' && (
        <CancellationModal
          eventId={event.draftId}
          token={token}
          onSuccess={onSuccess}
          onClose={() => setModal('none')}
        />
      )}

      {modal === 'close_reg' && (
        <ConfirmModal
          title="Close Registrations"
          description="No new attendees can register until you reopen."
          confirmLabel="Close Registrations"
          confirmCls="bg-amber-500 hover:bg-amber-600"
          icon={Lock}
          loading={loading}
          onConfirm={() => callStatus('close_registrations')}
          onClose={() => setModal('none')}
        />
      )}

      {modal === 'reopen_reg' && (
        <ConfirmModal
          title="Reopen Registrations"
          description="Attendees will be able to register again."
          confirmLabel="Reopen Registrations"
          confirmCls="bg-emerald-600 hover:bg-emerald-700"
          icon={LockOpen}
          loading={loading}
          onConfirm={() => callStatus('reopen_registrations')}
          onClose={() => setModal('none')}
        />
      )}

      {modal === 'complete' && (
        <ConfirmModal
          title="Mark as Completed"
          description="This event will become read-only. Only archiving is allowed after completion."
          confirmLabel="Mark Complete"
          confirmCls="bg-sky-600 hover:bg-sky-700"
          icon={CheckCircle}
          loading={loading}
          onConfirm={() => callStatus('complete')}
          onClose={() => setModal('none')}
        />
      )}

      {modal === 'archive' && (
        <ConfirmModal
          title="Archive Event"
          description="This event will be hidden from active lists. It becomes permanently read-only."
          confirmLabel="Archive Event"
          confirmCls="bg-muted-foreground hover:opacity-80"
          icon={Archive}
          loading={loading}
          onConfirm={() => callStatus('archive')}
          onClose={() => setModal('none')}
        />
      )}

      {modal === 'duplicate' && (
        <ConfirmModal
          title="Duplicate Event"
          description="A draft copy will be created. You'll be taken to the wizard to edit and publish it."
          confirmLabel="Duplicate & Edit"
          confirmCls="bg-primary hover:bg-[#bf1868]"
          icon={Copy}
          loading={loading}
          onConfirm={handleDuplicate}
          onClose={() => setModal('none')}
        />
      )}

      {modal === 'unpublish' && (
        <ConfirmModal
          title="Unpublish Event"
          description="The event page will be hidden from the public. All data is preserved — you can republish at any time."
          confirmLabel="Unpublish"
          confirmCls="bg-amber-500 hover:bg-amber-600"
          icon={EyeOff}
          loading={loading}
          onConfirm={() => callStatus('unpublish')}
          onClose={() => setModal('none')}
        />
      )}
    </div>
  )
}
