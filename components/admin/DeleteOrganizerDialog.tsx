'use client'

// RD-ORGANIZER-REMAINING-ALL · the Delete Organizer confirmation.
//
// ═══ WHAT THIS DIALOG IS DEFENDING AGAINST ═══════════════════════════════════
// Two different mistakes, and they need different defences:
//
//   1. THE WRONG ROW. Suspend, Ban and Delete sit next to each other in one action cluster, and
//      only one of them is irreversible. So the dialog states the identity it is about to
//      destroy — name, email, organization — rather than trusting that the admin clicked the
//      row they meant. The typed confirmation exists for the same reason: it cannot be
//      satisfied by a mis-aimed click.
//
//   2. A DELETION THAT SHOULD NOT HAPPEN. The dialog asks the server whether this organizer is
//      deletable and shows the blocking reasons verbatim when it is not. It does NOT compute
//      that verdict itself and never treats its own answer as permission — the DELETE endpoint
//      re-runs every probe. If those two ever disagree, the server wins and this dialog simply
//      reports what it said.
//
// The confirm button stays disabled until ALL conditions hold: the server said deletable, the
// typed text is exactly `DELETE`, and a reason is written. Case-sensitive — `delete` does not
// count, because the point of the gesture is deliberateness, not spelling.
//
// RD-PREPROD · D3 — the reason is sent to the server, which requires it (3–500 characters) and
// records it in the admin audit log. The length check here is a convenience; the server decides.

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

/** The exact string an admin must type. Case-sensitive by design. */
export const DELETE_CONFIRMATION = 'DELETE'

/** Mirrors REASON_MIN/REASON_MAX in lib/admin/financialGuard (server-only, so not imported). */
const REASON_MIN = 3
const REASON_MAX = 500

interface Eligibility {
  deletable?: boolean
  blockers?:  { code: string; reason: string }[]
  identity?:  { name: string; email: string; organizationName: string } | null
  jobStatus?: string | null
  error?:     string
}

export interface DeleteOrganizerDialogProps {
  uid:       string
  /** Fallback identity from the list row, shown until the server's own copy arrives. */
  fallback:  { name: string; email: string; organizationName: string }
  getToken:  () => Promise<string | null>
  onClose:   () => void
  /** Called after a successful deletion so the list can drop the row. */
  onDeleted: (uid: string) => void
}

