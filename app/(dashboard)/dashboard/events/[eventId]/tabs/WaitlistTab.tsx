'use client'

import { useState, useEffect, useCallback } from 'react'
import { Clock, UserCheck, UserX, Users, ToggleLeft, ToggleRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useConfirm } from '@/components/ui/ConfirmDialog'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WaitlistEntry {
  id:        string
  passId:    string
  passName:  string
  attendee:  { name: string; email: string; phone: string }
  status:    'waiting' | 'invited' | 'removed'
  joinedAt:  string | null
  invitedAt: string | null
  invitedBy: string | null
}

interface WaitlistData {
  entries:   WaitlistEntry[]
  settings:  { waitlistEnabled: boolean; waitlistLimit: number | null }
  analytics: { waitlistCount: number; promotedCount: number }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function StatusBadge({ status }: { status: WaitlistEntry['status'] }) {
  const map = {
    waiting: { label: 'Waiting',  cls: 'bg-amber-100 text-amber-700'   },
    invited: { label: 'Invited',  cls: 'bg-emerald-100 text-emerald-700' },
    removed: { label: 'Removed',  cls: 'bg-muted text-muted-foreground'  },
  }
  const { label, cls } = map[status]
  return (
    <span className={cn('rounded-full px-2.5 py-0.5 text-[11px] font-semibold', cls)}>
      {label}
    </span>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function WaitlistTab({
  eventId,
  token,
}: {
  eventId: string
  token:   string
}) {
  const [data,      setData]      = useState<WaitlistData | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [actionId,  setActionId]  = useState<string | null>(null)
  const [toggling,  setToggling]  = useState(false)
  const [limitEdit, setLimitEdit] = useState<string>('')
  const [limitSaving, setLimitSaving] = useState(false)
  const { confirm } = useConfirm()

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const base    = `/api/organizer/events/${eventId}/waitlist`

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res  = await fetch(base, { headers: { Authorization: `Bearer ${token}` } })
      const json = await res.json() as WaitlistData & { error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Failed to load waitlist')
      setData(json)
      setLimitEdit(json.settings.waitlistLimit != null ? String(json.settings.waitlistLimit) : '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [base, token])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load() }, [load])

  async function patchSettings(patch: { enabled?: boolean; limit?: number | null }) {
    const res  = await fetch(base, { method: 'PATCH', headers, body: JSON.stringify(patch) })
    const json = await res.json() as { success?: boolean; error?: string }
    if (!res.ok) throw new Error(json.error ?? 'Failed to update settings')
    await load()
  }

  async function handleToggle() {
    if (!data) return
    setToggling(true)
    try {
      await patchSettings({ enabled: !data.settings.waitlistEnabled })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update')
    } finally {
      setToggling(false)
    }
  }

  async function handleSaveLimit() {
    setLimitSaving(true)
    try {
      const limit = limitEdit.trim() ? parseInt(limitEdit, 10) : null
      if (limitEdit.trim() && (isNaN(limit!) || limit! < 1)) {
        setError('Limit must be a positive number.'); return
      }
      await patchSettings({ limit })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update limit')
    } finally {
      setLimitSaving(false)
    }
  }

  async function handlePromote(id: string) {
    setActionId(id)
    try {
      const res  = await fetch(`${base}/${id}/promote`, { method: 'POST', headers })
      const json = await res.json() as { success?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Failed to promote')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to promote')
    } finally {
      setActionId(null)
    }
  }

  async function handleRemove(id: string) {
    if (!(await confirm({ message: 'Remove this person from the waitlist?', tone: 'danger' }))) return
    setActionId(id)
    try {
      const res  = await fetch(`${base}/${id}/remove`, { method: 'POST', headers })
      const json = await res.json() as { success?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Failed to remove')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove')
    } finally {
      setActionId(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)}
      </div>
    )
  }

  if (error && !data) {
    return <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-[14px] text-red-700">{error}</div>
  }

  const settings   = data?.settings ?? { waitlistEnabled: false, waitlistLimit: null }
  const analytics  = data?.analytics ?? { waitlistCount: 0, promotedCount: 0 }
  const entries    = data?.entries ?? []
  const visible    = entries.filter(e => e.status !== 'removed')
  const waiting    = entries.filter(e => e.status === 'waiting')

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>
      )}

      {/* Settings */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="mb-3 text-[15px] font-semibold text-foreground">Waitlist Settings</p>

        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[14px] font-medium text-foreground">Enable Waitlist</p>
            <p className="text-[13px] text-muted-foreground">
              When registration is full, attendees can join the waitlist.
            </p>
          </div>
          <button
            type="button"
            onClick={handleToggle}
            disabled={toggling}
            className="shrink-0"
          >
            {toggling
              ? <Loader2 className="size-6 animate-spin text-muted-foreground" />
              : settings.waitlistEnabled
                ? <ToggleRight className="size-8 text-emerald-600" />
                : <ToggleLeft  className="size-8 text-muted-foreground" />
            }
          </button>
        </div>

        {settings.waitlistEnabled && (
          <div className="mt-4 flex items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-[13px] text-muted-foreground">
                Waitlist limit (blank = unlimited)
              </label>
              <input
                type="number"
                min={1}
                value={limitEdit}
                onChange={e => setLimitEdit(e.target.value)}
                placeholder="Unlimited"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <button
              type="button"
              onClick={handleSaveLimit}
              disabled={limitSaving}
              className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground disabled:opacity-60"
            >
              {limitSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {/* Analytics */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Waiting',  value: waiting.length,           icon: Clock      },
          { label: 'Invited',  value: analytics.promotedCount,  icon: UserCheck  },
          { label: 'Total joined', value: analytics.waitlistCount, icon: Users  },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="rounded-xl border border-border bg-card px-4 py-3 text-center">
            <div className="flex items-center justify-center gap-1.5 text-muted-foreground">
              <Icon className="size-4" />
            </div>
            <p className="mt-1 text-[22px] font-bold tabular-nums text-foreground">{value}</p>
            <p className="text-[12px] text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      {/* List */}
      <div>
        <p className="mb-3 text-[15px] font-semibold text-foreground">
          Waitlist Entries
          {visible.length > 0 && (
            <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">
              ({visible.length})
            </span>
          )}
        </p>

        {visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-14 text-center">
            <Clock className="mx-auto mb-3 size-8 text-muted-foreground/40" />
            <p className="text-[14px] font-semibold text-foreground">No waitlist entries</p>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {settings.waitlistEnabled
                ? 'Attendees can join the waitlist when this event is full.'
                : 'Enable the waitlist above to start collecting entries.'}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-border bg-muted/[0.04]">
                  <th className="px-4 py-2.5 font-medium text-muted-foreground">Name</th>
                  <th className="px-4 py-2.5 font-medium text-muted-foreground hidden sm:table-cell">Email</th>
                  <th className="px-4 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Phone</th>
                  <th className="px-4 py-2.5 font-medium text-muted-foreground hidden sm:table-cell">Pass</th>
                  <th className="px-4 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">Joined</th>
                  <th className="px-4 py-2.5 font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-2.5 font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map(entry => (
                  <tr key={entry.id} className={cn('hover:bg-muted/[0.03]', entry.status === 'invited' && 'bg-emerald-50/30')}>
                    <td className="px-4 py-3 font-medium text-foreground">{entry.attendee.name}</td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{entry.attendee.email}</td>
                    <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{entry.attendee.phone}</td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{entry.passName}</td>
                    <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{fmtDate(entry.joinedAt)}</td>
                    <td className="px-4 py-3"><StatusBadge status={entry.status} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {entry.status === 'waiting' && (
                          <button
                            type="button"
                            onClick={() => handlePromote(entry.id)}
                            disabled={actionId === entry.id}
                            className="flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                          >
                            {actionId === entry.id
                              ? <Loader2 className="size-3 animate-spin" />
                              : <UserCheck className="size-3" />}
                            Promote
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemove(entry.id)}
                          disabled={actionId === entry.id}
                          className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-muted-foreground hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                        >
                          <UserX className="size-3" />
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
