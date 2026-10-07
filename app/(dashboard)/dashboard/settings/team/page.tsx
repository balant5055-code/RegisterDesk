'use client'

// /dashboard/settings/team — STAFF MANAGEMENT (RD-TEAM-IMPL-01)
//
// ═══ WHAT THIS PAGE USED TO BE ═══════════════════════════════════════════════
// An email invitation screen: type an address, pick a role, send mail, wait for the
// person to accept. That flow is gone. RegisterDesk issues gate credentials
// directly — the organizer creates the account, hands over a username and password,
// and the operator signs in. Nobody waits for an email, and a gate operator never
// needs a mailbox at all.
//
// ═══ WHAT IT SHOWS THAT THE OLD SCREEN DID NOT ═══════════════════════════════
// Event assignment. The old screen could SET an assignment while inviting and then
// never showed it again, so an organizer had no way to see or change which events
// somebody could work (RD-TEAM-AUDIT-01 F-01). It is a column here, and editable in
// place, because it is the whole of a gate operator's authority.
//
// ═══ THE PASSWORD IS SHOWN EXACTLY ONCE ══════════════════════════════════════
// It exists in this page's memory and nowhere else — not in Firestore, not in an
// audit record, not in a log. A forgotten password is answered by issuing a new one,
// never by reading the old one back.
//
// ═══ LEGACY MEMBERS ══════════════════════════════════════════════════════════
// Rows created by the old invitation flow are still live authorization grants, so
// they are listed — read-only, clearly labelled, with the ability to retire them.
// They cannot be created any more and are deliberately not presented as staff.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { cn } from '@/lib/utils/cn'
import {
  AlertCircle, Check, Copy, ExternalLink, KeyRound, Loader2, PauseCircle,
  PlayCircle, Search, Trash2, UserPlus, Users, X,
} from 'lucide-react'
import { STAFF_ROLES, type TeamRole, type TeamMemberView } from '@/lib/team/types'
import { isValidUsername, normalizeUsername, formatTempPassword, PASSWORD_MIN, TEMP_PASSWORD_BYTES } from '@/lib/staff/types'
import type { StaffAccountView } from '@/lib/staff/types'

interface EventOption { id: string; name: string; slug: string | null }

const ROLE_LABEL: Record<string, string> = {
  checkin_staff: 'Check-in Staff',
  checkin_lead:  'Check-in Lead',
}
const ROLE_HINT: Record<string, string> = {
  checkin_staff: 'Find and check in attendees.',
  checkin_lead:  'Check in attendees, and register walk-ups on site.',
}
const LEGACY_ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', manager: 'Manager', finance: 'Finance',
  checkin_staff: 'Check-in Staff', checkin_lead: 'Check-in Lead',
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never'

