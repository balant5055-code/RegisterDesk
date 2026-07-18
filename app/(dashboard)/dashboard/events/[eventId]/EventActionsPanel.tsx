'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter }  from 'next/navigation'
import { cn }         from '@/lib/utils/cn'
import {
  LockOpen, Lock, CheckCircle, XCircle, Archive,
  Copy, AlertTriangle, X, Loader2, Link2, EyeOff, ChevronDown, Send, RotateCcw,
} from 'lucide-react'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type { EventLifecycleStatus } from '@/types/events'
import { useToast } from '@/components/ui/Toast'
import { Dialog } from '@/components/ui/Dialog'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  event:     EventDetailResponse
  token:     string
  onSuccess: () => void
  mode?:     'flat' | 'dropdown'
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
  const { showToast }         = useToast()
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
    try {
      const result = await callAction(eventId, 'cancel', token, { cancelReason: reason })
      if (result.success) {
        showToast('Event cancelled.', 'success')
        onSuccess()
        onClose()
      } else {
        const msg = result.error ?? 'Failed to cancel event'
        setError(msg)
        showToast(msg, 'error')
      }
    } catch {
      const msg = 'Network error. Please try again.'
      setError(msg)
      showToast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog
      open onClose={onClose} title="Cancel Event" size="md"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border bg-card px-4 py-2.5 text-[14px] font-medium text-foreground hover:bg-muted/60"
          >
            Keep Event
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={loading || reason.trim().length < 5}
            className="flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
            {loading ? 'Cancelling…' : 'Cancel Event'}
          </button>
        </>
      }
    >
      <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-[13px] text-amber-800">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>
          Cancelling this event will stop all new registrations immediately and notify attendees
          via the public event page. This action cannot be undone easily.
        </span>
      </div>
      <label className="block space-y-1.5">
        <span className="text-[13px] font-medium text-foreground">
          Cancellation Reason <span className="text-red-500">*</span>
        </span>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Explain why this event is being cancelled…"
          rows={3}
          className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-red-400/40"
        />
        <span className="text-[13px] text-muted-foreground">{reason.length} / 5 min characters</span>
      </label>
      {error && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-600">{error}</p>
      )}
    </Dialog>
  )
}

// ─── Confirm Modal (generic) ──────────────────────────────────────────────────

function ConfirmModal({
  title, description, confirmLabel, confirmCls, icon: Icon,
  onConfirm, onClose, loading,
}: {
  title:        string
  description:  string
  confirmLabel: string
  confirmCls:   string
  icon:         React.ElementType
  onConfirm:    () => void
  onClose:      () => void
  loading:      boolean
}) {
  return (
    <Dialog
      open onClose={onClose} title={title} size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border bg-card px-4 py-2.5 text-[13px] font-medium hover:bg-muted/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[14px] font-semibold text-white transition-colors disabled:opacity-50',
              confirmCls,
            )}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
            {loading ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Icon className="size-5 text-foreground" />
        </div>
        <p className="text-[13px] text-muted-foreground">{description}</p>
      </div>
    </Dialog>
  )
}

// ─── Action Button (flat mode) ────────────────────────────────────────────────

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
        'flex items-center gap-2 rounded-xl border px-3.5 py-2 text-[14px] font-medium transition-colors',
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

// ─── Copy Registration Link (flat mode) ──────────────────────────────────────

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
      className="flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 text-[14px] font-medium text-foreground transition-colors hover:bg-muted/60"
    >
      <Link2 className="size-3.5" />
      {copied ? 'Copied!' : 'Copy Reg Link'}
    </button>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

type ModalState = 'none' | 'cancel' | 'close_reg' | 'reopen_reg' | 'complete' | 'archive' | 'duplicate' | 'unpublish' | 'republish' | 'restore'

