'use client'

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { Loader2, Plus, Trash2, Download, CalendarClock, Layers, Users, Building2 } from 'lucide-react'
import type { ScheduleBundle, SessionAnalytics, SessionView } from '@/lib/sessions/types'

interface Props { eventId: string; token: string }
type View = 'agenda' | 'track' | 'speaker'

const fmtTime = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const dayKey = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })

export default function ConferenceTab({ eventId, token }: Props) {
  const { showToast } = useToast()
  const { prompt } = useConfirm()
  const [bundle, setBundle] = useState<ScheduleBundle | null>(null)
  const [analytics, setAnalytics] = useState<SessionAnalytics | null>(null)
  const [view, setView] = useState<View>('agenda')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // New-session form
  const [showForm, setShowForm] = useState(false)
  const [f, setF] = useState({ title: '', trackId: '', hallId: '', speakerIds: [] as string[], start: '', end: '', capacity: '' })

  const headers = useCallback(() => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }), [token])
  const base = `/api/organizer/events/${eventId}/sessions`

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(base, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) throw new Error((await res.json().catch(() => null) as { error?: string } | null)?.error ?? 'Failed to load')
      const d = await res.json() as ScheduleBundle & { analytics: SessionAnalytics }
      setBundle({ sessions: d.sessions, tracks: d.tracks, halls: d.halls, speakers: d.speakers })
      setAnalytics(d.analytics)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') } finally { setLoading(false) }
  }, [base, token])

  useEffect(() => {
    // Defer so load()'s initial setState doesn't run synchronously in the effect
    // body (react-hooks/set-state-in-effect).
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load])

  async function action(payload: Record<string, unknown>): Promise<boolean> {
    setBusy(true)
    try {
      const res = await fetch(base, { method: 'POST', headers: headers(), body: JSON.stringify(payload) })
      const d = await res.json().catch(() => null) as { error?: string; detail?: string } | null
      if (!res.ok) { showToast(d?.error === 'HALL_CONFLICT' ? `Hall conflict with "${d.detail}"` : (d?.detail ? `${d.error}: ${d.detail}` : d?.error ?? 'Failed'), 'error'); return false }
      await load(); return true
    } catch { showToast('Request failed', 'error'); return false } finally { setBusy(false) }
  }

  async function quickAdd(kind: 'track' | 'hall' | 'speaker') {
    const name = (await prompt({ message: `New ${kind} name`, required: true }))?.trim()
    if (!name) return
    if (kind === 'track') await action({ action: 'create_track', name })
    else if (kind === 'hall') await action({ action: 'create_hall', name })
    else await action({ action: 'create_speaker', speaker: { name } })
  }

  async function createSession() {
    if (!f.title.trim() || !f.start || !f.end) { showToast('Title, start and end are required.', 'error'); return }
    const ok = await action({
      action: 'create_session',
      session: {
        title: f.title, trackId: f.trackId || null, hallId: f.hallId || null,
        speakerIds: f.speakerIds, startTime: new Date(f.start).getTime(), endTime: new Date(f.end).getTime(),
        capacity: f.capacity ? Number(f.capacity) : null,
      },
    })
    if (ok) { setShowForm(false); setF({ title: '', trackId: '', hallId: '', speakerIds: [], start: '', end: '', capacity: '' }) }
  }

  function exportUrl(qs: string) { return `${base}?${qs}&format=csv` }
  async function download(qs: string, name: string) {
    const res = await fetch(exportUrl(qs), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) { showToast('Export failed', 'error'); return }
    const blob = await res.blob(); const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href)
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error || !bundle) return <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">{error ?? 'Failed'}</div>

  const trackName = (id: string | null) => bundle.tracks.find(t => t.trackId === id)?.name ?? '—'
  const hallName = (id: string | null) => bundle.halls.find(h => h.hallId === id)?.name ?? '—'
  const active = bundle.sessions.filter(s => s.status === 'published')

  return (
    <div className="space-y-6">
      {/* Analytics */}
      {analytics && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          {[
            { label: 'Sessions', value: String(analytics.totalSessions) },
            { label: 'Registered', value: analytics.totalRegistered.toLocaleString('en-IN') },
            { label: 'Checked in', value: analytics.totalCheckedIn.toLocaleString('en-IN') },
            { label: 'No-show', value: `${analytics.noShowPct}%` },
            { label: 'Tracks', value: String(bundle.tracks.length) },
          ].map(k => (
            <div key={k.label} className="rounded-2xl border border-border bg-card p-4">
              <p className="text-[12px] text-muted-foreground">{k.label}</p>
              <p className="mt-1 text-[18px] font-bold text-foreground">{k.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Tracks / Halls / Speakers quick management */}
      <div className="grid gap-3 sm:grid-cols-3">
        <EntityCard icon={Layers} title="Tracks" items={bundle.tracks.map(t => ({ id: t.trackId, label: t.name }))} onAdd={() => void quickAdd('track')} onDelete={id => void action({ action: 'delete_track', trackId: id })} busy={busy} />
        <EntityCard icon={Building2} title="Halls" items={bundle.halls.map(h => ({ id: h.hallId, label: h.name }))} onAdd={() => void quickAdd('hall')} onDelete={id => void action({ action: 'delete_hall', hallId: id })} busy={busy} />
        <EntityCard icon={Users} title="Speakers" items={bundle.speakers.map(s => ({ id: s.speakerId, label: s.name, extra: () => void download(`speakerId=${s.speakerId}`, `speaker-${s.name}.csv`) }))} onAdd={() => void quickAdd('speaker')} onDelete={id => void action({ action: 'delete_speaker', speakerId: id })} busy={busy} />
      </div>

      {/* Header: view toggle + add session */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center rounded-lg border border-border bg-muted/30 p-0.5">
          {(['agenda', 'track', 'speaker'] as View[]).map(v => (
            <button key={v} onClick={() => setView(v)} className={cn('rounded-md px-3 py-1.5 text-[12.5px] font-medium capitalize', view === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}>{v} view</button>
          ))}
        </div>
        <button onClick={() => setShowForm(s => !s)} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm hover:opacity-90" style={{ backgroundImage: 'var(--primary-gradient)' }}>
          <Plus className="size-4" /> Add Session
        </button>
      </div>

      {/* New session form */}
      {showForm && (
        <div className="grid gap-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-2">
          <input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="Session title" className="rounded-lg border border-border bg-background px-3 py-2 text-[13px] sm:col-span-2" />
          <label className="text-[12px] text-muted-foreground">Start<input type="datetime-local" value={f.start} onChange={e => setF({ ...f, start: e.target.value })} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px]" /></label>
          <label className="text-[12px] text-muted-foreground">End<input type="datetime-local" value={f.end} onChange={e => setF({ ...f, end: e.target.value })} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px]" /></label>
          <select value={f.trackId} onChange={e => setF({ ...f, trackId: e.target.value })} className="rounded-lg border border-border bg-background px-3 py-2 text-[13px]"><option value="">No track</option>{bundle.tracks.map(t => <option key={t.trackId} value={t.trackId}>{t.name}</option>)}</select>
          <select value={f.hallId} onChange={e => setF({ ...f, hallId: e.target.value })} className="rounded-lg border border-border bg-background px-3 py-2 text-[13px]"><option value="">No hall</option>{bundle.halls.map(h => <option key={h.hallId} value={h.hallId}>{h.name}</option>)}</select>
          <input value={f.capacity} onChange={e => setF({ ...f, capacity: e.target.value.replace(/\D/g, '') })} placeholder="Capacity (blank = unlimited)" className="rounded-lg border border-border bg-background px-3 py-2 text-[13px]" />
          <select multiple value={f.speakerIds} onChange={e => setF({ ...f, speakerIds: Array.from(e.target.selectedOptions, o => o.value) })} className="rounded-lg border border-border bg-background px-3 py-2 text-[13px]">{bundle.speakers.map(s => <option key={s.speakerId} value={s.speakerId}>{s.name}</option>)}</select>
          <div className="flex gap-2 sm:col-span-2">
            <button onClick={() => void createSession()} disabled={busy} className="rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm disabled:opacity-60" style={{ backgroundImage: 'var(--primary-gradient)' }}>{busy ? 'Saving…' : 'Create session'}</button>
            <button onClick={() => setShowForm(false)} className="rounded-lg border border-border px-4 py-2 text-[13px]">Cancel</button>
          </div>
        </div>
      )}

      {/* Schedule */}
      {active.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border py-12 text-center text-[13px] text-muted-foreground">No sessions yet. Add tracks, halls and speakers, then create sessions.</p>
      ) : view === 'agenda' ? (
        <AgendaView sessions={active} trackName={trackName} hallName={hallName} onCancel={id => void action({ action: 'cancel_session', sessionId: id })} onExport={id => void download(`sessionId=${id}`, `attendees-${id}.csv`)} busy={busy} />
      ) : view === 'track' ? (
        <GroupedView groups={bundle.tracks.map(t => ({ key: t.trackId, label: t.name, sessions: active.filter(s => s.trackId === t.trackId) })).concat([{ key: 'none', label: 'No track', sessions: active.filter(s => !s.trackId) }]).filter(g => g.sessions.length > 0)} hallName={hallName} onCancel={id => void action({ action: 'cancel_session', sessionId: id })} onExport={id => void download(`sessionId=${id}`, `attendees-${id}.csv`)} busy={busy} />
      ) : (
        <GroupedView groups={bundle.speakers.map(sp => ({ key: sp.speakerId, label: sp.name, sessions: active.filter(s => s.speakerIds.includes(sp.speakerId)) })).filter(g => g.sessions.length > 0)} hallName={hallName} onCancel={id => void action({ action: 'cancel_session', sessionId: id })} onExport={id => void download(`sessionId=${id}`, `attendees-${id}.csv`)} busy={busy} />
      )}
    </div>
  )
}

function EntityCard({ icon: Icon, title, items, onAdd, onDelete, busy }: { icon: React.ElementType; title: string; items: { id: string; label: string; extra?: () => void }[]; onAdd: () => void; onDelete: (id: string) => void; busy: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground"><Icon className="size-4 text-muted-foreground" /> {title}</p>
        <button onClick={onAdd} disabled={busy} className="rounded-md border border-border px-2 py-0.5 text-[12px] hover:bg-muted disabled:opacity-60">+ Add</button>
      </div>
      {items.length === 0 ? <p className="text-[12px] text-muted-foreground">None yet</p> : (
        <ul className="space-y-1">{items.map(i => (
          <li key={i.id} className="flex items-center justify-between gap-2 text-[13px]">
            <span className="truncate text-foreground">{i.label}</span>
            <span className="flex items-center gap-1.5">
              {i.extra && <button onClick={i.extra} title="Export schedule" className="text-muted-foreground hover:text-primary"><Download className="size-3.5" /></button>}
              <button onClick={() => onDelete(i.id)} disabled={busy} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></button>
            </span>
          </li>
        ))}</ul>
      )}
    </div>
  )
}

function SessionRow({ s, hallName, onCancel, onExport, busy }: { s: SessionView; hallName: (id: string | null) => string; onCancel: (id: string) => void; onExport: (id: string) => void; busy: boolean }) {
  const noShow = s.registeredCount > 0 ? Math.round((1 - s.checkedInCount / s.registeredCount) * 100) : 0
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-foreground">{s.title}</p>
        <p className="text-[12px] text-muted-foreground">{fmtTime(s.startTime)} – {fmtTime(s.endTime)} · {hallName(s.hallId)}</p>
      </div>
      <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
        <span><CalendarClock className="mr-1 inline size-3.5" />{s.registeredCount}{s.capacity !== null ? `/${s.capacity}` : ''} reg</span>
        <span>{s.checkedInCount} in · {noShow}% no-show</span>
        <button onClick={() => onExport(s.sessionId)} title="Export attendees" className="hover:text-primary"><Download className="size-3.5" /></button>
        <button onClick={() => onCancel(s.sessionId)} disabled={busy} className="hover:text-destructive"><Trash2 className="size-3.5" /></button>
      </div>
    </div>
  )
}

function AgendaView({ sessions, trackName, hallName, onCancel, onExport, busy }: { sessions: SessionView[]; trackName: (id: string | null) => string; hallName: (id: string | null) => string; onCancel: (id: string) => void; onExport: (id: string) => void; busy: boolean }) {
  const days = new Map<string, SessionView[]>()
  for (const s of sessions) { const k = dayKey(s.startTime); if (!days.has(k)) days.set(k, []); days.get(k)!.push(s) }
  return (
    <div className="space-y-5">
      {[...days.entries()].map(([day, list]) => (
        <div key={day}>
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">{day}</p>
          <div className="space-y-2">{list.map(s => <div key={s.sessionId}><p className="mb-0.5 text-[11px] text-muted-foreground">{trackName(s.trackId)}</p><SessionRow s={s} hallName={hallName} onCancel={onCancel} onExport={onExport} busy={busy} /></div>)}</div>
        </div>
      ))}
    </div>
  )
}

function GroupedView({ groups, hallName, onCancel, onExport, busy }: { groups: { key: string; label: string; sessions: SessionView[] }[]; hallName: (id: string | null) => string; onCancel: (id: string) => void; onExport: (id: string) => void; busy: boolean }) {
  return (
    <div className="space-y-5">
      {groups.map(g => (
        <div key={g.key}>
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">{g.label}</p>
          <div className="space-y-2">{g.sessions.map(s => <SessionRow key={s.sessionId} s={s} hallName={hallName} onCancel={onCancel} onExport={onExport} busy={busy} />)}</div>
        </div>
      ))}
    </div>
  )
}
