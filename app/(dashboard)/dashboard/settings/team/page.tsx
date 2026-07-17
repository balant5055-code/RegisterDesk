'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { cn } from '@/lib/utils/cn'
import {
  Users, UserPlus, Loader2, Trash2, ShieldCheck, PauseCircle, PlayCircle, Mail, AlertCircle,
} from 'lucide-react'
import { ASSIGNABLE_ROLES, ROLE_PERMISSIONS, permissionsForRole, type TeamRole, type TeamMemberView } from '@/lib/team/types'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', manager: 'Manager', checkin_staff: 'Check-in Staff', finance: 'Finance',
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function TeamPage() {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const userRef = useRef<User | null>(null)
  const [members, setMembers] = useState<TeamMemberView[]>([])
  const [invites, setInvites] = useState<TeamMemberView[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [busyId,  setBusyId]  = useState<string | null>(null)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole,  setInviteRole]  = useState<TeamRole>('manager')
  const [inviting,    setInviting]    = useState(false)

  const authedFetch = useCallback(async (path: string, init?: RequestInit) => {
    const user = userRef.current
    if (!user) throw new Error('Not signed in.')
    const token = await user.getIdToken()
    return fetch(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    })
  }, [])

  const reload = useCallback(async () => {
    try {
      const res = await authedFetch('/api/organizer/team')
      if (!res.ok) throw new Error('Could not load your team.')
      const data = await res.json() as { members: TeamMemberView[]; invites: TeamMemberView[] }
      setMembers(data.members); setInvites(data.invites); setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally { setLoading(false) }
  }, [authedFetch])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      userRef.current = user
      if (!user) { setError('You must be signed in.'); setLoading(false); return }
      void reload()
    })
    return unsub
  }, [reload])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    if (!inviteEmail.trim()) return
    setInviting(true)
    try {
      const res = await authedFetch('/api/organizer/team', {
        method: 'POST', body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      })
      const data = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) throw new Error(data?.error ?? 'Could not send the invitation.')
      showToast('Invitation sent.', 'success')
      setInviteEmail('')
      await reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Invite failed', 'error')
    } finally { setInviting(false) }
  }

  async function act(id: string, init: RequestInit, okMsg: string) {
    setBusyId(id)
    try {
      const res = await authedFetch(`/api/organizer/team/${id}`, init)
      const data = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) throw new Error(data?.error ?? 'Action failed.')
      showToast(okMsg, 'success')
      await reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Action failed', 'error')
    } finally { setBusyId(null) }
  }

  const changeRole  = (id: string, role: string) => act(id, { method: 'PATCH', body: JSON.stringify({ action: 'change_role', role }) }, 'Role updated.')
  const suspend     = (id: string) => act(id, { method: 'PATCH', body: JSON.stringify({ action: 'suspend' }) }, 'Member suspended.')
  const reactivate  = (id: string) => act(id, { method: 'PATCH', body: JSON.stringify({ action: 'reactivate' }) }, 'Member reactivated.')
  const remove      = async (id: string) => { if (await confirm({ message: 'Remove this team member? This cannot be undone.', tone: 'danger' })) void act(id, { method: 'DELETE' }, 'Member removed.') }
  const cancelInvite= async (id: string) => { if (await confirm({ message: 'Cancel this invitation?', tone: 'danger' })) void act(id, { method: 'DELETE' }, 'Invitation cancelled.') }

  return (
    <div className="space-y-6 p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/[0.09] text-primary"><Users className="size-5" aria-hidden /></div>
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">Team</h1>
          <p className="text-[13.5px] text-muted-foreground">Invite team members and assign role-based permissions.</p>
        </div>
      </div>

      {/* Invite */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-[15px] font-bold text-foreground"><UserPlus className="size-4 text-primary" aria-hidden /> Invite a member</h2>
        <form onSubmit={handleInvite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Email</span>
            <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} required placeholder="teammate@example.com"
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-[14px] text-foreground outline-none focus:ring-2 focus:ring-primary/30" />
          </label>
          <label className="sm:w-48">
            <span className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Role</span>
            <select value={inviteRole} onChange={e => setInviteRole(e.target.value as TeamRole)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-[14px] text-foreground outline-none focus:ring-2 focus:ring-primary/30">
              {ASSIGNABLE_ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <button type="submit" disabled={inviting}
            className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[14px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
            style={{ backgroundImage: 'var(--primary-gradient)' }}>
            {inviting ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" aria-hidden />} Invite
          </button>
        </form>
        <p className="mt-2 text-[12px] text-muted-foreground">
          {ROLE_LABEL[inviteRole]} can access: {permissionsForRole(inviteRole).join(', ')}.
        </p>
      </section>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-[13.5px] text-destructive">
          <AlertCircle className="size-4" aria-hidden /> {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2.5">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-xl border border-border bg-muted/30" />)}</div>
      ) : (
        <>
          {/* Team Members */}
          <section>
            <h2 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground"><ShieldCheck className="size-4" aria-hidden /> Team Members</h2>
            {members.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-12 text-center text-[13.5px] text-muted-foreground">No team members yet. Invite someone above.</div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-border">
                <table className="w-full min-w-[680px] text-[13.5px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
                      <th className="px-4 py-2.5">Member</th>
                      <th className="px-4 py-2.5">Role</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {members.map(m => (
                      <tr key={m.id} className="hover:bg-muted/20">
                        <td className="px-4 py-3 font-medium text-foreground">{m.email}</td>
                        <td className="px-4 py-3">
                          <select value={m.role} disabled={busyId === m.id} onChange={e => void changeRole(m.id, e.target.value)}
                            className="rounded-md border border-border bg-background px-2 py-1 text-[12.5px] text-foreground outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50">
                            {ASSIGNABLE_ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                          </select>
                        </td>
                        <td className="px-4 py-3">
                          <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1',
                            m.status === 'active' ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-red-50 text-red-700 ring-red-600/20')}>
                            {m.status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            {m.status === 'active' ? (
                              <button onClick={() => void suspend(m.id)} disabled={busyId === m.id} title="Suspend"
                                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] font-medium text-amber-700 hover:bg-muted disabled:opacity-50">
                                <PauseCircle className="size-3.5" aria-hidden /> Suspend
                              </button>
                            ) : (
                              <button onClick={() => void reactivate(m.id)} disabled={busyId === m.id} title="Reactivate"
                                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] font-medium text-emerald-700 hover:bg-muted disabled:opacity-50">
                                <PlayCircle className="size-3.5" aria-hidden /> Reactivate
                              </button>
                            )}
                            <button onClick={() => remove(m.id)} disabled={busyId === m.id} title="Remove"
                              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] font-medium text-red-600 hover:bg-muted disabled:opacity-50">
                              <Trash2 className="size-3.5" aria-hidden /> Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Pending Invites */}
          <section>
            <h2 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground"><Mail className="size-4" aria-hidden /> Pending Invites</h2>
            {invites.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-12 text-center text-[13.5px] text-muted-foreground">No pending invitations.</div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-border">
                <table className="w-full min-w-[560px] text-[13.5px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
                      <th className="px-4 py-2.5">Email</th>
                      <th className="px-4 py-2.5">Role</th>
                      <th className="px-4 py-2.5">Invited</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {invites.map(m => (
                      <tr key={m.id} className="hover:bg-muted/20">
                        <td className="px-4 py-3 font-medium text-foreground">{m.email}</td>
                        <td className="px-4 py-3 text-muted-foreground">{ROLE_LABEL[m.role]}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtDate(m.invitedAt)}</td>
                        <td className="px-4 py-3 text-right">
                          <button onClick={() => cancelInvite(m.id)} disabled={busyId === m.id}
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] font-medium text-red-600 hover:bg-muted disabled:opacity-50">
                            <Trash2 className="size-3.5" aria-hidden /> Cancel
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Permission reference */}
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Role permissions</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(ROLE_PERMISSIONS) as TeamRole[]).map(r => (
                <div key={r} className="rounded-lg border border-border/60 px-3 py-2">
                  <p className="text-[13px] font-semibold text-foreground">{ROLE_LABEL[r]}</p>
                  <p className="text-[12px] text-muted-foreground">{r === 'owner' ? 'Full access' : ROLE_PERMISSIONS[r].join(', ')}</p>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
