'use client'

// OE-4 Sprint 4 — Bulk action bar. ORCHESTRATION only. Every action calls an
// EXISTING endpoint; nothing new is built:
//   check-in    → POST /events/[id]/registrations/bulk-jobs {kind:'check_in'}   (job runner, ≤20k)
//   badges      → POST /api/organizer/print-jobs {templateId, filters:{registrationIds}}  (job)
//   certificates→ POST /events/[id]/certificates/generate   (event-wide, existing)
//   ticket email→ POST /events/[id]/registrations/bulk {action:'resend_email'}   (≤200 sync)
//   undo        → POST /organizer/registrations/[id]/undo-checkin   (no bulk engine exists →
//                 sequential over the single audited endpoint, with progress)
//   whatsapp    → deep-link to the existing Broadcast composer (broadcast engine)
//   export      → client-side CSV of the already-loaded selection (no engine, no dup)
//
// Selection is IDs only (owned by the parent). Large work runs as background jobs;
// progress lives in the existing surfaces (Print Operations Center / Activity feed).

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { useToast } from '@/components/ui/Toast'
import { buttonVariants } from '@/components/ui'
import {
  UserCheck, Undo2, IdCard, Award, Send, MessageSquare, Download, X, Loader2, ExternalLink, Printer,
} from 'lucide-react'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'
import type { PrintTemplate } from '@/lib/printAssets/types'
import { csvCell } from '@/lib/utils/csv'

interface ConfirmState { title: string; body: React.ReactNode; confirmLabel: string; onConfirm: () => void }

const estimate = (n: number) => (n < 50 ? 'a few seconds' : n < 500 ? '1–2 minutes' : 'several minutes')

