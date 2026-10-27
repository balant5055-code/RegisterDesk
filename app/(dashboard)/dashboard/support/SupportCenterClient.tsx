'use client'

// RD-SUPPORT-01 · Support Center — open a ticket, follow the conversation, reply or reopen.
//
// Everything shown comes from /api/organizer/support/tickets, which returns the organizer whitelist
// view only (lib/support/types toOrganizerTicketView): no internal notes, assignee or admin ids.
// Forms validate with the SAME functions the server enforces. Screenshots are fetched through the
// authorized attachment route and shown from a local blob — no file has a public URL.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { LifeBuoy, Loader2, Plus, ArrowLeft, Paperclip, Send, RotateCcw, X, Lock, MessageSquareText, CheckCircle2, Info } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Dialog } from '@/components/ui/Dialog'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import {
  validateTicket, validateReply, TICKET_STATUS_LABEL, TICKET_CATEGORIES, TICKET_CATEGORY_LABEL, TICKET_PRIORITIES,
  TICKET_PRIORITY_LABEL, LIMITS, ATTACHMENT_TYPES, REOPEN_WINDOW_DAYS,
  type OrganizerTicketView, type TicketStatus, type AttachmentView,
} from '@/lib/support/types'

const STATUS_TONE: Record<TicketStatus, string> = {
  open:                  'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  in_progress:           'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
  waiting_for_organizer: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  resolved:              'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  closed:                'bg-muted text-muted-foreground',
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
const inputCls = 'w-full rounded-control border border-border bg-background px-3 py-2 text-fs-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/50 focus:ring-2 focus:ring-primary/20'
const labelCls = 'mb-1 block text-fs-xs font-semibold text-foreground'
const primaryBtn = 'inline-flex h-10 items-center gap-2 rounded-control px-4 text-fs-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2'
const MB = 1024 * 1024

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const u = auth.currentUser
  if (!u) throw new Error('Not signed in')
  const token = await u.getIdToken()
  const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData
  return fetch(path, { ...init, cache: 'no-store', headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, ...(isForm ? {} : { 'Content-Type': 'application/json' }) } })
}

/** JSON when there are no files; multipart (payload + files) when there are. */
function messageBody(payload: unknown, files: File[]): BodyInit {
  if (files.length === 0) return JSON.stringify(payload)
  const fd = new FormData()
  fd.set('payload', JSON.stringify(payload))
  for (const f of files) fd.append('files', f)
  return fd
}

/** The browser-side mirror of the server's screenshot rules (the server re-checks the bytes). */
function fileProblem(files: File[]): string | null {
  if (files.length > LIMITS.filesPerMessage) return `Attach up to ${LIMITS.filesPerMessage} screenshots.`
  if (files.some(f => !(ATTACHMENT_TYPES as readonly string[]).includes(f.type))) return 'Only PNG, JPEG or WebP screenshots can be attached.'
  if (files.reduce((n, f) => n + f.size, 0) > LIMITS.totalUploadBytes) return `Screenshots must be ${LIMITS.totalUploadBytes / MB} MB or less in total.`
  return null
}

