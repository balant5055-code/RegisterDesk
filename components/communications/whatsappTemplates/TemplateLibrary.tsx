'use client'

// RD-WA-TEMPLATES-01 — Communication Center › Templates › WhatsApp Template Library.
//
// The organizer builds their own WhatsApp templates, checks them against the SAME validator the
// server enforces (lib/whatsappTemplates/validate), previews them with realistic values, and submits
// them. Depending on the platform's review mode a Super Admin approves them first (manual) or they go
// straight to Meta (automatic); Meta must approve every template before a broadcast can use it.
// Rejections show Meta's own reason verbatim, plain-language guidance, and a suggested revision.
// Workspace-scoped: every call goes through /api/organizer/whatsapp-templates (permission: broadcasts).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { AlertTriangle, CheckCircle2, ChevronLeft, CircleAlert, Info, Lightbulb, Loader2, Plus, Trash2, MessageSquareText } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Button, StatusChip, useConfirm } from '@/components/ui'
import type { StatusTone } from '@/components/ui/StatusChip'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import {
  CATEGORY_LABEL, CATEGORY_HINT, SUPPORTED_CATEGORIES, TEMPLATE_LANGUAGES, INTERNAL_STATUS_LABEL, META_STATUS_LABEL, LIMITS,
  variablesForEventType, startersForEventType, catalogVariable,
  type TemplateDraftInput, type TemplateSummary, type TemplateDetail, type VersionView, type ValidationFinding,
  type InternalStatus, type MetaStatus, type TemplateButton, type CustomVariable,
} from '@/lib/whatsappTemplates/types'
import { validateTemplate, renderPreview, usedVariables } from '@/lib/whatsappTemplates/validate'
import { rejectionGuidance, suggestRevision } from '@/lib/whatsappTemplates/guidance'

const API = '/api/organizer/whatsapp-templates'

async function call<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string; code?: string; findings?: ValidationFinding[] } }> {
  const token = await auth.currentUser?.getIdToken()
  const res = await fetch(path, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, cache: 'no-store' })
  const body = await res.json().catch(() => ({})) as T & { error?: string; code?: string; findings?: ValidationFinding[] }
  return { ok: res.ok, status: res.status, body }
}

export const INTERNAL_TONE: Record<InternalStatus, StatusTone> = {
  draft: 'neutral', pending_review: 'info', changes_requested: 'warning', approved_for_submission: 'success', rejected: 'danger',
}
export const META_TONE: Record<MetaStatus, StatusTone> = {
  not_submitted: 'neutral', submitting: 'info', submission_failed: 'danger', submission_unknown: 'warning', pending: 'info',
  approved: 'success', flagged: 'warning', rejected: 'danger', paused: 'warning', disabled: 'danger', in_appeal: 'info',
  locked: 'warning', limit_exceeded: 'danger', archived: 'neutral', deleted: 'neutral', unknown: 'neutral',
}
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')

function blankDraft(eventSlug: string | null): TemplateDraftInput {
  return { name: '', category: 'utility', language: 'en', content: { header: null, body: '', footer: null, buttons: [] }, customVariables: [], examples: {}, eventSlug }
}
function draftFromVersion(name: string, eventSlug: string | null, v: VersionView, category: TemplateDraftInput['category'], language: string): TemplateDraftInput {
  return { name, category, language, content: v.content, customVariables: v.customVariables, examples: v.examples, eventSlug: eventSlug }
}

// ─── Library ──────────────────────────────────────────────────────────────────

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'detail'; id: string }