export function BulkActionBar({ eventId, selectedIds, regs, onClear, onRefresh }: {
  eventId: string
  selectedIds: string[]
  regs: SerializedRegistration[]
  onClear: () => void
  onRefresh: () => void
}) {
  const { showToast } = useToast()
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState('')
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [templates, setTemplates] = useState<PrintTemplate[] | null>(null)
  const [badgeTpl, setBadgeTpl] = useState('')
  const [jobLink, setJobLink] = useState<{ href: string; label: string } | null>(null)

  const idSet = new Set(selectedIds)
  const selected = regs.filter(r => idSet.has(r.id))
  const n = selected.length

  const headers = useCallback(async () => ({ Authorization: `Bearer ${await auth.currentUser?.getIdToken() ?? ''}`, 'Content-Type': 'application/json' }), [])
  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setJobLink(null)
    try { await fn() } catch (e) { showToast(e instanceof Error ? e.message : 'Action failed', 'error') } finally { setBusy(''); setProgress('') }
  }, [showToast])

  // ── Check In (background job) ────────────────────────────────────────────────
  const checkIn = () => setConfirm({
    title: 'Check in participants', confirmLabel: `Check in ${n}`,
    body: <>Check in <b>{n}</b> selected participant{n === 1 ? '' : 's'}? This runs as a background job (already checked-in and ineligible ones are skipped).</>,
    onConfirm: () => { setConfirm(null); void run('checkin', async () => {
      const res = await fetch(`/api/organizer/events/${eventId}/registrations/bulk-jobs`, { method: 'POST', headers: await headers(), body: JSON.stringify({ kind: 'check_in', registrationIds: selectedIds }) })
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string }
      if (!res.ok || !data.success) { showToast(data.error ?? 'Check-in job failed', 'error'); return }
      showToast(`Checking in ${n} in the background`, 'success'); onRefresh(); onClear()
    }) },
  })

  // ── Undo (no bulk engine — sequential over the existing audited endpoint) ─────
  const undo = () => {
    const toUndo = selected.filter(r => r.checkedIn)
    if (toUndo.length === 0) { showToast('None of the selected are checked in', 'error'); return }
    setConfirm({
      title: 'Undo check-in', confirmLabel: `Undo ${toUndo.length}`,
      body: <>Undo check-in for <b>{toUndo.length}</b> participant{toUndo.length === 1 ? '' : 's'}? Applied one-by-one via the audited undo endpoint.</>,
      onConfirm: () => { setConfirm(null); void run('undo', async () => {
        let ok = 0
        for (let i = 0; i < toUndo.length; i++) {
          setProgress(`${i + 1}/${toUndo.length}`)
          const res = await fetch(`/api/organizer/registrations/${toUndo[i].id}/undo-checkin`, { method: 'POST', headers: await headers() })
          if (res.ok) ok++
        }
        showToast(`Undid ${ok} of ${toUndo.length}`, ok === toUndo.length ? 'success' : 'error'); onRefresh(); onClear()
      }) },
    })
  }

  // ── Generate Badges (Print Assets job) ────────────────────────────────────────
  const badges = () => void run('badges-load', async () => {
    let tpls = templates
    if (!tpls) {
      const res = await fetch('/api/organizer/print-templates', { headers: { Authorization: (await headers()).Authorization } })
      const data = await res.json().catch(() => ({})) as { templates?: PrintTemplate[] }
      tpls = (data.templates ?? []).filter(t => t.eventId === eventId)
      setTemplates(tpls); if (tpls[0]) setBadgeTpl(tpls[0].id)
    }
    if (!tpls.length) { showToast('No badge template for this event — create one in Print Assets', 'error'); return }
    const first = tpls[0].id
    setConfirm({
      title: 'Generate badges', confirmLabel: `Generate ${n}`,
      body: <div className="space-y-2"><p>Generate badges for <b>{n}</b> participant{n === 1 ? '' : 's'}? Runs as a background print job (~{estimate(n)}).</p>
        <select defaultValue={badgeTpl || first} onChange={e => setBadgeTpl(e.target.value)} className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-[13px]">
          {tpls.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select></div>,
      onConfirm: () => { setConfirm(null); void run('badges', async () => {
        const templateId = badgeTpl || first
        const res = await fetch('/api/organizer/print-jobs', { method: 'POST', headers: await headers(), body: JSON.stringify({ templateId, filters: { registrationIds: selectedIds } }) })
        const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string }
        if (!res.ok || !data.success) { showToast(data.error ?? 'Badge job failed', 'error'); return }
        showToast(`Generating ${n} badges in the background`, 'success')
        setJobLink({ href: '/dashboard/print-assets/operations', label: 'Track in Print Operations Center' }); onClear()
      }) },
    })
  })

  // ── Generate Certificates (existing event-wide endpoint) ─────────────────────
  const certificates = () => setConfirm({
    title: 'Generate certificates', confirmLabel: 'Generate',
    body: <>Generate certificates for <b>all eligible</b> registrations in this event that don’t have one yet? (The certificate engine is event-wide; the current selection is not used.)</>,
    onConfirm: () => { setConfirm(null); void run('certs', async () => {
      const res = await fetch(`/api/organizer/events/${eventId}/certificates/generate`, { method: 'POST', headers: await headers() })
      const data = await res.json().catch(() => ({})) as { generated?: number; skipped?: number; ineligible?: number; error?: string }
      if (!res.ok) { showToast(data.error ?? 'Certificate generation failed', 'error'); return }
      showToast(`Certificates: ${data.generated ?? 0} generated · ${data.skipped ?? 0} existing · ${data.ineligible ?? 0} ineligible`, 'success'); onRefresh()
    }) },
  })

  // ── Send Ticket Email (legacy bulk, ≤200 sync) ───────────────────────────────
  const sendEmail = () => setConfirm({
    title: 'Resend ticket email', confirmLabel: `Send ${Math.min(n, 200)}`,
    body: <>Resend the ticket email to <b>{Math.min(n, 200)}</b> participant{n === 1 ? '' : 's'}?{n > 200 ? ' (capped at 200 per batch)' : ''}</>,
    onConfirm: () => { setConfirm(null); void run('email', async () => {
      const res = await fetch(`/api/organizer/events/${eventId}/registrations/bulk`, { method: 'POST', headers: await headers(), body: JSON.stringify({ action: 'resend_email', registrationIds: selectedIds.slice(0, 200) }) })
      const data = await res.json().catch(() => ({})) as { success?: boolean; succeeded?: number; failed?: number; error?: string }
      if (!res.ok || !data.success) { showToast(data.error ?? 'Resend failed', 'error'); return }
      showToast(`Ticket email: ${data.succeeded ?? 0} sent${data.failed ? ` · ${data.failed} failed` : ''}`, 'success'); onRefresh()
    }) },
  })

  // ── Export Selected (client-side CSV of already-loaded rows) ─────────────────
  const exportCsv = () => {
    const cols = ['Name', 'Email', 'Phone', 'Ticket', 'Pass', 'Status', 'Payment', 'Checked in', 'Checked in at', 'Source']
    const rows = selected.map(r => [r.attendee.name, r.attendee.email, r.attendee.phone ?? '', r.ticketCode, r.passName, r.status, r.paymentStatus, r.checkedIn ? 'Yes' : 'No', typeof r.checkedInAt === 'string' ? r.checkedInAt : '', r.registrationSource ?? 'online'])
    const csv = [cols, ...rows].map(row => row.map(csvCell).join(',')).join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `participants-${eventId}-${n}.csv`; a.click(); URL.revokeObjectURL(a.href)
  }

  if (n === 0) return null

  return (
    <>
      <div className="sticky bottom-3 z-30 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-2.5 shadow-lg">
        <span className="ml-1 text-[13px] font-bold text-foreground">{n} selected</span>
        <div className="mx-1 h-5 w-px bg-border" />
        <BAB icon={UserCheck} label="Check in" busy={busy === 'checkin'} onClick={checkIn} />
        <BAB icon={Undo2} label={progress && busy === 'undo' ? `Undo ${progress}` : 'Undo'} busy={busy === 'undo'} onClick={undo} />
        <BAB icon={IdCard} label="Badges" busy={busy === 'badges' || busy === 'badges-load'} onClick={badges} />
        <BAB icon={Award} label="Certificates" busy={busy === 'certs'} onClick={certificates} />
        <BAB icon={Send} label="Ticket email" busy={busy === 'email'} onClick={sendEmail} />
        <Link href="/dashboard/communications/broadcasts" className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted"><MessageSquare className="size-3.5 text-muted-foreground" /> WhatsApp</Link>
        <BAB icon={Download} label="Export" onClick={exportCsv} />
        {jobLink && <Link href={jobLink.href} className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1.5 text-[12px] font-semibold text-primary hover:bg-primary/20"><Printer className="size-3.5" /> {jobLink.label} <ExternalLink className="size-3" /></Link>}
        <button onClick={onClear} className="ml-auto inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-3.5" /> Clear</button>
      </div>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirm(null)}>
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="mb-2 text-[16px] font-bold text-foreground">{confirm.title}</h3>
            <div className="text-[13.5px] text-muted-foreground">{confirm.body}</div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Cancel</button>
              <button onClick={confirm.onConfirm} className={buttonVariants({ variant: 'primary', size: 'sm' })}>{confirm.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function BAB({ icon: Icon, label, onClick, busy }: { icon: React.ElementType; label: string; onClick: () => void; busy?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={busy}
      className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5 text-muted-foreground" />} {label}
    </button>
  )
}
