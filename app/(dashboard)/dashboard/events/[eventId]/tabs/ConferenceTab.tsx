'use client'

// RD-EVENT-17 · Conference — the event's schedule, and whether it holds together.
//
// ═══ WHAT THIS WORKSPACE ANSWERS ═════════════════════════════════════════════
// What is on, when, and where · which sessions are filling up · how full the rooms are ·
// what is on right now · what was cancelled. It is a workspace inside the Event Command
// Center: the shell header above owns the event's identity, its lifecycle and its
// registration/revenue/capacity figures, and none of them is repeated here.
//
// The numbers on this page are SESSION figures — how many people picked each session —
// not the event's registration totals. They are labelled that way for exactly that reason.
//
// ═══ WHAT THIS REPLACES ══════════════════════════════════════════════════════
//   · Times were formatted in the BROWSER's zone, so an organiser abroad read the agenda
//     against their own clock. Everything now formats in the EVENT's timezone.
//   · "0% no-show" was printed for sessions nobody had registered for — a percentage of
//     nothing rendered as perfect attendance.
//   · Cancelled sessions were filtered out and never shown, so cancelling made a row
//     vanish and the empty state then claimed "No sessions yet" about an event with several.
//   · Cancel and delete fired instantly with no confirmation. Cancelling a session also
//     detaches it from every attendee who picked it — that is not an undoable click.
//   · The error state rendered the raw server payload (`HALL_CONFLICT`, `Operation failed`).
//   · A bare spinner replaced the entire page while loading.
//
// ═══ READS ═══════════════════════════════════════════════════════════════════
// ONE request per view, and one more per mutation. The schedule bundle is small and
// bounded by the hours in a day, so search and filtering happen in memory — there is no
// second page a client-side filter could hide. No polling, no timers, no event refetch:
// the event object comes from the shell.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle, CalendarClock, CalendarDays, Check, ChevronDown, CircleSlash, Clock,
  Download, Layers, Loader2, MapPin, Mic, Plus, RefreshCw, Search, Trash2, Users, X,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent, type AccentTone } from '@/lib/dashboard/accents'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import {
  CONFERENCE_VIEWS, SESSION_STATE_LABEL, UNAVAILABLE, capacityView, conferenceEditable,
  conferenceEmptyMessage, conferenceLockReason, conferenceSummary, filterSessions,
  formatDuration, formatSessionDay, formatSessionRange, groupByDay, groupBySpeaker,
  groupByTrack, hallName, hallUsage, isConferenceView, isStatusFilter, noShowPercent,
  sessionMinutes, sessionState, speakerNames, trackName,
  type ConferenceStatusFilter, type ConferenceView, type SessionState,
} from '@/lib/sessions/conferenceView'
import type { ScheduleBundle, SessionView } from '@/lib/sessions/types'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'

// ─── Status vocabulary ────────────────────────────────────────────────────────

/** Icon, word and tone — three signals, so colour is never the only one. */
const STATE_ICON: Record<SessionState, typeof Clock> = {
  live:      CalendarClock,
  upcoming:  Clock,
  ended:     Check,
  cancelled: CircleSlash,
}

const STATE_TONE: Record<SessionState, AccentTone> = {
  live:      'verify',
  upcoming:  'event',
  ended:     'neutral',
  cancelled: 'critical',
}

function StateBadge({ state }: { state: SessionState }) {
  const Icon = STATE_ICON[state]
  return (
    <span className={cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-1 text-fs-2xs font-semibold',
      accent(STATE_TONE[state]).tile,
    )}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {SESSION_STATE_LABEL[state]}
    </span>
  )
}

/** A hairline meter. `percent === null` means there is no proportion to draw. */
function Meter({ percent, tone, label }: { percent: number | null; tone: AccentTone; label: string }) {
  if (percent === null) {
    return <div className="h-1.5 w-full rounded-pill border border-dashed border-border" aria-hidden />
  }
  const width = Math.min(100, Math.max(percent, percent > 0 ? 2 : 0))
  return (
    <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
         aria-label={label} className="h-1.5 w-full overflow-hidden rounded-pill bg-muted">
      <div className={cn('h-full rounded-pill transition-[width] duration-500', accent(tone).bar)}
           style={{ width: `${width}%` }} />
    </div>
  )
}

const fillTone = (pct: number): AccentTone =>
  pct >= 100 ? 'critical' : pct >= 80 ? 'pending' : 'verify'