export function DeleteOrganizerDialog({
  uid, fallback, getToken, onClose, onDeleted,
}: DeleteOrganizerDialogProps) {
  const [typed,   setTyped]   = useState('')
  const [reason,  setReason]  = useState('')
  const [elig,    setElig]    = useState<Eligibility | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const endpoint = `/api/admin/organizers/${encodeURIComponent(uid)}/delete`

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(endpoint, {
        headers: { authorization: `Bearer ${token ?? ''}` }, cache: 'no-store',
      })
      const body = await res.json() as Eligibility
      if (!res.ok) { setError(body.error ?? 'Could not check whether this organizer can be deleted.'); setElig(null) }
      else { setElig(body); setError(null) }
    } catch {
      // Fail CLOSED: an unknown verdict must not present as deletable.
      setError('Could not check whether this organizer can be deleted.')
      setElig(null)
    } finally { setLoading(false) }
  }, [endpoint, getToken])

  // Deferred a microtask so nothing in `load` runs synchronously inside the effect.
  useEffect(() => {
    let alive = true
    void Promise.resolve().then(() => (alive ? load() : undefined))
    return () => { alive = false }
  }, [load])

  // Escape closes, unless a deletion is in flight — interrupting it would leave the admin
  // unsure whether it ran.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const identity  = elig?.identity ?? fallback
  const deletable = elig?.deletable === true
  const blockers  = elig?.blockers ?? []
  const confirmed = typed === DELETE_CONFIRMATION
  const reasonOk  = reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX
  const canDelete = deletable && confirmed && reasonOk && !busy && !loading

  const submit = useCallback(async () => {
    if (!canDelete) return
    setBusy(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(endpoint, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      const body = await res.json() as {
        success?: boolean; blockers?: { code: string; reason: string }[]; error?: string
      }
      if (res.ok && body.success) { onDeleted(uid); onClose(); return }

      // A 409 means the server's own re-check refused. Show its reasons rather than a generic
      // failure — this is the case where the dialog was out of date, and saying so is honest.
      if (body.blockers?.length) {
        setElig(prev => ({ ...(prev ?? {}), deletable: false, blockers: body.blockers }))
        setError(body.error ?? 'This organizer can no longer be deleted.')
      } else {
        setError(body.error ?? 'Deletion failed.')
      }
    } catch {
      setError('Deletion failed. Check the organizer list before retrying.')
    } finally { setBusy(false) }
  }, [canDelete, endpoint, getToken, onClose, onDeleted, reason, uid])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-organizer-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="w-full max-w-md rounded-xl border border-destructive/30 bg-card shadow-xl">
        {/* ── Header ── */}
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="size-4.5 text-destructive" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="delete-organizer-title" className="text-[15px] font-bold text-foreground">
              Delete Organizer?
            </h2>
            {/* Named apart from Suspend and Ban so the irreversible one cannot be mistaken for
                the reversible ones sitting beside it in the same action cluster. */}
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              This is not Suspend or Ban. It permanently removes the account and cannot be undone.
            </p>
          </div>
          <button
            type="button" onClick={onClose} disabled={busy} aria-label="Close"
            className="rounded-lg p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* ── Who ── */}
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[13px]">
            <p className="font-semibold text-foreground">{identity.organizationName || '—'}</p>
            <p className="text-muted-foreground">{identity.name || '—'}</p>
            <p className="text-muted-foreground">{identity.email || '—'}</p>
          </div>

          {loading ? (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking whether this account can be deleted…
            </p>
          ) : !deletable ? (
            /* ── Blocked ── */
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
              <p className="text-[13px] font-semibold text-amber-900">Deletion unavailable</p>
              {blockers.length > 0 ? (
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12.5px] text-amber-800">
                  {blockers.map(b => <li key={b.code}>{b.reason}</li>)}
                </ul>
              ) : (
                <p className="mt-1 text-[12.5px] text-amber-800">
                  {error ?? 'This organizer cannot be deleted right now.'}
                </p>
              )}
            </div>
          ) : (
            /* ── Confirm ── */
            <>
              <p className="text-[13px] text-muted-foreground">
                This removes the organizer account and the data it owns. Financial and audit
                records are retained.
              </p>
              <label className="block">
                <span className="text-[12.5px] text-muted-foreground">
                  Type{' '}
                  <span className="rounded bg-muted px-1 py-0.5 font-mono font-semibold text-foreground">
                    {DELETE_CONFIRMATION}
                  </span>{' '}
                  to confirm.
                </span>
                <input
                  autoFocus
                  value={typed}
                  onChange={e => setTyped(e.target.value)}
                  disabled={busy}
                  aria-label={`Type ${DELETE_CONFIRMATION} to confirm`}
                  placeholder={DELETE_CONFIRMATION}
                  className="mt-1.5 h-9 w-full rounded-lg border border-destructive/40 bg-background px-3 text-[13px] font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-destructive/25"
                />
              </label>
              <label className="block">
                <span className="text-[12.5px] text-muted-foreground">
                  Reason for deletion (recorded in the audit log).
                </span>
                <textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  disabled={busy}
                  maxLength={REASON_MAX}
                  rows={2}
                  aria-label="Reason for deletion"
                  className="mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-destructive/25"
                />
              </label>
            </>
          )}

          {error && deletable && (
            <p className="flex items-start gap-2 text-[12.5px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span>{error}</span>
            </p>
          )}
        </div>

        {/* ── Actions ── */}
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button" onClick={onClose} disabled={busy}
            className="rounded-lg border border-border px-3.5 py-2 text-[13px] font-medium text-foreground hover:bg-muted/60 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button" onClick={() => void submit()} disabled={!canDelete}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors',
              canDelete
                ? 'bg-destructive text-white hover:opacity-90'
                : 'cursor-not-allowed bg-muted text-muted-foreground',
            )}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
            Permanently delete
          </button>
        </div>
      </div>
    </div>
  )
}
