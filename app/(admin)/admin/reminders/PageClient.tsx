'use client'

// Admin Reminder console (RD-REM-01) — global reminder settings (enable, per-kind,
// retry), platform-wide analytics, and reminder history with cancel. Reuses the
// shared admin primitives.

import { useCallback, useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Loader2, Bell } from 'lucide-react'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import {
  AdminToolbar, StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow,
  FilterTabs, LoadMoreButton, ErrorBanner,
} from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { REMINDER_KIND_LABELS, type ReminderRow, type ReminderAnalytics } from '@/lib/reminders/types'

interface Settings {
  enabled: boolean
  kinds: Record<string, boolean>
  offsetHours: Record<string, number>
  retryCount: number
}

const STATUS_TONE: Record<string, PillTone> = {
  scheduled: 'info', sending: 'info', sent: 'success', partial: 'warning',
  failed: 'danger', skipped: 'neutral', cancelled: 'neutral',
}

const STATUS_FILTERS = [
  { value: '', label: 'All' }, { value: 'scheduled', label: 'Scheduled' },
  { value: 'sent', label: 'Sent' }, { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' }, { value: 'cancelled', label: 'Cancelled' },
]

const AUTO_KINDS = ['event_tomorrow', 'event_today', 'event_starting_soon', 'registration_closing', 'early_bird_ending', 'low_wallet'] as const

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}
const fmtDateTime = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export default function AdminRemindersPage() {
  const [items, setItems]         = useState<ReminderRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [analytics, setAnalytics] = useState<ReminderAnalytics | null>(null)
  const [settings, setSettings]   = useState<Settings | null>(null)
  const [loading, setLoading]     = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [savingSettings, setSaving] = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [status, setStatus]       = useState('')
  const { confirm } = useConfirm()

  const load = useCallback(async (opts: { cursor?: string | null } = {}) => {
    const append = !!opts.cursor
    if (append) setLoadingMore(true); else setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const qs = new URLSearchParams({ pageSize: '25' })
      if (status) qs.set('status', status)
      if (opts.cursor) qs.set('cursor', opts.cursor)
      const res = await fetch(`/api/admin/reminders?${qs.toString()}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const data = await res.json() as { items: ReminderRow[]; nextCursor: string | null; analytics: ReminderAnalytics; settings: Settings }
      setItems(prev => append ? [...prev, ...data.items] : data.items)
      setNextCursor(data.nextCursor)
      if (!append) { setAnalytics(data.analytics); setSettings(data.settings) }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reminders')
    } finally {
      if (append) setLoadingMore(false); else setLoading(false)
    }
  }, [status])

  useEffect(() => { const t = setTimeout(() => { void load() }, 250); return () => clearTimeout(t) }, [load])

  async function saveSettings(patch: Partial<Settings>) {
    if (!settings) return
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch('/api/admin/reminders', {
        method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error(`Save failed (${res.status})`)
      const data = await res.json() as { settings: Settings }
      setSettings(data.settings)
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed') }
    finally { setSaving(false) }
  }

  async function cancelReminder(id: string) {
    if (!(await confirm({ title: 'Cancel reminder', message: 'Cancel this scheduled reminder?', tone: 'danger' }))) return
    try {
      const token = await getToken()
      const res = await fetch('/api/admin/reminders', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', id }),
      })
      if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? 'Failed') }
      void load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Cancel failed') }
  }

  return (
    <div className="space-y-5">
      <AdminToolbar title="Reminders" description="Global reminder automation settings, analytics, and history." icon={Bell} />

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* Settings */}
      {settings && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[14px] font-bold text-foreground">Automation settings</p>
            <div className="flex items-center gap-2">
              {savingSettings && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              <Toggle checked={settings.enabled} onChange={v => saveSettings({ enabled: v })} label={settings.enabled ? 'Enabled' : 'Disabled'} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {AUTO_KINDS.map(k => (
              <label key={k} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-[12.5px]">
                <span className="text-foreground">{REMINDER_KIND_LABELS[k]}</span>
                <input type="checkbox" checked={settings.kinds[k] !== false} disabled={!settings.enabled} onChange={e => saveSettings({ kinds: { ...settings.kinds, [k]: e.target.checked } })} className="size-4 accent-primary" />
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 text-[12.5px]">
            <span className="text-muted-foreground">Retry policy (advisory):</span>
            <input type="number" min={0} max={5} value={settings.retryCount} onChange={e => saveSettings({ retryCount: Math.max(0, Number(e.target.value) || 0) })} className="w-16 rounded-lg border border-border bg-background px-2 py-1" />
          </div>
        </div>
      )}

      {/* Analytics */}
      {analytics && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {([['Scheduled', analytics.scheduled], ['Sent', analytics.sent], ['Failed', analytics.failed], ['Skipped', analytics.skipped], ['Cancelled', analytics.cancelled], ['Recipients', analytics.recipients]] as [string, number][]).map(([l, v]) => (
            <div key={l} className="rounded-xl border border-border bg-card p-3">
              <p className="text-[11px] text-muted-foreground">{l}</p>
              <p className="mt-0.5 text-[16px] font-bold text-foreground">{v}</p>
            </div>
          ))}
        </div>
      )}

      <FilterTabs options={STATUS_FILTERS} value={status} onChange={setStatus} aria-label="Filter by reminder status" />

      <TableFrame minWidth="min-w-[860px]">
        <THead>
          <Th>Reminder</Th><Th>Event</Th><Th>Audience</Th><Th>Send at</Th><Th>Status</Th><Th align="right">Sent</Th><Th align="right">Actions</Th>
        </THead>
        <TBody>
          {loading ? (
            <TableStateRow colSpan={7}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
          ) : items.length === 0 ? (
            <TableStateRow colSpan={7}>No reminders found.</TableStateRow>
          ) : items.map(r => (
            <Tr key={r.id}>
              <Td className="font-medium text-foreground">{r.kindLabel}<div className="text-[11px] text-muted-foreground">{r.source}</div></Td>
              <Td className="text-muted-foreground">{r.eventName}</Td>
              <Td className="text-muted-foreground capitalize">{r.audience}</Td>
              <Td className="text-muted-foreground">{fmtDateTime(r.sendAt)}</Td>
              <Td><StatusPill tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</StatusPill></Td>
              <Td align="right" className="tabular-nums">{r.counts.sent}/{r.counts.recipients || '—'}</Td>
              <Td align="right">
                {r.status === 'scheduled'
                  ? <button onClick={() => cancelReminder(r.id)} className="text-[12px] font-semibold text-rose-600 hover:underline">Cancel</button>
                  : <span className="text-[12px] text-muted-foreground/50">—</span>}
              </Td>
            </Tr>
          ))}
        </TBody>
      </TableFrame>

      {nextCursor && !loading && <LoadMoreButton onClick={() => load({ cursor: nextCursor })} loading={loadingMore} />}
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="inline-flex items-center gap-2">
      <span className={cn('relative inline-flex h-5 w-9 items-center rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted')}>
        <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
      </span>
      <span className="text-[12.5px] font-medium text-foreground">{label}</span>
    </button>
  )
}