export default function EventActionsPanel({ event, token, onSuccess, mode = 'flat' }: Props) {
  const router                          = useRouter()
  const { showToast }                   = useToast()
  const [modal, setModal]               = useState<ModalState>('none')
  const [loading, setLoading]           = useState(false)
  const [actionError, setActionError]   = useState<string | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef                     = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    function onMouseDown(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [dropdownOpen])

  const ls: EventLifecycleStatus = event.lifecycleStatus

  async function callStatus(action: string) {
    setLoading(true)
    setActionError(null)
    try {
      const result = await callAction(event.draftId, 'status', token, { action })
      if (result.success) {
        showToast('Event updated.', 'success')
        onSuccess()   // refresh state after a successful action
      } else {
        const msg = result.error ?? 'Action failed'
        setActionError(msg)
        showToast(msg, 'error')
      }
    } catch {
      const msg = 'Network error. Please try again.'
      setActionError(msg)
      showToast(msg, 'error')
    } finally {
      setLoading(false)
      setModal('none')
    }
  }

  // Republish an unpublished event: sends it back to admin review via the
  // dedicated route (reuses the paid license — never a payment). Distinct from
  // callStatus because it hits /republish, not /status.
  async function callRepublish() {
    setLoading(true)
    setActionError(null)
    try {
      const res  = await fetch(`/api/organizer/events/${event.draftId}/republish`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json().catch(() => ({})) as { success?: boolean; error?: string }
      if (res.ok && json.success) {
        showToast('Event submitted for review.', 'success')
        onSuccess()   // refresh state after a successful transition
      } else {
        const msg = json.error ?? 'Republish failed'
        setActionError(msg)
        showToast(msg, 'error')
      }
    } catch {
      const msg = 'Network error. Please try again.'
      setActionError(msg)
      showToast(msg, 'error')
    } finally {
      setLoading(false)
      setModal('none')
    }
  }

  // Restore an archived event: returns it to the private 'unpublished' state via
  // the dedicated route (reuses the paid license — never a payment).
  async function callRestore() {
    setLoading(true)
    setActionError(null)
    try {
      const res  = await fetch(`/api/organizer/events/${event.draftId}/restore`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json().catch(() => ({})) as { success?: boolean; error?: string }
      if (res.ok && json.success) {
        showToast('Event restored.', 'success')
        onSuccess()   // refresh state after a successful transition
      } else {
        const msg = json.error ?? 'Restore failed'
        setActionError(msg)
        showToast(msg, 'error')
      }
    } catch {
      const msg = 'Network error. Please try again.'
      setActionError(msg)
      showToast(msg, 'error')
    } finally {
      setLoading(false)
      setModal('none')
    }
  }

  async function handleDuplicate() {
    setLoading(true)
    setActionError(null)
    try {
      const res  = await fetch(`/api/organizer/events/${event.draftId}/duplicate`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json() as { success: boolean; draftId?: string; error?: string }
      if (json.success && json.draftId) {
        showToast('Event duplicated.', 'success')
        router.push(`/dashboard/events/new/visibility?draftId=${json.draftId}`)
      } else {
        const msg = json.error ?? 'Duplication failed'
        setActionError(msg)
        showToast(msg, 'error')
      }
    } catch {
      const msg = 'Network error. Please try again.'
      setActionError(msg)
      showToast(msg, 'error')
    } finally {
      setLoading(false)
      setModal('none')
    }
  }

  const canCloseReg  = ls === 'published'
  const canReopenReg = ls === 'registration_closed'
  const canComplete  = ls === 'published'
  const canCancel    = ls === 'published' || ls === 'registration_closed'
  const canArchive   = ls === 'completed' || ls === 'cancelled'
  const canUnpublish = ls === 'published'
  const canRepublish = ls === 'unpublished'
  const canRestore   = ls === 'archived'
  const canDuplicate = true
  const showRegLink  = (ls === 'published' || ls === 'registration_closed') && !!event.slug
  const isReadOnly   = false

  // ── Dropdown action list ──────────────────────────────────────────────────

  type DropdownItem = {
    icon:     React.ElementType
    label:    string
    onClick:  () => void
    variant?: 'danger'
  }

  const dropdownItems: DropdownItem[] = []
  if (canCloseReg)  dropdownItems.push({ icon: Lock,        label: 'Close Registrations',  onClick: () => { setDropdownOpen(false); setModal('close_reg')  } })
  if (canReopenReg) dropdownItems.push({ icon: LockOpen,    label: 'Reopen Registrations', onClick: () => { setDropdownOpen(false); setModal('reopen_reg') } })
  if (canUnpublish) dropdownItems.push({ icon: EyeOff,      label: 'Unpublish Event',       onClick: () => { setDropdownOpen(false); setModal('unpublish')  } })
  if (canRepublish) dropdownItems.push({ icon: Send,        label: 'Republish Event',       onClick: () => { setDropdownOpen(false); setModal('republish')  } })
  if (canRestore)   dropdownItems.push({ icon: RotateCcw,   label: 'Restore Event',         onClick: () => { setDropdownOpen(false); setModal('restore')    } })
  if (canComplete)  dropdownItems.push({ icon: CheckCircle, label: 'Mark Complete',         onClick: () => { setDropdownOpen(false); setModal('complete')   } })
  if (canDuplicate) dropdownItems.push({ icon: Copy,        label: 'Duplicate Event',        onClick: () => { setDropdownOpen(false); setModal('duplicate')  } })
  if (canArchive)   dropdownItems.push({ icon: Archive,     label: 'Archive Event',          onClick: () => { setDropdownOpen(false); setModal('archive')    } })
  if (canCancel)    dropdownItems.push({ icon: XCircle,     label: 'Cancel Event',           onClick: () => { setDropdownOpen(false); setModal('cancel')     }, variant: 'danger' })

  return (
    <>
      {/* ── Flat mode (original behavior) ──────────────────────────────────── */}
      {mode === 'flat' && (
        <div className="flex flex-col gap-3">
          {actionError && (
            <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-600">
              <AlertTriangle className="size-3.5 shrink-0" />
              {actionError}
              <button type="button" onClick={() => setActionError(null)} className="ml-auto">
                <X className="size-3.5" />
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold',
              ls === 'published'           && 'bg-emerald-100 text-emerald-700',
              ls === 'registration_closed' && 'bg-amber-100 text-amber-700',
              ls === 'completed'           && 'bg-sky-100 text-sky-700',
              ls === 'cancelled'           && 'bg-red-100 text-red-600',
              ls === 'draft'               && 'bg-muted text-muted-foreground',
              ls === 'unpublished'         && 'bg-slate-100 text-slate-600',
              ls === 'archived'            && 'bg-muted text-muted-foreground',
            )}>
              <span className={cn(
                'size-1.5 rounded-full',
                ls === 'published'           && 'bg-emerald-500',
                ls === 'registration_closed' && 'bg-amber-500',
                ls === 'completed'           && 'bg-sky-500',
                ls === 'cancelled'           && 'bg-red-500',
                ls === 'draft'               && 'bg-muted-foreground',
                ls === 'unpublished'         && 'bg-slate-400',
                ls === 'archived'            && 'bg-muted-foreground',
              )} />
              {ls === 'published'           && 'Registrations Open'}
              {ls === 'registration_closed' && 'Registrations Closed'}
              {ls === 'completed'           && 'Event Completed'}
              {ls === 'cancelled'           && 'Event Cancelled'}
              {ls === 'draft'               && 'Draft'}
              {ls === 'unpublished'         && 'Unpublished'}
              {ls === 'archived'            && 'Archived'}
            </span>
            {showRegLink && event.slug && <CopyLinkButton slug={event.slug} />}
          </div>

          {!isReadOnly && (
            <div className="flex flex-wrap gap-2">
              {canCloseReg  && <ActionBtn icon={Lock}        label="Close Registrations"  onClick={() => setModal('close_reg')}  />}
              {canUnpublish && <ActionBtn icon={EyeOff}      label="Unpublish Event"       onClick={() => setModal('unpublish')}  />}
              {canRepublish && <ActionBtn icon={Send}        label="Republish Event"       onClick={() => setModal('republish')} variant="primary" />}
              {canRestore   && <ActionBtn icon={RotateCcw}   label="Restore Event"         onClick={() => setModal('restore')}   variant="primary" />}
              {canReopenReg && <ActionBtn icon={LockOpen}    label="Reopen Registrations" onClick={() => setModal('reopen_reg')} variant="primary" />}
              {canComplete  && <ActionBtn icon={CheckCircle} label="Mark Complete"         onClick={() => setModal('complete')}   />}
              {canArchive   && <ActionBtn icon={Archive}     label="Archive"               onClick={() => setModal('archive')}    />}
              {canDuplicate && <ActionBtn icon={Copy}        label="Duplicate Event"        onClick={() => setModal('duplicate')}  />}
              {canCancel    && <ActionBtn icon={XCircle}     label="Cancel Event"           onClick={() => setModal('cancel')}     variant="danger" />}
            </div>
          )}

          {isReadOnly && canDuplicate && (
            <div className="flex flex-wrap gap-2">
              <ActionBtn icon={Copy} label="Duplicate Event" onClick={() => setModal('duplicate')} />
            </div>
          )}
        </div>
      )}

      {/* ── Dropdown mode ──────────────────────────────────────────────────── */}
      {mode === 'dropdown' && (
        <div className="flex flex-col gap-2">
          {actionError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600">
              <AlertTriangle className="size-3.5 shrink-0" />
              <span className="flex-1">{actionError}</span>
              <button type="button" onClick={() => setActionError(null)}>
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {dropdownItems.length > 0 && (
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setDropdownOpen(o => !o)}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                Actions
                <ChevronDown className={cn('size-3.5 transition-transform duration-150', dropdownOpen && 'rotate-180')} />
              </button>

              {dropdownOpen && (
                <div className="absolute right-0 top-full z-30 mt-1.5 w-52 overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                  {dropdownItems.map((item, i) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={item.onClick}
                      className={cn(
                        'flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13px] font-medium transition-colors',
                        item.variant === 'danger'
                          ? 'text-red-600 hover:bg-red-50'
                          : 'text-foreground hover:bg-muted/60',
                        i > 0 && 'border-t border-border/40',
                      )}
                    >
                      <item.icon className="size-3.5 shrink-0" />
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Modals — shared by both modes ───────────────────────────────────── */}

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
          confirmCls="bg-primary hover:bg-[var(--primary-hover)]"
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

      {modal === 'republish' && (
        <ConfirmModal
          title="Republish Event"
          description="The event will be submitted for admin review again. Your existing license is reused — there is no new payment. Once approved, it goes live."
          confirmLabel="Submit for Review"
          confirmCls="bg-primary hover:bg-primary/90"
          icon={Send}
          loading={loading}
          onConfirm={() => callRepublish()}
          onClose={() => setModal('none')}
        />
      )}

      {modal === 'restore' && (
        <ConfirmModal
          title="Restore Event"
          description="The event will be restored as Unpublished — still private (404 to the public). Your existing license is reused, with no new payment. Republish it to send it for review and go live again."
          confirmLabel="Restore Event"
          confirmCls="bg-primary hover:bg-primary/90"
          icon={RotateCcw}
          loading={loading}
          onConfirm={() => callRestore()}
          onClose={() => setModal('none')}
        />
      )}
    </>
  )
}