export default function SupportCenterClient() {
  const router = useRouter()
  const params = useSearchParams()
  const { showToast } = useToast()
  const { events } = useEventContext()
  const [tickets, setTickets] = useState<OrganizerTicketView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(params.get('id'))
  const [detail, setDetail] = useState<OrganizerTicketView | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(params.get('new') === '1')

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/api/organizer/support/tickets')
      const json = await res.json() as { tickets?: OrganizerTicketView[]; error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Could not load your tickets.')
      setTickets(json.tickets ?? []); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load your tickets.') }
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await authedFetch(`/api/organizer/support/tickets/${encodeURIComponent(id)}`)
      const json = await res.json() as { ticket?: OrganizerTicketView; error?: string }
      if (!res.ok || !json.ticket) throw new Error(json.error ?? 'Could not load the ticket.')
      setDetail(json.ticket); setDetailError(null)
    } catch (e) { setDetailError(e instanceof Error ? e.message : 'Could not load the ticket.') }
  }, [])

  useEffect(() => {
    const unsub = auth.onAuthStateChanged(u => { if (u) void load() })
    return unsub
  }, [load])

  // A deep link (?id=…, e.g. from a notification) opens that ticket once the user is known. Only the
  // id the page was opened with — later selections update the URL and load the ticket themselves.
  const [deepLinked] = useState(() => params.get('id'))
  useEffect(() => {
    if (!deepLinked) return
    const unsub = auth.onAuthStateChanged(u => { if (u) void loadDetail(deepLinked) })
    return unsub
  }, [deepLinked, loadDetail])

  const select = (id: string | null) => {
    setOpenId(id)
    setDetail(null); setDetailError(null)
    router.replace(id ? `/dashboard/support?id=${encodeURIComponent(id)}` : '/dashboard/support', { scroll: false })
    if (id) void loadDetail(id)
  }

  const waiting = useMemo(() => (tickets ?? []).filter(t => t.status === 'waiting_for_organizer').length, [tickets])
  const toConfirm = useMemo(() => (tickets ?? []).filter(t => t.status === 'resolved').length, [tickets])
  const closeForm = () => {
    setFormOpen(false)
    if (params.get('new')) router.replace('/dashboard/support', { scroll: false })
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <div className="relative overflow-hidden rounded-surface border border-border bg-card p-5 sm:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full opacity-[0.12] blur-2xl" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-fs-xs font-semibold uppercase tracking-wider text-primary">Help &amp; Support</p>
            <h1 className="mt-1 text-xl font-bold tracking-tight text-foreground sm:text-2xl">Support Center</h1>
            <p className="mt-1 max-w-xl text-fs-sm text-muted-foreground">
              Tell us what’s wrong and the RegisterDesk team will reply here. You’ll also get an email when we answer.
            </p>
          </div>
          <button type="button" onClick={() => setFormOpen(true)} className={cn(primaryBtn, 'shrink-0 shadow-sm')} style={{ backgroundImage: 'var(--primary-gradient)' }}>
            <Plus className="size-4" aria-hidden /> New ticket
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        {/* My tickets — hidden on small screens while a ticket is open */}
        <section aria-labelledby="my-tickets" className={cn('min-w-0', openId && 'hidden lg:block')}>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 id="my-tickets" className="text-fs-base font-semibold text-foreground">My tickets</h2>
            {(waiting > 0 || toConfirm > 0) && (
              <p className="text-fs-xs font-semibold text-amber-700 dark:text-amber-300">
                {[waiting > 0 && `${waiting} need${waiting === 1 ? 's' : ''} your reply`, toConfirm > 0 && `${toConfirm} to confirm`].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          {error && <p role="alert" className="rounded-control border border-destructive/30 bg-destructive/5 px-3 py-2 text-fs-sm text-destructive">{error}</p>}
          {!tickets && !error && <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" /></div>}
          {tickets && tickets.length === 0 && (
            <div className="rounded-surface border border-dashed border-border px-4 py-10 text-center">
              <LifeBuoy className="mx-auto size-6 text-primary" aria-hidden />
              <p className="mt-2 text-fs-sm font-semibold text-foreground">No tickets yet</p>
              <p className="mt-1 text-fs-xs text-muted-foreground">When you open one, it appears here with every reply.</p>
            </div>
          )}
          <ul className="space-y-2">
            {(tickets ?? []).map(t => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => select(t.id)}
                  aria-current={openId === t.id ? 'true' : undefined}
                  className={cn('w-full rounded-surface border bg-card px-4 py-3 text-left transition-colors hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    openId === t.id ? 'border-primary/50' : 'border-border')}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 break-words text-fs-sm font-semibold text-foreground">{t.subject}</p>
                    <span className={cn('shrink-0 rounded-pill px-2 py-0.5 text-fs-xs font-semibold', STATUS_TONE[t.status])}>{TICKET_STATUS_LABEL[t.status]}</span>
                  </div>
                  <p className="mt-1 text-fs-xs text-muted-foreground">{t.number} · {TICKET_CATEGORY_LABEL[t.category]} · {fmt(t.lastActivityAt)}</p>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-fs-xs text-muted-foreground">
            Not signed in to the right account? The public <Link href="/contact" className="font-semibold text-primary hover:underline">contact page</Link> is still available.
          </p>
        </section>

        {/* Ticket */}
        <section aria-label="Ticket" className={cn('min-w-0', !openId && 'hidden lg:block')}>
          {!openId ? (
            <div className="flex h-full min-h-48 items-center justify-center rounded-surface border border-dashed border-border px-4 py-10 text-center text-fs-sm text-muted-foreground">
              Choose a ticket to see the conversation.
            </div>
          ) : (
            <TicketPanel
              ticket={detail && detail.id === openId ? detail : null}
              error={detailError}
              onBack={() => select(null)}
              onChanged={async (msg) => { showToast(msg, 'success'); await Promise.all([loadDetail(openId), load()]) }}
            />
          )}
        </section>
      </div>

      <NewTicketForm
        open={formOpen}
        onClose={closeForm}
        events={events.map(e => ({ id: e.draftId, name: e.name }))}
        onCreated={(id, number) => {
          closeForm()
          showToast(`Ticket ${number} is open. We’ll reply here and by email.`, 'success', { title: 'Ticket sent' })
          void load()
          select(id)
        }}
      />
    </div>
  )
}

// ─── One ticket ────────────────────────────────────────────────────────────────

function TicketPanel({ ticket, error, onBack, onChanged }: {
  ticket: OrganizerTicketView | null; error: string | null; onBack: () => void; onChanged: (msg: string) => Promise<void>
}) {
  if (error) return <p role="alert" className="rounded-control border border-destructive/30 bg-destructive/5 px-3 py-2 text-fs-sm text-destructive">{error}</p>
  if (!ticket) return <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" /></div>
  const t = ticket
  return (
    <div className="rounded-surface border border-border bg-card">
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <button type="button" onClick={onBack} className="mb-2 inline-flex items-center gap-1 text-fs-xs font-semibold text-muted-foreground hover:text-foreground lg:hidden">
          <ArrowLeft className="size-3.5" aria-hidden /> All tickets
        </button>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="min-w-0 break-words text-fs-base font-bold text-foreground">{t.subject}</h2>
          <span className={cn('shrink-0 rounded-pill px-2.5 py-0.5 text-fs-xs font-semibold', STATUS_TONE[t.status])}>{TICKET_STATUS_LABEL[t.status]}</span>
        </div>
        <p className="mt-1 text-fs-xs text-muted-foreground">
          {t.number} · {TICKET_CATEGORY_LABEL[t.category]} · {TICKET_PRIORITY_LABEL[t.priority]} priority{t.eventName ? ` · ${t.eventName}` : ''} · Opened {fmt(t.createdAt)}
        </p>
      </div>

      <ol className="space-y-3 px-4 py-4 sm:px-5" aria-label="Conversation">
        {(t.messages ?? []).map(m => (
          <li key={m.id} className={cn('rounded-control border p-3', m.from === 'support' ? 'border-primary/20 bg-primary/[0.04]' : 'border-border bg-background')}>
            <p className="flex flex-wrap items-baseline gap-x-2 text-fs-xs">
              <span className={cn('font-semibold', m.from === 'support' ? 'text-primary' : 'text-foreground')}>{m.authorName}</span>
              <span className="text-muted-foreground">{fmt(m.at)}</span>
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-fs-sm text-foreground">{m.body}</p>
            {m.attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {m.attachments.map(a => <Screenshot key={a.id} src={`/api/organizer/support/tickets/${encodeURIComponent(t.id)}/attachments/${encodeURIComponent(a.id)}`} file={a} />)}
              </div>
            )}
          </li>
        ))}
      </ol>

      {t.history && t.history.length > 0 && (
        <details className="border-t border-border px-4 py-3 sm:px-5">
          <summary className="cursor-pointer text-fs-xs font-semibold text-muted-foreground">Status history</summary>
          <ol className="mt-2 space-y-1.5 border-l border-border pl-4" aria-label="Status history">
            {t.history.map(h => (
              <li key={h.id} className="relative text-fs-xs">
                <span className="absolute -left-[21px] top-1 size-2 rounded-full bg-primary" aria-hidden />
                <span className="font-semibold text-foreground">{h.type === 'created' ? 'Opened' : h.type === 'reopened' ? `Reopened — ${h.to ? TICKET_STATUS_LABEL[h.to] : ''}` : h.to ? TICKET_STATUS_LABEL[h.to] : ''}</span>
                <span className="text-muted-foreground"> · {fmt(h.at)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      <div className="space-y-3 border-t border-border px-4 py-4 sm:px-5">
        <StatusNote status={t.status} />
        {t.canReply ? (
          <Composer ticketId={t.id} reopen={false} onSent={() => onChanged('Reply sent.')} />
        ) : t.canConfirmClose ? (
          <ResolvedActions ticket={t} onChanged={onChanged} />
        ) : t.status === 'closed' ? (
          <p className="flex items-start gap-2 text-fs-sm text-muted-foreground">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            It can’t be replied to or reopened. If you need more help, open a new ticket and mention {t.number}.
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** What the current status means and what the organizer can do — shown above the actions. */
const STATUS_NOTE: Record<TicketStatus, { text: string; tone: 'info' | 'action' | 'done' }> = {
  open:                  { tone: 'info',   text: 'The RegisterDesk team will pick this up soon. You can add details below at any time.' },
  in_progress:           { tone: 'info',   text: 'The RegisterDesk team is working on this. You can add details below.' },
  waiting_for_organizer: { tone: 'action', text: 'We need a reply from you to continue.' },
  resolved:              { tone: 'action', text: 'Support has marked this resolved. If it’s fixed, confirm and close the ticket. If it isn’t, reopen it and tell us what’s still wrong.' },
  closed:                { tone: 'done',   text: 'This ticket is closed.' },
}

function StatusNote({ status }: { status: TicketStatus }) {
  const n = STATUS_NOTE[status]
  return (
    <p className={cn('flex items-start gap-2 rounded-control px-3 py-2 text-fs-sm',
      n.tone === 'action' ? 'bg-amber-500/10 text-amber-900 dark:text-amber-200' : n.tone === 'done' ? 'bg-muted text-muted-foreground' : 'bg-primary/[0.05] text-foreground')}>
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{n.text}</span>
    </p>
  )
}

/** Resolved: Confirm & Close (after a confirmation), or Reopen with a message while still allowed. */
function ResolvedActions({ ticket: t, onChanged }: { ticket: OrganizerTicketView; onChanged: (msg: string) => Promise<void> }) {
  const { confirm } = useConfirm()
  const [reopening, setReopening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function confirmClose() {
    const ok = await confirm({
      title: 'Confirm & close this ticket?', confirmLabel: 'Confirm & Close',
      message: `Close ${t.number} as fixed. A closed ticket can’t be reopened — for a new problem you’d open a new ticket.`,
    })
    if (!ok) return
    setBusy(true); setErr(null)
    try {
      const res = await authedFetch(`/api/organizer/support/tickets/${encodeURIComponent(t.id)}/close`, { method: 'POST', body: JSON.stringify({ expectedStatus: 'resolved' }) })
      const json = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) { setErr(json.error ?? 'Could not close the ticket.'); return }
      await onChanged('Ticket closed. Thanks for confirming.')
    } catch { setErr('Network error — please try again.') } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void confirmClose()} disabled={busy} className={primaryBtn} style={{ backgroundImage: 'var(--primary-gradient)' }}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CheckCircle2 className="size-4" aria-hidden />} Confirm &amp; Close
        </button>
        {t.canReopen && !reopening && (
          <button type="button" onClick={() => setReopening(true)} disabled={busy}
            className="inline-flex h-10 items-center gap-2 rounded-control border border-border px-4 text-fs-sm font-semibold text-foreground hover:bg-muted disabled:opacity-60">
            <RotateCcw className="size-4" aria-hidden /> Reopen Ticket
          </button>
        )}
      </div>
      {err && <p role="alert" className="text-fs-xs font-medium text-destructive">{err}</p>}
      {!t.canReopen && (
        <p className="text-fs-xs text-muted-foreground">
          It was resolved more than {REOPEN_WINDOW_DAYS} days ago, so it can no longer be reopened — if the problem is back, open a new ticket and mention {t.number}.
        </p>
      )}
      {t.canReopen && reopening && (
        <>
          <p className="text-fs-xs text-muted-foreground">Tell us what’s still wrong{t.reopenUntil ? ` (you can reopen until ${fmt(t.reopenUntil)})` : ''}.</p>
          <Composer ticketId={t.id} reopen onSent={() => onChanged('Ticket reopened.')} />
        </>
      )}
    </div>
  )
}

/** A screenshot, fetched with the caller's token and shown from a local blob URL. */
function Screenshot({ src, file }: { src: string; file: AttachmentView }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let made: string | null = null
    void (async () => {
      try {
        const res = await authedFetch(src)
        if (!res.ok) throw new Error()
        made = URL.createObjectURL(await res.blob())
        if (alive) setUrl(made); else URL.revokeObjectURL(made)
      } catch { if (alive) setFailed(true) }
    })()
    return () => { alive = false; if (made) URL.revokeObjectURL(made) }
  }, [src])
  return (
    <a href={url ?? undefined} target="_blank" rel="noreferrer" title={file.name}
      className="flex size-24 items-center justify-center overflow-hidden rounded-control border border-border bg-muted/40 text-fs-xs text-muted-foreground">
      {/* eslint-disable-next-line @next/next/no-img-element -- a private blob: URL, not an optimizable asset */}
      {url ? <img src={url} alt={file.name} className="size-full object-cover" /> : failed ? 'Unavailable' : <Loader2 className="size-4 animate-spin" aria-label="Loading screenshot" />}
    </a>
  )
}

function FilePicker({ files, setFiles, id }: { files: File[]; setFiles: (f: File[]) => void; id: string }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input ref={ref} id={id} type="file" multiple accept={ATTACHMENT_TYPES.join(',')} className="sr-only"
        onChange={e => { setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, LIMITS.filesPerMessage + 1)); e.target.value = '' }} />
      <button type="button" onClick={() => ref.current?.click()} disabled={files.length >= LIMITS.filesPerMessage}
        className="inline-flex h-9 items-center gap-1.5 rounded-control border border-border px-3 text-fs-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50">
        <Paperclip className="size-3.5" aria-hidden /> Add screenshot
      </button>
      {files.map((f, i) => (
        <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1 rounded-pill bg-muted px-2 py-1 text-fs-xs text-foreground">
          <span className="max-w-[12rem] truncate">{f.name}</span>
          <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
        </span>
      ))}
    </div>
  )
}

function Composer({ ticketId, reopen, onSent }: { ticketId: string; reopen: boolean; onSent: () => Promise<void> }) {
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const v = validateReply({ body, reopen })
    if (!v.ok) { setErr(Object.values(v.errors)[0]); return }
    const fp = fileProblem(files)
    if (fp) { setErr(fp); return }
    setErr(null); setSending(true)
    try {
      const res = await authedFetch(`/api/organizer/support/tickets/${encodeURIComponent(ticketId)}/replies`, { method: 'POST', body: messageBody({ body, reopen }, files) })
      const json = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) { setErr(json.error ?? 'Could not send.'); return }
      setBody(''); setFiles([])
      await onSent()
    } catch { setErr('Network error — please try again.') } finally { setSending(false) }
  }

  return (
    <form onSubmit={send} className="space-y-2" noValidate>
      <label htmlFor={`reply-${ticketId}`} className="sr-only">{reopen ? 'Why are you reopening this ticket?' : 'Your reply'}</label>
      <textarea id={`reply-${ticketId}`} rows={3} maxLength={LIMITS.reply.max} value={body} onChange={e => setBody(e.target.value)}
        placeholder={reopen ? 'What is still not working?' : 'Write a reply…'} className={cn(inputCls, 'resize-y')} aria-invalid={!!err} />
      <FilePicker files={files} setFiles={setFiles} id={`files-${ticketId}`} />
      {err && <p role="alert" className="text-fs-xs font-medium text-destructive">{err}</p>}
      <div className="flex justify-end">
        <button type="submit" disabled={sending} className={primaryBtn} style={{ backgroundImage: 'var(--primary-gradient)' }}>
          {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : reopen ? <RotateCcw className="size-4" aria-hidden /> : <Send className="size-4" aria-hidden />}
          {sending ? 'Sending…' : reopen ? 'Reopen ticket' : 'Send reply'}
        </button>
      </div>
    </form>
  )
}

// ─── New ticket ────────────────────────────────────────────────────────────────

const EMPTY = { subject: '', description: '', category: '', priority: 'normal', eventId: '' }

function NewTicketForm({ open, onClose, events, onCreated }: {
  open: boolean; onClose: () => void; events: { id: string; name: string }[]; onCreated: (id: string, number: string) => void
}) {
  const [v, setV] = useState(EMPTY)
  const [files, setFiles] = useState<File[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  // One Idempotency-Key per submission ATTEMPT: a retry of the same ticket (double click, network
  // error) reuses it, so the server opens one ticket and alerts the Super Admins once.
  const attempt = useRef<{ key: string; sig: string } | null>(null)
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV(s => ({ ...s, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const payload = { ...v, eventId: v.eventId || null }
    const check = validateTicket(payload)                  // the server's own rule
    const fp = fileProblem(files)
    if (!check.ok || fp) { setErrors({ ...(check.ok ? {} : check.errors), ...(fp ? { files: fp } : {}) }); return }
    setErrors({}); setSending(true)
    const sig = JSON.stringify([payload, files.map(f => [f.name, f.size, f.lastModified])])
    if (!attempt.current || attempt.current.sig !== sig) attempt.current = { key: crypto.randomUUID(), sig }
    try {
      const res = await authedFetch('/api/organizer/support/tickets', { method: 'POST', body: messageBody(payload, files), headers: { 'Idempotency-Key': attempt.current.key } })
      const json = await res.json().catch(() => ({})) as { id?: string; number?: string; error?: string; fields?: Record<string, string> }
      if (!res.ok || !json.id) { setErrors({ ...(json.fields ?? {}), _: json.error ?? 'Could not open the ticket.' }); return }
      setV(EMPTY); setFiles([]); attempt.current = null
      onCreated(json.id, json.number ?? '')
    } catch { setErrors({ _: 'Network error — please try again.' }) } finally { setSending(false) }
  }

  const err = (k: string) => errors[k] ? <p id={`st-${k}-err`} className="mt-1 text-fs-xs font-medium text-destructive">{errors[k]}</p> : null
  const counter = (val: string, max: number) => <span className="text-fs-xs text-muted-foreground">{val.trim().length}/{max}</span>

  return (
    <Dialog open={open} onClose={onClose} title="New support ticket" size="lg">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="flex items-start gap-1.5 text-fs-xs text-muted-foreground">
          <MessageSquareText className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Never include card numbers, passwords, OTPs or API keys — we will never ask for them. Payment or order references are fine.
        </p>
        <div>
          <div className="flex items-baseline justify-between"><label htmlFor="st-subject" className={labelCls}>Subject</label>{counter(v.subject, LIMITS.subject.max)}</div>
          <input id="st-subject" className={inputCls} maxLength={LIMITS.subject.max} value={v.subject} onChange={set('subject')} placeholder="e.g. Check-in scanner shows “invalid ticket”"
            aria-invalid={!!errors.subject} aria-describedby={errors.subject ? 'st-subject-err' : undefined} />
          {err('subject')}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="st-category" className={labelCls}>Category</label>
            <select id="st-category" className={inputCls} value={v.category} onChange={set('category')} aria-invalid={!!errors.category} aria-describedby={errors.category ? 'st-category-err' : undefined}>
              <option value="">Choose…</option>
              {TICKET_CATEGORIES.map(c => <option key={c} value={c}>{TICKET_CATEGORY_LABEL[c]}</option>)}
            </select>
            {err('category')}
          </div>
          <div>
            <label htmlFor="st-priority" className={labelCls}>Priority</label>
            <select id="st-priority" className={inputCls} value={v.priority} onChange={set('priority')}>
              {TICKET_PRIORITIES.map(p => <option key={p} value={p}>{TICKET_PRIORITY_LABEL[p]}</option>)}
            </select>
            {err('priority')}
          </div>
          <div>
            <label htmlFor="st-event" className={labelCls}>Event <span className="font-normal text-muted-foreground">(optional)</span></label>
            <select id="st-event" className={inputCls} value={v.eventId} onChange={set('eventId')} aria-describedby={errors.eventId ? 'st-eventId-err' : undefined}>
              <option value="">Not about one event</option>
              {events.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            {err('eventId')}
          </div>
        </div>
        <div>
          <div className="flex items-baseline justify-between"><label htmlFor="st-description" className={labelCls}>What happened?</label>{counter(v.description, LIMITS.description.max)}</div>
          <textarea id="st-description" rows={6} className={cn(inputCls, 'resize-y')} maxLength={LIMITS.description.max} value={v.description} onChange={set('description')}
            placeholder="What were you trying to do, what did you expect, and what happened instead?"
            aria-invalid={!!errors.description} aria-describedby={errors.description ? 'st-description-err' : undefined} />
          {err('description')}
        </div>
        <div>
          <p className={labelCls}>Screenshots <span className="font-normal text-muted-foreground">(optional · up to {LIMITS.filesPerMessage}, PNG/JPEG/WebP, {LIMITS.totalUploadBytes / MB} MB total · only you and RegisterDesk support can see them)</span></p>
          <FilePicker files={files} setFiles={setFiles} id="st-files" />
          {err('files')}
        </div>
        {errors._ && <p role="alert" className="rounded-control bg-destructive/5 px-3 py-2 text-fs-sm text-destructive">{errors._}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="h-10 rounded-control border border-border px-4 text-fs-sm font-semibold text-foreground hover:bg-muted">Cancel</button>
          <button type="submit" disabled={sending} className={primaryBtn} style={{ backgroundImage: 'var(--primary-gradient)' }}>
            {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            {sending ? 'Sending…' : 'Send ticket'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
