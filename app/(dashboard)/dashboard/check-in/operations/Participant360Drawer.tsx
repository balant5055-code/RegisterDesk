'use client'

// OE-4 Sprint 2 — Participant 360 drawer. COMPOSITION ONLY. Every action reuses an
// EXISTING API; the Timeline / Certificates / Communications / Sessions / Identifier
// / CRM sections REUSE the canonical <ParticipantWorkspace360> component (no second
// participant workspace). New here = only the on-site operations panels that don't
// exist yet: Attendance+Undo, Ticket, Badge (Print Assets), Payment, Quick Actions.
//
// Reused endpoints:
//   check-in   → POST /api/checkin/scan            (source: 'operations')
//   undo       → POST /api/organizer/registrations/[id]/undo-checkin   (audited)
//   ticket     → GET  /api/tickets/[id]/pdf         (bearer)
//   resend     → POST /api/organizer/registrations/[id]/resend-email
//   badge      → GET  /api/organizer/print-templates → POST /api/organizer/print-jobs
//                 → GET .../items → .../items/[id]/download   (PA-4, unchanged)
//   certificate→ GET  /api/certificates/download/[id]   (find-or-create, unchanged)

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { buttonVariants, EmptyState } from '@/components/ui'
import {
  X, UserCheck, Undo2, TicketCheck, IdCard, Award, Send, ExternalLink, Loader2,
  Download, Printer, ScanLine, Clock, CreditCard,
} from 'lucide-react'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import ParticipantWorkspace360 from '@/app/(dashboard)/dashboard/events/[eventId]/registrations/ParticipantWorkspace360'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'
import type { PrintTemplate } from '@/lib/printAssets/types'

