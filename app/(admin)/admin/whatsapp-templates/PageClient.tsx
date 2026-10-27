'use client'

// RD-WA-TEMPLATES-01 · Super Admin WhatsApp template review.
//
// Every read and write goes through /api/admin/whatsapp-templates (requireSuperAdmin). A decision is
// made on ONE exact version: the page sends that version's contentHash and the server refuses it if
// the stored content differs. Approving re-validates on the server and submits to Meta; Meta's own
// approval is still required before any broadcast can use the template — in both review modes.
// Internal notes stay here: they are never part of an organizer response or notification.

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Loader2, X, ShieldCheck, RefreshCw, Send, StickyNote, MessageSquareText } from 'lucide-react'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { AdminToolbar, FilterTabs, StatusPill, ErrorBanner, TableFrame, THead, Th, TBody, Tr, Td, type PillTone } from '@/components/admin'
import { Findings, Preview } from '@/components/communications/whatsappTemplates/TemplateLibrary'
import {
  INTERNAL_STATUS_LABEL, META_STATUS_LABEL, CATEGORY_LABEL, SUBMITTABLE_META_STATUSES, catalogVariable,
  type TemplateSummary, type TemplateDetail, type InternalStatus, type MetaStatus, type ReviewMode, type VersionView,
} from '@/lib/whatsappTemplates/types'
import { exampleFor, usedVariables } from '@/lib/whatsappTemplates/validate'
import { rejectionGuidance } from '@/lib/whatsappTemplates/guidance'

type Filter = 'pending_review' | 'at_meta' | 'meta_rejected' | 'approved' | 'all'
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'pending_review', label: 'Pending review' }, { value: 'at_meta', label: 'At Meta' },
  { value: 'meta_rejected', label: 'Rejected / failed' }, { value: 'approved', label: 'Approved' }, { value: 'all', label: 'All' },
]
const INTERNAL_TONE: Record<InternalStatus, PillTone> = { draft: 'neutral', pending_review: 'info', changes_requested: 'warning', approved_for_submission: 'success', rejected: 'danger' }
const META_TONE: Record<MetaStatus, PillTone> = {
  not_submitted: 'neutral', submitting: 'info', submission_failed: 'danger', submission_unknown: 'warning', pending: 'info', approved: 'success',
  flagged: 'warning', rejected: 'danger', paused: 'warning', disabled: 'danger', in_appeal: 'accent', locked: 'warning', limit_exceeded: 'danger',
  archived: 'neutral', deleted: 'neutral', unknown: 'neutral',
}
interface Detail extends TemplateDetail {
  notes: { id: string; text: string; version: number | null; authorUid: string; createdAt: string | null }[]
  organizer: { uid: string; name: string | null; email: string | null }
}
interface Governance { mode: ReviewMode; unavailable: boolean; metaConfigured?: boolean }

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')

