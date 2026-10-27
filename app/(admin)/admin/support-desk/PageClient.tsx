'use client'

// RD-SUPPORT-01 · Super Admin Support Desk.
//
// Every read and write goes through /api/admin/support/tickets, which requires a Super Admin
// (ADMIN_UIDS). Replies are organizer-visible; internal notes are not, and never reach a
// notification or email. A save's organizer notice is QUEUED with the change — this page never
// claims an email was delivered (that outcome lives on the notification outbox record).

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Headset, Loader2, X, StickyNote, History, Send, Lock, CheckCircle2, AlertTriangle } from 'lucide-react'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { AdminToolbar, FilterTabs, StatusPill, ErrorBanner, SearchInput, TableFrame, THead, Th, TBody, Tr, Td, type PillTone } from '@/components/admin'
import {
  TICKET_STATUSES, TICKET_STATUS_LABEL, TICKET_PRIORITIES, TICKET_PRIORITY_LABEL, TICKET_CATEGORIES, TICKET_CATEGORY_LABEL, LIMITS,
  type TicketStatus, type TicketPriority, type TicketCategory, type AttachmentView,
} from '@/lib/support/types'

type Filter = 'all' | TicketStatus
const TONE: Record<TicketStatus, PillTone> = { open: 'info', in_progress: 'accent', waiting_for_organizer: 'warning', resolved: 'success', closed: 'neutral' }
const PRIORITY_TONE: Record<TicketPriority, PillTone> = { low: 'neutral', normal: 'info', high: 'warning', critical: 'danger' }

interface Row {
  id: string; number: string; subject: string; category: TicketCategory; priority: TicketPriority; status: TicketStatus
  organizationName: string | null; workspaceUid: string; assigneeUid: string | null
  createdAt: string | null; lastActivityAt: string | null; lastOrganizerActivityAt: string | null; lastSupportActivityAt: string | null
  messageCount: number
}
interface Detail extends Row {
  eventId: string | null; eventName: string | null; createdBy: string | null; createdByName: string | null
  messages: { id: string; from: 'organizer' | 'support'; authorUid: string | null; authorName: string | null; body: string; at: string | null; attachments: AttachmentView[] }[]
  history: { id: string; type: string; from: string | null; to: string | null; actorUid: string | null; actorRole: string | null; reason: string | null; at: string | null }[]
  notes: { id: string; text: string; authorUid: string | null; at: string | null }[]
}
interface Admin { uid: string; label: string }

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const field = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground'

async function api(path: string, init?: RequestInit): Promise<Response> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return fetch(path, { ...init, cache: 'no-store', headers: { ...(init?.headers ?? {}), authorization: `Bearer ${await u.getIdToken()}`, 'content-type': 'application/json' } })
}

