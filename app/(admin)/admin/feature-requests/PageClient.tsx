'use client'

// RD-FEATURE-REQ-01 · Super Admin Feature Requests console.
//
// Every read and write goes through /api/admin/feature-requests, which requires a Super Admin
// (ADMIN_UIDS). Changes are whitelisted server-side; history, audit and the organizer notification
// commit with each change. The rollout section records a PLAN only — nothing here enables a feature.

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Lightbulb, Loader2, X, Link2, StickyNote, History, Rocket } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { AdminToolbar, FilterTabs, StatusPill, ErrorBanner, TableFrame, THead, Th, TBody, Tr, Td, type PillTone } from '@/components/admin'
import {
  FEATURE_REQUEST_STATUSES, STATUS_LABEL, ADMIN_PRIORITIES, ADMIN_PRIORITY_LABEL, ORGANIZER_PRIORITY_LABEL,
  ROLLOUT_SCOPES, ROLLOUT_SCOPE_LABEL, requestEventTypeLabel, LIMITS,
  type FeatureRequestStatus, type AdminPriority, type OrganizerPriority, type RolloutPlan, type RolloutScope,
} from '@/lib/featureRequests/types'

type Filter = 'all' | FeatureRequestStatus
const FILTERS = [{ value: 'all' as Filter, label: 'All' }, ...FEATURE_REQUEST_STATUSES.map(s => ({ value: s as Filter, label: STATUS_LABEL[s] }))]
const TONE: Record<FeatureRequestStatus, PillTone> = {
  submitted: 'neutral', under_review: 'info', planned: 'accent', in_development: 'warning', released: 'success', declined: 'danger',
}

interface Row {
  id: string; title: string; status: FeatureRequestStatus; adminPriority: AdminPriority | null
  organizerPriority: OrganizerPriority; eventType: string; eventName: string | null
  workspaceUid: string; organizationName: string | null; duplicateOf: string | null; createdAt: string | null
}
interface Detail extends Row {
  problem: string; proposal: string; eventId: string | null; submittedBy: string | null
  organizerResponse: string | null; releaseNote: string | null; rollout: RolloutPlan
  history: { id: string; from: FeatureRequestStatus | null; to: FeatureRequestStatus; at: string | null; actorUid: string | null; actorRole: string | null }[]
  notes: { id: string; text: string; authorUid: string | null; at: string | null }[]
  duplicates: { id: string; title: string; status: FeatureRequestStatus }[]
  suggestions: { id: string; title: string; status: FeatureRequestStatus; score: number }[]
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const field = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground'

async function api(path: string, init?: RequestInit): Promise<Response> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return fetch(path, { ...init, cache: 'no-store', headers: { ...(init?.headers ?? {}), authorization: `Bearer ${await u.getIdToken()}`, 'content-type': 'application/json' } })
}

