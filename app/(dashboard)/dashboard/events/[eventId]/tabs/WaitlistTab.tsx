'use client'

// RD-EVENT-15 · Waitlist — who is queueing for a place, and whether the queue is even open.
//
// ═══ WHAT THIS WORKSPACE ANSWERS ═════════════════════════════════════════════
// Can anyone join right now, and if not WHY · who is waiting and in what order · who has
// been invited · how much room is left · what an organizer can do about it. It is a
// workspace inside the Event Command Center: the shell header above owns the event's
// identity and its headline figures, and none of them is repeated here.
//
// ═══ THE DEFECT THIS REPLACES ════════════════════════════════════════════════
// The old tab showed an "Enable Waitlist" toggle and nothing else about availability. But
// FIVE conditions decide whether a person can join (see lib/waitlist/waitlistView.ts), and
// the first of them — `WAITLIST_ENABLED` in lib/registrations/gate.ts — is currently
// FALSE platform-wide. So an organizer could switch the waitlist "on", watch it report
// itself on, and collect nobody, because /api/waitlist/join answers 403 to everyone. The
// switch was telling the truth about a field and nothing about the world.
//
// It also ordered the queue NEWEST FIRST, on a list whose entire purpose is "who is next".
//
// ═══ WHAT THIS DELIBERATELY DOES NOT SHOW ════════════════════════════════════
// Expiry, acceptance, decline, automatic promotion, "converted to registration". None of
// them exists in the data model (lib/waitlist/types.ts has exactly three states), and a
// chip for a rule that does not run is worse than no chip. `invited` is labelled "Invited"
// rather than "Accepted" for the same reason — the product cannot tell whether the person
// used the link.
//
// ═══ READS ═══════════════════════════════════════════════════════════════════
// ONE request per view. The server answers counts with `count()` aggregates (which
// transfer no documents) and returns at most PAGE_SIZE entries. Filtering, search and
// paging are all server-side; nothing here scans a queue in the browser.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle, CheckCircle2, ChevronDown, Clock, Info, ListChecks, Loader2,
  Mail, MailCheck, Phone, RefreshCw, Search, Send, UserMinus, Users, X,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent, type AccentTone } from '@/lib/dashboard/accents'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { SEARCH_MIN_CHARS } from '@/lib/registrations/search'
import { MAX_WAITLIST_LIMIT, isValidWaitlistLimit } from '@/lib/waitlist/waitlistSettings'
import {
  UNAVAILABLE, WAITLIST_FILTERS, WAITLIST_STATUS_HINT, WAITLIST_STATUS_LABEL,
  WAITLIST_STATUS_TONE, formatJoinedAt, formatJoinedDay, isWaitlistFilter,
  promoteBlockedReason, removeBlockedReason, resolveWaitlistAvailability, spotsAvailable,
  waitlistAvailabilityCopy, waitlistEmptyMessage, waitlistNoun, waitlistSummary,
  type WaitlistFilter, type WaitlistRow, type WaitlistStatus,
} from '@/lib/waitlist/waitlistView'
import type { WaitlistListResponse } from '@/app/api/organizer/events/[eventId]/waitlist/route'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'

// ─── Status vocabulary ────────────────────────────────────────────────────────

/** Icon, word and tone — three signals, so colour is never the only one. */
const STATUS_ICON: Record<WaitlistStatus, typeof Clock> = {
  waiting: Clock,
  invited: MailCheck,
  removed: UserMinus,
}

function StatusBadge({ status }: { status: WaitlistStatus }) {
  const Icon = STATUS_ICON[status]
  return (
    <span
      title={WAITLIST_STATUS_HINT[status]}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-1 text-fs-2xs font-semibold',
        accent(WAITLIST_STATUS_TONE[status]).tile,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {WAITLIST_STATUS_LABEL[status]}
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
    <div
      role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
      aria-label={label}
      className="h-1.5 w-full overflow-hidden rounded-pill bg-muted"
    >
      <div className={cn('h-full rounded-pill transition-[width] duration-500', accent(tone).bar)}
           style={{ width: `${width}%` }} />
    </div>
  )
}

const fillTone = (pct: number): AccentTone =>
  pct >= 100 ? 'critical' : pct >= 80 ? 'pending' : 'verify'

