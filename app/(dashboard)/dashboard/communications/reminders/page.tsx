'use client'

// Organizer Reminder Center (RD-REM-01) — history, analytics, and a "new custom
// reminder" composer with preview. Auto reminders (event tomorrow/today/starting
// soon, registration closing, early bird, low wallet) are scheduled by the engine;
// this page also lets organizers author + schedule custom reminders and cancel
// pending ones. Reuses the communications design tokens.

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { Loader2, ArrowLeft, Bell, Plus, X, CalendarClock } from 'lucide-react'
import type { ReminderRow, ReminderAnalytics } from '@/lib/reminders/types'

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`
const fmtDateTime = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

const STATUS_CLS: Record<string, string> = {
  scheduled: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  sending:   'bg-blue-50 text-blue-700 ring-blue-600/20',
  sent:      'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  partial:   'bg-amber-50 text-amber-700 ring-amber-600/20',
  failed:    'bg-rose-50 text-rose-700 ring-rose-600/20',
  skipped:   'bg-slate-100 text-slate-600 ring-slate-500/20',
  cancelled: 'bg-slate-100 text-slate-600 ring-slate-500/20',
}

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

interface EventOpt { slug: string; name: string }

export default function RemindersPage() {
  const { confirm } = useConfirm()
  const [rows, setRows]           = useState<ReminderRow[]>([])
  const [analytics, setAnalytics] = useState<ReminderAnalytics | null>(null)
  const [events, setEvents]       = useState<EventOpt[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [showForm, setShowForm]   = useState(false)

  async function reload() {
    const token = await getToken()
    const res = await fetch('/api/organizer/reminders', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    if (!res.ok) throw new Error('Could not load reminders.')
    const data = await res.json() as { reminders: ReminderRow[]; analytics: ReminderAnalytics }
    setRows(data.reminders); setAnalytics(data.analytics)
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        await reload()
        const token = await getToken()
        const lic = await fetch('/api/organizer/licenses', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (lic.ok && alive) {
          const d = await lic.json() as { licenses: { slug: string; eventName: string }[] }
          setEvents(d.licenses.map(l => ({ slug: l.slug, name: l.eventName })))
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  async function cancel(id: string) {
    if (!(await confirm({ message: 'Cancel this scheduled reminder?', tone: 'danger' }))) return
    try {
      const token = await getToken()
      const res = await fetch('/api/organizer/reminders', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', id }),
      })
      if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? 'Failed') }
      await reload()
    } catch (e) { setError(e instanceof Error ? e.message : 'Cancel failed') }
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="space-y-6 p-5 sm:p-6">
      <Link href="/dashboard/communications" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to Communications
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary/[0.09] text-primary"><Bell className="size-5" /></div>
          <div>
            <h1 className="text-[20px] font-bold tracking-tight text-foreground">Reminders</h1>
            <p className="text-[13.5px] text-muted-foreground">Automatic event reminders + custom scheduled messages to your attendees.</p>
          </div>
        </div>
        <button onClick={() => setShowForm(v => !v)} className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm" style={{ backgroundImage: 'var(--primary-gradient)' }}>
          <Plus className="size-4" /> New reminder
        </button>
      </div>

      {error && <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13.5px] text-destructive">{error}</div>}

      {analytics && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <Kpi label="Scheduled" value={analytics.scheduled} />
          <Kpi label="Sent" value={analytics.sent} />
          <Kpi label="Failed" value={analytics.failed} />
          <Kpi label="Skipped" value={analytics.skipped} />
          <Kpi label="Recipients" value={analytics.recipients} />
          <Kpi label="Cost" value={rupees(analytics.costPaise)} />
        </div>
      )}

      {showForm && <NewReminderForm events={events} onClose={() => setShowForm(false)} onCreated={() => { setShowForm(false); void reload() }} />}

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[820px] text-[13px]">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
              <th className="px-3 py-2.5">Reminder</th>
              <th className="px-3 py-2.5">Event</th>
              <th className="px-3 py-2.5">Audience</th>
              <th className="px-3 py-2.5">Send at</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Sent</th>
              <th className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">No reminders yet.</td></tr>
            ) : rows.map(r => (
              <tr key={r.id} className="hover:bg-muted/20">
                <td className="px-3 py-2.5">
                  <div className="font-medium text-foreground">{r.kindLabel}</div>
                  <div className="text-[11.5px] text-muted-foreground">{r.source === 'auto' ? 'Automatic' : 'Custom'}{r.subject ? ` · ${r.subject}` : ''}</div>
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.eventName}</td>
                <td className="px-3 py-2.5 text-muted-foreground capitalize">{r.audience}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{fmtDateTime(r.sendAt)}</td>
                <td className="px-3 py-2.5"><span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1', STATUS_CLS[r.status] ?? STATUS_CLS.scheduled)}>{r.status}</span></td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.counts.sent}/{r.counts.recipients || '—'}</td>
                <td className="px-3 py-2.5 text-right">
                  {r.status === 'scheduled'
                    ? <button onClick={() => cancel(r.id)} className="text-[12px] font-semibold text-rose-600 hover:underline">Cancel</button>
                    : <span className="text-[12px] text-muted-foreground/50">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-[18px] font-bold text-foreground">{value}</p>
    </div>
  )
}

function NewReminderForm({ events, onClose, onCreated }: { events: EventOpt[]; onClose: () => void; onCreated: () => void }) {
  const [audience, setAudience] = useState<'attendees' | 'organizer'>('attendees')
  const [eventId, setEventId]   = useState('')
  const [subject, setSubject]   = useState('')
  const [message, setMessage]   = useState('')
  const [when, setWhen]         = useState('')
  const [busy, setBusy]         = useState(false)
  const [err, setErr]           = useState<string | null>(null)

  async function submit() {
    setErr(null)
    const sendAtMs = when ? new Date(when).getTime() : Date.now()
    if (audience === 'attendees' && !eventId) { setErr('Select an event'); return }
    if (!subject.trim() || !message.trim()) { setErr('Subject and message are required'); return }
    setBusy(true)
    try {
      const token = await getToken()
      const res = await fetch('/api/organizer/reminders', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', audience, eventId: audience === 'attendees' ? eventId : null, subject, message, sendAtMs }),
      })
      if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? 'Failed') }
      onCreated()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to schedule') }
    finally { setBusy(false) }
  }

  const input = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground'

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[15px] font-bold text-foreground"><CalendarClock className="size-4 text-primary" /> New custom reminder</h2>
        <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-[12px] font-medium text-foreground">Audience
          <select value={audience} onChange={e => setAudience(e.target.value as 'attendees' | 'organizer')} className={cn(input, 'mt-1')}>
            <option value="attendees">Attendees of an event</option>
            <option value="organizer">Just me (organizer)</option>
          </select>
        </label>
        {audience === 'attendees' && (
          <label className="text-[12px] font-medium text-foreground">Event
            <select value={eventId} onChange={e => setEventId(e.target.value)} className={cn(input, 'mt-1')}>
              <option value="">Select an event…</option>
              {events.map(ev => <option key={ev.slug} value={ev.slug}>{ev.name}</option>)}
            </select>
          </label>
        )}
        <label className="text-[12px] font-medium text-foreground">Send at
          <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} className={cn(input, 'mt-1')} />
          <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">Leave blank to send at the next cron run.</span>
        </label>
        <label className="text-[12px] font-medium text-foreground">Subject
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Reminder subject" className={cn(input, 'mt-1')} />
        </label>
        <label className="text-[12px] font-medium text-foreground sm:col-span-2">Message
          <textarea value={message} onChange={e => setMessage(e.target.value)} rows={4} placeholder="Your reminder message…" className={cn(input, 'mt-1')} />
        </label>
      </div>

      {/* Preview */}
      {(subject || message) && (
        <div className="mt-3 rounded-lg border border-border bg-muted/20 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Preview</p>
          <p className="mt-1 text-[13px] font-semibold text-foreground">{subject || '(no subject)'}</p>
          <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-muted-foreground">{message || '(no message)'}</p>
        </div>
      )}

      {err && <p className="mt-2 text-[12px] text-destructive">{err}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-foreground hover:bg-muted">Cancel</button>
        <button onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm disabled:opacity-50" style={{ backgroundImage: 'var(--primary-gradient)' }}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <CalendarClock className="size-4" />} Schedule reminder
        </button>
      </div>
    </div>
  )
}