export default function StaffManagementPage() {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const { user, getToken } = useAuth()

  const [staff,   setStaff]   = useState<StaffAccountView[]>([])
  const [legacy,  setLegacy]  = useState<TeamMemberView[]>([])
  const [events,  setEvents]  = useState<EventOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [busyId,  setBusyId]  = useState<string | null>(null)

  const [query,  setQuery]  = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'suspended'>('all')

  const [showCreate, setShowCreate] = useState(false)
  const [name,     setName]     = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role,     setRole]     = useState<TeamRole>('checkin_staff')
  const [eventIds, setEventIds] = useState<string[]>([])
  const [creating, setCreating] = useState(false)

  /** The one-time credential, held in memory only until dismissed. */
  const [issued, setIssued] = useState<{ name: string; username: string; password: string } | null>(null)
  /** Which staff row has its assignment editor open. */
  const [editing, setEditing] = useState<{ staffId: string; eventIds: string[] } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const authedFetch = useCallback(async (url: string, init?: RequestInit) => {
    const token = await getToken()
    if (!token) throw new Error('Your session has expired. Sign in again.')
    return fetch(url, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
  }, [getToken])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      // Three independent reads; a failure in the legacy list or the event picker
      // must not stop the staff roster from rendering.
      const [staffRes, eventsRes, teamRes] = await Promise.all([
        authedFetch('/api/organizer/staff'),
        authedFetch('/api/organizer/events?limit=100&tab=published'),
        authedFetch('/api/organizer/team'),
      ])
      if (!staffRes.ok) {
        const b = await staffRes.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? 'Could not load staff accounts.')
      }
      setStaff(((await staffRes.json()) as { staff: StaffAccountView[] }).staff)

      if (eventsRes.ok) {
        const data = await eventsRes.json() as { events?: Array<{ draftId?: string; name?: string; slug?: string | null }> }
        setEvents((data.events ?? [])
          .filter((e): e is { draftId: string; name: string; slug: string | null } => Boolean(e.draftId))
          .map(e => ({ id: e.draftId, name: e.name || 'Untitled event', slug: e.slug ?? null })))
      }
      if (teamRes.ok) {
        setLegacy(((await teamRes.json()) as { members?: TeamMemberView[] }).members ?? [])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load staff accounts.')
    } finally {
      setLoading(false)
    }
  }, [authedFetch])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (user) void load() }, [user, load])

  const eventName = useCallback(
    (id: string) => events.find(e => e.id === id)?.name ?? id,
    [events],
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return staff.filter(s => {
      if (filter !== 'all' && s.status !== filter) return false
      if (!q) return true
      return s.displayName.toLowerCase().includes(q) || s.username.toLowerCase().includes(q)
    })
  }, [staff, query, filter])

  // ── Create ────────────────────────────────────────────────────────────────

  const create = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const u = normalizeUsername(username)
    if (!name.trim())        { showToast('Enter the staff member’s name.', 'error'); return }
    if (!isValidUsername(u)) { showToast('Username must be 3–32 characters: letters, digits and single . _ - separators.', 'error'); return }
    if (password && password.length < PASSWORD_MIN) {
      showToast(`A password needs at least ${PASSWORD_MIN} characters.`, 'error'); return
    }
    if (eventIds.length === 0) {
      // Refused here as well as on the server, because the reason is worth stating
      // plainly: an unassigned staff account would reach the whole workspace.
      showToast('Assign at least one event.', 'error'); return
    }

    setCreating(true)
    try {
      const res = await authedFetch('/api/organizer/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: name.trim(), username: u, role, eventIds,
          // Omitted entirely when blank, so the server generates one.
          ...(password ? { password } : {}),
        }),
      })
      const body = await res.json().catch(() => null) as
        { staff?: StaffAccountView; temporaryPassword?: string; error?: string } | null
      if (!res.ok || !body?.staff) {
        showToast(body?.error ?? 'Could not create the staff account.', 'error'); return
      }
      setIssued({
        name: body.staff.displayName,
        username: body.staff.username,
        password: body.temporaryPassword!,
      })
      setName(''); setUsername(''); setPassword(''); setEventIds([]); setRole('checkin_staff')
      setShowCreate(false)
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not create the staff account.', 'error')
    } finally {
      setCreating(false)
    }
  }, [name, username, password, role, eventIds, authedFetch, load, showToast])

  // ── Row actions ───────────────────────────────────────────────────────────

  const patch = useCallback(async (staffId: string, body: Record<string, unknown>, okMsg?: string) => {
    setBusyId(staffId)
    try {
      const res = await authedFetch(`/api/organizer/staff/${encodeURIComponent(staffId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => null) as
        { error?: string; temporaryPassword?: string } | null
      if (!res.ok) { showToast(data?.error ?? 'Could not update the account.', 'error'); return null }
      if (okMsg) showToast(okMsg, 'success')
      await load()
      return data
    } finally {
      setBusyId(null)
    }
  }, [authedFetch, load, showToast])

  const resetPassword = useCallback(async (s: StaffAccountView) => {
    const ok = await confirm({
      title: 'Issue a new password?',
      message: `${s.displayName} will be signed out everywhere and must use the new password. The current one stops working immediately.`,
      confirmLabel: 'Issue new password',
    })
    if (!ok) return
    const data = await patch(s.staffId, { action: 'reset_password' })
    if (data?.temporaryPassword) {
      setIssued({ name: s.displayName, username: s.username, password: data.temporaryPassword })
    }
  }, [confirm, patch])

  const remove = useCallback(async (s: StaffAccountView) => {
    const ok = await confirm({
      title: 'Remove staff account?',
      message: `${s.displayName} (${s.username}) will no longer be able to sign in. This cannot be undone.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return
    setBusyId(s.staffId)
    try {
      const res = await authedFetch(`/api/organizer/staff/${encodeURIComponent(s.staffId)}`, { method: 'DELETE' })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        showToast(b?.error ?? 'Could not remove the account.', 'error'); return
      }
      showToast('Staff account removed.', 'success')
      await load()
    } finally {
      setBusyId(null)
    }
  }, [authedFetch, confirm, load, showToast])

  const removeLegacy = useCallback(async (m: TeamMemberView) => {
    const ok = await confirm({
      title: 'Remove team member?',
      message: `${m.email} will lose access to this workspace. This cannot be undone.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return
    setBusyId(m.id)
    try {
      const res = await authedFetch(`/api/organizer/team/${encodeURIComponent(m.id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        showToast(b?.error ?? 'Could not remove the member.', 'error'); return
      }
      showToast('Team member removed.', 'success')
      await load()
    } finally {
      setBusyId(null)
    }
  }, [authedFetch, confirm, load, showToast])

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied(c => (c === key ? null : c)), 1600)
    } catch {
      showToast('Could not copy. Select the text and copy manually.', 'error')
    }
  }, [showToast])

  /** The per-event staff door. Built from the event's own slug, never free text. */
  const loginUrl = useCallback((slug: string) =>
    `${typeof window === 'undefined' ? '' : window.location.origin}/events/${encodeURIComponent(slug)}/staff-login`,
  [])

  // ── Styles (existing tokens only) ─────────────────────────────────────────
  const field = 'w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-fs-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus-visible:ring-2 focus-visible:ring-primary'
  const btnPrimary = 'inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-fs-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary'
  const btnGhost = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-fs-2xs font-semibold text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary'

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Users className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-fs-xl font-bold leading-tight text-foreground">Staff</h1>
            <p className="mt-0.5 text-fs-sm text-muted-foreground">
              Create sign-ins for the people working your gates. No email needed — you hand over the username and password.
            </p>
          </div>
        </div>
        <button type="button" className={btnPrimary} onClick={() => setShowCreate(v => !v)}>
          {showCreate ? <X className="size-4" aria-hidden /> : <UserPlus className="size-4" aria-hidden />}
          {showCreate ? 'Cancel' : 'Create staff'}
        </button>
      </header>

      {/* ── The one-time credential ────────────────────────────────────────── */}
      {issued && (
        <section role="status" className="rounded-2xl border border-success/40 bg-success/5 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-fs-sm font-bold text-foreground">Credentials for {issued.name}</h2>
              <p className="mt-1 text-fs-2xs text-muted-foreground">
                Shown once. Share them directly with the operator — RegisterDesk cannot show this password again.
              </p>
            </div>
            <button type="button" aria-label="Dismiss" onClick={() => setIssued(null)}
              className="rounded-lg p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary">
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <dl className="mt-4 grid gap-2 sm:grid-cols-2">
            {([['Username', issued.username], ['Password', issued.password]] as const).map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5">
                <div className="min-w-0">
                  <dt className="text-fs-2xs uppercase tracking-wider text-muted-foreground">{label}</dt>
                  <dd className="truncate font-mono text-fs-sm font-semibold text-foreground">{value}</dd>
                </div>
                <button type="button" className={btnGhost} onClick={() => void copy(value, label)}>
                  {copied === label ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                  {copied === label ? 'Copied' : 'Copy'}
                </button>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* ── Create ─────────────────────────────────────────────────────────── */}
      {showCreate && (
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-fs-sm font-bold text-foreground">New staff account</h2>
          <form onSubmit={create} className="mt-4 flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-fs-sm font-medium text-foreground">Full name</span>
                <input className={field} value={name} onChange={e => setName(e.target.value)} placeholder="Arun Kumar" required />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-fs-sm font-medium text-foreground">Username</span>
                <input className={cn(field, 'font-mono')} value={username}
                  onChange={e => setUsername(e.target.value)} placeholder="gate.arun" autoComplete="off" required />
                <span className="text-fs-2xs text-muted-foreground">
                  3–32 characters: letters, digits and single . _ - separators. Must be unique.
                </span>
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-fs-sm font-medium text-foreground">Password</span>
                <div className="flex gap-2">
                  <input className={cn(field, 'font-mono')} value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="Leave blank to generate" autoComplete="new-password" />
                  {/* The SAME formatter the server uses, fed by the platform CSPRNG,
                      so a generated password has one shape wherever it came from. */}
                  <button type="button" className={btnGhost}
                    onClick={() => setPassword(formatTempPassword(crypto.getRandomValues(new Uint8Array(TEMP_PASSWORD_BYTES))))}>
                    <KeyRound className="size-3.5" aria-hidden /> Generate
                  </button>
                </div>
                <span className="text-fs-2xs text-muted-foreground">
                  Shown once after creation. The operator is asked to change it at first sign-in.
                </span>
              </label>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-fs-sm font-medium text-foreground">Role</legend>
                <div className="flex flex-col gap-1.5">
                  {STAFF_ROLES.map(r => (
                    <label key={r} className="flex items-start gap-2 rounded-xl border border-border px-3 py-2">
                      <input type="radio" name="role" value={r} checked={role === r}
                        onChange={() => setRole(r)} className="mt-0.5 accent-[var(--primary)]" />
                      <span>
                        <span className="block text-fs-sm font-medium text-foreground">{ROLE_LABEL[r]}</span>
                        <span className="block text-fs-2xs text-muted-foreground">{ROLE_HINT[r]}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            {/* Assignment is mandatory — the server refuses an empty list, and this
                says why rather than only refusing. */}
            <fieldset className="rounded-xl border border-border p-4">
              <legend className="px-1 text-fs-sm font-medium text-foreground">Events this account may work</legend>
              {events.length === 0 ? (
                <p className="text-fs-2xs text-muted-foreground">
                  No published events yet. Publish an event before creating staff — an account must name at least one.
                </p>
              ) : (
                <>
                  <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto">
                    {events.map(ev => (
                      <label key={ev.id} className="flex items-center gap-2 text-fs-sm text-foreground">
                        <input type="checkbox" checked={eventIds.includes(ev.id)}
                          onChange={e => setEventIds(prev => e.target.checked ? [...prev, ev.id] : prev.filter(i => i !== ev.id))}
                          className="size-4 rounded border-border accent-[var(--primary)]" />
                        <span className="truncate">{ev.name}</span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-fs-2xs text-muted-foreground">
                    {eventIds.length === 0
                      ? 'Select at least one — a staff account is never workspace-wide.'
                      : `${eventIds.length} event${eventIds.length === 1 ? '' : 's'}. Every other event is refused.`}
                  </p>
                </>
              )}
            </fieldset>

            <div className="flex justify-end">
              <button type="submit" className={btnPrimary} disabled={creating}>
                {creating ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UserPlus className="size-4" aria-hidden />}
                Create staff
              </button>
            </div>
          </form>
        </section>
      )}

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      {staff.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input value={query} onChange={e => setQuery(e.target.value)} aria-label="Search staff"
              placeholder="Search name or username" className={cn(field, 'pl-9')} />
          </div>
          <div role="tablist" aria-label="Filter by status" className="flex gap-1 rounded-xl border border-border bg-card p-1">
            {(['all', 'active', 'suspended'] as const).map(f => (
              <button key={f} role="tab" aria-selected={filter === f} type="button" onClick={() => setFilter(f)}
                className={cn('rounded-lg px-3 py-1.5 text-fs-2xs font-semibold capitalize transition-colors focus-visible:ring-2 focus-visible:ring-primary',
                  filter === f ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}>
                {f}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-fs-sm text-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden /> {error}
        </p>
      )}

      {/* ── Roster ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-8 text-fs-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading staff…
        </div>
      ) : staff.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <p className="text-fs-sm font-semibold text-foreground">No staff accounts yet</p>
          <p className="mx-auto mt-1 max-w-md text-fs-2xs text-muted-foreground">
            Create one for each person working your gates. They sign in with a username and password — no email, no invitation to accept.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[860px] text-fs-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5">Staff</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Events</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Last login</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map(s => {
                const busy = busyId === s.staffId
                const open = editing?.staffId === s.staffId
                return (
                  <tr key={s.staffId} className="align-top hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <span className="block font-medium text-foreground">{s.displayName}</span>
                      <span className="block font-mono text-fs-2xs text-muted-foreground">{s.username}</span>
                      <span className="block text-fs-2xs text-muted-foreground">Created {fmtDate(s.createdAt)}</span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{ROLE_LABEL[s.role] ?? s.role}</td>
                    <td className="px-4 py-3">
                      {open ? (
                        <div className="flex flex-col gap-2">
                          <div className="flex max-h-36 flex-col gap-1 overflow-y-auto">
                            {events.map(ev => (
                              <label key={ev.id} className="flex items-center gap-2 text-fs-2xs text-foreground">
                                <input type="checkbox" checked={editing.eventIds.includes(ev.id)}
                                  onChange={e => setEditing(cur => cur && ({
                                    ...cur,
                                    eventIds: e.target.checked
                                      ? [...cur.eventIds, ev.id]
                                      : cur.eventIds.filter(i => i !== ev.id),
                                  }))}
                                  className="size-3.5 rounded border-border accent-[var(--primary)]" />
                                <span className="truncate">{ev.name}</span>
                              </label>
                            ))}
                          </div>
                          <div className="flex gap-1.5">
                            <button type="button" className={btnGhost} disabled={busy || editing.eventIds.length === 0}
                              onClick={async () => {
                                const ok = await patch(s.staffId, { eventIds: editing.eventIds }, 'Assignment updated.')
                                if (ok !== null) setEditing(null)
                              }}>
                              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />} Save
                            </button>
                            <button type="button" className={btnGhost} onClick={() => setEditing(null)}>Cancel</button>
                          </div>
                          {editing.eventIds.length === 0 && (
                            <p className="text-fs-2xs text-destructive">At least one event is required.</p>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {s.eventIds.map(id => {
                            const ev = events.find(e => e.id === id)
                            return (
                              <span key={id} className="flex items-center gap-1.5">
                                <span className="truncate text-fs-2xs text-foreground">{eventName(id)}</span>
                                {ev?.slug && (
                                  <button type="button" title="Copy this event's staff sign-in link"
                                    onClick={() => void copy(loginUrl(ev.slug!), `login-${s.staffId}-${id}`)}
                                    className="inline-flex items-center gap-1 text-fs-2xs font-semibold text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary">
                                    {copied === `login-${s.staffId}-${id}`
                                      ? <><Check className="size-3" aria-hidden /> Copied</>
                                      : <><ExternalLink className="size-3" aria-hidden /> Login link</>}
                                  </button>
                                )}
                              </span>
                            )
                          })}
                          <button type="button" className="mt-1 self-start text-fs-2xs font-semibold text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary"
                            onClick={() => setEditing({ staffId: s.staffId, eventIds: [...s.eventIds] })}>
                            Edit events
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('inline-flex rounded-full px-2 py-0.5 text-fs-2xs font-semibold capitalize ring-1',
                        s.status === 'active'
                          ? 'bg-success/10 text-success ring-success/30'
                          : 'bg-warning/10 text-warning ring-warning/30')}>
                        {s.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-fs-2xs text-muted-foreground">{fmtDateTime(s.lastLoginAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button type="button" className={btnGhost} disabled={busy} onClick={() => void resetPassword(s)}>
                          <KeyRound className="size-3.5" aria-hidden /> Reset
                        </button>
                        {s.status === 'active' ? (
                          <button type="button" className={btnGhost} disabled={busy}
                            onClick={() => void patch(s.staffId, { status: 'suspended' }, 'Staff suspended.')}>
                            <PauseCircle className="size-3.5" aria-hidden /> Suspend
                          </button>
                        ) : (
                          <button type="button" className={btnGhost} disabled={busy}
                            onClick={() => void patch(s.staffId, { status: 'active' }, 'Staff reactivated.')}>
                            <PlayCircle className="size-3.5" aria-hidden /> Reactivate
                          </button>
                        )}
                        <button type="button" className={cn(btnGhost, 'text-destructive')} disabled={busy} onClick={() => void remove(s)}>
                          <Trash2 className="size-3.5" aria-hidden /> Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {visible.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-fs-sm text-muted-foreground">
                  No staff match this search.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Legacy members ─────────────────────────────────────────────────── */}
      {legacy.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-fs-sm font-bold text-foreground">Earlier team members</h2>
          <p className="mt-1 text-fs-2xs text-muted-foreground">
            Invited by email before staff accounts existed. They keep the access they were given; new people are added as staff above.
          </p>
          <ul className="mt-4 divide-y divide-border">
            {legacy.map(m => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <span className="block truncate text-fs-sm text-foreground">{m.email}</span>
                  <span className="block text-fs-2xs text-muted-foreground">
                    {LEGACY_ROLE_LABEL[m.role] ?? m.role} · {m.status}
                    {m.eventIds.length > 0 && ` · ${m.eventIds.length} event${m.eventIds.length === 1 ? '' : 's'}`}
                  </span>
                </div>
                <button type="button" className={cn(btnGhost, 'text-destructive')} disabled={busyId === m.id}
                  onClick={() => void removeLegacy(m)}>
                  <Trash2 className="size-3.5" aria-hidden /> Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