function Metric({ icon: Icon, tone, value, label, sub, unavailable }: {
  icon: typeof Users
  tone: AccentTone
  value: string
  label: string
  sub?: string | null
  unavailable?: boolean
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-control', accent(tone).tile)} aria-hidden>
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0">
        {/* A WORD is set smaller than a numeral — the rule Passes and Coupons follow. */}
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

/**
 * 44px where a finger uses it, 36px in the desktop table where a pointer does.
 *
 * The table only exists at `xl` and above, so the compact height never applies on a
 * touch viewport — the card list below `xl` keeps the full target.
 */
const ROW_BTN =
  'inline-flex h-11 items-center justify-center gap-1.5 rounded-control border px-3 text-fs-2xs font-semibold ' +
  'transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-primary/40 xl:h-9 xl:px-2.5'

// ─── Error reading ────────────────────────────────────────────────────────────

/** The statuses this product's own waitlist routes produce, all with fixed human copy. */
const TRUSTED_STATUSES = new Set([400, 403, 404, 409, 503])

async function readError(res: Response, fallback: string): Promise<string> {
  if (!TRUSTED_STATUSES.has(res.status)) return fallback
  try {
    const json = await res.json() as { error?: string }
    return typeof json.error === 'string' && json.error ? json.error : fallback
  } catch {
    return fallback
  }
}

// ─── Workspace ────────────────────────────────────────────────────────────────

type LoadState = 'loading' | 'ready' | 'error'

export default function WaitlistTab({ event, token }: { event: EventDetailResponse; token: string }) {
  const eventId = event.draftId
  const noun    = waitlistNoun(event.eventType)
  const router  = useRouter()
  const params  = useSearchParams()

  // ── URL is the state (RD-EVENT-05/09) ─────────────────────────────────────
  // Filter and query live in the address bar, so Back/Forward work, a filtered queue can
  // be linked to a teammate, and a reload lands where the organizer was.
  const urlFilter = params.get('wl')
  const filter: WaitlistFilter = isWaitlistFilter(urlFilter) ? urlFilter : 'all'
  const query = params.get('wq') ?? ''

  /**
   * `push` for a deliberate choice, `replace` for a debounced one.
   *
   * Clicking a filter is a navigation an organizer expects Back to undo. Typing is not —
   * one history entry per keystroke would bury the page they came from.
   */
  const setParams = useCallback((patch: Record<string, string | null>, mode: 'push' | 'replace' = 'push') => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    const href = `?${next.toString()}`
    if (mode === 'push') router.push(href, { scroll: false })
    else router.replace(href, { scroll: false })
  }, [params, router])

  // The input is local so typing is not one history entry per keystroke; the URL catches
  // up on a debounce, which is also what triggers the (server-side) search.
  //
  // The URL→input resync is done DURING RENDER rather than in an effect: Back/Forward
  // changes `query` externally, and an effect for it would render the stale text once
  // before correcting itself. This is React's documented reset-on-change pattern.
  const [draft, setDraft] = useState(query)
  const [syncedQuery, setSyncedQuery] = useState(query)
  if (query !== syncedQuery) {
    setSyncedQuery(query)
    setDraft(query)
  }

  useEffect(() => {
    if (draft === query) return
    const t = setTimeout(() => setParams({ wq: draft || null }, 'replace'), 350)
    return () => clearTimeout(t)
  }, [draft, query, setParams])

  const [state,   setState]   = useState<LoadState>('loading')
  const [rows,    setRows]    = useState<WaitlistRow[]>([])
  const [counts,  setCounts]  = useState<WaitlistListResponse['counts']>({ waiting: null, invited: null, removed: null })
  const [settings, setSettings] = useState<WaitlistListResponse['settings']>({ waitlistEnabled: null, waitlistLimit: null })
  const [platformEnabled, setPlatformEnabled] = useState(true)
  const [published, setPublished] = useState(true)
  const [cursor,  setCursor]  = useState<string | null>(null)
  const [searchInfo, setSearchInfo] = useState<WaitlistListResponse['search'] | null>(null)

  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busyId,   setBusyId]   = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [notice,   setNotice]   = useState<string | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [limitDraft, setLimitDraft] = useState('')

  const { confirm } = useConfirm()
  const base = `/api/organizer/events/${eventId}/waitlist`
  const authHeaders = useMemo(
    () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }),
    [token],
  )

  const listUrl = useMemo(() => {
    const p = new URLSearchParams()
    if (filter !== 'all') p.set('status', filter)
    if (query.trim().length >= SEARCH_MIN_CHARS) p.set('q', query.trim())
    const s = p.toString()
    return s ? `${base}?${s}` : base
  }, [base, filter, query])

  // ── Load ──────────────────────────────────────────────────────────────────
  // Target-keyed rather than guarded by an effect-instance flag: under StrictMode the
  // first effect's cleanup would otherwise discard a response that had already arrived —
  // the bug RD-EVENT-09 fixed in the shell.
  const [attempt, setAttempt] = useState(0)
  const loadKey = useRef('')

  useEffect(() => {
    if (!token) return
    const key = `${listUrl}|${attempt}`
    if (loadKey.current === key) return
    const first = loadKey.current === ''
    loadKey.current = key

    void (async () => {
      // A filter change keeps the previous rows on screen and shows a local indicator,
      // rather than blanking a page the organizer is reading.
      if (first) setState('loading'); else setRefreshing(true)
      setActionErr(null)
      try {
        const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error('load')
        const json = await res.json() as WaitlistListResponse
        if (loadKey.current !== key) return
        setRows(json.entries ?? [])
        setCounts(json.counts ?? { waiting: null, invited: null, removed: null })
        setSettings(json.settings ?? { waitlistEnabled: null, waitlistLimit: null })
        setPlatformEnabled(json.platformEnabled !== false)
        setPublished(json.eventPublished !== false)
        setCursor(json.nextCursor ?? null)
        setSearchInfo(json.search ?? null)
        setLimitDraft(json.settings?.waitlistLimit != null ? String(json.settings.waitlistLimit) : '')
        setState('ready')
      } catch {
        if (loadKey.current !== key) return
        setState('error')
      } finally {
        if (loadKey.current === key) setRefreshing(false)
      }
    })()
  }, [listUrl, token, attempt])

  const reload = useCallback(() => setAttempt(n => n + 1), [])

  // ── Load more ─────────────────────────────────────────────────────────────

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return
    setLoadingMore(true); setActionErr(null)
    try {
      const sep = listUrl.includes('?') ? '&' : '?'
      const res = await fetch(`${listUrl}${sep}cursor=${encodeURIComponent(cursor)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        setActionErr(await readError(res, 'The next page could not be loaded. Please try again.'))
        return
      }
      const json = await res.json() as WaitlistListResponse
      // De-duplicated by id: a row that moved between pages must not appear twice.
      setRows(prev => {
        const seen = new Set(prev.map(r => r.id))
        return [...prev, ...(json.entries ?? []).filter(r => !seen.has(r.id))]
      })
      setCursor(json.nextCursor ?? null)
    } catch {
      setActionErr('The next page could not be loaded. Please check your connection.')
    } finally {
      setLoadingMore(false)
    }
  }, [cursor, loadingMore, listUrl, token])

  // ── Settings ──────────────────────────────────────────────────────────────

  const saveSettings = useCallback(async (patch: { enabled?: boolean; limit?: number | null }) => {
    setSavingSettings(true); setActionErr(null); setNotice(null)
    try {
      const res = await fetch(base, { method: 'PATCH', headers: authHeaders, body: JSON.stringify(patch) })
      if (!res.ok) {
        setActionErr(await readError(res, 'The waitlist settings could not be saved. Please try again.'))
        return false
      }
      // Only after the server agrees. The old tab flipped the toggle regardless.
      setSettings(prev => ({
        waitlistEnabled: 'enabled' in patch ? patch.enabled! : prev.waitlistEnabled,
        waitlistLimit:   'limit'   in patch ? (patch.limit ?? null) : prev.waitlistLimit,
      }))
      setNotice('Waitlist settings saved.')
      return true
    } catch {
      setActionErr('The waitlist settings could not be saved. Please check your connection.')
      return false
    } finally {
      setSavingSettings(false)
    }
  }, [base, authHeaders])

  const saveLimit = useCallback(async () => {
    const raw = limitDraft.trim()
    if (raw === '') { void saveSettings({ limit: null }); return }
    // The SAME predicate the API applies, so the form never accepts a value the server
    // would refuse and the two never word the same rule differently.
    const n = Number(raw)
    if (!isValidWaitlistLimit(n)) {
      setActionErr(`The waitlist limit must be a whole number between 1 and ${MAX_WAITLIST_LIMIT.toLocaleString('en-IN')}, or blank for no limit.`)
      return
    }
    void saveSettings({ limit: n })
  }, [limitDraft, saveSettings])

  // ── Row actions ───────────────────────────────────────────────────────────

  const promote = useCallback(async (row: WaitlistRow) => {
    const ok = await confirm({
      title: `Invite ${row.attendee.name || 'this person'}?`,
      message: `RegisterDesk will email them a link to register for ${row.passName || 'this event'}. This cannot be undone, and their place in the queue is given up whether or not they use it.`,
      confirmLabel: 'Send invitation',
    })
    if (!ok) return

    setBusyId(row.id); setActionErr(null); setNotice(null)
    try {
      const res = await fetch(`${base}/${row.id}/promote`, { method: 'POST', headers: authHeaders })
      if (!res.ok) {
        setActionErr(await readError(res, `${row.attendee.name || 'This person'} could not be invited. Nothing was sent.`))
        return
      }
      const json = await res.json() as { notified?: boolean }
      // Only after the server agrees, and only this row — no full-queue refetch. A row
      // that no longer matches the active filter LEAVES the list: showing an "Invited"
      // badge under a "Waiting" filter would contradict the filter it is sitting in.
      setRows(prev => filter === 'waiting' || filter === 'removed'
        ? prev.filter(r => r.id !== row.id)
        : prev.map(r => r.id === row.id ? { ...r, status: 'invited', position: null } : r))
      setCounts(prev => ({
        ...prev,
        waiting: prev.waiting === null ? null : Math.max(0, prev.waiting - 1),
        invited: prev.invited === null ? null : prev.invited + 1,
      }))
      // "Invited" and "invited but never told" are different outcomes, so they get
      // different sentences. The status change stands either way.
      // One noun phrase for both cases, so the sentence agrees whether or not a name was
      // given: "Priya has been emailed" and "This person has been emailed" both read.
      const who = row.attendee.name || 'This person'
      setNotice(json.notified === false
        ? `${who} was marked invited, but the email could not be sent — contact them directly.`
        : `${who} has been emailed a link to register.`)
    } catch {
      setActionErr('The invitation could not be sent. Please check your connection.')
    } finally {
      setBusyId(null)
    }
  }, [base, authHeaders, confirm, filter])

  const remove = useCallback(async (row: WaitlistRow) => {
    const ok = await confirm({
      title: `Remove ${row.attendee.name || 'this person'}?`,
      message: row.status === 'invited'
        ? 'They have already been sent an invitation. Removing them here does not cancel that email, and they keep no place in the queue.'
        : `They lose their place in the queue. Nothing is sent to them, and this cannot be undone.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return

    setBusyId(row.id); setActionErr(null); setNotice(null)
    try {
      const res = await fetch(`${base}/${row.id}/remove`, { method: 'POST', headers: authHeaders })
      if (!res.ok) {
        setActionErr(await readError(res, `${row.attendee.name || 'This person'} could not be removed. They are unchanged.`))
        return
      }
      const previous = row.status
      setRows(prev => filter === 'all' || filter === 'removed'
        ? prev.map(r => r.id === row.id ? { ...r, status: 'removed', position: null } : r)
        : prev.filter(r => r.id !== row.id))
      setCounts(prev => ({
        waiting: previous === 'waiting' && prev.waiting !== null ? Math.max(0, prev.waiting - 1) : prev.waiting,
        invited: previous === 'invited' && prev.invited !== null ? Math.max(0, prev.invited - 1) : prev.invited,
        removed: prev.removed === null ? null : prev.removed + 1,
      }))
      setNotice(`${row.attendee.name || 'This person'} has been removed from the waitlist.`)
    } catch {
      setActionErr(`${row.attendee.name || 'This person'} could not be removed. Please check your connection.`)
    } finally {
      setBusyId(null)
    }
  }, [base, authHeaders, confirm, filter])

  // ── Derived ───────────────────────────────────────────────────────────────

  const summary = useMemo(
    () => waitlistSummary(counts, settings.waitlistLimit),
    [counts, settings.waitlistLimit],
  )
  const free = spotsAvailable(
    event.totalCapacity,
    event.statsUnavailable === true ? null : event.totalRegistrations,
  )
  const availability = useMemo(() => resolveWaitlistAvailability({
    platformEnabled,
    eventPublished: published,
    lifecycleStatus: event.lifecycleStatus,
    organizerEnabled: settings.waitlistEnabled === true,
    totalCapacity: event.totalCapacity,
    registered: event.statsUnavailable === true ? null : event.totalRegistrations,
    waitlistLimit: settings.waitlistLimit,
    waitingCount: counts.waiting,
  }), [platformEnabled, published, event.lifecycleStatus, event.totalCapacity,
       event.totalRegistrations, event.statsUnavailable, settings, counts.waiting])
  const copy = waitlistAvailabilityCopy(availability, noun)

  const readOnly = !platformEnabled && rows.length === 0
  // Position exists only in the waiting queue; elsewhere the column would be a row of
  // placeholders standing in for a number that has no meaning in that view.
  const showPosition = rows.some(r => r.position !== null)
  const searching = query.trim().length >= SEARCH_MIN_CHARS

  // ── Loading ───────────────────────────────────────────────────────────────

  if (state === 'loading') {
    return (
      <div className="space-y-5" aria-busy="true">
        <div className="h-32 animate-pulse rounded-surface border border-border bg-muted/40" />
        <div className="h-24 animate-pulse rounded-surface border border-border bg-muted/40" />
        <div className="h-72 animate-pulse rounded-surface border border-border bg-muted/40" />
        <p className="sr-only" role="status">Loading the waitlist</p>
      </div>
    )
  }

  // ── Could not be read ─────────────────────────────────────────────────────

  if (state === 'error') {
    return (
      <section aria-labelledby="waitlist-error" className="min-w-0">
        <div className="rounded-surface border border-border bg-card px-4 py-14 text-center">
          <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('critical').tile)} aria-hidden>
            <AlertTriangle className="size-5" />
          </span>
          <h2 id="waitlist-error" className="mt-4 text-fs-md font-semibold text-foreground">
            The waitlist couldn&apos;t be loaded
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
            This is a problem reading it, not a statement about how many people are queueing.
            Anyone already on the waitlist is still on it.
          </p>
          <button type="button" onClick={reload} className={cn(PRIMARY_BTN, 'mt-5')}>
            <RefreshCw className="size-4" aria-hidden /> Try again
          </button>
        </div>
      </section>
    )
  }

  // ── Never published ───────────────────────────────────────────────────────

  if (!published) {
    return (
      <section aria-labelledby="waitlist-draft" className="min-w-0">
        <div className="rounded-surface border border-border bg-card px-4 py-14 text-center">
          <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('event').tile)} aria-hidden>
            <ListChecks className="size-5" />
          </span>
          <h2 id="waitlist-draft" className="mt-4 text-fs-md font-semibold text-foreground">
            The waitlist opens once this event is published
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
            People join the queue from the event&apos;s public registration page, at the moment
            it turns them away for being full. This event does not have one yet.
          </p>
          {/* RD-EVENT-15A · the setting is real before publish — the builder writes the
              same field this workspace does — so the draft says which way it is set
              rather than leaving the organizer to guess. */}
          {settings.waitlistEnabled !== null && (
            <p className="mx-auto mt-4 max-w-md text-fs-xs text-muted-foreground">
              It is currently set to{' '}
              <strong className="font-semibold text-foreground">
                {settings.waitlistEnabled ? 'collect a waitlist' : 'not collect a waitlist'}
              </strong>{' '}
              in the event builder, and that setting is kept when you publish.
            </p>
          )}
        </div>
      </section>
    )
  }

  return (
    <div className="space-y-5">
      {/* ══ AVAILABILITY — the question the page exists to answer ══════════ */}
      <section aria-labelledby="waitlist-status" className="min-w-0">
        <h2 id="waitlist-status" className="sr-only">Waitlist status</h2>

        <div className="overflow-hidden rounded-surface border border-border bg-card">
          <span className={cn('block h-0.5 w-full', accent(copy.tone).bar)} aria-hidden />

          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start">
            <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-control', accent(copy.tone).tile)} aria-hidden>
              <ListChecks className="size-4.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-fs-md font-semibold leading-snug text-foreground">{copy.headline}</p>
              <p className="mt-1 max-w-2xl text-fs-sm leading-relaxed text-muted-foreground">{copy.detail}</p>
            </div>

            {/* The organizer's own switch. Rendered even when the platform switch is off,
                because the setting is still theirs to make — but it is labelled with what
                it will and will not do. */}
            <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end">
              {/* A switch, not a checkbox: this saves the moment it is flipped rather than
                  belonging to a form that is submitted. The whole 44px control is the hit
                  area — a bare 20px checkbox is below every touch-target guideline — and
                  `role="switch"` gives a screen reader the on/off state directly. */}
              <button
                type="button"
                role="switch"
                aria-checked={settings.waitlistEnabled === true}
                aria-label="Collect a waitlist for this event"
                disabled={savingSettings || settings.waitlistEnabled === null}
                onClick={() => void saveSettings({ enabled: settings.waitlistEnabled !== true })}
                className={cn(
                  '-mx-2 flex h-11 items-center gap-2.5 rounded-control px-2 transition-colors',
                  'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                )}
              >
                <span className="text-fs-xs font-medium text-foreground">Collect a waitlist</span>
                <span
                  aria-hidden
                  className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill transition-colors',
                    settings.waitlistEnabled === true ? 'bg-primary/70' : 'bg-muted-foreground/30',
                  )}
                >
                  <span className={cn(
                    'absolute size-4 rounded-pill bg-card shadow-sm transition-[left]',
                    settings.waitlistEnabled === true ? 'left-[1.125rem]' : 'left-0.5',
                  )} />
                </span>
              </button>
              {savingSettings && (
                <span className="flex items-center gap-1 text-fs-2xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" aria-hidden /> Saving
                </span>
              )}
              {settings.waitlistEnabled === null && (
                <span className="text-fs-2xs text-muted-foreground">Setting unavailable</span>
              )}
            </div>
          </div>

          {/* Limit — shown only when the switch is on, because it governs nothing off. */}
          {settings.waitlistEnabled === true && (
            <div className="flex flex-col gap-3 border-t border-border bg-muted/20 px-4 py-3 sm:flex-row sm:items-end">
              <div className="min-w-0 sm:max-w-xs sm:flex-1">
                <label htmlFor="waitlist-limit" className="mb-1 block text-fs-xs font-medium text-foreground">
                  Maximum queue length
                </label>
                <input
                  id="waitlist-limit"
                  className={cn(FIELD, 'h-11 tabular-nums sm:h-9')}
                  value={limitDraft}
                  onChange={e => setLimitDraft(e.target.value)}
                  inputMode="numeric"
                  placeholder="No limit"
                />
                {/* A cap IS stored but is not a usable number, so it is enforcing
                    nothing. Reporting the event as "uncapped" would be a much more
                    permissive claim than the truth. */}
                {settings.limitInvalid ? (
                  <p className="mt-1 flex items-start gap-1.5 text-fs-2xs text-critical">
                    <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
                    The stored limit isn&apos;t a usable number, so no limit is being enforced.
                    Save a whole number, or clear the field to make &ldquo;no limit&rdquo; deliberate.
                  </p>
                ) : (
                  <p className="mt-1 text-fs-2xs text-muted-foreground">
                    Joins are refused once this many people are waiting. Blank means no limit.
                  </p>
                )}
              </div>
              <button
                type="button" onClick={() => void saveLimit()} disabled={savingSettings}
                className={cn(GHOST_BTN, 'shrink-0 sm:h-9')}
              >
                {savingSettings ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Save limit
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ══ SUMMARY ═══════════════════════════════════════════════════════ */}
      <section aria-labelledby="waitlist-summary" className="min-w-0">
        <h2 id="waitlist-summary" className="sr-only">Waitlist figures</h2>

        <div className="overflow-hidden rounded-surface border border-border bg-card">
          <div className="grid gap-x-6 gap-y-5 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              icon={Clock} tone="pending"
              value={counts.waiting === null ? UNAVAILABLE : counts.waiting.toLocaleString('en-IN')}
              unavailable={counts.waiting === null}
              label="Waiting"
              sub={counts.waiting === null ? 'Count couldn’t be read' : `In the queue, oldest first`}
            />
            <Metric
              icon={MailCheck} tone="verify"
              value={counts.invited === null ? UNAVAILABLE : counts.invited.toLocaleString('en-IN')}
              unavailable={counts.invited === null}
              label="Invited"
              sub={counts.invited === null ? 'Count couldn’t be read' : 'Sent a link to register'}
            />
            <Metric
              icon={Users} tone="people"
              value={free === null ? UNAVAILABLE : free.toLocaleString('en-IN')}
              unavailable={free === null}
              label="Places free"
              sub={
                event.totalCapacity === null ? 'This event has no capacity limit'
                : free === null ? 'Registration figures couldn’t be read'
                : `of ${event.totalCapacity.toLocaleString('en-IN')} capacity`
              }
            />
            <Metric
              icon={ListChecks} tone="neutral"
              value={
                settings.waitlistLimit === null ? 'No limit'
                : summary.queueHeadroom === null ? UNAVAILABLE
                : summary.queueHeadroom.toLocaleString('en-IN')
              }
              unavailable={settings.waitlistLimit !== null && summary.queueHeadroom === null}
              label={settings.waitlistLimit === null ? 'Queue length' : 'Queue places left'}
              sub={
                settings.waitlistLimit === null ? 'The queue can grow without a cap'
                : `of a ${settings.waitlistLimit.toLocaleString('en-IN')} maximum`
              }
            />
          </div>

          {/* A rail is drawn only where a proportion exists — an uncapped queue has
              nothing to fill, and a dashed full-width rail there would read as empty. */}
          {settings.waitlistLimit !== null && (
            <div className="border-t border-border bg-muted/20 px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-fs-xs font-medium text-foreground">Queue used</p>
                {summary.queuePercent !== null && (
                  <p className="text-fs-xs font-semibold tabular-nums text-foreground">{summary.queuePercent}%</p>
                )}
              </div>
              <div className="mt-2">
                <Meter
                  percent={summary.queuePercent}
                  tone={summary.queuePercent === null ? 'neutral' : fillTone(summary.queuePercent)}
                  label={summary.queuePercent === null
                    ? 'How much of the queue limit is used is unavailable'
                    : `${summary.queuePercent}% of the queue limit used`}
                />
              </div>
              {summary.queuePercent !== null && summary.queuePercent > 100 && (
                <p className="mt-1.5 flex items-start gap-1.5 text-fs-2xs text-critical">
                  <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
                  More people are waiting than the limit allows — the limit was lowered afterwards.
                </p>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ══ FEEDBACK ══════════════════════════════════════════════════════ */}
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
      {notice && (
        <p role="status" className="flex items-start gap-2 rounded-surface border border-border bg-card px-3.5 py-2.5 text-fs-xs text-foreground">
          <CheckCircle2 className={cn('mt-px size-3.5 shrink-0', accent('verify').fg)} aria-hidden />
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message"
                  className="shrink-0 rounded-control p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            <X className="size-3.5" aria-hidden />
          </button>
        </p>
      )}

      {/* ══ THE QUEUE ═════════════════════════════════════════════════════ */}
      <section aria-labelledby="waitlist-people" className="min-w-0">
        <div className="overflow-hidden rounded-surface border border-border bg-card">
          {/* Toolbar */}
          <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center">
            <h2 id="waitlist-people" className="text-fs-sm font-semibold text-foreground sm:sr-only">
              People on the waitlist
            </h2>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="search" value={draft} onChange={e => setDraft(e.target.value)}
                placeholder={`Search by name, email or phone`}
                aria-label="Search the waitlist"
                className={cn(FIELD, 'h-11 pl-9 sm:h-9')}
              />
              {refreshing && (
                <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />
              )}
            </div>
            <button type="button" onClick={reload} disabled={refreshing}
                    className={cn(GHOST_BTN, 'shrink-0 sm:h-9')}>
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden />
              Refresh
            </button>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5" role="group" aria-label="Filter the waitlist by status">
            {WAITLIST_FILTERS.map(({ key, label }) => {
              const count = key === 'all'
                ? summary.everJoined
                : counts[key as WaitlistStatus]
              const on = filter === key
              return (
                <button
                  key={key} type="button" aria-pressed={on}
                  onClick={() => setParams({ wl: key === 'all' ? null : key })}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-pill border px-3 text-fs-xs font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    // The selected chip is marked by its TINT and its ring, not by brand
                    // text: `--primary-text` over a primary tint measures 4.43:1 in dark
                    // mode — just under AA — and a filter label is not decoration.
                    on ? 'border-primary/45 bg-primary/[0.12] font-semibold text-foreground'
                       : 'border-border bg-card text-muted-foreground hover:bg-muted',
                  )}
                >
                  {label}
                  <span className={cn('tabular-nums', on ? 'opacity-100' : 'opacity-70')}>
                    {count === null ? UNAVAILABLE : count.toLocaleString('en-IN')}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Search scope — the bound is stated, never hidden. */}
          {searching && searchInfo?.truncated && (
            <p className="flex items-start gap-1.5 border-b border-border px-4 py-2.5 text-fs-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Searched the {searchInfo.scanLimit.toLocaleString('en-IN')} people who joined
              earliest. There may be later matches this search did not reach — an exact email
              address finds anyone.
            </p>
          )}

          {/* ── Rows ─────────────────────────────────────────────────────── */}
          {rows.length === 0 ? (
            <div className="px-4 py-14 text-center">
              <span className={cn('mx-auto flex size-11 items-center justify-center rounded-surface', accent('neutral').tile)} aria-hidden>
                <Clock className="size-5" />
              </span>
              <p className="mt-4 text-fs-md font-semibold text-foreground">
                {waitlistEmptyMessage(filter, query, noun)}
              </p>
              <p className="mx-auto mt-1.5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
                {searching || filter !== 'all'
                  ? 'Other people may be on the waitlist under a different status.'
                  : copy.detail}
              </p>
              {(searching || filter !== 'all') && (
                <button type="button" onClick={() => setParams({ wl: null, wq: null })}
                        className={cn(GHOST_BTN, 'mt-4')}>
                  Show everyone
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Desktop: a real table, so a screen reader announces row and column. */}
              <div className="hidden overflow-x-auto xl:block">
                <table className="w-full min-w-[46rem] border-collapse text-left">
                  <caption className="sr-only">
                    People on the waitlist for this event, oldest first.{' '}
                    {showPosition ? 'The number before each name is their place in the queue. ' : ''}
                    {rows.length} shown.
                  </caption>
                  <thead>
                    <tr className="border-b border-border bg-muted/20">
                      <th scope="col" className="px-4 py-2.5 text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {showPosition ? 'Place · Name' : 'Name'}
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">Contact</th>
                      <th scope="col" className="px-4 py-2.5 text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">Wants</th>
                      <th scope="col" className="px-4 py-2.5 text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">Joined</th>
                      <th scope="col" className="px-4 py-2.5 text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                      <th scope="col" className="px-4 py-2.5 text-right text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map(row => (
                      <tr key={row.id} className={cn('align-top', busyId === row.id && 'opacity-60')}>
                        {/* The place number sits INSIDE the name cell rather than in a
                            column of its own: a separate column cost ~70px, which pushed
                            the action buttons behind a horizontal scroll at 1280 — and the
                            number belongs beside the person it refers to anyway. */}
                        <td className="max-w-[11rem] px-4 py-3">
                          <div className="flex min-w-0 items-center gap-2">
                            {showPosition && (
                              <span
                                title={row.position === null ? 'Not in the waiting queue' : `Place ${row.position} in the queue`}
                                className="inline-flex min-w-[1.75rem] shrink-0 justify-center rounded-control bg-muted px-1.5 py-0.5 text-fs-xs font-semibold tabular-nums text-muted-foreground"
                              >
                                {row.position ?? UNAVAILABLE}
                              </span>
                            )}
                            <span className="truncate text-fs-sm font-medium text-foreground">
                              {row.attendee.name || <span className="text-muted-foreground">Name not given</span>}
                            </span>
                          </div>
                        </td>
                        <td className="max-w-[13rem] px-4 py-3">
                          <p className="flex items-center gap-1.5 truncate text-fs-xs text-muted-foreground">
                            <Mail className="size-3 shrink-0" aria-hidden />
                            <span className="truncate">{row.attendee.email || UNAVAILABLE}</span>
                          </p>
                          {row.attendee.phone && (
                            <p className="mt-0.5 flex items-center gap-1.5 truncate text-fs-xs text-muted-foreground">
                              <Phone className="size-3 shrink-0" aria-hidden />
                              <span className="truncate">{row.attendee.phone}</span>
                            </p>
                          )}
                        </td>
                        <td className="max-w-[9rem] px-4 py-3">
                          <span className="block truncate text-fs-xs text-foreground">{row.passName || UNAVAILABLE}</span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-fs-xs text-muted-foreground">
                          <span title={formatJoinedAt(row.joinedAt, event.timezone)}>
                            {formatJoinedDay(row.joinedAt, event.timezone)}
                          </span>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={row.status} /></td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <RowActions row={row} busy={busyId === row.id}
                                      lifecycleStatus={event.lifecycleStatus}
                                      onPromote={() => void promote(row)}
                                      onRemove={() => void remove(row)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile / tablet: the same rows as cards. */}
              <ul className="divide-y divide-border xl:hidden">
                {rows.map(row => (
                  <li key={row.id} className={cn('min-w-0 p-4', busyId === row.id && 'opacity-60')}>
                    <div className="flex min-w-0 items-start gap-3">
                      {row.position !== null && (
                        <span className="mt-0.5 inline-flex min-w-[1.75rem] shrink-0 justify-center rounded-control bg-muted px-1.5 py-0.5 text-fs-xs font-semibold tabular-nums text-foreground">
                          {row.position}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <p className="min-w-0 break-words text-fs-sm font-semibold text-foreground">
                            {row.attendee.name || 'Name not given'}
                          </p>
                          <StatusBadge status={row.status} />
                        </div>
                        <p className="mt-1 break-all text-fs-xs text-muted-foreground">{row.attendee.email || UNAVAILABLE}</p>
                        {row.attendee.phone && (
                          <p className="text-fs-xs text-muted-foreground">{row.attendee.phone}</p>
                        )}
                        <p className="mt-1 text-fs-2xs text-muted-foreground">
                          {row.passName || UNAVAILABLE} · joined {formatJoinedDay(row.joinedAt, event.timezone)}
                        </p>
                        <div className="mt-3">
                          <RowActions row={row} busy={busyId === row.id}
                                      lifecycleStatus={event.lifecycleStatus}
                                      onPromote={() => void promote(row)}
                                      onRemove={() => void remove(row)} />
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* ── More ─────────────────────────────────────────────────────── */}
          {cursor && (
            <div className="border-t border-border px-4 py-3 text-center">
              <button type="button" onClick={() => void loadMore()} disabled={loadingMore}
                      className={cn(GHOST_BTN, 'mx-auto')}>
                {loadingMore
                  ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Loading</>
                  : <><ChevronDown className="size-4" aria-hidden /> Show more</>}
              </button>
            </div>
          )}
        </div>

        {/* The vocabulary, once — so a coloured pill never has to be guessed at. */}
        <p className="mt-3 text-fs-2xs leading-relaxed text-muted-foreground">
          <strong className="font-medium text-foreground">Waiting</strong> is in the queue and
          not yet contacted. <strong className="font-medium text-foreground">Invited</strong> has
          been emailed a link to register — RegisterDesk cannot tell whether they used it, so
          there is no &ldquo;accepted&rdquo; state.
          <strong className="font-medium text-foreground"> Removed</strong> was taken off the
          queue by an organizer. Promotion is manual: nobody is invited automatically when a
          place frees up.
          {readOnly && ' Entries can still be managed here while joins are switched off.'}
        </p>
      </section>
    </div>
  )
}

// ─── Row actions ──────────────────────────────────────────────────────────────

function RowActions({ row, busy, lifecycleStatus, onPromote, onRemove }: {
  row: WaitlistRow
  busy: boolean
  lifecycleStatus: string | null
  onPromote: () => void
  onRemove: () => void
}) {
  const promoteBlocked = promoteBlockedReason(row, lifecycleStatus)
  const removeBlocked  = removeBlockedReason(row, lifecycleStatus)

  // A button that is visible but cannot work explains itself. Server authorization is
  // still the authority — these are not the check, they are the courtesy.
  return (
    <div className="flex flex-wrap items-center justify-start gap-2 xl:flex-nowrap xl:justify-end">
      <button
        type="button" onClick={onPromote} disabled={busy || promoteBlocked !== null}
        title={promoteBlocked ?? undefined}
        aria-label={`Invite ${row.attendee.name || 'this person'} to register`}
        className={cn(ROW_BTN, 'border-transparent', accent('verify').tile)}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
        Invite
      </button>
      <button
        type="button" onClick={onRemove} disabled={busy || removeBlocked !== null}
        title={removeBlocked ?? undefined}
        aria-label={`Remove ${row.attendee.name || 'this person'} from the waitlist`}
        className={cn(ROW_BTN, 'border-border bg-card text-muted-foreground hover:bg-critical/10 hover:text-critical')}
      >
        <UserMinus className="size-3.5" aria-hidden />
        Remove
      </button>
    </div>
  )
}
