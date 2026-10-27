'use client'

// RD-FEATURE-REQ-01 · Organizer Feature Requests — submit an idea, follow its status.
//
// Everything shown comes from the organizer API, which returns the organizer whitelist view only
// (lib/featureRequests/types toOrganizerView): no internal notes, rollout targets or admin ids.
// The form validates with the SAME function the server enforces (validateSubmission), so a
// message shown here is the message the server would give.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Lightbulb, Loader2, ChevronDown, CheckCircle2, MessageSquareText, Rocket, Link2 } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Dialog } from '@/components/ui/Dialog'
import { useToast } from '@/components/ui/Toast'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import {
  validateSubmission, STATUS_LABEL, ORGANIZER_PRIORITIES, ORGANIZER_PRIORITY_LABEL, REQUEST_EVENT_TYPES,
  requestEventTypeLabel, LIMITS, FEATURE_REQUEST_STATUSES,
  type OrganizerFeatureRequestView, type FeatureRequestStatus,
} from '@/lib/featureRequests/types'

const STATUS_TONE: Record<FeatureRequestStatus, string> = {
  submitted:      'bg-muted text-foreground',
  under_review:   'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  planned:        'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  in_development: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
  released:       'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  declined:       'bg-rose-500/10 text-rose-700 dark:text-rose-300',
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
const inputCls = 'w-full rounded-control border border-border bg-background px-3 py-2 text-fs-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/50 focus:ring-2 focus:ring-primary/20'
const labelCls = 'mb-1 block text-fs-xs font-semibold text-foreground'

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const u = auth.currentUser
  if (!u) throw new Error('Not signed in')
  const token = await u.getIdToken()
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
}

