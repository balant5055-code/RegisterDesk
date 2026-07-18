'use client'

import { useState } from 'react'
import { Flag, X, Loader2, CheckCircle2 } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn }   from '@/lib/utils/cn'
import { IconButton } from '@/components/ui'
import type { ReportTargetType } from '@/lib/admin/reportTypes'

const REASONS = [
  'Spam or misleading',
  'Fraud or scam',
  'Inappropriate or offensive content',
  'Prohibited or illegal activity',
  'Impersonation',
  'Other',
]

interface Props {
  targetType: ReportTargetType
  targetId:   string
  label?:     string
  className?: string
}

export default function ReportButton({ targetType, targetId, label, className }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground',
          className,
        )}
      >
        <Flag className="size-3.5" aria-hidden />
        {label ?? `Report ${targetType}`}
      </button>
      {open && <ReportModal targetType={targetType} targetId={targetId} onClose={() => setOpen(false)} />}
    </>
  )
}

function ReportModal({ targetType, targetId, onClose }: {
  targetType: ReportTargetType
  targetId:   string
  onClose:    () => void
}) {
  const [reason,  setReason]  = useState(REASONS[0])
  const [details, setDetails] = useState('')
  const [email,   setEmail]   = useState('')
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [done,    setDone]    = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      // Attach auth when signed in (optional — endpoint is public).
      const token = await auth.currentUser?.getIdToken().catch(() => null)
      if (token) headers.authorization = `Bearer ${token}`

      const res = await fetch('/api/report', {
        method:  'POST',
        headers,
        body: JSON.stringify({
          targetType,
          targetId,
          reason,
          details: details.trim() || undefined,
          email:   email.trim()   || undefined,
        }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? `Could not submit report (${res.status})`)
      }
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit report')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-foreground">Report this {targetType}</h2>
          <IconButton onClick={onClose} aria-label="Close"><X className="size-4" /></IconButton>
        </div>

        {done ? (
          <div className="py-6 text-center">
            <CheckCircle2 className="mx-auto mb-3 size-10 text-emerald-500" />
            <p className="text-[14px] font-medium text-foreground">Thank you for your report</p>
            <p className="mt-1 text-[13px] text-muted-foreground">Our team will review it shortly.</p>
            <button onClick={onClose} className="mt-5 rounded-lg border border-border px-4 py-2 text-[13.5px] font-medium hover:bg-muted">Close</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-[12.5px] font-medium text-foreground">Reason</label>
              <select
                value={reason}
                onChange={e => setReason(e.target.value)}
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-primary"
              >
                {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12.5px] font-medium text-foreground">Details <span className="font-normal text-muted-foreground">(optional)</span></label>
              <textarea
                value={details}
                onChange={e => setDetails(e.target.value)}
                rows={3}
                maxLength={5000}
                placeholder="Add any context that will help us review this report…"
                className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-[12.5px] font-medium text-foreground">Your email <span className="font-normal text-muted-foreground">(optional)</span></label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13.5px] outline-none focus:border-primary"
              />
            </div>

            {error && <p className="text-[13px] text-destructive">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-[13.5px] font-medium hover:bg-muted">Cancel</button>
              <button
                onClick={submit}
                disabled={busy || !reason}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {busy && <Loader2 className="size-4 animate-spin" />} Submit report
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
