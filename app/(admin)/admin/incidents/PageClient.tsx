'use client'

import { useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { Loader2, Siren, Plus } from 'lucide-react'
import { AdminToolbar, StatusPill, ErrorBanner } from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { useToast } from '@/components/ui/Toast'
import type { IncidentView, IncidentSeverity, IncidentStatus } from '@/lib/operations/incidents'

const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
const SEV_TONE: Record<IncidentSeverity, PillTone> = { critical: 'danger', major: 'warning', minor: 'neutral' }
const STATUS_TONE: Record<IncidentStatus, PillTone> = { open: 'danger', investigating: 'warning', resolved: 'success' }
const NEXT: Record<IncidentStatus, IncidentStatus | null> = { open: 'investigating', investigating: 'resolved', resolved: null }

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<IncidentView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ title: '', description: '', severity: 'major' as IncidentSeverity })
  const { showToast } = useToast()

  async function token() { const u = auth.currentUser; if (!u) throw new Error('Not authenticated'); return u.getIdToken() }

  async function load() {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/admin/incidents', { headers: { authorization: `Bearer ${await token()}` }, cache: 'no-store' })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      setIncidents(((await res.json()) as { incidents: IncidentView[] }).incidents)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') } finally { setLoading(false) }
  }

  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function create() {
    if (!form.title.trim()) { showToast('Title required', 'error'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/admin/incidents', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${await token()}` }, body: JSON.stringify(form) })
      if (!res.ok) throw new Error('Create failed')
      setForm({ title: '', description: '', severity: 'major' })
      await load()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') } finally { setBusy(false) }
  }

  async function patch(id: string, body: { status?: IncidentStatus; postmortem?: string }) {
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/incidents/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${await token()}` }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error('Update failed')
      await load()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') } finally { setBusy(false) }
  }

  return (
    <div className="space-y-5">
      <AdminToolbar icon={Siren} title="Incidents" description="Track and resolve operational incidents." />

      {/* Create */}
      <div className="grid gap-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-[1fr_auto_auto]">
        <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Incident title" className="rounded-lg border border-border bg-background px-3 py-2 text-[13px] sm:col-span-3" />
        <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Description (optional)" className="rounded-lg border border-border bg-background px-3 py-2 text-[13px]" />
        <select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value as IncidentSeverity })} className="rounded-lg border border-border bg-background px-3 py-2 text-[13px]">
          <option value="critical">Critical</option><option value="major">Major</option><option value="minor">Minor</option>
        </select>
        <button onClick={() => void create()} disabled={busy} className="inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60" style={{ backgroundImage: 'var(--primary-gradient)' }}>
          <Plus className="size-4" /> Create
        </button>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {loading ? <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div> : (
        <div className="space-y-3">
          {incidents.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border py-12 text-center text-[13px] text-muted-foreground">No incidents recorded.</p>
          ) : incidents.map(i => {
            const next = NEXT[i.status]
            return (
              <div key={i.incidentId} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <StatusPill tone={SEV_TONE[i.severity]}>{i.severity}</StatusPill>
                    <StatusPill tone={STATUS_TONE[i.status]}>{i.status}</StatusPill>
                    <span className="text-[14px] font-semibold text-foreground">{i.title}</span>
                  </div>
                  {next && <button onClick={() => void patch(i.incidentId, { status: next })} disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted disabled:opacity-60 capitalize">Mark {next}</button>}
                </div>
                {i.description && <p className="mt-2 text-[13px] text-muted-foreground">{i.description}</p>}
                <p className="mt-1 text-[11px] text-muted-foreground">Opened {fmt(i.createdAt)}{i.resolvedAt ? ` · resolved ${fmt(i.resolvedAt)}` : ''}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-[12.5px] font-medium text-primary">Postmortem</summary>
                  <PostmortemEditor incident={i} onSave={pm => void patch(i.incidentId, { postmortem: pm })} busy={busy} />
                </details>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PostmortemEditor({ incident, onSave, busy }: { incident: IncidentView; onSave: (pm: string) => void; busy: boolean }) {
  const [text, setText] = useState(incident.postmortem)
  return (
    <div className="mt-2 space-y-2">
      <textarea value={text} onChange={e => setText(e.target.value)} rows={4} placeholder="Root cause, timeline, follow-ups…" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px]" />
      <button onClick={() => onSave(text)} disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted disabled:opacity-60">Save postmortem</button>
    </div>
  )
}