export default function FeatureRequestsClient() {
  const router = useRouter()
  const params = useSearchParams()
  const { showToast } = useToast()
  const { events } = useEventContext()
  const [requests, setRequests] = useState<OrganizerFeatureRequestView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(params.get('id'))
  const [details, setDetails] = useState<Record<string, OrganizerFeatureRequestView>>({})
  const [formOpen, setFormOpen] = useState(params.get('new') === '1')

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/api/organizer/feature-requests')
      const json = await res.json() as { requests?: OrganizerFeatureRequestView[]; error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Could not load your requests.')
      setRequests(json.requests ?? []); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load your requests.') }
  }, [])

  useEffect(() => {
    const unsub = auth.onAuthStateChanged(u => { if (u) void load() })
    return unsub
  }, [load])

  // Details (with status history) are fetched when a card opens — from the event, not an effect.
  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await authedFetch(`/api/organizer/feature-requests/${encodeURIComponent(id)}`)
      const json = await res.json() as { request?: OrganizerFeatureRequestView }
      if (res.ok && json.request) setDetails(d => ({ ...d, [id]: json.request! }))
    } catch { /* the card still shows the summary */ }
  }, [])
  const toggle = (id: string) => {
    const next = open === id ? null : id
    setOpen(next)
    if (next && !details[next]) void loadDetail(next)
  }

  // A deep link (?id=…, e.g. from a notification) opens that card once the user is known.
  const deepLinked = params.get('id')
  useEffect(() => {
    if (!deepLinked) return
    const unsub = auth.onAuthStateChanged(u => { if (u) void loadDetail(deepLinked) })
    return unsub
  }, [deepLinked, loadDetail])

  const counts = useMemo(() => {
    const c = Object.fromEntries(FEATURE_REQUEST_STATUSES.map(s => [s, 0])) as Record<FeatureRequestStatus, number>
    for (const r of requests ?? []) c[r.status]++
    return c
  }, [requests])

  const closeForm = () => {
    setFormOpen(false)
    if (params.get('new')) router.replace('/dashboard/feature-requests')
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      {/* Header */}
      <div className="relative overflow-hidden rounded-surface border border-border bg-card p-5 sm:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full opacity-[0.12] blur-2xl" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-fs-xs font-semibold uppercase tracking-wider text-primary">Feature requests</p>
            <h1 className="mt-1 text-xl font-bold tracking-tight text-foreground sm:text-2xl">Help shape RegisterDesk</h1>
            <p className="mt-1 max-w-xl text-fs-sm text-muted-foreground">
              Tell us what would make running your events easier. Every request is read by the RegisterDesk team, and you’ll see its status and our response here.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-control px-4 text-fs-sm font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
            style={{ backgroundImage: 'var(--primary-gradient)' }}
          >
            <Lightbulb className="size-4" aria-hidden /> Request a feature
          </button>
        </div>
      </div>

      {/* My Requests */}
      <section aria-labelledby="my-requests">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="my-requests" className="text-fs-base font-semibold text-foreground">My requests</h2>
          {requests && requests.length > 0 && (
            <p className="text-fs-xs text-muted-foreground">
              {FEATURE_REQUEST_STATUSES.filter(s => counts[s] > 0).map(s => `${counts[s]} ${STATUS_LABEL[s].toLowerCase()}`).join(' · ')}
            </p>
          )}
        </div>

        {error && <p role="alert" className="rounded-control border border-destructive/30 bg-destructive/5 px-3 py-2 text-fs-sm text-destructive">{error}</p>}
        {!requests && !error && <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" /></div>}
        {requests && requests.length === 0 && (
          <div className="rounded-surface border border-dashed border-border px-4 py-10 text-center">
            <Lightbulb className="mx-auto size-6 text-primary" aria-hidden />
            <p className="mt-2 text-fs-sm font-semibold text-foreground">No requests yet</p>
            <p className="mt-1 text-fs-xs text-muted-foreground">Your ideas will appear here with their status.</p>
          </div>
        )}

        <ul className="space-y-2">
          {(requests ?? []).map(r => {
            const isOpen = open === r.id
            const d = details[r.id]
            return (
              <li key={r.id} className={cn('rounded-surface border bg-card transition-colors', isOpen ? 'border-primary/40' : 'border-border')}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggle(r.id)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-fs-sm font-semibold text-foreground">{r.title}</p>
                    <p className="mt-0.5 text-fs-xs text-muted-foreground">
                      {requestEventTypeLabel(r.eventType)}{r.eventName ? ` · ${r.eventName}` : ''} · Sent {fmt(r.createdAt)}
                    </p>
                  </div>
                  <span className={cn('shrink-0 rounded-pill px-2.5 py-0.5 text-fs-xs font-semibold', STATUS_TONE[r.status])}>{STATUS_LABEL[r.status]}</span>
                  <ChevronDown className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} aria-hidden />
                </button>
                {isOpen && (
                  <div className="space-y-3 border-t border-border px-4 py-3 text-fs-sm">
                    {r.organizerResponse && (
                      <div className="flex gap-2 rounded-control bg-primary/[0.05] p-3">
                        <MessageSquareText className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                        <div className="min-w-0"><p className="text-fs-xs font-semibold text-foreground">Response from RegisterDesk</p><p className="mt-0.5 whitespace-pre-wrap break-words text-foreground">{r.organizerResponse}</p></div>
                      </div>
                    )}
                    {r.status === 'released' && r.releaseNote && (
                      <div className="flex gap-2 rounded-control bg-emerald-500/[0.07] p-3">
                        <Rocket className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                        <div className="min-w-0"><p className="text-fs-xs font-semibold text-foreground">Release update</p><p className="mt-0.5 whitespace-pre-wrap break-words text-foreground">{r.releaseNote}</p></div>
                      </div>
                    )}
                    {r.linkedToExisting && (
                      <p className="flex items-center gap-1.5 text-fs-xs text-muted-foreground"><Link2 className="size-3.5" aria-hidden /> We’re tracking this together with a similar request, so updates on either reach you.</p>
                    )}
                    <div><p className="text-fs-xs font-semibold text-muted-foreground">The need</p><p className="whitespace-pre-wrap break-words text-foreground">{r.problem}</p></div>
                    <div><p className="text-fs-xs font-semibold text-muted-foreground">Proposed behaviour and benefit</p><p className="whitespace-pre-wrap break-words text-foreground">{r.proposal}</p></div>
                    <p className="text-fs-xs text-muted-foreground">Your priority: {ORGANIZER_PRIORITY_LABEL[r.organizerPriority]}</p>
                    {d?.history && d.history.length > 0 && (
                      <ol className="space-y-1.5 border-l border-border pl-4" aria-label="Status history">
                        {d.history.map(h => (
                          <li key={h.id} className="relative text-fs-xs">
                            <span className="absolute -left-[21px] top-1 size-2 rounded-full bg-primary" aria-hidden />
                            <span className="font-semibold text-foreground">{STATUS_LABEL[h.to]}</span>
                            <span className="text-muted-foreground"> · {fmt(h.at)}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <RequestForm
        open={formOpen}
        onClose={closeForm}
        events={events.map(e => ({ id: e.draftId, name: e.name }))}
        onSubmitted={id => {
          closeForm()
          showToast('Thanks — your request was sent to the RegisterDesk team.', 'success', { title: 'Request submitted' })
          setOpen(id)
          void load()
          void loadDetail(id)
        }}
      />
    </div>
  )
}

// ─── Form ──────────────────────────────────────────────────────────────────────

function RequestForm({ open, onClose, events, onSubmitted }: {
  open: boolean; onClose: () => void; events: { id: string; name: string }[]; onSubmitted: (id: string) => void
}) {
  const [v, setV] = useState({ title: '', problem: '', proposal: '', eventId: '', eventType: '', organizerPriority: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV(s => ({ ...s, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const body = { ...v, eventId: v.eventId || null }
    const check = validateSubmission(body)                // the server's own rule
    if (!check.ok) { setErrors(check.errors); return }
    setErrors({}); setSending(true)
    try {
      const res = await authedFetch('/api/organizer/feature-requests', { method: 'POST', body: JSON.stringify(body) })
      const json = await res.json() as { id?: string; error?: string; fields?: Record<string, string> }
      if (!res.ok || !json.id) { setErrors({ ...(json.fields ?? {}), _: json.error ?? 'Could not submit the request.' }); return }
      setV({ title: '', problem: '', proposal: '', eventId: '', eventType: '', organizerPriority: '' })
      onSubmitted(json.id)
    } catch { setErrors({ _: 'Network error — please try again.' }) } finally { setSending(false) }
  }

  const err = (k: string) => errors[k] ? <p id={`fr-${k}-err`} className="mt-1 text-fs-xs font-medium text-destructive">{errors[k]}</p> : null
  const counter = (val: string, max: number) => <span className="text-fs-xs text-muted-foreground">{val.trim().length}/{max}</span>

  return (
    <Dialog open={open} onClose={onClose} title="Request a feature" size="lg">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-fs-xs text-muted-foreground">Please don’t include attendee personal details or passwords — describe the need, not the data.</p>
        <div>
          <div className="flex items-baseline justify-between"><label htmlFor="fr-title" className={labelCls}>Feature title</label>{counter(v.title, LIMITS.title.max)}</div>
          <input id="fr-title" className={inputCls} maxLength={LIMITS.title.max} value={v.title} onChange={set('title')} placeholder="e.g. Bulk-edit pass prices" aria-invalid={!!errors.title} aria-describedby={errors.title ? 'fr-title-err' : undefined} />
          {err('title')}
        </div>
        <div>
          <div className="flex items-baseline justify-between"><label htmlFor="fr-problem" className={labelCls}>What problem or need does this address?</label>{counter(v.problem, LIMITS.problem.max)}</div>
          <textarea id="fr-problem" rows={4} className={cn(inputCls, 'resize-y')} maxLength={LIMITS.problem.max} value={v.problem} onChange={set('problem')} aria-invalid={!!errors.problem} aria-describedby={errors.problem ? 'fr-problem-err' : undefined} />
          {err('problem')}
        </div>
        <div>
          <div className="flex items-baseline justify-between"><label htmlFor="fr-proposal" className={labelCls}>How should it work, and what would it change for you?</label>{counter(v.proposal, LIMITS.proposal.max)}</div>
          <textarea id="fr-proposal" rows={4} className={cn(inputCls, 'resize-y')} maxLength={LIMITS.proposal.max} value={v.proposal} onChange={set('proposal')} aria-invalid={!!errors.proposal} aria-describedby={errors.proposal ? 'fr-proposal-err' : undefined} />
          {err('proposal')}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="fr-event" className={labelCls}>Relevant event <span className="font-normal text-muted-foreground">(optional)</span></label>
            <select id="fr-event" className={inputCls} value={v.eventId} onChange={set('eventId')} aria-describedby={errors.eventId ? 'fr-eventId-err' : undefined}>
              <option value="">None</option>
              {events.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            {err('eventId')}
          </div>
          <div>
            <label htmlFor="fr-type" className={labelCls}>Event type</label>
            <select id="fr-type" className={inputCls} value={v.eventType} onChange={set('eventType')} aria-invalid={!!errors.eventType} aria-describedby={errors.eventType ? 'fr-eventType-err' : undefined}>
              <option value="">Choose…</option>
              {REQUEST_EVENT_TYPES.map(t => <option key={t} value={t}>{requestEventTypeLabel(t)}</option>)}
            </select>
            {err('eventType')}
          </div>
          <div>
            <label htmlFor="fr-priority" className={labelCls}>How important is it to you?</label>
            <select id="fr-priority" className={inputCls} value={v.organizerPriority} onChange={set('organizerPriority')} aria-invalid={!!errors.organizerPriority} aria-describedby={errors.organizerPriority ? 'fr-organizerPriority-err' : undefined}>
              <option value="">Choose…</option>
              {ORGANIZER_PRIORITIES.map(p => <option key={p} value={p}>{ORGANIZER_PRIORITY_LABEL[p]}</option>)}
            </select>
            {err('organizerPriority')}
          </div>
        </div>
        {errors._ && <p role="alert" className="rounded-control bg-destructive/5 px-3 py-2 text-fs-sm text-destructive">{errors._}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="h-10 rounded-control border border-border px-4 text-fs-sm font-semibold text-foreground hover:bg-muted">Cancel</button>
          <button type="submit" disabled={sending} className="inline-flex h-10 items-center gap-2 rounded-control px-4 text-fs-sm font-semibold text-primary-foreground disabled:opacity-60" style={{ backgroundImage: 'var(--primary-gradient)' }}>
            {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CheckCircle2 className="size-4" aria-hidden />}
            {sending ? 'Sending…' : 'Submit request'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