function Metric({ icon: Icon, tone, value, label, sub, unavailable }: {
  icon: typeof Users; tone: AccentTone; value: string; label: string
  sub?: string | null; unavailable?: boolean
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-control', accent(tone).tile)} aria-hidden>
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0">
        {/* A WORD is set smaller than a numeral — the rule Passes, Coupons and Waitlist
            follow. A long word at numeral size reads as the most important figure. */}
        <p className={cn(
          'font-semibold leading-none',
          /^[\d,]+$/.test(value) ? 'text-fs-xl tabular-nums' : 'text-fs-md',
          unavailable ? 'text-muted-foreground' : 'text-foreground',
        )}>
          {unavailable
            ? <><span aria-hidden>{value}</span><span className="sr-only">Unavailable</span></>
            : value}
        </p>
        <p className="mt-1.5 truncate text-fs-xs font-medium text-foreground">{label}</p>
        {sub && <p className="truncate text-fs-2xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}

// ─── Shared control classes ───────────────────────────────────────────────────

const FIELD =
  'w-full rounded-control border border-border bg-background px-3 py-2 text-fs-sm text-foreground ' +
  'placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

const GHOST_BTN =
  'inline-flex h-11 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3.5 ' +
  'text-fs-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

const PRIMARY_BTN =
  'inline-flex h-11 items-center justify-center gap-1.5 rounded-control bg-primary/[0.08] px-4 ' +
  'text-fs-sm font-semibold text-[color:var(--primary-text)] transition-colors hover:bg-primary/[0.14] ' +
  'disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

const ICON_BTN =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-muted-foreground ' +
  'transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 xl:size-9'

// ─── Error copy ───────────────────────────────────────────────────────────────

/**
 * The server speaks in codes (`HALL_CONFLICT`, `SESSION_FULL`). The old tab rendered
 * them verbatim. Each one gets a sentence a person can act on; anything unrecognised
 * falls back to fixed copy rather than leaking a payload.
 */
function actionMessage(code: string | null | undefined, detail: string | null | undefined): string {
  switch (code) {
    case 'HALL_CONFLICT':   return detail ? `That room is already booked for “${detail}” at this time.` : 'That room is already booked at this time.'
    case 'SESSION_CONFLICT': return 'That clashes with another session the same people are attending.'
    case 'SESSION_FULL':    return 'That session is already full.'
    case 'INVALID_TIME':    return 'The end time must be after the start time.'
    case 'SESSION_NOT_FOUND': return 'That session no longer exists — refresh to see the current schedule.'
    case 'SESSION_CANCELLED': return 'That session has been cancelled.'
    case 'EVENT_LOCKED':    return detail ?? 'This event is read-only.'
    default:                return 'That change could not be saved. Please try again.'
  }
}

// ─── Workspace ────────────────────────────────────────────────────────────────

type LoadState = 'loading' | 'ready' | 'error'
type Bundle = ScheduleBundle & { editable?: boolean; lockReason?: string | null; published?: boolean }

export default function ConferenceTab({ event, token }: { event: EventDetailResponse; token: string }) {
  const eventId = event.draftId
  const tz = event.timezone
  const { now } = useEventContext()
  const { showToast } = useToast()
  const { confirm, prompt } = useConfirm()
  const router = useRouter()
  const params = useSearchParams()

  // ── URL is the state ──────────────────────────────────────────────────────
  // View and filters live in the address bar, so Back/Forward work, a filtered agenda
  // can be linked to a colleague, and a reload lands where the organiser was.
  const view: ConferenceView = isConferenceView(params.get('cv')) ? params.get('cv') as ConferenceView : 'agenda'
  const status: ConferenceStatusFilter = isStatusFilter(params.get('cs')) ? params.get('cs') as ConferenceStatusFilter : 'scheduled'
  const query = params.get('cq') ?? ''
  const trackId = params.get('ct')
  const hallId = params.get('ch')

  const setParams = useCallback((patch: Record<string, string | null>, mode: 'push' | 'replace' = 'push') => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k); else next.set(k, v)
    }
    const href = `?${next.toString()}`
    if (mode === 'push') router.push(href, { scroll: false }); else router.replace(href, { scroll: false })
  }, [params, router])

  // Typing is debounced into the URL with `replace` so it is not one history entry per
  // keystroke; the resync happens DURING RENDER, React's documented reset-on-change
  // pattern, so Back never paints stale text for a frame.
  const [draft, setDraft] = useState(query)
  const [syncedQuery, setSyncedQuery] = useState(query)
  if (query !== syncedQuery) { setSyncedQuery(query); setDraft(query) }
  useEffect(() => {
    if (draft === query) return
    const t = setTimeout(() => setParams({ cq: draft || null }, 'replace'), 300)
    return () => clearTimeout(t)
  }, [draft, query, setParams])

  const [bundle, setBundle] = useState<Bundle | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [busy, setBusy] = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [showSetup, setShowSetup] = useState(false)

  const base = `/api/organizer/events/${eventId}/sessions`
  const authHeaders = useMemo(
    () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
    [token],
  )

  // ── Load ──────────────────────────────────────────────────────────────────
  // Target-keyed rather than guarded by an effect-instance flag: under StrictMode the
  // first effect's cleanup would otherwise discard a response that had already arrived.
  const [attempt, setAttempt] = useState(0)
  const loadKey = useRef('')

  useEffect(() => {
    if (!token) return
    const key = `${eventId}|${attempt}`
    if (loadKey.current === key) return
    const first = loadKey.current === ''
    loadKey.current = key

    void (async () => {
      if (first) setState('loading')
      setActionErr(null)
      try {
        const res = await fetch(base, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error('load')
        const d = await res.json() as Bundle
        if (loadKey.current !== key) return
        setBundle({
          sessions: d.sessions ?? [], tracks: d.tracks ?? [], halls: d.halls ?? [],
          speakers: d.speakers ?? [], editable: d.editable, lockReason: d.lockReason ?? null,
          published: d.published !== false,
        })
        setState('ready')
      } catch {
        if (loadKey.current !== key) return
        setState('error')
      }
    })()
  }, [base, token, eventId, attempt])

  const reload = useCallback(() => setAttempt(n => n + 1), [])

  // ── Mutations ─────────────────────────────────────────────────────────────
  // Every one re-reads the schedule, because a create can shift day groupings, a cancel
  // detaches attendees, and a delete changes the filter lists. The bundle is small and
  // this is a deliberate, user-initiated action — not a render-triggered refetch.
  const act = useCallback(async (payload: Record<string, unknown>): Promise<boolean> => {
    setBusy(true); setActionErr(null)
    try {
      const res = await fetch(base, { method: 'POST', headers: authHeaders, body: JSON.stringify(payload) })
      if (!res.ok) {
        const d = await res.json().catch(() => null) as { error?: string; detail?: string } | null
        setActionErr(actionMessage(d?.error, d?.detail))
        return false
      }
      setAttempt(n => n + 1)
      return true
    } catch {
      setActionErr('That change could not be saved. Please check your connection.')
      return false
    } finally {
      setBusy(false)
    }
  }, [base, authHeaders])

  const editable = bundle?.editable !== false && conferenceEditable(event.lifecycleStatus)
  const lockReason = bundle?.lockReason ?? conferenceLockReason(event.lifecycleStatus)

  // ── Derived ───────────────────────────────────────────────────────────────
  const filters = useMemo(() => ({ query, trackId, hallId, status }), [query, trackId, hallId, status])
  const summary = useMemo(
    () => bundle ? conferenceSummary(bundle.sessions, tz) : null,
    [bundle, tz],
  )
  const visible = useMemo(
    () => bundle ? filterSessions(bundle.sessions, filters, bundle.speakers) : [],
    [bundle, filters],
  )
  const groups = useMemo(() => {
    if (!bundle) return []
    if (view === 'track')   return groupByTrack(visible, bundle.tracks)
    if (view === 'speaker') return groupBySpeaker(visible, bundle.speakers)
    return groupByDay(visible, tz)
  }, [bundle, visible, view, tz])
  const rooms = useMemo(() => bundle ? hallUsage(bundle.sessions, bundle.halls) : [], [bundle])

  // ── Downloads ─────────────────────────────────────────────────────────────
  const download = useCallback(async (qs: string, name: string) => {
    setActionErr(null)
    try {
      const res = await fetch(`${base}?${qs}&format=csv`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) { setActionErr('That export could not be produced. Please try again.'); return }
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob); a.download = name
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href)
    } catch {
      setActionErr('That export could not be produced. Please check your connection.')
    }
  }, [base, token])

  // ── Row actions ───────────────────────────────────────────────────────────
  const cancelSession = useCallback(async (s: SessionView) => {
    const c = capacityView(s)
    const ok = await confirm({
      title: `Cancel “${s.title}”?`,
      message: c.registered > 0
        ? `${c.registered.toLocaleString('en-IN')} ${c.registered === 1 ? 'person has' : 'people have'} this session in their schedule. Cancelling removes it from all of them. This cannot be undone.`
        : 'The session stays on record as cancelled rather than being deleted. This cannot be undone.',
      confirmLabel: 'Cancel session', tone: 'danger',
    })
    if (!ok) return
    if (await act({ action: 'cancel_session', sessionId: s.sessionId })) {
      showToast(`“${s.title}” was cancelled.`, 'success')
    }
  }, [act, confirm, showToast])

  const removeEntity = useCallback(async (
    kind: 'track' | 'hall' | 'speaker', id: string, label: string, usedBy: number,
  ) => {
    const ok = await confirm({
      title: `Remove ${label}?`,
      message: usedBy > 0
        ? `${usedBy} ${usedBy === 1 ? 'session uses' : 'sessions use'} it. They stay on the schedule but lose this assignment.`
        : 'Nothing on the schedule uses it.',
      confirmLabel: 'Remove', tone: 'danger',
    })
    if (!ok) return
    const action = kind === 'track' ? 'delete_track' : kind === 'hall' ? 'delete_hall' : 'delete_speaker'
    const key = kind === 'track' ? 'trackId' : kind === 'hall' ? 'hallId' : 'speakerId'
    if (await act({ action, [key]: id })) showToast(`${label} was removed.`, 'success')
  }, [act, confirm, showToast])

  const addEntity = useCallback(async (kind: 'track' | 'hall' | 'speaker') => {
    const noun = kind === 'track' ? 'track' : kind === 'hall' ? 'room' : 'speaker'
    const name = (await prompt({
      title: `Add a ${noun}`,
      message: `What is this ${noun} called?`,
      required: true,
    }))?.trim()
    if (!name) return
    const payload = kind === 'speaker'
      ? { action: 'create_speaker', speaker: { name } }
      : { action: kind === 'track' ? 'create_track' : 'create_hall', name }
    if (await act(payload)) showToast(`${name} was added.`, 'success')
  }, [act, prompt, showToast])

  // ── Loading ───────────────────────────────────────────────────────────────
  if (state === 'loading') {
    return (
      <div className="space-y-5" aria-busy="true">
        <div className="h-28 animate-pulse rounded-surface border border-border bg-muted/40" />
        <div className="h-16 animate-pulse rounded-surface border border-border bg-muted/40" />
        <div className="space-y-3">
          {[0, 1, 2].map(i => <div key={i} className="h-24 animate-pulse rounded-surface border border-border bg-muted/40" />)}
        </div>
        <p className="sr-only" role="status">Loading the schedule</p>
      </div>
    )
  }

  // ── Could not be read ─────────────────────────────────────────────────────
  if (state === 'error' || !bundle) {
    return (
      <section aria-labelledby="conf-error" className="min-w-0">
        <div className="rounded-surface border border-border bg-card px-4 py-14 text-center">
          <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('critical').tile)} aria-hidden>
            <AlertTriangle className="size-5" />
          </span>
          <h2 id="conf-error" className="mt-4 text-fs-md font-semibold text-foreground">
            The schedule couldn&apos;t be loaded
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
            This is a problem reading it, not a statement about what is on. Anything already
            scheduled is still scheduled, and attendees still see it.
          </p>
          <button type="button" onClick={reload} className={cn(PRIMARY_BTN, 'mt-5')}>
            <RefreshCw className="size-4" aria-hidden /> Try again
          </button>
        </div>
      </section>
    )
  }

  // ── Not published yet ─────────────────────────────────────────────────────
  if (bundle.published === false) {
    return (
      <section aria-labelledby="conf-draft" className="min-w-0">
        <div className="rounded-surface border border-border bg-card px-4 py-14 text-center">
          <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('event').tile)} aria-hidden>
            <CalendarDays className="size-5" />
          </span>
          <h2 id="conf-draft" className="mt-4 text-fs-md font-semibold text-foreground">
            The schedule opens once this event is published
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
            Sessions are stored against the event&apos;s public address, which it gets when
            you publish. Nothing is lost — there is simply nowhere to attach an agenda yet.
          </p>
        </div>
      </section>
    )
  }

  const s = summary!
  const nothingAtAll = bundle.sessions.length === 0

  return (
    <div className="space-y-5">
      {/* ══ SUMMARY — session figures, never the event's ══════════════════ */}
      {!nothingAtAll && (
        <section aria-labelledby="conf-summary" className="min-w-0">
          <h2 id="conf-summary" className="sr-only">Schedule overview</h2>
          <div className="overflow-hidden rounded-surface border border-border bg-card">
            <div className="grid gap-x-6 gap-y-5 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Metric
                icon={CalendarDays} tone="event"
                value={String(s.scheduled)} label="Sessions scheduled"
                sub={s.days > 0
                  ? `Across ${s.days} ${s.days === 1 ? 'day' : 'days'} · ${formatDuration(s.minutes)}`
                  : 'No dates set'}
              />
              <Metric
                icon={Users} tone="people"
                value={s.registered.toLocaleString('en-IN')} label="Session places taken"
                sub="People who picked a session"
              />
              <Metric
                icon={Check} tone="verify"
                value={s.checkedIn.toLocaleString('en-IN')} label="Checked into a session"
                sub={s.registered === 0 ? 'Nobody has picked a session yet' : `of ${s.registered.toLocaleString('en-IN')} places taken`}
              />
              <Metric
                icon={AlertTriangle} tone={s.noShowPct !== null && s.noShowPct >= 30 ? 'pending' : 'neutral'}
                value={s.noShowPct === null ? UNAVAILABLE : `${s.noShowPct}%`}
                unavailable={s.noShowPct === null}
                label="Did not attend"
                sub={s.noShowPct === null
                  ? 'Nobody has picked a session, so there is no share to take'
                  : 'Of the places taken'}
              />
            </div>

            {(s.cancelled > 0 || s.full > 0 || s.withoutHall > 0) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border bg-muted/20 px-4 py-2.5 text-fs-2xs text-muted-foreground">
                {s.full > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn('size-1.5 rounded-pill', accent('pending').bar)} aria-hidden />
                    {s.full} {s.full === 1 ? 'session is' : 'sessions are'} full
                  </span>
                )}
                {s.withoutHall > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn('size-1.5 rounded-pill', accent('neutral').bar)} aria-hidden />
                    {s.withoutHall} {s.withoutHall === 1 ? 'has' : 'have'} no room, so clashes can&apos;t be checked
                  </span>
                )}
                {s.cancelled > 0 && (
                  <button
                    type="button"
                    onClick={() => setParams({ cs: status === 'cancelled' ? null : 'cancelled' })}
                    // The hit area is the full 44px row even though the text sits inline:
                    // negative margins keep the footnote from growing around it.
                    className="-my-2 inline-flex min-h-11 items-center gap-1.5 rounded-control px-1 py-0.5 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <span className={cn('size-1.5 rounded-pill', accent('critical').bar)} aria-hidden />
                    {s.cancelled} cancelled — {status === 'cancelled' ? 'show scheduled' : 'show them'}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ══ ROOMS — the one chart that answers an operational question ════ */}
      {rooms.length > 0 && (
        <section aria-labelledby="conf-rooms" className="min-w-0">
          <h2 id="conf-rooms" className="mb-2 flex items-center gap-1.5 text-fs-sm font-semibold text-foreground">
            <MapPin className="size-3.5 text-muted-foreground" aria-hidden />
            How full the rooms get
          </h2>
          <div className="rounded-surface border border-border bg-card p-4">
            <ul className="space-y-2.5">
              {rooms.map(r => (
                <li key={r.hallId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto]">
                  <span className="min-w-0 truncate text-fs-xs text-foreground">{r.name}</span>
                  <span className="col-span-2 sm:col-span-1">
                    <Meter
                      percent={r.percent}
                      tone={r.percent === null ? 'neutral' : fillTone(r.percent)}
                      label={r.percent === null
                        ? `${r.name}: no seat count set`
                        : `${r.name}: busiest session fills ${r.percent}% of ${r.capacity} seats`}
                    />
                  </span>
                  <span className="shrink-0 text-fs-2xs tabular-nums text-muted-foreground sm:order-last">
                    {r.capacity === null
                      ? `${r.sessions} ${r.sessions === 1 ? 'session' : 'sessions'}`
                      : `${r.percent}% of ${r.capacity.toLocaleString('en-IN')}`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-border pt-2.5 text-fs-2xs text-muted-foreground">
              Measured at the busiest single session in each room, not the total across the
              day — that is the number that decides whether people fit.
            </p>
          </div>
        </section>
      )}

      {/* ══ FEEDBACK ═════════════════════════════════════════════════════ */}
      {actionErr && (
        <p role="alert" className="flex items-start gap-2 rounded-surface border border-critical/25 px-3.5 py-2.5 text-fs-xs text-critical">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{actionErr}</span>
          <button type="button" onClick={() => setActionErr(null)} aria-label="Dismiss error"
                  className="shrink-0 rounded-control p-0.5 hover:bg-critical/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            <X className="size-3.5" aria-hidden />
          </button>
        </p>
      )}
      {!editable && lockReason && (
        <p className="flex items-start gap-2 rounded-surface border border-border bg-card px-3.5 py-2.5 text-fs-xs text-muted-foreground">
          <CircleSlash className="mt-px size-3.5 shrink-0" aria-hidden />
          {lockReason} You can still read it and export from it.
        </p>
      )}

      {/* ══ SETUP — tracks, rooms, speakers ══════════════════════════════ */}
      <SetupPanel
        bundle={bundle} open={showSetup} onToggle={() => setShowSetup(o => !o)}
        editable={editable} busy={busy}
        onAdd={addEntity} onRemove={removeEntity}
        onExportSpeaker={(id, name) => void download(`speakerId=${encodeURIComponent(id)}`, `speaker-schedule-${name}.csv`)}
      />

      {/* ══ THE SCHEDULE ═════════════════════════════════════════════════ */}
      <section aria-labelledby="conf-schedule" className="min-w-0">
        <div className="overflow-hidden rounded-surface border border-border bg-card">
          {/* Toolbar */}
          <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center">
            <h2 id="conf-schedule" className="text-fs-sm font-semibold text-foreground sm:sr-only">Schedule</h2>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="search" value={draft} onChange={e => setDraft(e.target.value)}
                placeholder="Search sessions and speakers"
                aria-label="Search the schedule"
                className={cn(FIELD, 'h-11 pl-9 sm:h-9')}
              />
            </div>
            <button type="button" onClick={reload} className={cn(GHOST_BTN, 'shrink-0 sm:h-9')}>
              <RefreshCw className="size-3.5" aria-hidden /> Refresh
            </button>
            {editable && (
              <button type="button" onClick={() => setShowForm(o => !o)} className={cn(PRIMARY_BTN, 'shrink-0 sm:h-9')}>
                <Plus className="size-4" aria-hidden /> {showForm ? 'Close' : 'Add session'}
              </button>
            )}
          </div>

          {/* Views + filters */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Group the schedule by">
              {CONFERENCE_VIEWS.map(v => {
                const on = view === v.key
                return (
                  <button key={v.key} type="button" aria-pressed={on}
                    onClick={() => setParams({ cv: v.key === 'agenda' ? null : v.key })}
                    className={cn(
                      'inline-flex h-8 items-center rounded-pill border px-3 text-fs-xs font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                      on ? 'border-primary/45 bg-primary/[0.12] font-semibold text-foreground'
                         : 'border-border bg-card text-muted-foreground hover:bg-muted',
                    )}
                  >{v.label}</button>
                )
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {bundle.tracks.length > 0 && (
                <label className="inline-flex items-center gap-1.5 text-fs-2xs text-muted-foreground">
                  <span className="sr-only sm:not-sr-only">Track</span>
                  <select value={trackId ?? ''} onChange={e => setParams({ ct: e.target.value || null })}
                          aria-label="Filter by track"
                          className={cn(FIELD, 'h-8 w-auto py-0 text-fs-xs')}>
                    <option value="">All tracks</option>
                    {bundle.tracks.map(t => <option key={t.trackId} value={t.trackId}>{t.name}</option>)}
                  </select>
                </label>
              )}
              {bundle.halls.length > 0 && (
                <label className="inline-flex items-center gap-1.5 text-fs-2xs text-muted-foreground">
                  <span className="sr-only sm:not-sr-only">Room</span>
                  <select value={hallId ?? ''} onChange={e => setParams({ ch: e.target.value || null })}
                          aria-label="Filter by room"
                          className={cn(FIELD, 'h-8 w-auto py-0 text-fs-xs')}>
                    <option value="">All rooms</option>
                    {bundle.halls.map(h => <option key={h.hallId} value={h.hallId}>{h.name}</option>)}
                  </select>
                </label>
              )}
              <label className="inline-flex items-center gap-1.5 text-fs-2xs text-muted-foreground">
                <span className="sr-only sm:not-sr-only">Status</span>
                <select value={status} onChange={e => setParams({ cs: e.target.value === 'scheduled' ? null : e.target.value })}
                        aria-label="Filter by status"
                        className={cn(FIELD, 'h-8 w-auto py-0 text-fs-xs')}>
                  <option value="scheduled">Scheduled</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="all">All</option>
                </select>
              </label>
            </div>
          </div>

          {/* New session */}
          {showForm && editable && (
            <SessionForm
              bundle={bundle} busy={busy} tz={tz}
              onCancel={() => setShowForm(false)}
              onSave={async input => {
                if (await act({ action: 'create_session', session: input })) {
                  setShowForm(false); showToast('Session added to the schedule.', 'success')
                }
              }}
            />
          )}

          {/* Rows */}
          {visible.length === 0 ? (
            <div className="px-4 py-14 text-center">
              <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('event').tile)} aria-hidden>
                <CalendarDays className="size-5" />
              </span>
              <p className="mt-4 text-fs-md font-semibold text-foreground">
                {conferenceEmptyMessage(filters, s.scheduled, s.cancelled)}
              </p>
              <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
                {nothingAtAll
                  ? 'A session is one item on the agenda — a talk, a workshop, a ceremony. Add tracks, rooms and speakers first if you want to group and place them.'
                  : 'Other sessions exist under different filters.'}
              </p>
              {!nothingAtAll && (
                <button type="button" onClick={() => setParams({ cq: null, ct: null, ch: null, cs: null })}
                        className={cn(GHOST_BTN, 'mt-4')}>Show the whole schedule</button>
              )}
              {nothingAtAll && editable && (
                <button type="button" onClick={() => setShowForm(true)} className={cn(PRIMARY_BTN, 'mt-4')}>
                  <Plus className="size-4" aria-hidden /> Add the first session
                </button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {groups.map(g => (
                <div key={g.key} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3 bg-muted/20 px-4 py-2">
                    <h3 className="truncate text-fs-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h3>
                    <span className="shrink-0 text-fs-2xs tabular-nums text-muted-foreground">
                      {g.sessions.length} {g.sessions.length === 1 ? 'session' : 'sessions'}
                    </span>
                  </div>
                  <ul className="divide-y divide-border">
                    {g.sessions.map(sv => (
                      <SessionRow
                        key={sv.sessionId} s={sv} bundle={bundle} tz={tz} now={now}
                        editable={editable} busy={busy}
                        showDay={view !== 'agenda'}
                        onCancel={() => void cancelSession(sv)}
                        onExport={() => void download(`sessionId=${encodeURIComponent(sv.sessionId)}`, `session-attendees-${sv.title}.csv`)}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="mt-3 text-fs-2xs leading-relaxed text-muted-foreground">
          Times are shown in the event&apos;s timezone{tz ? ` (${tz})` : ''}.{' '}
          <strong className="font-medium text-foreground">Session places</strong> are how many
          people picked each session — separate from the event&apos;s own registration total
          in the header above. Cancelling a session removes it from everyone who chose it.
        </p>
      </section>
    </div>
  )
}

// ─── One session ──────────────────────────────────────────────────────────────

function SessionRow({ s, bundle, tz, now, editable, busy, showDay, onCancel, onExport }: {
  s: SessionView; bundle: ScheduleBundle; tz: string | null; now: number
  editable: boolean; busy: boolean; showDay: boolean
  onCancel: () => void; onExport: () => void
}) {
  const state = sessionState(s, now)
  const cap = capacityView(s)
  const noShow = noShowPercent(s.registeredCount, s.checkedInCount)
  const track = trackName(bundle, s.trackId)
  const hall = hallName(bundle, s.hallId)
  const speakers = speakerNames(bundle, s.speakerIds)
  const mins = sessionMinutes(s.startTime, s.endTime)

  return (
    <li className={cn('min-w-0 p-4', state === 'cancelled' && 'bg-muted/20')}>
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start">
        {/* Time */}
        <div className="min-w-0 shrink-0 lg:w-44">
          <p className={cn('text-fs-sm font-semibold tabular-nums',
            state === 'cancelled' ? 'text-muted-foreground line-through' : 'text-foreground')}>
            {formatSessionRange(s.startTime, s.endTime, tz)}
          </p>
          <p className="mt-0.5 text-fs-2xs text-muted-foreground">
            {showDay ? `${formatSessionDay(s.startTime, tz)} · ` : ''}{formatDuration(mins)}
          </p>
        </div>

        {/* Identity */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className={cn('min-w-0 break-words text-fs-sm font-semibold',
              state === 'cancelled' ? 'text-muted-foreground' : 'text-foreground')}>
              {s.title}
            </p>
            <StateBadge state={state} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-fs-2xs text-muted-foreground">
            {track && <span className="inline-flex min-w-0 items-center gap-1"><Layers className="size-3 shrink-0" aria-hidden /><span className="truncate">{track}</span></span>}
            <span className="inline-flex min-w-0 items-center gap-1">
              <MapPin className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{hall ?? 'No room assigned'}</span>
            </span>
            {speakers.length > 0 && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <Mic className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{speakers.join(', ')}</span>
              </span>
            )}
          </div>
        </div>

        {/* Attendance */}
        <div className="min-w-0 shrink-0 lg:w-52">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-fs-xs font-medium text-foreground">
              {cap.capacity === null
                ? `${cap.registered.toLocaleString('en-IN')} ${cap.registered === 1 ? 'place' : 'places'} taken`
                : `${cap.registered.toLocaleString('en-IN')} of ${cap.capacity.toLocaleString('en-IN')}`}
            </p>
            {cap.percent !== null && (
              <p className="text-fs-2xs font-semibold tabular-nums text-foreground">{cap.percent}%</p>
            )}
          </div>
          {/* A rail is drawn only where a proportion exists — an uncapped session has
              nothing to fill, and a dashed rail under it would read as empty. */}
          {cap.percent !== null && (
            <div className="mt-1.5">
              <Meter percent={cap.percent} tone={fillTone(cap.percent)}
                     label={`${s.title}: ${cap.percent}% of ${cap.capacity} places taken`} />
            </div>
          )}
          <p className="mt-1 text-fs-2xs text-muted-foreground">
            {s.checkedInCount.toLocaleString('en-IN')} checked in
            {noShow === null ? '' : ` · ${noShow}% didn’t attend`}
          </p>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={onExport}
                  aria-label={`Export the attendee list for ${s.title}`}
                  className={ICON_BTN}>
            <Download className="size-4" aria-hidden />
          </button>
          {state !== 'cancelled' && (
            <button
              type="button" onClick={onCancel} disabled={busy || !editable}
              title={!editable ? 'This event is read-only.' : undefined}
              aria-label={`Cancel the session ${s.title}`}
              className={cn(ICON_BTN, 'hover:bg-critical/10 hover:text-critical')}
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

// ─── Tracks / rooms / speakers ────────────────────────────────────────────────

function SetupPanel({ bundle, open, onToggle, editable, busy, onAdd, onRemove, onExportSpeaker }: {
  bundle: ScheduleBundle
  open: boolean
  onToggle: () => void
  editable: boolean
  busy: boolean
  onAdd: (kind: 'track' | 'hall' | 'speaker') => void
  onRemove: (kind: 'track' | 'hall' | 'speaker', id: string, label: string, usedBy: number) => void
  onExportSpeaker: (id: string, name: string) => void
}) {
  const counts = {
    track: bundle.tracks.length, hall: bundle.halls.length, speaker: bundle.speakers.length,
  }
  const live = bundle.sessions.filter(x => x.status !== 'cancelled')

  const lists = [
    {
      kind: 'track' as const, label: 'Tracks', icon: Layers,
      hint: 'Themes a session belongs to',
      items: bundle.tracks.map(t => ({
        id: t.trackId, name: t.name,
        usedBy: live.filter(x => x.trackId === t.trackId).length,
      })),
    },
    {
      kind: 'hall' as const, label: 'Rooms', icon: MapPin,
      hint: 'Where a session happens — two sessions can’t share one at the same time',
      items: bundle.halls.map(h => ({
        id: h.hallId, name: h.capacity ? `${h.name} · ${h.capacity} seats` : h.name,
        usedBy: live.filter(x => x.hallId === h.hallId).length,
      })),
    },
    {
      kind: 'speaker' as const, label: 'Speakers', icon: Mic,
      hint: 'People presenting',
      items: bundle.speakers.map(sp => ({
        id: sp.speakerId, name: sp.name,
        usedBy: live.filter(x => x.speakerIds.includes(sp.speakerId)).length,
        onExport: () => onExportSpeaker(sp.speakerId, sp.name),
      })),
    },
  ]

  return (
    <section aria-labelledby="conf-setup" className="min-w-0">
      <div className="overflow-hidden rounded-surface border border-border bg-card">
        <button
          type="button" onClick={onToggle} aria-expanded={open}
          {...(open ? { 'aria-controls': 'conf-setup-body' } : {})}
          className="flex w-full min-h-11 items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
        >
          <span className="min-w-0">
            <span id="conf-setup" className="block text-fs-sm font-semibold text-foreground">
              Tracks, rooms and speakers
            </span>
            <span className="mt-0.5 block truncate text-fs-2xs text-muted-foreground">
              {counts.track} {counts.track === 1 ? 'track' : 'tracks'} · {counts.hall} {counts.hall === 1 ? 'room' : 'rooms'} · {counts.speaker} {counts.speaker === 1 ? 'speaker' : 'speakers'}
            </span>
          </span>
          <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
        </button>

        {open && (
          <div id="conf-setup-body" className="grid gap-px border-t border-border bg-border sm:grid-cols-3">
            {lists.map(l => (
              <div key={l.kind} className="min-w-0 bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="inline-flex min-w-0 items-center gap-1.5 text-fs-xs font-semibold text-foreground">
                    <l.icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    {l.label}
                  </p>
                  {editable && (
                    <button type="button" onClick={() => onAdd(l.kind)} disabled={busy}
                            className="inline-flex h-8 items-center gap-1 rounded-control border border-border px-2 text-fs-2xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                      <Plus className="size-3" aria-hidden /> Add
                    </button>
                  )}
                </div>
                <p className="mt-1 text-fs-2xs text-muted-foreground">{l.hint}</p>

                {l.items.length === 0 ? (
                  <p className="mt-3 text-fs-2xs text-muted-foreground">None yet.</p>
                ) : (
                  <ul className="mt-3 space-y-1">
                    {l.items.map(i => (
                      <li key={i.id} className="flex min-w-0 items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-fs-xs text-foreground">
                          {i.name}
                          {i.usedBy > 0 && (
                            <span className="ml-1.5 text-fs-2xs text-muted-foreground">· {i.usedBy}</span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center">
                          {'onExport' in i && i.onExport && (
                            <button type="button" onClick={i.onExport}
                                    aria-label={`Export the schedule for ${i.name}`}
                                    className={cn(ICON_BTN, 'size-8')}>
                              <Download className="size-3.5" aria-hidden />
                            </button>
                          )}
                          {editable && (
                            <button type="button" onClick={() => onRemove(l.kind, i.id, i.name, i.usedBy)} disabled={busy}
                                    aria-label={`Remove ${i.name}`}
                                    className={cn(ICON_BTN, 'size-8 hover:bg-critical/10 hover:text-critical')}>
                              <Trash2 className="size-3.5" aria-hidden />
                            </button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// ─── New session ──────────────────────────────────────────────────────────────

interface SessionInput {
  title: string; trackId: string | null; hallId: string | null
  speakerIds: string[]; startTime: number; endTime: number; capacity: number | null
}

function SessionForm({ bundle, busy, tz, onSave, onCancel }: {
  bundle: ScheduleBundle; busy: boolean; tz: string | null
  onSave: (input: SessionInput) => void
  onCancel: () => void
}) {
  const [f, setF] = useState({ title: '', trackId: '', hallId: '', speakerIds: [] as string[], start: '', end: '', capacity: '' })
  const [err, setErr] = useState<string | null>(null)
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(p => ({ ...p, [k]: v }))

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const title = f.title.trim()
    if (!title) { setErr('Give the session a title.'); return }
    if (!f.start || !f.end) { setErr('Set both a start and an end time.'); return }
    const startTime = new Date(f.start).getTime()
    const endTime = new Date(f.end).getTime()
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) { setErr('Those times could not be read.'); return }
    if (endTime <= startTime) { setErr('The end time must be after the start time.'); return }
    const capacity = f.capacity.trim() === '' ? null : Number(f.capacity)
    if (capacity !== null && (!Number.isInteger(capacity) || capacity <= 0)) {
      setErr('A capacity must be a whole number above zero, or blank for unlimited.'); return
    }
    setErr(null)
    onSave({
      title, trackId: f.trackId || null, hallId: f.hallId || null,
      speakerIds: f.speakerIds, startTime, endTime, capacity,
    })
  }

  const labelCls = 'mb-1 block text-fs-xs font-medium text-foreground'
  const hintCls = 'mt-1 text-fs-2xs text-muted-foreground'

  return (
    <form onSubmit={submit} className="border-b border-border bg-muted/20 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <label htmlFor="sess-title" className={labelCls}>Title</label>
          <input id="sess-title" className={FIELD} value={f.title} maxLength={200} required
                 onChange={e => set('title', e.target.value)} placeholder="Opening keynote" />
        </div>

        <div className="min-w-0">
          <label htmlFor="sess-start" className={labelCls}>Starts</label>
          <input id="sess-start" type="datetime-local" className={cn(FIELD, 'h-11 sm:h-auto')}
                 value={f.start} onChange={e => set('start', e.target.value)} required />
          <p className={hintCls}>Entered in your own timezone{tz ? `; shown to everyone in ${tz}` : ''}.</p>
        </div>
        <div className="min-w-0">
          <label htmlFor="sess-end" className={labelCls}>Ends</label>
          <input id="sess-end" type="datetime-local" className={cn(FIELD, 'h-11 sm:h-auto')}
                 value={f.end} onChange={e => set('end', e.target.value)} required />
        </div>

        <div className="min-w-0">
          <label htmlFor="sess-track" className={labelCls}>Track</label>
          <select id="sess-track" className={FIELD} value={f.trackId} onChange={e => set('trackId', e.target.value)}>
            <option value="">No track</option>
            {bundle.tracks.map(t => <option key={t.trackId} value={t.trackId}>{t.name}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="sess-hall" className={labelCls}>Room</label>
          <select id="sess-hall" className={FIELD} value={f.hallId} onChange={e => set('hallId', e.target.value)}>
            <option value="">No room</option>
            {bundle.halls.map(h => <option key={h.hallId} value={h.hallId}>{h.name}</option>)}
          </select>
          <p className={hintCls}>A room can hold only one session at a time.</p>
        </div>

        <div className="min-w-0">
          <label htmlFor="sess-cap" className={labelCls}>Capacity</label>
          <input id="sess-cap" className={cn(FIELD, 'tabular-nums')} value={f.capacity} inputMode="numeric"
                 onChange={e => set('capacity', e.target.value.replace(/\D/g, ''))} placeholder="Unlimited" />
          <p className={hintCls}>Blank means anyone registered can attend.</p>
        </div>

        {bundle.speakers.length > 0 && (
          <fieldset className="min-w-0">
            <legend className={labelCls}>Speakers</legend>
            {/* Toggle chips rather than a <select multiple>, which needs ctrl-click to
                use and is unusable on touch. */}
            <div className="flex flex-wrap gap-1.5">
              {bundle.speakers.map(sp => {
                const on = f.speakerIds.includes(sp.speakerId)
                return (
                  <button
                    key={sp.speakerId} type="button" aria-pressed={on}
                    onClick={() => set('speakerIds', on
                      ? f.speakerIds.filter(x => x !== sp.speakerId)
                      : [...f.speakerIds, sp.speakerId])}
                    className={cn(
                      'inline-flex h-9 max-w-[13rem] items-center gap-1.5 rounded-pill border px-3 text-fs-xs font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                      on ? 'border-primary/45 bg-primary/[0.12] font-semibold text-foreground'
                         : 'border-border bg-card text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {on && <Check className="size-3 shrink-0" aria-hidden />}
                    <span className="truncate">{sp.name}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>
        )}
      </div>

      {err && (
        <p role="alert" className="mt-3 flex items-start gap-1.5 text-fs-xs text-critical">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />{err}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" className={PRIMARY_BTN} disabled={busy}>
          {busy ? <><Loader2 className="size-4 animate-spin" aria-hidden />Saving…</> : 'Add to schedule'}
        </button>
        <button type="button" onClick={onCancel} className={GHOST_BTN} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}