export default function AdminFeatureRequestsPage() {
  const params = useSearchParams()
  const [filter, setFilter] = useState<Filter>('all')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(params.get('id'))

  const load = useCallback(async () => {
    setRows(null)
    try {
      const res = await api(`/api/admin/feature-requests${filter === 'all' ? '' : `?status=${filter}`}`)
      const json = await res.json() as { rows?: Row[]; error?: string }
      if (!res.ok) throw new Error(res.status === 403 ? 'Feature requests are available to Super Admins only.' : (json.error ?? 'Failed to load'))
      setRows(json.rows ?? []); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load'); setRows([]) }
  }, [filter])

  useEffect(() => {
    const unsub = auth.onAuthStateChanged(u => { if (u) void load() })
    return unsub
  }, [load])

  return (
    <div className="space-y-5">
      <AdminToolbar icon={Lightbulb} title="Feature Requests" description="What organizers are asking for — triage, respond, link duplicates and plan rollouts." />
      <FilterTabs options={FILTERS} value={filter} onChange={setFilter} aria-label="Filter by status" scrollable />
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {!rows ? (
        <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border px-4 py-10 text-center text-[13px] text-muted-foreground">No requests{filter === 'all' ? '' : ` with status “${STATUS_LABEL[filter]}”`}.</div>
      ) : (
        <TableFrame minWidth="min-w-[820px]">
          <THead>
            <Th>Request</Th><Th>Organizer</Th><Th>Status</Th><Th>Priority</Th><Th>Received</Th>
          </THead>
          <TBody>
            {rows.map(r => (
              <Tr key={r.id} className="cursor-pointer" onClick={() => setOpenId(r.id)}>
                <Td>
                  <div className="font-medium text-foreground">{r.title}</div>
                  <div className="text-[11.5px] text-muted-foreground">{requestEventTypeLabel(r.eventType)}{r.eventName ? ` · ${r.eventName}` : ''}{r.duplicateOf ? ' · linked duplicate' : ''}</div>
                </Td>
                <Td className="text-[12.5px]">{r.organizationName ?? r.workspaceUid}</Td>
                <Td><StatusPill tone={TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusPill></Td>
                <Td className="text-[12px]">
                  <div>{r.adminPriority ? ADMIN_PRIORITY_LABEL[r.adminPriority] : <span className="text-muted-foreground">Untriaged</span>}</div>
                  <div className="text-muted-foreground">Org: {ORGANIZER_PRIORITY_LABEL[r.organizerPriority]}</div>
                </Td>
                <Td className="text-[12px] text-muted-foreground">{fmt(r.createdAt)}</Td>
              </Tr>
            ))}
          </TBody>
        </TableFrame>
      )}
      {openId && <DetailPanel id={openId} onClose={() => setOpenId(null)} onChanged={() => void load()} onOpen={setOpenId} />}
    </div>
  )
}

function DetailPanel({ id, onClose, onChanged, onOpen }: { id: string; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void }) {
  const [d, setD] = useState<Detail | null>(null)
  const [flagKeys, setFlagKeys] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const [form, setForm] = useState({ status: '' as FeatureRequestStatus | '', adminPriority: '', organizerResponse: '', releaseNote: '', duplicateOf: '' })
  const [rollout, setRollout] = useState({ scope: 'none' as RolloutScope, list: '', eventTypes: '', flagKey: '' })

  const apply = useCallback((r: Detail, keys: string[]) => {
    setD(r); setFlagKeys(keys); setErr(null)
    setForm({ status: r.status, adminPriority: r.adminPriority ?? '', organizerResponse: r.organizerResponse ?? '', releaseNote: r.releaseNote ?? '', duplicateOf: r.duplicateOf ?? '' })
    const list = r.rollout.scope === 'selected_events' ? r.rollout.eventSlugs : r.rollout.scope === 'selected_organizers' ? r.rollout.organizerUids : []
    setRollout({ scope: r.rollout.scope, list: list.join(', '), eventTypes: r.rollout.eventTypes.join(', '), flagKey: r.rollout.flagKey ?? '' })
  }, [])
  const fetchDetail = useCallback(async () => {
    const res = await api(`/api/admin/feature-requests/${encodeURIComponent(id)}`)
    const json = await res.json() as { request?: Detail; flagKeys?: string[]; error?: string }
    if (!res.ok || !json.request) throw new Error(json.error ?? 'Failed to load')
    return { request: json.request, keys: json.flagKeys ?? [] }
  }, [id])
  const load = useCallback(async () => {
    try { const r = await fetchDetail(); apply(r.request, r.keys) } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load') }
  }, [fetchDetail, apply])
  useEffect(() => {
    let alive = true
    void (async () => {
      try { const r = await fetchDetail(); if (alive) apply(r.request, r.keys) }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
    })()
    return () => { alive = false }
  }, [fetchDetail, apply])

  async function save() {
    if (!d) return
    setSaving(true); setErr(null)
    const splitList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)
    const body: Record<string, unknown> = {
      expectedStatus: d.status,
      ...(form.status && form.status !== d.status ? { status: form.status } : {}),
      adminPriority: form.adminPriority || null,
      organizerResponse: form.organizerResponse.trim() || null,
      releaseNote: form.releaseNote.trim() || null,
      duplicateOf: form.duplicateOf.trim() || null,
      rollout: {
        scope: rollout.scope,
        eventSlugs: rollout.scope === 'selected_events' ? splitList(rollout.list) : [],
        organizerUids: rollout.scope === 'selected_organizers' ? splitList(rollout.list) : [],
        eventTypes: rollout.scope === 'event_types' ? splitList(rollout.eventTypes) : [],
        flagKey: rollout.flagKey || null,
      },
    }
    try {
      const res = await api(`/api/admin/feature-requests/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
      const json = await res.json() as { error?: string; notified?: boolean }
      if (!res.ok) throw new Error(json.error ?? 'Could not save')
      await load(); onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save') } finally { setSaving(false) }
  }

  async function addNote() {
    if (note.trim().length < LIMITS.note.min) return
    setSaving(true)
    try {
      const res = await api(`/api/admin/feature-requests/${encodeURIComponent(id)}/notes`, { method: 'POST', body: JSON.stringify({ text: note }) })
      const json = await res.json() as { error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Could not add the note')
      setNote(''); await load()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not add the note') } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-foreground/30" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Feature request" className="h-full w-full max-w-xl overflow-y-auto bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-[16px] font-bold text-foreground">{d?.title ?? 'Feature request'}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
        </div>
        {err && <ErrorBanner>{err}</ErrorBanner>}
        {!d ? <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div> : (
          <div className="space-y-4 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={TONE[d.status]}>{STATUS_LABEL[d.status]}</StatusPill>
              <span className="text-muted-foreground">{d.organizationName ?? d.workspaceUid} · {requestEventTypeLabel(d.eventType)}{d.eventName ? ` · ${d.eventName}` : ''} · {fmt(d.createdAt)}</span>
            </div>
            <section className="space-y-2 rounded-lg border border-border p-3">
              <p><span className="font-semibold">Need: </span><span className="whitespace-pre-wrap">{d.problem}</span></p>
              <p><span className="font-semibold">Proposal: </span><span className="whitespace-pre-wrap">{d.proposal}</span></p>
              <p className="text-muted-foreground">Organizer priority: {ORGANIZER_PRIORITY_LABEL[d.organizerPriority]}</p>
            </section>

            <section className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Triage</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">Status
                  <select className={field} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as FeatureRequestStatus }))}>
                    {FEATURE_REQUEST_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </label>
                <label className="block">Priority
                  <select className={field} value={form.adminPriority} onChange={e => setForm(f => ({ ...f, adminPriority: e.target.value }))}>
                    <option value="">Untriaged</option>
                    {ADMIN_PRIORITIES.map(p => <option key={p} value={p}>{ADMIN_PRIORITY_LABEL[p]}</option>)}
                  </select>
                </label>
              </div>
              <label className="block">Response to the organizer <span className="text-muted-foreground">(visible to them{form.status === 'declined' ? ' — required to decline' : ''})</span>
                <textarea className={cn(field, 'h-20')} maxLength={LIMITS.response.max} value={form.organizerResponse} onChange={e => setForm(f => ({ ...f, organizerResponse: e.target.value }))} />
              </label>
              <label className="block">Release update <span className="text-muted-foreground">(shown when Released)</span>
                <textarea className={cn(field, 'h-16')} maxLength={LIMITS.response.max} value={form.releaseNote} onChange={e => setForm(f => ({ ...f, releaseNote: e.target.value }))} />
              </label>
              <label className="block">Duplicate of <span className="text-muted-foreground">(request id — links, never merges)</span>
                <input className={field} value={form.duplicateOf} onChange={e => setForm(f => ({ ...f, duplicateOf: e.target.value }))} placeholder="Original request id" />
              </label>
            </section>

            <section className="space-y-2 rounded-lg border border-dashed border-border p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><Rocket className="size-3.5" /> Rollout plan</p>
              <p className="text-[12px] text-muted-foreground">A plan only — it does <strong>not</strong> enable anything, and marking a request Released does not either. Activation needs the per-organizer / per-event flag layer described in lib/featureRequests/README.md.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">Intended audience
                  <select className={field} value={rollout.scope} onChange={e => setRollout(r => ({ ...r, scope: e.target.value as RolloutScope }))}>
                    {ROLLOUT_SCOPES.map(s => <option key={s} value={s}>{ROLLOUT_SCOPE_LABEL[s]}</option>)}
                  </select>
                </label>
                <label className="block">Existing feature flag
                  <select className={field} value={rollout.flagKey} onChange={e => setRollout(r => ({ ...r, flagKey: e.target.value }))}>
                    <option value="">None</option>
                    {flagKeys.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </label>
              </div>
              {(rollout.scope === 'selected_events' || rollout.scope === 'selected_organizers') && (
                <label className="block">{rollout.scope === 'selected_events' ? 'Event slugs' : 'Organizer uids'} <span className="text-muted-foreground">(comma separated)</span>
                  <input className={field} value={rollout.list} onChange={e => setRollout(r => ({ ...r, list: e.target.value }))} />
                </label>
              )}
              {rollout.scope === 'event_types' && (
                <label className="block">Event types <span className="text-muted-foreground">(e.g. sports, conference)</span>
                  <input className={field} value={rollout.eventTypes} onChange={e => setRollout(r => ({ ...r, eventTypes: e.target.value }))} />
                </label>
              )}
            </section>

            <div className="flex justify-end">
              <button type="button" disabled={saving} onClick={() => void save()} className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50">{saving ? 'Saving…' : 'Save changes'}</button>
            </div>

            {(d.duplicates.length > 0 || d.suggestions.length > 0) && (
              <section className="space-y-2 rounded-lg border border-border p-3">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><Link2 className="size-3.5" /> Duplicates</p>
                {d.duplicates.map(x => (
                  <button key={x.id} type="button" onClick={() => onOpen(x.id)} className="block w-full text-left hover:underline">Linked: {x.title} <span className="text-muted-foreground">· {STATUS_LABEL[x.status]}</span></button>
                ))}
                {d.suggestions.map(x => (
                  <div key={x.id} className="flex items-center justify-between gap-2">
                    <button type="button" onClick={() => onOpen(x.id)} className="min-w-0 truncate text-left hover:underline">Similar: {x.title} <span className="text-muted-foreground">· {Math.round(x.score * 100)}%</span></button>
                    <button type="button" onClick={() => setForm(f => ({ ...f, duplicateOf: x.id }))} className="shrink-0 rounded border border-border px-2 py-0.5 text-[11.5px]">Use as original</button>
                  </div>
                ))}
              </section>
            )}

            <section className="space-y-2 rounded-lg border border-border p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><StickyNote className="size-3.5" /> Internal notes <span className="normal-case">(never shown to organizers)</span></p>
              <div className="flex gap-2">
                <input className={field} value={note} maxLength={LIMITS.note.max} onChange={e => setNote(e.target.value)} placeholder="Add a note for the team" />
                <button type="button" disabled={saving || note.trim().length < LIMITS.note.min} onClick={() => void addNote()} className="shrink-0 rounded-md border border-border px-3 text-[12.5px] font-semibold disabled:opacity-50">Add</button>
              </div>
              {d.notes.map(n => <p key={n.id} className="whitespace-pre-wrap rounded bg-muted/40 px-2 py-1.5">{n.text}<span className="block text-[11px] text-muted-foreground">{n.authorUid} · {fmt(n.at)}</span></p>)}
            </section>

            <section className="space-y-1.5 rounded-lg border border-border p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><History className="size-3.5" /> Status history</p>
              {d.history.map(h => (
                <p key={h.id}>{h.from ? `${STATUS_LABEL[h.from]} → ` : ''}<strong>{STATUS_LABEL[h.to]}</strong> <span className="text-muted-foreground">· {h.actorRole === 'organizer' ? 'organizer' : `admin ${h.actorUid ?? ''}`} · {fmt(h.at)}</span></p>
              ))}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