const rupees = (paise?: number) => (typeof paise === 'number' ? `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : '—')
const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?'
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function Participant360Drawer({ reg, eventId, token, onClose, onChanged }: {
  reg: SerializedRegistration
  eventId: string
  token: string
  onClose: () => void
  onChanged: () => void
}) {
  const { showToast } = useToast()
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])
  const jsonHeaders = useMemo(() => ({ ...headers, 'Content-Type': 'application/json' }), [headers])
  const [busy, setBusy] = useState('')

  // GA-7D S1: this slide-over had no dialog semantics. Reuse the shared focus trap
  // (trap + restore + initial focus) and add Escape-to-close + role/aria-modal below.
  const trapRef = useFocusTrap<HTMLDivElement>(true)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // ── Badge (Print Assets) ────────────────────────────────────────────────────
  const [templates, setTemplates] = useState<PrintTemplate[] | null>(null)
  const [templateId, setTemplateId] = useState('')
  const [badgeUrl, setBadgeUrl] = useState('')

  const loadTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/organizer/print-templates', { headers, cache: 'no-store' })
      const data = await res.json().catch(() => ({})) as { success?: boolean; templates?: PrintTemplate[] }
      const forEvent = (data.templates ?? []).filter(t => t.eventId === eventId)
      setTemplates(forEvent)
      if (forEvent[0]) setTemplateId(forEvent[0].id)
    } catch { setTemplates([]) }
  }, [headers, eventId])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadTemplates() }, [loadTemplates])

  // ── Actions (all reuse existing endpoints) ──────────────────────────────────
  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try { await fn() } catch (e) { showToast(e instanceof Error ? e.message : 'Action failed', 'error') } finally { setBusy('') }
  }, [showToast])

  const checkIn = () => run('checkin', async () => {
    const res = await fetch('/api/checkin/scan', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ticketCode: reg.ticketCode, source: 'operations' }) })
    const data = await res.json().catch(() => ({})) as { success?: boolean; alreadyCheckedIn?: boolean; error?: string }
    if (!res.ok || !data.success) { showToast(data.error ?? 'Check-in failed', 'error'); return }
    showToast(data.alreadyCheckedIn ? 'Already checked in' : 'Checked in', 'success'); onChanged()
  })
  const undo = () => run('undo', async () => {
    const res = await fetch(`/api/organizer/registrations/${reg.id}/undo-checkin`, { method: 'POST', headers })
    const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string }
    if (!res.ok || !data.success) { showToast(data.error ?? 'Undo failed', 'error'); return }
    showToast('Check-in undone', 'success'); onChanged()
  })
  const resendTicket = () => run('resend', async () => {
    const res = await fetch(`/api/organizer/registrations/${reg.id}/resend-email`, { method: 'POST', headers })
    if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; showToast(d.error ?? 'Resend failed', 'error'); return }
    showToast('Ticket email resent', 'success')
  })

  async function blobDownload(url: string, filename: string, hdrs?: Record<string, string>) {
    const res = await fetch(url, { headers: hdrs ?? headers })
    const ct = res.headers.get('content-type') ?? ''
    if (!res.ok || !ct.includes('pdf')) {
      const d = await res.json().catch(() => ({})) as { reason?: string; error?: string }
      throw new Error(d.reason ?? d.error ?? 'Not available')
    }
    const blob = await res.blob()
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click()
    URL.revokeObjectURL(a.href)
  }
  const downloadTicket = () => run('ticket', () => blobDownload(`/api/tickets/${reg.id}/pdf`, `ticket-${reg.ticketCode || reg.id}.pdf`))
  const downloadCert   = () => run('cert', () => blobDownload(`/api/certificates/download/${reg.id}`, `certificate-${reg.ticketCode || reg.id}.pdf`))

  // Badge: reuse PA-4 generation (create job → item ready → download token URL).
  const generateBadge = () => run('badge', async () => {
    if (!templateId) { showToast('Select a badge template', 'error'); return }
    setBadgeUrl('')
    const create = await fetch('/api/organizer/print-jobs', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ templateId, filters: { registrationIds: [reg.id] } }) })
    const cj = await create.json().catch(() => ({})) as { success?: boolean; jobId?: string; error?: string }
    if (!create.ok || !cj.success || !cj.jobId) { showToast(cj.error ?? 'Badge generation failed', 'error'); return }
    // The create call drives the first chunk inline, so the single item is usually
    // ready immediately; re-check a few times without a long poll.
    for (let i = 0; i < 4; i++) {
      const items = await fetch(`/api/organizer/print-jobs/${cj.jobId}/items`, { headers, cache: 'no-store' })
      const data = await items.json().catch(() => ({})) as { success?: boolean; items?: { registrationId: string; ready: boolean }[] }
      const it = data.items?.find(x => x.registrationId === reg.id)
      if (it?.ready) { setBadgeUrl(`/api/organizer/print-jobs/${cj.jobId}/items/${reg.id}/download?token=${encodeURIComponent(await auth.currentUser?.getIdToken() ?? token)}`); showToast('Badge ready', 'success'); return }
      await sleep(1200)
    }
    showToast('Badge is generating — check the Print Operations Center shortly', 'success')
  })

  const category = reg.bibCategory || reg.passType || '—'
  const responses = Object.entries(reg.attendee.formResponses ?? {}).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="p360-title"
        className="flex h-full w-full max-w-[460px] flex-col overflow-y-auto bg-card shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-border bg-card p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[15px] font-bold text-primary">{initials(reg.attendee.name)}</div>
          <div className="min-w-0 flex-1">
            <p id="p360-title" className="truncate text-[16px] font-bold text-foreground">{reg.attendee.name || '—'}</p>
            <p className="truncate text-[12px] text-muted-foreground">{reg.ticketCode || reg.id} · {reg.passName}{category !== '—' ? ` · ${category}` : ''}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              <Pill tone={reg.checkedIn ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'}>{reg.checkedIn ? 'Checked in' : 'Not checked in'}</Pill>
              <Pill tone="bg-muted text-muted-foreground">{reg.status}</Pill>
              <Pill tone="bg-muted text-muted-foreground">{reg.paymentStatus}</Pill>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button>
        </div>

        {/* ── Quick Actions ── */}
        <div className="grid grid-cols-4 gap-1.5 border-b border-border p-3">
          <QA icon={UserCheck} label="Check In" busy={busy === 'checkin'} disabled={reg.checkedIn} onClick={checkIn} />
          <QA icon={Undo2} label="Undo" busy={busy === 'undo'} disabled={!reg.checkedIn} onClick={undo} />
          <QA icon={TicketCheck} label="Ticket" busy={busy === 'ticket'} onClick={downloadTicket} />
          <QA icon={Send} label="Resend" busy={busy === 'resend'} onClick={resendTicket} />
          <QA icon={IdCard} label="Badge" busy={busy === 'badge'} onClick={generateBadge} />
          <QA icon={Award} label="Cert" busy={busy === 'cert'} onClick={downloadCert} />
          <Link href={`/dashboard/events/${eventId}?tab=registrations`} className="flex flex-col items-center gap-1 rounded-lg border border-border py-2 text-[10.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
            <ExternalLink className="size-4" /> Open
          </Link>
        </div>

        <div className="space-y-3 p-4">
          {/* Attendance */}
          <Section title="Attendance" icon={ScanLine}>
            <Row label="Checked in" value={reg.checkedIn ? 'Yes' : 'No'} />
            {reg.checkedIn && <>
              <Row label="Time" value={fmt(reg.checkedInAt)} />
              <Row label="Operator" value={reg.checkedInBy ?? '—'} />
              <Row label="Source" value={reg.checkedInSource ?? '—'} />
              <button onClick={undo} disabled={busy === 'undo'} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-2 w-full')}>
                {busy === 'undo' ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />} Undo check-in
              </button>
            </>}
            {!reg.checkedIn && <button onClick={checkIn} disabled={busy === 'checkin'} className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'mt-2 w-full')}>
              {busy === 'checkin' ? <Loader2 className="size-4 animate-spin" /> : <UserCheck className="size-4" />} Check in
            </button>}
          </Section>

          {/* Registration & Payment */}
          <Section title="Registration & Payment" icon={CreditCard}>
            <Row label="Registered" value={fmt(reg.registeredAt as string | null)} />
            <Row label="Source" value={reg.registrationSource ?? 'online'} />
            <Row label="Payment" value={reg.paymentStatus + (reg.paymentMethod ? ` · ${reg.paymentMethod}` : '')} />
            <Row label="Amount" value={rupees(reg.amount)} />
            {typeof reg.originalAmount === 'number' && reg.originalAmount !== reg.amount && <Row label="Original" value={rupees(reg.originalAmount)} />}
            {reg.couponCode && <Row label="Coupon" value={`${reg.couponCode}${typeof reg.discountAmount === 'number' ? ` (−${rupees(reg.discountAmount)})` : ''}`} />}
            {reg.referenceNumber && <Row label="Reference" value={reg.referenceNumber} />}
            {responses.length > 0 && (
              <details className="mt-1"><summary className="cursor-pointer text-[12px] font-medium text-primary">Form responses ({responses.length})</summary>
                <div className="mt-1 space-y-0.5">{responses.map(([k, v]) => <Row key={k} label={k} value={String(v)} />)}</div>
              </details>
            )}
          </Section>

          {/* Ticket */}
          <Section title="Ticket" icon={TicketCheck}>
            <div className="flex gap-2">
              <button onClick={downloadTicket} disabled={busy === 'ticket'} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'flex-1')}>{busy === 'ticket' ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Download</button>
              <button onClick={resendTicket} disabled={busy === 'resend'} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'flex-1')}>{busy === 'resend' ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send again</button>
            </div>
          </Section>

          {/* Badge (Print Assets) */}
          <Section title="Badge" icon={IdCard}>
            {templates === null ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
              : templates.length === 0 ? (
                <EmptyState icon={Printer} title="No badge template" description="Create a print template for this event to generate badges." />
              ) : (
                <div className="space-y-2">
                  <select value={templateId} onChange={e => { setTemplateId(e.target.value); setBadgeUrl('') }} className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-[13px]">
                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <div className="flex gap-2">
                    <button onClick={generateBadge} disabled={busy === 'badge' || !templateId} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'flex-1')}>{busy === 'badge' ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />} {badgeUrl ? 'Reprint' : 'Generate'}</button>
                    {badgeUrl && <a href={badgeUrl} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'flex-1')}><Download className="size-4" /> Download</a>}
                  </div>
                  {!templates.length && <p className="text-[11px] text-muted-foreground">Manage templates in Print Assets.</p>}
                </div>
              )}
          </Section>

          {/* Certificate quick download (list + generate live in the workspace below) */}
          <Section title="Certificate" icon={Award}>
            <button onClick={downloadCert} disabled={busy === 'cert'} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full')}>{busy === 'cert' ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Download / generate</button>
            <p className="mt-1 text-[11px] text-muted-foreground">Issued certificates are listed below. Certificates require check-in to be enabled.</p>
          </Section>

          {/* Reused canonical workspace: Timeline / Certificates / Communications / Sessions / Identifier / CRM */}
          <div className="border-t border-border pt-3">
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><Clock className="size-3" /> Full participant history</p>
            <ParticipantWorkspace360 reg={reg} eventId={eventId} token={token} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Local helpers ──────────────────────────────────────────────────────────────
function QA({ icon: Icon, label, onClick, busy, disabled }: { icon: React.ElementType; label: string; onClick: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={busy || disabled}
      className="flex flex-col items-center gap-1 rounded-lg border border-border py-2 text-[10.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40">
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4 text-muted-foreground" />} {label}
    </button>
  )
}
function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[12px] font-bold text-foreground"><Icon className="size-3.5 text-muted-foreground" /> {title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  )
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-3 text-[12.5px]"><span className="shrink-0 text-muted-foreground">{label}</span><span className="min-w-0 break-words text-right text-foreground">{value}</span></div>
}
function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize', tone)}>{children}</span>
}