async function api(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  const res = await fetch(path, { ...init, cache: 'no-store', headers: { ...(init?.headers ?? {}), authorization: `Bearer ${await u.getIdToken()}`, 'content-type': 'application/json' } })
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

export default function WhatsAppTemplatesAdminPage() {
  const params = useSearchParams()
  const [filter, setFilter] = useState<Filter>('pending_review')
  const [rows, setRows] = useState<TemplateSummary[] | null>(null)
  const [gov, setGov] = useState<Governance | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(params.get('template'))
  const { prompt } = useConfirm()

  const load = useCallback(async () => {
    setRows(null)
    try {
      const [list, g] = await Promise.all([api(`/api/admin/whatsapp-templates?status=${filter}`), api('/api/admin/whatsapp-templates/governance')])
      if (!list.ok) throw new Error(list.status === 403 ? 'WhatsApp template review is available to Super Admins only.' : String(list.body.error ?? 'Failed to load'))
      setRows((list.body.templates as TemplateSummary[]) ?? []); setGov(g.ok ? g.body as unknown as Governance : null); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load'); setRows([]) }
  }, [filter])

  useEffect(() => {
    const unsub = auth.onAuthStateChanged(u => { if (u) void load() })
    return unsub
  }, [load])

  const changeMode = async (next: ReviewMode) => {
    const reason = await prompt({
      title: next === 'automatic' ? 'Switch to automatic submission?' : 'Switch to manual review?',
      message: next === 'automatic'
        ? 'Templates that pass validation will be submitted to Meta without a Super Admin review. Meta must still approve each one before it can be broadcast. Give a reason for the audit log.'
        : 'Every new template version will wait for a Super Admin to approve it before it is submitted to Meta. Give a reason for the audit log.',
      confirmLabel: 'Change review mode', required: true, multiline: true, placeholder: 'Reason (5–500 characters)',
    })
    if (!reason) return
    const r = await api('/api/admin/whatsapp-templates/governance', { method: 'PUT', body: JSON.stringify({ mode: next, reason }) }).catch(() => null)
    if (!r?.ok) { setError(String(r?.body.error ?? 'Could not change the review mode.')); return }
    await load()
  }

  return (
    <div className="space-y-5 p-5 sm:p-6">
      <AdminToolbar icon={MessageSquareText} title="WhatsApp Templates" description="Organizer message templates: review them, follow Meta’s decision, and choose how templates reach Meta." />
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {gov && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[13.5px] font-semibold text-foreground"><ShieldCheck className="size-4 text-primary" aria-hidden />Review mode: {gov.mode === 'manual' ? 'Manual Super Admin approval' : 'Automatic submission'}</p>
            <p className="mt-0.5 max-w-[80ch] text-[12.5px] text-muted-foreground">
              {gov.mode === 'manual' ? 'Each version waits for a Super Admin before it is submitted to Meta.' : 'Versions that pass validation are submitted to Meta straight away.'} Meta approval is always required before a template can be used in a broadcast.
              {gov.unavailable && ' The setting could not be read, so manual review is being applied.'}
              {gov.metaConfigured === false && ' Meta WhatsApp is not configured on this deployment, so nothing can be submitted.'}
            </p>
          </div>
          <button type="button" onClick={() => changeMode(gov.mode === 'manual' ? 'automatic' : 'manual')} className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-semibold text-foreground hover:bg-muted">
            {gov.mode === 'manual' ? 'Switch to automatic…' : 'Switch to manual…'}
          </button>
        </section>
      )}

      <FilterTabs options={FILTERS} value={filter} onChange={setFilter} aria-label="Template status" scrollable />

      <TableFrame>
        <THead><Th>Template</Th><Th>Workspace</Th><Th>Category</Th><Th>Review</Th><Th>Meta</Th><Th>Updated</Th></THead>
        <TBody>
          {rows === null && <tr><td colSpan={6} className="px-4 py-6 text-center text-[13px] text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" aria-hidden />Loading…</td></tr>}
          {rows?.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-[13px] text-muted-foreground">No templates here.</td></tr>}
          {rows?.map(r => (
            <Tr key={r.id} onClick={() => setOpenId(r.id)} className="cursor-pointer">
              <Td><span className="font-mono text-[12.5px] text-foreground">{r.name}</span><span className="block text-[11.5px] text-muted-foreground">v{r.latestVersion} · {r.language}</span></Td>
              <Td><span className="font-mono text-[11.5px] text-muted-foreground">{r.organizerUid?.slice(0, 10)}…</span></Td>
              <Td>{CATEGORY_LABEL[r.category]}</Td>
              <Td><StatusPill tone={INTERNAL_TONE[r.internalStatus]}>{INTERNAL_STATUS_LABEL[r.internalStatus]}</StatusPill></Td>
              <Td><StatusPill tone={META_TONE[r.metaStatus]}>{META_STATUS_LABEL[r.metaStatus]}</StatusPill></Td>
              <Td className="whitespace-nowrap text-[12px] text-muted-foreground">{fmt(r.updatedAt)}</Td>
            </Tr>
          ))}
        </TBody>
      </TableFrame>

      {openId && <DetailPanel id={openId} onClose={() => { setOpenId(null); void load() }} />}
    </div>
  )
}

function DetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [t, setT] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const { prompt, confirm } = useConfirm()

  const apply = useCallback((r: Awaited<ReturnType<typeof api>> | null) => {
    if (!r?.ok) { setError(String(r?.body.error ?? 'Could not load the template.')); return }
    setT(r.body.template as Detail); setError(null)
  }, [])
  const load = useCallback(() => api(`/api/admin/whatsapp-templates/${encodeURIComponent(id)}`).catch(() => null).then(apply), [id, apply])
  useEffect(() => {
    let alive = true
    api(`/api/admin/whatsapp-templates/${encodeURIComponent(id)}`).catch(() => null).then(r => { if (alive) apply(r) })
    return () => { alive = false }
  }, [id, apply])

  const v: VersionView | undefined = t ? (t.versions.find(x => x.version === selected) ?? t.versions[0]) : undefined

  const act = async (label: string, path: string, body: Record<string, unknown>) => {
    setBusy(label); setNotice(null)
    const r = await api(path, { method: 'POST', body: JSON.stringify(body) }).catch(() => null)
    setBusy(null)
    if (!r) { setNotice('Network error — please try again.'); return }
    if (!r.ok) { setNotice(String(r.body.error ?? 'The action failed.')); await load(); return }
    const meta = typeof r.body.metaStatus === 'string' ? ` Meta: ${META_STATUS_LABEL[r.body.metaStatus as MetaStatus] ?? r.body.metaStatus}.` : ''
    setNotice(`${label} — done.${meta}${r.body.metaMessage ? ` ${String(r.body.metaMessage)}` : ''}`)
    await load()
  }
  const decide = async (action: 'approve' | 'reject' | 'request_changes') => {
    if (!t || !v) return
    let reason: string | null = null
    if (action === 'approve') {
      if (!(await confirm({ title: `Approve version ${v.version}?`, message: 'It will be validated again and submitted to Meta. It can be used in broadcasts only after Meta approves it.', confirmLabel: 'Approve and submit' }))) return
    } else {
      reason = await prompt({
        title: action === 'reject' ? 'Reject this version' : 'Request changes',
        message: 'The organizer sees this explanation. Say what to change and why.', required: true, multiline: true, placeholder: 'Explanation for the organizer (5–1000 characters)',
        confirmLabel: action === 'reject' ? 'Reject' : 'Request changes', tone: action === 'reject' ? 'danger' : 'default',
      })
      if (!reason) return
    }
    await act(action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Changes requested', `/api/admin/whatsapp-templates/${encodeURIComponent(t.id)}/decision`, { version: v.version, contentHash: v.contentHash, action, reason, note: note.trim() || null })
    setNote('')
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Template review" className="h-full w-full max-w-[1040px] overflow-y-auto bg-background p-4 shadow-xl sm:p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-all font-mono text-[16px] font-semibold text-foreground">{t?.name ?? '…'}</h2>
            {t && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t.organizer.name ?? 'Organizer'}{t.organizer.email ? ` · ${t.organizer.email}` : ''} · {CATEGORY_LABEL[t.category]} · {t.language}{t.eventSlug ? ` · event ${t.eventSlug}` : ''}{t.activeVersion ? ` · v${t.activeVersion} in use` : ''}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><X className="size-4" aria-hidden /></button>
        </div>
        {error && <div className="mt-3"><ErrorBanner>{error}</ErrorBanner></div>}
        {!t && !error && <p className="mt-6 text-[13px] text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" aria-hidden />Loading…</p>}
        {t && v && (
          <>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {t.versions.map(x => (
                <button key={x.version} type="button" onClick={() => setSelected(x.version)} className={cn('rounded-full border px-2.5 py-1 text-[12px] font-medium', x.version === v.version ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground')}>
                  v{x.version} · {x.meta.status !== 'not_submitted' ? META_STATUS_LABEL[x.meta.status] : INTERNAL_STATUS_LABEL[x.internal.status]}
                </button>
              ))}
            </div>
            {notice && <p role="status" className="mt-3 rounded-lg bg-muted px-3 py-2 text-[13px] text-foreground">{notice}</p>}
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="space-y-4">
                <section className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={INTERNAL_TONE[v.internal.status]}>{INTERNAL_STATUS_LABEL[v.internal.status]}{v.internal.decidedBySystem ? ' (automatic)' : ''}</StatusPill>
                    <StatusPill tone={META_TONE[v.meta.status]}>{META_STATUS_LABEL[v.meta.status]}</StatusPill>
                    {v.parentVersion && <span className="text-[12px] text-muted-foreground">revised from v{v.parentVersion}</span>}
                  </div>
                  <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-[12.5px] sm:grid-cols-2">
                    <dt className="text-muted-foreground">Meta name</dt><dd className="break-all font-mono">{v.metaName}</dd>
                    <dt className="text-muted-foreground">Meta template id</dt><dd className="font-mono">{v.meta.templateId ?? '—'}</dd>
                    <dt className="text-muted-foreground">Submission attempts</dt><dd>{v.meta.attempts}</dd>
                    <dt className="text-muted-foreground">Submitted</dt><dd>{fmt(v.meta.submittedAt)}</dd>
                    <dt className="text-muted-foreground">Last Meta event</dt><dd>{fmt(v.meta.statusAt)}</dd>
                    <dt className="text-muted-foreground">Last checked</dt><dd>{fmt(v.meta.syncedAt)}</dd>
                    <dt className="text-muted-foreground">Meta category</dt><dd>{v.meta.category ?? '—'}{v.meta.categoryChanged ? ' (changed by Meta)' : ''}</dd>
                    <dt className="text-muted-foreground">Content hash</dt><dd className="font-mono">{v.contentHash.slice(0, 12)}</dd>
                  </dl>
                  {v.internal.decisionReason && <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-[12.5px]"><span className="font-semibold">Decision message: </span>{v.internal.decisionReason}</p>}
                  {v.meta.lastError && <p className="mt-3 text-[12.5px] text-amber-700 dark:text-amber-300">{v.meta.lastError}</p>}
                  {v.meta.status === 'rejected' && (() => { const g = rejectionGuidance(v.meta); return (
                    <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50/60 px-3 py-2 text-[12.5px] dark:border-rose-900 dark:bg-rose-950/30">
                      <p><span className="font-semibold">Meta reason: </span>{g.metaReason ?? 'not provided'}</p>
                      {g.metaDetail?.reason && <p className="mt-1">Meta: {g.metaDetail.reason}</p>}
                      {g.metaDetail?.recommendation && <p className="mt-1">Recommendation: {g.metaDetail.recommendation}</p>}
                    </div>) })()}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {v.internal.status === 'pending_review' && <>
                      <button type="button" disabled={!!busy} onClick={() => decide('approve')} className="rounded-lg bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-60">{busy === 'Approved' ? 'Approving…' : 'Approve for submission'}</button>
                      <button type="button" disabled={!!busy} onClick={() => decide('request_changes')} className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-semibold disabled:opacity-60">Request changes</button>
                      <button type="button" disabled={!!busy} onClick={() => decide('reject')} className="rounded-lg border border-rose-300 px-3 py-1.5 text-[12.5px] font-semibold text-rose-700 disabled:opacity-60 dark:text-rose-300">Reject</button>
                    </>}
                    {v.internal.status === 'approved_for_submission' && SUBMITTABLE_META_STATUSES.has(v.meta.status) && (
                      <button type="button" disabled={!!busy} onClick={() => act('Submission retried', `/api/admin/whatsapp-templates/${encodeURIComponent(t.id)}/submit`, { version: v.version })} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-semibold disabled:opacity-60"><Send className="size-3.5" aria-hidden />{v.meta.status === 'not_submitted' ? 'Submit to Meta' : 'Retry submission'}</button>
                    )}
                    {(v.meta.templateId || v.meta.status === 'submission_unknown') && (
                      <button type="button" disabled={!!busy} onClick={() => act('Synced with Meta', `/api/admin/whatsapp-templates/${encodeURIComponent(t.id)}/sync`, { version: v.version })} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-semibold disabled:opacity-60"><RefreshCw className="size-3.5" aria-hidden />Sync with Meta</button>
                    )}
                  </div>
                  {v.internal.status === 'pending_review' && (
                    <label className="mt-3 block text-[12px] text-muted-foreground">Internal note with the decision (optional, never shown to the organizer)
                      <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground" />
                    </label>
                  )}
                </section>

                <section className="rounded-xl border border-border bg-card p-4">
                  <h3 className="text-[13px] font-semibold">Variables and examples</h3>
                  <table className="mt-2 w-full text-[12.5px]"><tbody className="divide-y divide-border">
                    {usedVariables(v.content).map(k => {
                      const cat = catalogVariable(k), custom = v.customVariables.find(c => c.key === k)
                      return <tr key={k}><td className="py-1.5 pr-3 font-mono">{`{{${k}}}`}</td><td className="py-1.5 pr-3 text-muted-foreground">{cat ? `automatic · ${cat.source}` : custom ? `typed at send · ${custom.label}` : 'unknown'}</td><td className="py-1.5">{exampleFor(k, v)}</td></tr>
                    })}
                  </tbody></table>
                </section>

                <section className="rounded-xl border border-border bg-card p-4">
                  <h3 className="text-[13px] font-semibold">Validation (server, at save/submit)</h3>
                  <div className="mt-2">{v.validation.length ? <Findings findings={v.validation} /> : <p className="text-[12.5px] text-muted-foreground">No findings.</p>}</div>
                </section>

                <section className="rounded-xl border border-border bg-card p-4">
                  <h3 className="flex items-center gap-1.5 text-[13px] font-semibold"><StickyNote className="size-3.5" aria-hidden />Internal notes</h3>
                  <ul className="mt-2 space-y-2">{t.notes.map(n => <li key={n.id} className="text-[12.5px]"><p className="whitespace-pre-wrap">{n.text}</p><p className="text-[11.5px] text-muted-foreground">{fmt(n.createdAt)}{n.version ? ` · v${n.version}` : ''}</p></li>)}</ul>
                  {v.internal.status !== 'pending_review' && (
                    <form className="mt-2 flex gap-2" onSubmit={async e => { e.preventDefault(); if (!note.trim()) return; await act('Note added', `/api/admin/whatsapp-templates/${encodeURIComponent(t.id)}/notes`, { text: note, version: v.version }); setNote('') }}>
                      <input value={note} onChange={e => setNote(e.target.value)} placeholder="Add an internal note" className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-[13px]" />
                      <button type="submit" className="rounded-lg border border-border px-3 text-[12.5px] font-semibold">Add</button>
                    </form>
                  )}
                </section>

                <section className="rounded-xl border border-border bg-card p-4">
                  <h3 className="text-[13px] font-semibold">History</h3>
                  <ol className="mt-2 space-y-2">{t.history.map(h => <li key={h.id} className="text-[12.5px]"><p>{h.summary}</p><p className="text-[11.5px] text-muted-foreground">{fmt(h.at)} · {h.actor}{h.version ? ` · v${h.version}` : ''} · {h.action}</p></li>)}</ol>
                </section>
              </div>
              <Preview input={{ content: v.content, customVariables: v.customVariables, examples: v.examples }} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