export default function SupportDeskPage() {
  const params = useSearchParams()
  const [filter, setFilter] = useState<Filter>('all')
  const [priority, setPriority] = useState('')
  const [category, setCategory] = useState('')
  const [assignee, setAssignee] = useState('')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [counts, setCounts] = useState<Partial<Record<TicketStatus, number>>>({})
  const [admins, setAdmins] = useState<Admin[]>([])
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(params.get('id'))

  const load = useCallback(async () => {
    setRows(null)
    const sp = new URLSearchParams()
    if (filter !== 'all') sp.set('status', filter)
    if (priority) sp.set('priority', priority)
    if (category) sp.set('category', category)
    if (assignee) sp.set('assignee', assignee)
    if (q.trim()) sp.set('q', q.trim())
    try {
      const res = await api(`/api/admin/support/tickets?${sp.toString()}`)
      const json = await res.json() as { rows?: Row[]; counts?: Record<TicketStatus, number>; admins?: Admin[]; error?: string }
      if (!res.ok) throw new Error(res.status === 403 ? 'The Support Desk is available to Super Admins only.' : (json.error ?? 'Failed to load'))
      setRows(json.rows ?? []); setCounts(json.counts ?? {}); setAdmins(json.admins ?? []); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load'); setRows([]) }
  }, [filter, priority, category, assignee, q])

  useEffect(() => {
    const unsub = auth.onAuthStateChanged(u => { if (u) void load() })
    return unsub
  }, [load])

  // Search applies after typing pauses, not on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 350)
    return () => clearTimeout(t)
  }, [qInput])

  const adminLabel = (uid: string | null) => (uid ? admins.find(a => a.uid === uid)?.label ?? uid : '—')
  const filters = [{ value: 'all' as Filter, label: 'All' }, ...TICKET_STATUSES.map(s => ({ value: s as Filter, label: `${TICKET_STATUS_LABEL[s]}${(counts[s] ?? 0) > 0 ? ` (${counts[s]})` : ''}` }))]

  return (
    <div className="space-y-5">
      <AdminToolbar icon={Headset} title="Support Desk" description="Organizer support tickets — reply, assign, prioritise and resolve." />
      <FilterTabs options={filters} value={filter} onChange={setFilter} aria-label="Filter by status" scrollable />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <SearchInput value={qInput} onChange={setQInput} placeholder="Ticket number, subject or organizer" aria-label="Search tickets" />
        <select className={field} value={priority} onChange={e => setPriority(e.target.value)} aria-label="Priority">
          <option value="">Any priority</option>
          {TICKET_PRIORITIES.map(p => <option key={p} value={p}>{TICKET_PRIORITY_LABEL[p]}</option>)}
        </select>
        <select className={field} value={category} onChange={e => setCategory(e.target.value)} aria-label="Category">
          <option value="">Any category</option>
          {TICKET_CATEGORIES.map(c => <option key={c} value={c}>{TICKET_CATEGORY_LABEL[c]}</option>)}
        </select>
        <select className={field} value={assignee} onChange={e => setAssignee(e.target.value)} aria-label="Assignee">
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
          {admins.map(a => <option key={a.uid} value={a.uid}>{a.label}</option>)}
        </select>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {!rows ? (
        <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border px-4 py-10 text-center text-[13px] text-muted-foreground">No tickets match these filters.</div>
      ) : (
        <TableFrame minWidth="min-w-[900px]">
          <THead><Th>Ticket</Th><Th>Organizer</Th><Th>Status</Th><Th>Priority</Th><Th>Assignee</Th><Th>Last activity</Th></THead>
          <TBody>
            {rows.map(r => (
              <Tr key={r.id} className="cursor-pointer" onClick={() => setOpenId(r.id)}>
                <Td>
                  <div className="font-medium text-foreground">{r.subject}</div>
                  <div className="text-[11.5px] text-muted-foreground">{r.number} · {TICKET_CATEGORY_LABEL[r.category]} · {r.messageCount} message{r.messageCount === 1 ? '' : 's'}</div>
                </Td>
                <Td className="text-[12.5px]">{r.organizationName ?? r.workspaceUid}</Td>
                <Td><StatusPill tone={TONE[r.status]}>{TICKET_STATUS_LABEL[r.status]}</StatusPill></Td>
                <Td><StatusPill tone={PRIORITY_TONE[r.priority]}>{TICKET_PRIORITY_LABEL[r.priority]}</StatusPill></Td>
                <Td className="text-[12px]">{r.assigneeUid ? adminLabel(r.assigneeUid) : <span className="text-muted-foreground">Unassigned</span>}</Td>
                <Td className="text-[12px] text-muted-foreground">{fmt(r.lastActivityAt)}</Td>
              </Tr>
            ))}
          </TBody>
        </TableFrame>
      )}
      {openId && <TicketDrawer id={openId} admins={admins} onClose={() => setOpenId(null)} onChanged={() => void load()} />}
    </div>
  )
}