export function WhatsAppTemplateLibrary() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const linked = params.get('template')
  const [view, setView] = useState<View>(linked ? { kind: 'detail', id: linked } : { kind: 'list' })
  const [rows, setRows] = useState<TemplateSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fetch first, then apply in the promise callback (never a synchronous set inside the effect).
  const apply = useCallback((r: Awaited<ReturnType<typeof call<{ templates: TemplateSummary[] }>>> | null) => {
    if (!r) { setError('Network error — please try again.'); return }
    if (!r.ok) { setError(r.body.error ?? 'Could not load templates.'); return }
    setError(null); setRows(r.body.templates)
  }, [])
  const load = useCallback(() => call<{ templates: TemplateSummary[] }>(API).catch(() => null).then(apply), [apply])
  useEffect(() => {
    let alive = true
    call<{ templates: TemplateSummary[] }>(API).catch(() => null).then(r => { if (alive) apply(r) })
    return () => { alive = false }
  }, [apply])

  const go = (v: View) => {
    setView(v)
    const p = new URLSearchParams(params.toString())
    if (v.kind === 'detail') p.set('template', v.id); else p.delete('template')
    router.replace(`${pathname}?${p.toString()}`, { scroll: false })
    if (v.kind === 'list') void load()
  }

  if (view.kind === 'create') return <Builder mode="create" onCancel={() => go({ kind: 'list' })} onSaved={id => go({ kind: 'detail', id })} />
  if (view.kind === 'detail') return <TemplateView id={view.id} onBack={() => go({ kind: 'list' })} />

  return (
    <section className="rounded-2xl border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-foreground">Your WhatsApp templates</h2>
          <p className="mt-0.5 max-w-[62ch] text-[12.5px] text-muted-foreground">Create your own message templates for WhatsApp broadcasts. Every template is reviewed and must be approved by Meta before it can be sent.</p>
        </div>
        <Button size="sm" onClick={() => go({ kind: 'create' })}><Plus className="size-4" aria-hidden /> New template</Button>
      </header>
      {error && <p role="alert" className="px-5 py-3 text-[13px] text-destructive">{error}</p>}
      {!rows && !error && <div className="flex items-center gap-2 px-5 py-6 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading templates…</div>}
      {rows && rows.length === 0 && (
        <div className="px-5 py-8 text-center">
          <MessageSquareText className="mx-auto size-8 text-muted-foreground/50" aria-hidden />
          <p className="mt-2 text-[13.5px] font-medium text-foreground">No templates yet</p>
          <p className="mx-auto mt-1 max-w-[46ch] text-[12.5px] text-muted-foreground">Start from a ready-made template — confirmation, reminder, schedule change, certificate or collection details — and adapt it to your event.</p>
        </div>
      )}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-border">
          {rows.map(t => (
            <li key={t.id}>
              <button type="button" onClick={() => go({ kind: 'detail', id: t.id })} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:px-5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px] font-medium text-foreground">{t.name}</span>
                  <span className="block text-[11.5px] text-muted-foreground">{CATEGORY_LABEL[t.category]} · {t.language} · version {t.latestVersion}{t.activeVersion ? ` · v${t.activeVersion} usable in broadcasts` : ''}</span>
                </span>
                <StatusChip tone={INTERNAL_TONE[t.internalStatus]}>{INTERNAL_STATUS_LABEL[t.internalStatus]}</StatusChip>
                <StatusChip tone={META_TONE[t.metaStatus]}>{META_STATUS_LABEL[t.metaStatus]}</StatusChip>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ─── One template ─────────────────────────────────────────────────────────────

function TemplateView({ id, onBack }: { id: string; onBack: () => void }) {
  const [t, setT] = useState<TemplateDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ mode: 'edit' | 'revise'; draft: TemplateDraftInput; fromVersion: number; notes?: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string; findings?: ValidationFinding[] } | null>(null)
  const { confirm } = useConfirm()

  const apply = useCallback((r: Awaited<ReturnType<typeof call<{ template: TemplateDetail }>>> | null) => {
    if (!r) { setError('Network error — please try again.'); return null }
    if (!r.ok) { setError(r.body.error ?? 'Could not load the template.'); return null }
    setError(null); setT(r.body.template)
    return r.body.template
  }, [])
  const load = useCallback(() => call<{ template: TemplateDetail }>(`${API}/${encodeURIComponent(id)}`).catch(() => null).then(apply), [id, apply])
  useEffect(() => {
    let alive = true
    call<{ template: TemplateDetail }>(`${API}/${encodeURIComponent(id)}`).catch(() => null).then(r => { if (alive) apply(r) })
    return () => { alive = false }
  }, [id, apply])

  if (error) return <div className="space-y-3"><BackLink onBack={onBack} /><p role="alert" className="text-[13px] text-destructive">{error}</p></div>
  if (!t) return <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading…</div>

  const latest = t.versions[0]
  const v = t.versions.find(x => x.version === (selected ?? latest.version)) ?? latest

  if (editing) {
    return (
      <Builder
        mode={editing.mode} templateId={t.id} revision={t.revision} version={editing.mode === 'edit' ? latest.version : undefined}
        fromVersion={editing.fromVersion} initial={editing.draft} notes={editing.notes}
        onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); setSelected(null); await load() }}
      />
    )
  }

  const submit = async () => {
    const ok = await confirm({ title: 'Submit this template?', message: 'Once submitted, this version can no longer be edited. If it needs changes later you will create a new version.', confirmLabel: 'Submit' })
    if (!ok) return
    setBusy(true); setNotice(null)
    const r = await call<{ mode: string; internalStatus: InternalStatus; metaStatus: MetaStatus; metaMessage?: string | null }>(`${API}/${encodeURIComponent(t.id)}/submit`, { method: 'POST', body: JSON.stringify({ version: latest.version, revision: t.revision }) }).catch(() => null)
    setBusy(false)
    if (!r) { setNotice({ tone: 'error', text: 'Network error — please try again.' }); return }
    if (!r.ok) { setNotice({ tone: 'error', text: r.body.error ?? 'Could not submit.', findings: r.body.findings }); if (r.body.code === 'STALE') await load(); return }
    setNotice({ tone: 'ok', text: r.body.internalStatus === 'pending_review'
      ? 'Submitted. RegisterDesk will review it, then submit it to Meta.'
      : `Submitted to Meta — ${META_STATUS_LABEL[r.body.metaStatus].toLowerCase()}.${r.body.metaMessage ? ` ${r.body.metaMessage}` : ''}` })
    await load()
  }

  const canEdit = latest.internal.status === 'draft'
  const canRevise = !canEdit && latest.internal.status !== 'pending_review' && latest.meta.status !== 'submitting'
  const metaRejected = v.meta.status === 'rejected'

  return (
    <div className="space-y-4">
      <BackLink onBack={onBack} />
      <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-all font-mono text-[15px] font-semibold text-foreground">{t.name}</h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{CATEGORY_LABEL[t.category]} · {t.language}{t.activeVersion ? ` · version ${t.activeVersion} is usable in broadcasts` : ' · not yet usable in broadcasts'}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit && <Button size="sm" variant="outline" onClick={() => setEditing({ mode: 'edit', draft: draftFromVersion(t.name, t.eventSlug, latest, t.category, t.language), fromVersion: latest.version })}>Edit draft</Button>}
            {canEdit && <Button size="sm" isLoading={busy} onClick={submit}>Submit for approval</Button>}
            {canRevise && <Button size="sm" variant="outline" onClick={() => setEditing({ mode: 'revise', draft: draftFromVersion(t.name, t.eventSlug, latest, t.category, t.language), fromVersion: latest.version })}>Create new version</Button>}
          </div>
        </div>
        {notice && (
          <div role={notice.tone === 'error' ? 'alert' : 'status'} className={cn('mt-3 rounded-xl border px-3 py-2 text-[13px]', notice.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200' : 'border-destructive/30 bg-destructive/5 text-destructive')}>
            {notice.text}
            {notice.findings && <div className="mt-2"><Findings findings={notice.findings.filter(f => f.severity === 'error')} /></div>}
          </div>
        )}
        {t.versions.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Versions">
            {t.versions.map(x => (
              <button key={x.version} type="button" role="tab" aria-selected={x.version === v.version} onClick={() => setSelected(x.version)}
                className={cn('rounded-full border px-2.5 py-1 text-[12px] font-medium', x.version === v.version ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
                v{x.version}{x.version === t.activeVersion ? ' · in use' : ''}
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <h3 className="text-[13.5px] font-semibold text-foreground">Version {v.version} status</h3>
            <dl className="mt-3 grid gap-3 text-[13px] sm:grid-cols-2">
              <div><dt className="text-[11.5px] uppercase tracking-wide text-muted-foreground">RegisterDesk review</dt><dd className="mt-1"><StatusChip tone={INTERNAL_TONE[v.internal.status]}>{INTERNAL_STATUS_LABEL[v.internal.status]}</StatusChip>{v.internal.decidedBySystem && <span className="ml-2 text-[11.5px] text-muted-foreground">automatic</span>}</dd></div>
              <div><dt className="text-[11.5px] uppercase tracking-wide text-muted-foreground">Meta</dt><dd className="mt-1"><StatusChip tone={META_TONE[v.meta.status]}>{META_STATUS_LABEL[v.meta.status]}</StatusChip></dd></div>
            </dl>
            {v.internal.decisionReason && (
              <div className="mt-3 rounded-xl bg-muted/60 px-3 py-2 text-[13px]"><p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Message from RegisterDesk</p><p className="mt-1 whitespace-pre-wrap text-foreground">{v.internal.decisionReason}</p></div>
            )}
            {v.meta.categoryChanged && <p className="mt-3 flex gap-2 text-[12.5px] text-amber-700 dark:text-amber-300"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />Meta changed this template’s category to {v.meta.category}. Marketing messages are charged at a different Meta rate.</p>}
            {v.meta.lastError && !metaRejected && <p className="mt-3 text-[12.5px] text-muted-foreground">{v.meta.lastError}</p>}
            {v.meta.otherInfo?.description && <p className="mt-3 text-[12.5px] text-muted-foreground">Meta: {v.meta.otherInfo.description}</p>}
          </section>

          {metaRejected && <RejectionHelp v={v} category={t.category} onRevise={canRevise ? (draft, notes) => setEditing({ mode: 'revise', draft: { ...draft, name: t.name, eventSlug: t.eventSlug, language: t.language }, fromVersion: v.version, notes }) : null} />}

          <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <h3 className="text-[13.5px] font-semibold text-foreground">Checks</h3>
            {v.validation.length ? <div className="mt-2"><Findings findings={v.validation} /></div> : <p className="mt-2 flex items-center gap-2 text-[13px] text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="size-4" aria-hidden /> No problems found.</p>}
            <p className="mt-3 text-[11.5px] text-muted-foreground">Passing these checks does not guarantee Meta’s approval.</p>
          </section>

          <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <h3 className="text-[13.5px] font-semibold text-foreground">History</h3>
            <ol className="mt-3 space-y-2.5">
              {t.history.map(h => (
                <li key={h.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-[12.5px]">
                  <span className="mt-1.5 size-2 rounded-full bg-border" aria-hidden />
                  <div><p className="text-foreground">{h.summary}</p><p className="text-[11.5px] text-muted-foreground">{fmt(h.at)} · {h.actor === 'super_admin' ? 'RegisterDesk' : h.actor === 'meta' ? 'Meta' : h.actor === 'system' ? 'Automatic' : 'Your team'}{h.version ? ` · v${h.version}` : ''}</p></div>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <Preview input={{ content: v.content, customVariables: v.customVariables, examples: v.examples }} />
      </div>
    </div>
  )
}

function BackLink({ onBack }: { onBack: () => void }) {
  return <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"><ChevronLeft className="size-4" aria-hidden /> All WhatsApp templates</button>
}

function RejectionHelp({ v, category, onRevise }: { v: VersionView; category: TemplateDraftInput['category']; onRevise: ((d: TemplateDraftInput, notes: string[]) => void) | null }) {
  const g = rejectionGuidance(v.meta)
  const suggestion = useMemo(() => suggestRevision(v.content, category, v.meta.rejectionReason), [v, category])
  return (
    <section className="rounded-2xl border border-destructive/30 bg-destructive/[0.03] p-4 sm:p-5">
      <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-foreground"><CircleAlert className="size-4 text-destructive" aria-hidden /> Meta rejected this version</h3>
      <p className="mt-2 text-[12.5px] text-muted-foreground">Meta’s reason: {g.metaReason ? <span className="font-mono font-semibold text-foreground">{g.metaReason}</span> : <span className="text-foreground">not provided</span>}</p>
      {g.metaDetail && (g.metaDetail.reason || g.metaDetail.recommendation) && (
        <div className="mt-2 rounded-xl bg-card px-3 py-2 text-[12.5px]">
          {g.metaDetail.reason && <p><span className="font-semibold">Meta: </span>{g.metaDetail.reason}</p>}
          {g.metaDetail.recommendation && <p className="mt-1"><span className="font-semibold">Meta’s recommendation: </span>{g.metaDetail.recommendation}</p>}
        </div>
      )}
      <p className="mt-3 text-[13px] font-semibold text-foreground">{g.title}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">{g.explanation}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-foreground">{g.steps.map(s => <li key={s}>{s}</li>)}</ul>
      {onRevise && (
        <div className="mt-4 flex flex-wrap gap-2">
          {suggestion.changes.length > 0 && <Button size="sm" onClick={() => onRevise({ ...draftFromVersion('', null, v, suggestion.category, ''), content: suggestion.content, category: suggestion.category }, suggestion.changes)}>Revise with suggested changes</Button>}
          <Button size="sm" variant="outline" onClick={() => onRevise({ ...draftFromVersion('', null, v, category, ''), category }, [])}>Revise manually</Button>
        </div>
      )}
      <p className="mt-3 text-[11.5px] text-muted-foreground">Suggestions are a starting point. They cannot guarantee that Meta will approve the next version.</p>
    </section>
  )
}

// ─── Builder ──────────────────────────────────────────────────────────────────

const inputCls = 'w-full rounded-xl border border-border bg-background px-3 py-2 text-[14px] text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60'
const labelCls = 'block text-[12.5px] font-semibold text-foreground'

function Builder(p: {
  mode: 'create' | 'edit' | 'revise'; templateId?: string; revision?: number; version?: number; fromVersion?: number
  initial?: TemplateDraftInput; notes?: string[]; onCancel: () => void; onSaved: (id: string) => void
}) {
  const { selectedEvent } = useEventContext()
  const eventSlug = p.initial?.eventSlug ?? (selectedEvent?.slug ?? null)
  const [d, setD] = useState<TemplateDraftInput>(() => p.initial ?? blankDraft(eventSlug))
  const [linkEvent, setLinkEvent] = useState<boolean>(!!d.eventSlug)
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null)
  const [serverError, setServerError] = useState<{ text: string; findings?: ValidationFinding[] } | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  // RD-WA-MARKETING-01 — Marketing is offered only while a Super Admin has it enabled (the server
  // refuses Marketing create / edit / new version otherwise). Unknown until loaded ⇒ treated as off.
  const [marketingEnabled, setMarketingEnabled] = useState(false)
  useEffect(() => {
    let alive = true
    void call<{ marketingTemplatesEnabled?: boolean }>(API).then(r => { if (alive) setMarketingEnabled(r.ok && r.body.marketingTemplatesEnabled === true) }).catch(() => null)
    return () => { alive = false }
  }, [])
  const eventType = linkEvent ? (selectedEvent?.eventType ?? null) : null
  const input: TemplateDraftInput = { ...d, eventSlug: linkEvent ? (d.eventSlug ?? selectedEvent?.slug ?? null) : null }
  // The SAME validator the server runs on save, on submit and at approval time.
  const findings = validateTemplate(input, { eventType })
  const errors = findings.filter(f => f.severity === 'error')
  const vars = variablesForEventType(eventType)
  const used = usedVariables(d.content)

  const setContent = (patch: Partial<TemplateDraftInput['content']>) => setD(x => ({ ...x, content: { ...x.content, ...patch } }))
  const insertVar = (key: string) => {
    const el = bodyRef.current
    const token = `{{${key}}}`
    if (!el) { setContent({ body: `${d.content.body}${token}` }); return }
    const start = el.selectionStart ?? d.content.body.length, end = el.selectionEnd ?? start
    const next = d.content.body.slice(0, start) + token + d.content.body.slice(end)
    setContent({ body: next })
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length) })
  }
  const setCustom = (i: number, patch: Partial<CustomVariable>) => setD(x => ({ ...x, customVariables: x.customVariables.map((c, j) => (j === i ? { ...c, ...patch } : c)) }))
  const setButton = (i: number, b: TemplateButton) => setContent({ buttons: (d.content.buttons ?? []).map((x, j) => (j === i ? b : x)) })

  const save = async (andSubmit: boolean) => {
    setBusy(andSubmit ? 'submit' : 'save'); setServerError(null)
    try {
      let id = p.templateId ?? ''
      if (p.mode === 'create') {
        const r = await call<{ id: string }>(API, { method: 'POST', body: JSON.stringify({ ...input, submit: andSubmit }) })
        if (!r.ok) { setServerError({ text: r.body.error ?? 'Could not save.', findings: r.body.findings }); return }
        id = r.body.id
      } else {
        const r = p.mode === 'edit'
          ? await call(`${API}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...input, version: p.version, revision: p.revision }) })
          : await call(`${API}/${encodeURIComponent(id)}/versions`, { method: 'POST', body: JSON.stringify({ ...input, fromVersion: p.fromVersion, revision: p.revision }) })
        if (!r.ok) { setServerError({ text: r.body.error ?? 'Could not save.', findings: r.body.findings }); return }
        if (andSubmit) {
          const fresh = await call<{ template: TemplateDetail }>(`${API}/${encodeURIComponent(id)}`)
          if (!fresh.ok) { setServerError({ text: 'Saved, but the template could not be reloaded to submit it. Open it and submit again.' }); return }
          const s = await call(`${API}/${encodeURIComponent(id)}/submit`, { method: 'POST', body: JSON.stringify({ version: fresh.body.template.latestVersion, revision: fresh.body.template.revision }) })
          if (!s.ok) { setServerError({ text: `Saved as a draft, but not submitted: ${s.body.error ?? 'unknown error'}`, findings: s.body.findings }); return }
        }
      }
      p.onSaved(id)
    } catch {
      setServerError({ text: 'Network error — please try again.' })
    } finally { setBusy(null) }
  }

  const starters = startersForEventType(eventType)
  return (
    <div className="space-y-4">
      <button type="button" onClick={p.onCancel} className="inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground"><ChevronLeft className="size-4" aria-hidden /> Cancel</button>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <section className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
            <h2 className="text-[15px] font-semibold text-foreground">{p.mode === 'create' ? 'New WhatsApp template' : p.mode === 'edit' ? `Edit draft · ${d.name}` : `New version of ${d.name}`}</h2>
            {p.notes && p.notes.length > 0 && (
              <div className="rounded-xl border border-primary/25 bg-primary/[0.05] px-3 py-2 text-[12.5px]">
                <p className="font-semibold text-foreground">Suggested changes applied — review them before submitting:</p>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">{p.notes.map(n => <li key={n}>{n}</li>)}</ul>
              </div>
            )}
            {p.mode === 'create' && (
              <div>
                <p className={labelCls}>Start from</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {starters.map(s => (
                    <button key={s.id} type="button" onClick={() => setD(x => ({ ...x, name: x.name || s.name, category: s.category, content: s.content, customVariables: s.customVariables, examples: {} }))}
                      className="rounded-xl border border-border px-3 py-2 text-left hover:border-primary/40 hover:bg-primary/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
                      <span className="block text-[13px] font-medium text-foreground">{s.title}</span>
                      <span className="block text-[11.5px] text-muted-foreground">{s.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <label htmlFor="wt-name" className={labelCls}>Template name</label>
                <input id="wt-name" value={d.name} disabled={p.mode !== 'create'} onChange={e => setD(x => ({ ...x, name: e.target.value }))} placeholder="event_reminder" className={cn(inputCls, 'font-mono')} />
                <p className="text-[11.5px] text-muted-foreground">Lowercase letters, numbers and underscores. It cannot be changed later.</p>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="wt-cat" className={labelCls}>Category</label>
                <select id="wt-cat" value={d.category} onChange={e => setD(x => ({ ...x, category: e.target.value as TemplateDraftInput['category'] }))} className={inputCls}>
                  {SUPPORTED_CATEGORIES.map(c => (
                    <option key={c} value={c} disabled={c === 'marketing' && !marketingEnabled}>
                      {c === 'marketing' && !marketingEnabled ? `${CATEGORY_LABEL[c]} (coming soon)` : CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
                <p className="text-[11.5px] text-muted-foreground">{CATEGORY_HINT[d.category]}</p>
                {d.category === 'marketing' && !marketingEnabled && (
                  <p role="status" className="text-[11.5px] text-amber-700 dark:text-amber-300">
                    Marketing templates are not available yet, so this template can’t be saved as Marketing. Choose Utility, or wait until RegisterDesk enables Marketing templates.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="wt-lang" className={labelCls}>Language</label>
                <select id="wt-lang" value={d.language} onChange={e => setD(x => ({ ...x, language: e.target.value }))} className={inputCls}>
                  {TEMPLATE_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label} ({l.code})</option>)}
                </select>
                <p className="text-[11.5px] text-muted-foreground">Write the message in this language — Meta does not translate it.</p>
              </div>
              {selectedEvent?.slug && (
                <label className="flex items-start gap-2 text-[12.5px] text-foreground sm:col-span-2">
                  <input type="checkbox" checked={linkEvent} onChange={e => setLinkEvent(e.target.checked)} className="mt-0.5" />
                  <span>Designed for <span className="font-medium">{selectedEvent.name}</span> — offer variables for this type of event only.</span>
                </label>
              )}
            </div>
          </section>

          <section className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
            <div className="space-y-1.5">
              <label htmlFor="wt-header" className={labelCls}>Header <span className="font-normal text-muted-foreground">(optional, text only)</span></label>
              <input id="wt-header" value={d.content.header?.text ?? ''} maxLength={LIMITS.header + 20} onChange={e => setContent({ header: e.target.value ? { format: 'text', text: e.target.value } : null })} placeholder="Important update" className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2"><label htmlFor="wt-body" className={labelCls}>Message</label><span className="text-[11.5px] tabular-nums text-muted-foreground">{d.content.body.length}/{LIMITS.body}</span></div>
              <textarea id="wt-body" ref={bodyRef} rows={6} value={d.content.body} onChange={e => setContent({ body: e.target.value })} placeholder="Hi {{attendeeName}}, …" className={cn(inputCls, 'resize-y leading-relaxed')} />
              <div className="flex flex-wrap gap-1.5" aria-label="Insert a variable">
                {vars.map(v => <button key={v.key} type="button" title={v.description} onClick={() => insertVar(v.key)} className={cn('rounded-full border px-2 py-0.5 text-[11.5px]', used.includes(v.key) ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>{v.label}</button>)}
                {d.customVariables.filter(c => c.key).map(c => <button key={c.key} type="button" onClick={() => insertVar(c.key)} className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:text-foreground">{c.label || c.key}</button>)}
              </div>
              <p className="text-[11.5px] text-muted-foreground">Automatic variables are filled for each attendee when you send. Values you type when sending are “broadcast-time” variables below.</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="wt-footer" className={labelCls}>Footer <span className="font-normal text-muted-foreground">(optional)</span></label>
              <input id="wt-footer" value={d.content.footer ?? ''} onChange={e => setContent({ footer: e.target.value || null })} placeholder={d.category === 'marketing' ? 'Reply STOP to unsubscribe' : 'Sent via RegisterDesk'} className={inputCls} />
            </div>
          </section>

          <section className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-semibold text-foreground">Broadcast-time variables</h3>
              <Button size="xs" variant="outline" disabled={d.customVariables.length >= LIMITS.customVariables} onClick={() => setD(x => ({ ...x, customVariables: [...x.customVariables, { key: '', label: '', example: '' }] }))}><Plus className="size-3.5" aria-hidden /> Add</Button>
            </div>
            {d.customVariables.length === 0 && <p className="text-[12.5px] text-muted-foreground">None. Add one for a value you type each time you send, such as a collection time.</p>}
            {d.customVariables.map((c, i) => (
              <div key={i} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1fr_1fr_1.4fr_auto]">
                <input aria-label="Variable name" value={c.key} onChange={e => setCustom(i, { key: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} placeholder="collectionTime" className={cn(inputCls, 'font-mono text-[13px]')} />
                <input aria-label="Label" value={c.label} onChange={e => setCustom(i, { label: e.target.value })} placeholder="When" className={inputCls} />
                <input aria-label="Example value" value={c.example} onChange={e => setCustom(i, { example: e.target.value })} placeholder="Friday, 10:00–18:00" className={inputCls} />
                <button type="button" aria-label="Remove variable" onClick={() => setD(x => ({ ...x, customVariables: x.customVariables.filter((_, j) => j !== i) }))} className="justify-self-end rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><Trash2 className="size-4" aria-hidden /></button>
              </div>
            ))}
            {used.filter(k => catalogVariable(k)).length > 0 && (
              <details className="text-[12.5px]">
                <summary className="cursor-pointer font-medium text-foreground">Example values Meta will see</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {used.filter(k => catalogVariable(k)).map(k => (
                    <label key={k} className="space-y-1"><span className="block text-[11.5px] text-muted-foreground">{catalogVariable(k)!.label}</span>
                      <input value={d.examples[k] ?? ''} placeholder={catalogVariable(k)!.example} onChange={e => setD(x => ({ ...x, examples: { ...x.examples, [k]: e.target.value } }))} className={inputCls} /></label>
                  ))}
                </div>
              </details>
            )}
          </section>

          <section className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13.5px] font-semibold text-foreground">Buttons <span className="font-normal text-muted-foreground">(optional)</span></h3>
              <div className="flex gap-2">
                <Button size="xs" variant="outline" onClick={() => setContent({ buttons: [...(d.content.buttons ?? []), { type: 'url', text: '', url: 'https://' }] })}>+ Link</Button>
                <Button size="xs" variant="outline" onClick={() => setContent({ buttons: [...(d.content.buttons ?? []), { type: 'phone', text: '', phone: '+91' }] })}>+ Call</Button>
              </div>
            </div>
            {(d.content.buttons ?? []).map((b, i) => (
              <div key={i} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1fr_1.6fr_auto]">
                <input aria-label="Button label" value={b.text} maxLength={LIMITS.buttonText + 10} onChange={e => setButton(i, { ...b, text: e.target.value })} placeholder={b.type === 'url' ? 'View details' : 'Call us'} className={inputCls} />
                {b.type === 'url' && <input aria-label="Link" value={b.url} onChange={e => setButton(i, { ...b, url: e.target.value })} className={inputCls} />}
                {b.type === 'phone' && <input aria-label="Phone number" value={b.phone} onChange={e => setButton(i, { ...b, phone: e.target.value })} className={inputCls} />}
                {b.type === 'quick_reply' && <span className="self-center text-[12px] text-muted-foreground">Quick reply</span>}
                <button type="button" aria-label="Remove button" onClick={() => setContent({ buttons: (d.content.buttons ?? []).filter((_, j) => j !== i) })} className="justify-self-end rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><Trash2 className="size-4" aria-hidden /></button>
              </div>
            ))}
          </section>

          <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <h3 className="text-[13.5px] font-semibold text-foreground">Checks</h3>
            {findings.length ? <div className="mt-2"><Findings findings={findings} /></div> : <p className="mt-2 flex items-center gap-2 text-[13px] text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="size-4" aria-hidden /> No problems found.</p>}
            <p className="mt-3 text-[11.5px] text-muted-foreground">These checks catch common reasons Meta rejects templates. Passing them does not guarantee approval.</p>
            {serverError && (
              <div role="alert" className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
                {serverError.text}{serverError.findings && <div className="mt-2"><Findings findings={serverError.findings.filter(f => f.severity === 'error')} /></div>}
              </div>
            )}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button variant="outline" size="sm" isLoading={busy === 'save'} disabled={!!busy || !d.name.trim()} onClick={() => save(false)}>Save draft</Button>
              <Button size="sm" isLoading={busy === 'submit'} disabled={!!busy || errors.length > 0} onClick={() => save(true)}>Save and submit</Button>
            </div>
            {errors.length > 0 && <p className="mt-2 text-right text-[11.5px] text-muted-foreground">Fix {errors.length} error{errors.length === 1 ? '' : 's'} to submit. You can still save a draft.</p>}
          </section>
        </div>
        <Preview input={input} />
      </div>
    </div>
  )
}

// ─── Shared pieces ────────────────────────────────────────────────────────────

const FINDING_ICON = { error: CircleAlert, warning: AlertTriangle, suggestion: Lightbulb } as const
const FINDING_CLS = { error: 'text-destructive', warning: 'text-amber-600 dark:text-amber-400', suggestion: 'text-primary' } as const
const FINDING_LABEL = { error: 'Error', warning: 'Warning', suggestion: 'Suggestion' } as const

export function Findings({ findings }: { findings: readonly ValidationFinding[] }) {
  return (
    <ul className="space-y-2.5">
      {findings.map((f, i) => {
        const Icon = FINDING_ICON[f.severity]
        return (
          <li key={`${f.code}-${f.field}-${i}`} className="flex gap-2.5 text-[13px]">
            <Icon className={cn('mt-0.5 size-4 shrink-0', FINDING_CLS[f.severity])} aria-hidden />
            <div className="min-w-0">
              <p className="text-foreground"><span className="sr-only">{FINDING_LABEL[f.severity]}: </span>{f.message}</p>
              <p className="text-[12px] text-muted-foreground">{f.why}</p>
              {f.suggestion && <p className="text-[12px] text-foreground/80"><span className="font-medium">Try: </span>{f.suggestion}</p>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function Preview({ input, values }: { input: Pick<TemplateDraftInput, 'content' | 'customVariables' | 'examples'>; values?: Record<string, string> }) {
  const r = renderPreview(input, values)
  return (
    <aside className="h-fit overflow-hidden rounded-2xl border border-border bg-card lg:sticky lg:top-4" aria-label="Message preview">
      <div className="border-b border-border px-4 py-2.5"><p className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground"><Info className="size-3.5" aria-hidden /> Preview · example values</p></div>
      <div className="bg-[#e5ddd5] p-4 dark:bg-[#0b141a]">
        <div className="max-w-[92%] rounded-lg rounded-tl-none bg-white px-3 py-2.5 text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
          {r.header && <p className="text-[13.5px] font-bold">{r.header}</p>}
          <p className={cn('whitespace-pre-wrap break-words text-[13.5px] leading-relaxed', r.header && 'mt-1')}>{r.body || <span className="opacity-50">Your message appears here.</span>}</p>
          {r.footer && <p className="mt-1.5 text-[11.5px] opacity-60">{r.footer}</p>}
        </div>
        {(input.content.buttons ?? []).filter(b => b.text.trim()).map((b, i) => (
          <div key={i} className="mt-1 max-w-[92%] rounded-lg bg-white px-3 py-2 text-center text-[13px] font-medium text-[#0b7cc1] shadow-sm dark:bg-[#202c33] dark:text-[#53bdeb]">{b.text}</div>
        ))}
      </div>
    </aside>
  )
}