function TicketDrawer({ id, admins, onClose, onChanged }: { id: string; admins: Admin[]; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [reply, setReply] = useState('')
  const [replyStatus, setReplyStatus] = useState<TicketStatus | ''>('waiting_for_organizer')
  const [note, setNote] = useState('')
  const [triage, setTriage] = useState({ status: '' as TicketStatus | '', priority: '' as TicketPriority | '', assigneeUid: '' })
  const { confirm, prompt } = useConfirm()

  const apply = useCallback((t: Detail) => {
    setD(t); setErr(null)
    setTriage({ status: t.status, priority: t.priority, assigneeUid: t.assigneeUid ?? '' })
    setReplyStatus(t.status === 'closed' ? 'open' : 'waiting_for_organizer')
  }, [])
  const fetchDetail = useCallback(async () => {
    const res = await api(`/api/admin/support/tickets/${encodeURIComponent(id)}`)
    const json = await res.json() as { ticket?: Detail; error?: string }
    if (!res.ok || !json.ticket) throw new Error(json.error ?? 'Failed to load')
    return json.ticket
  }, [id])
  const reload = useCallback(async () => {
    try { apply(await fetchDetail()) } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load') }
  }, [fetchDetail, apply])
  useEffect(() => {
    let alive = true
    void (async () => {
      try { const t = await fetchDetail(); if (alive) apply(t) }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
    })()
    return () => { alive = false }
  }, [fetchDetail, apply])

  async function run(path: string, init: RequestInit, after: () => void) {
    setSaving(true); setErr(null)
    try {
      const res = await api(path, init)
      const json = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Could not save')
      after(); await reload(); onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save') } finally { setSaving(false) }
  }
  const base = `/api/admin/support/tickets/${encodeURIComponent(id)}`
  const sendReply = () => d && run(`${base}/replies`, { method: 'POST', body: JSON.stringify({ body: reply, expectedStatus: d.status, ...(replyStatus && replyStatus !== d.status ? { status: replyStatus } : {}) }) }, () => setReply(''))
  const saveTriage = async () => {
    if (!d) return
    const moving = triage.status && triage.status !== d.status ? triage.status : null
    // Closed is final unless reopened ON PURPOSE: the server requires a reason, kept in the history.
    let reason: string | undefined
    if (moving && d.status === 'closed') {
      reason = (await prompt({ title: 'Reopen a closed ticket', message: 'Why is this ticket being reopened? (kept in its history)', required: true }))?.trim()
      if (!reason) return
    }
    if (moving === 'closed' && !(await confirm({ title: `Close ${d.number}?`, message: 'The organizer can no longer reply or reopen it. They are notified.', confirmLabel: 'Close ticket', tone: 'danger' }))) return
    await run(base, { method: 'PATCH', body: JSON.stringify({
      expectedStatus: d.status,
      ...(moving ? { status: moving } : {}),
      ...(reason ? { reason } : {}),
      ...(triage.priority && triage.priority !== d.priority ? { priority: triage.priority } : {}),
      ...((triage.assigneeUid || null) !== (d.assigneeUid ?? null) ? { assigneeUid: triage.assigneeUid || null } : {}),
    }) }, () => undefined)
  }
  // The explicit Close Ticket action — a status transition, never inferred from reply text.
  const closeTicket = async () => {
    if (!d || d.status === 'closed') return
    if (!(await confirm({ title: `Close ${d.number}?`, message: d.status === 'resolved' ? 'The organizer has not confirmed yet. Closing makes the ticket final: they can no longer reply or reopen it. They are notified.' : 'Closing makes the ticket final: the organizer can no longer reply or reopen it. They are notified.', confirmLabel: 'Close ticket', tone: 'danger' }))) return
    await run(base, { method: 'PATCH', body: JSON.stringify({ expectedStatus: d.status, status: 'closed' }) }, () => undefined)
  }
  // A reply that SAYS it is fixed while the status stays open is the confusion this desk must avoid.
  const saysResolved = /\b(resolved|fixed|sorted|solved|closing this)\b/i.test(reply) && !/\b(not|un)\s*(resolved|fixed|solved)\b/i.test(reply) && (replyStatus || d?.status) !== 'resolved' && (replyStatus || d?.status) !== 'closed'
  const addNote = () => run(`${base}/notes`, { method: 'POST', body: JSON.stringify({ text: note }) }, () => setNote(''))
  const who = (uid: string | null, role: string | null) => role === 'organizer' ? 'organizer' : (admins.find(a => a.uid === uid)?.label ?? uid ?? 'admin')

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-foreground/30" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Support ticket" className="h-full w-full max-w-2xl overflow-y-auto bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11.5px] font-semibold text-muted-foreground">{d?.number ?? 'Ticket'}</p>
            <h2 className="break-words text-[16px] font-bold text-foreground">{d?.subject ?? ''}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
        </div>
        {err && <ErrorBanner>{err}</ErrorBanner>}
        {!d ? <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div> : (
          <div className="space-y-4 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={TONE[d.status]}>{TICKET_STATUS_LABEL[d.status]}</StatusPill>
              <StatusPill tone={PRIORITY_TONE[d.priority]}>{TICKET_PRIORITY_LABEL[d.priority]}</StatusPill>
              <span className="text-muted-foreground">
                {d.organizationName ?? d.workspaceUid} · {d.createdByName ?? 'Organizer'} · {TICKET_CATEGORY_LABEL[d.category]}{d.eventName ? ` · ${d.eventName}` : ''} · {fmt(d.createdAt)}
              </span>
              <a href={`/admin/organizers/${encodeURIComponent(d.workspaceUid)}`} className="text-primary hover:underline">Organizer 360</a>
              {d.status !== 'closed' && (
                <button type="button" disabled={saving} onClick={() => void closeTicket()} className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] font-semibold text-foreground hover:bg-muted disabled:opacity-50">
                  <CheckCircle2 className="size-3.5" /> Close ticket
                </button>
              )}
            </div>

            <section className="space-y-2" aria-label="Conversation">
              {d.messages.map(m => (
                <div key={m.id} className={cn('rounded-lg border p-3', m.from === 'support' ? 'border-primary/25 bg-primary/[0.04]' : 'border-border')}>
                  <p className="text-[11.5px]"><span className="font-semibold">{m.from === 'support' ? `Support · ${who(m.authorUid, 'super_admin')}` : (m.authorName ?? 'Organizer')}</span> <span className="text-muted-foreground">· {fmt(m.at)}</span></p>
                  <p className="mt-1 whitespace-pre-wrap break-words">{m.body}</p>
                  {m.attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {m.attachments.map(a => <AdminScreenshot key={a.id} src={`${`/api/admin/support/tickets/${encodeURIComponent(d.id)}`}/attachments/${encodeURIComponent(a.id)}`} file={a} />)}
                    </div>
                  )}
                </div>
              ))}
            </section>

            <section className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reply to the organizer <span className="normal-case">(they will see this)</span></p>
              {d.status === 'closed' && <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><Lock className="size-3.5" /> Closed — the reply reopens it with the status chosen below.</p>}
              <textarea className={cn(field, 'h-24')} maxLength={LIMITS.reply.max} value={reply} onChange={e => setReply(e.target.value)} placeholder="Write a reply…" aria-label="Reply" />
              {saysResolved && (
                <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-900 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Your reply says it’s resolved, but the ticket won’t be. Set “Status after reply” to Resolved so the organizer can confirm and close it.
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2">Status after reply
                  <select className={cn(field, 'w-auto')} value={replyStatus} onChange={e => setReplyStatus(e.target.value as TicketStatus | '')}>
                    {d.status !== 'closed' && <option value="">Keep “{TICKET_STATUS_LABEL[d.status]}”</option>}
                    {TICKET_STATUSES.filter(s => s !== d.status && !(d.status === 'closed' && s === 'closed')).map(s => <option key={s} value={s}>{TICKET_STATUS_LABEL[s]}</option>)}
                  </select>
                </label>
                <button type="button" disabled={saving || reply.trim().length < LIMITS.reply.min} onClick={() => void sendReply()} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50">
                  <Send className="size-3.5" /> {saving ? 'Sending…' : 'Send reply'}
                </button>
              </div>
            </section>

            <section className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Triage</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="block">Status
                  <select className={field} value={triage.status} onChange={e => setTriage(t => ({ ...t, status: e.target.value as TicketStatus }))}>
                    {TICKET_STATUSES.map(s => <option key={s} value={s}>{TICKET_STATUS_LABEL[s]}</option>)}
                  </select>
                </label>
                <label className="block">Priority
                  <select className={field} value={triage.priority} onChange={e => setTriage(t => ({ ...t, priority: e.target.value as TicketPriority }))}>
                    {TICKET_PRIORITIES.map(p => <option key={p} value={p}>{TICKET_PRIORITY_LABEL[p]}</option>)}
                  </select>
                </label>
                <label className="block">Assignee
                  <select className={field} value={triage.assigneeUid} onChange={e => setTriage(t => ({ ...t, assigneeUid: e.target.value }))}>
                    <option value="">Unassigned</option>
                    {admins.map(a => <option key={a.uid} value={a.uid}>{a.label}</option>)}
                  </select>
                </label>
              </div>
              <div className="flex justify-end">
                <button type="button" disabled={saving} onClick={() => void saveTriage()} className="rounded-md border border-border px-3 py-1.5 text-[12.5px] font-semibold disabled:opacity-50">{saving ? 'Saving…' : 'Save triage'}</button>
              </div>
            </section>

            <section className="space-y-2 rounded-lg border border-dashed border-amber-500/40 bg-amber-500/[0.03] p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><StickyNote className="size-3.5" /> Internal notes <span className="normal-case">(never shown to organizers or emailed)</span></p>
              <div className="flex gap-2">
                <input className={field} value={note} maxLength={LIMITS.note.max} onChange={e => setNote(e.target.value)} placeholder="Add a note for the team" aria-label="Internal note" />
                <button type="button" disabled={saving || note.trim().length < LIMITS.note.min} onClick={() => void addNote()} className="shrink-0 rounded-md border border-border px-3 text-[12.5px] font-semibold disabled:opacity-50">Add</button>
              </div>
              {d.notes.map(n => <p key={n.id} className="whitespace-pre-wrap rounded bg-muted/40 px-2 py-1.5">{n.text}<span className="block text-[11px] text-muted-foreground">{who(n.authorUid, 'super_admin')} · {fmt(n.at)}</span></p>)}
            </section>

            <section className="space-y-1.5 rounded-lg border border-border p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><History className="size-3.5" /> History</p>
              {d.history.map(h => (
                <p key={h.id}>
                  <strong>{h.type === 'created' ? 'Opened' : h.type === 'reply' ? 'Reply' : h.type === 'reopened' ? 'Reopened' : h.type === 'priority' ? 'Priority' : h.type === 'assignee' ? 'Assignee' : 'Status'}</strong>
                  {h.type === 'status' || h.type === 'reopened' ? ` ${h.from ? TICKET_STATUS_LABEL[h.from as TicketStatus] ?? h.from : ''} → ${TICKET_STATUS_LABEL[h.to as TicketStatus] ?? h.to}` : ''}
                  {h.type === 'priority' ? ` ${TICKET_PRIORITY_LABEL[h.from as TicketPriority] ?? h.from} → ${TICKET_PRIORITY_LABEL[h.to as TicketPriority] ?? h.to}` : ''}
                  {h.type === 'assignee' ? ` → ${h.to ? who(h.to, 'super_admin') : 'unassigned'}` : ''}
                  {h.reason && <span className="text-muted-foreground"> — “{h.reason}”</span>}
                  <span className="text-muted-foreground"> · {who(h.actorUid, h.actorRole)} · {fmt(h.at)}</span>
                </p>
              ))}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

function AdminScreenshot({ src, file }: { src: string; file: AttachmentView }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let made: string | null = null
    void (async () => {
      try {
        const res = await api(src)
        if (!res.ok) throw new Error()
        made = URL.createObjectURL(await res.blob())
        if (alive) setUrl(made); else URL.revokeObjectURL(made)
      } catch { if (alive) setFailed(true) }
    })()
    return () => { alive = false; if (made) URL.revokeObjectURL(made) }
  }, [src])
  return (
    <a href={url ?? undefined} target="_blank" rel="noreferrer" title={file.name} className="flex size-24 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40 text-[11px] text-muted-foreground">
      {/* eslint-disable-next-line @next/next/no-img-element -- a private blob: URL, not an optimizable asset */}
      {url ? <img src={url} alt={file.name} className="size-full object-cover" /> : failed ? 'Unavailable' : <Loader2 className="size-4 animate-spin" />}
    </a>
  )
}
