'use client'

// Global Command Palette (Phase H.4.2) — a pure orchestration layer.
//
// Ctrl/⌘+K opens a keyboard-driven palette that REUSES existing routes, tabs,
// APIs and action services. It creates no pages and duplicates no business
// logic: navigation goes through next/navigation, event tabs deep-link via the
// existing ManageEventClient (?tab= / same-page event), attendee/event search
// hit existing organizer APIs, and safe actions call the existing event routes.
//
// Reversible actions (duplicate / close / reopen / unpublish) run inline after a
// one-tap confirm; destructive actions (cancel / complete / archive) route the
// user to the event's existing confirmation flow instead of firing blindly.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { CalendarDays, CornerDownLeft, Loader2, Search, User2, X } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import { rankBy } from '@/lib/commandPalette/fuzzy'
import { useCommandData } from '@/lib/commandPalette/useCommandData'
import { OPEN_EVENT, SET_TAB_EVENT, REFRESH_EVENT } from '@/lib/commandPalette/bridge'
import {
  buildNavigationCommands, buildEventTabCommands, buildEventActionCommands,
  commandStrings, type PaletteCommand,
} from '@/lib/commandPalette/registry'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type { EventListItem } from '@/app/api/organizer/events/route'
import type { AttendeeSearchResult } from '@/app/api/organizer/events/[eventId]/checkin/search/route'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function eventIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/dashboard\/events\/([^/]+)/)
  if (!m) return null
  const id = m[1]!
  return id === 'new' ? null : id
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CommandPalette() {
  const router   = useRouter()
  const pathname = usePathname()
  const { showToast } = useToast()
  const [open, setOpen]           = useState(false)
  const { perms, loadEvents, searchAttendees } = useCommandData(open)

  const [query, setQuery]         = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [pending, setPending]     = useState<PaletteCommand | null>(null)  // reversible-action inline confirm
  const [busy, setBusy]           = useState(false)

  const [eventDetail, setEventDetail]       = useState<EventDetailResponse | null>(null)
  const [eventResults, setEventResults]     = useState<EventListItem[]>([])
  const [attendeeResults, setAttendeeResults] = useState<AttendeeSearchResult[]>([])

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef  = useRef<HTMLDivElement>(null)

  const currentEventId = useMemo(() => eventIdFromPath(pathname), [pathname])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setPending(null)
    setActiveIdx(0)
    setEventResults([])
    setAttendeeResults([])
  }, [])

  const openReset = useCallback(() => {
    setQuery('')
    setPending(null)
    setActiveIdx(0)
    setEventResults([])
    setAttendeeResults([])
    setOpen(true)
  }, [])

  // ── Global ⌘/Ctrl+K + external open events ──────────────────────────────────
  // Reset/open state is only ever touched inside these callbacks (never
  // synchronously in an effect body), so opening starts from a clean slate.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        if (open) close(); else openReset()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, openReset)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, openReset)
    }
  }, [open, close, openReset])

  // ── Focus the input when opened ─────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // ── Load the current event's detail for context (lifecycle + type + name) ───
  // Stale detail from a previously-viewed event is ignored in the memo below via
  // a draftId guard, so there is no need to null it synchronously here.
  useEffect(() => {
    if (!open || !currentEventId) return
    let cancelled = false
    void (async () => {
      const user = auth.currentUser
      if (!user) return
      const token = await user.getIdToken()
      const res = await fetch(`/api/organizer/events/${currentEventId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok || cancelled) return
      setEventDetail(await res.json() as EventDetailResponse)
    })()
    return () => { cancelled = true }
  }, [open, currentEventId])

  // ── Debounced dynamic search (events + attendees) ───────────────────────────
  // All result-state writes happen inside the timeout callback (never
  // synchronously in the effect body).
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    let cancelled = false
    const timer = setTimeout(async () => {
      if (!q) { setEventResults([]); setAttendeeResults([]); return }
      const events = await loadEvents()
      if (cancelled) return
      setEventResults(rankBy(q, events, e => [e.name, e.slug ?? '', e.tagline ?? '']).slice(0, 6))
      if (currentEventId && q.length >= 2) {
        const att = await searchAttendees(currentEventId, q)
        if (!cancelled) setAttendeeResults(att.slice(0, 6))
      } else {
        setAttendeeResults([])
      }
    }, 160)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, open, currentEventId, loadEvents, searchAttendees])

  // ── Command context (this-event tabs + gated safe actions) ──────────────────
  const contextCommands = useMemo<PaletteCommand[]>(() => {
    if (!currentEventId) return []
    // Ignore detail still belonging to a previously-viewed event.
    const detail  = eventDetail?.draftId === currentEventId ? eventDetail : null
    const name    = detail?.name
    const tabs    = buildEventTabCommands(currentEventId, detail?.eventType, name)
    const actions = detail
      ? buildEventActionCommands(currentEventId, detail.lifecycleStatus, name)
          .filter(a => !a.permission || perms.has(a.permission))
      : []
    return [...tabs, ...actions]
  }, [currentEventId, eventDetail, perms])

  // ── Dynamic record commands (events + attendees) ────────────────────────────
  const dynamicCommands = useMemo<PaletteCommand[]>(() => {
    const evts = eventResults.map<PaletteCommand>(e => ({
      id:       `event:${e.draftId}`,
      title:    e.name,
      subtitle: `Open event · ${e.lifecycleStatus}`,
      group:    'Events',
      keywords: [],
      icon:     CalendarDays,
      kind:     'navigate',
      href:     `/dashboard/events/${e.draftId}`,
    }))
    const atts = attendeeResults.map<PaletteCommand>(a => ({
      id:       `attendee:${a.id}`,
      title:    a.attendeeName || a.attendeeEmail,
      subtitle: `${a.attendeeEmail}${a.passName ? ` · ${a.passName}` : ''}`,
      group:    'Attendees',
      keywords: [],
      icon:     User2,
      kind:     'navigate',
      href:     `/dashboard/events/${currentEventId}?tab=registrations`,
    }))
    return [...evts, ...atts]
  }, [eventResults, attendeeResults, currentEventId])

  // ── Final ordered result list ───────────────────────────────────────────────
  const results = useMemo<PaletteCommand[]>(() => {
    const nav = buildNavigationCommands()
    if (!query.trim()) {
      return [...contextCommands, ...nav]                       // default: context first, then all nav
    }
    const ranked = rankBy(query, [...contextCommands, ...nav], commandStrings)
    return [...ranked, ...dynamicCommands]                      // matched commands, then live records
  }, [query, contextCommands, dynamicCommands])

  // Clamp the highlight into range as results shrink (derived, not effect state).
  const safeIdx = results.length ? Math.min(activeIdx, results.length - 1) : 0

  // Scroll the active row into view.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${safeIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [safeIdx, open])

  // ── Execute a command ───────────────────────────────────────────────────────
  const run = useCallback((cmd: PaletteCommand) => {
    switch (cmd.kind) {
      case 'navigate':
        if (cmd.newTab) window.open(cmd.href!, '_blank', 'noopener,noreferrer')
        else router.push(cmd.href!)
        close()
        break
      case 'event-tab':
        if (cmd.eventId === currentEventId) {
          window.dispatchEvent(new CustomEvent(SET_TAB_EVENT, { detail: { eventId: cmd.eventId, tab: cmd.tab } }))
        } else {
          router.push(`/dashboard/events/${cmd.eventId}?tab=${cmd.tab}`)
        }
        close()
        break
      case 'event-action':
        if (cmd.destructive) {
          router.push(`/dashboard/events/${cmd.eventId}`)
          showToast('Confirm this action on the event page.', 'info')
          close()
        } else {
          setPending(cmd)                                       // reversible → inline confirm
        }
        break
    }
  }, [router, currentEventId, close, showToast])

  // ── Perform a confirmed reversible action (reuse existing routes) ───────────
  const performAction = useCallback(async (cmd: PaletteCommand) => {
    setBusy(true)
    try {
      const user = auth.currentUser
      if (!user) { showToast('You must be signed in.', 'error'); return }
      const token = await user.getIdToken()

      if (cmd.action === 'duplicate') {
        const res  = await fetch(`/api/organizer/events/${cmd.eventId}/duplicate`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` },
        })
        const json = await res.json() as { success: boolean; draftId?: string; error?: string }
        if (json.success && json.draftId) {
          showToast('Event duplicated.', 'success')
          router.push(`/dashboard/events/new/visibility?draftId=${json.draftId}`)
        } else {
          showToast(json.error ?? 'Duplication failed', 'error')
        }
      } else {
        const res  = await fetch(`/api/organizer/events/${cmd.eventId}/status`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: cmd.action }),
        })
        const json = await res.json() as { success: boolean; error?: string }
        if (json.success) {
          showToast('Event updated.', 'success')
          window.dispatchEvent(new CustomEvent(REFRESH_EVENT, { detail: { eventId: cmd.eventId } }))
        } else {
          showToast(json.error ?? 'Action failed', 'error')
        }
      }
    } catch {
      showToast('Network error. Please try again.', 'error')
    } finally {
      setBusy(false)
      setPending(null)
      close()
    }
  }, [router, showToast, close])

  // ── Keyboard handling within the palette ────────────────────────────────────
  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape')      { e.preventDefault(); close(); return }
    if (pending) return          // in confirm mode, arrows/enter are handled by buttons
    if (e.key === 'ArrowDown')   { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp'){ e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter')  {
      e.preventDefault()
      const cmd = results[safeIdx]
      if (cmd) run(cmd)
    }
  }

  // GA-7D S1: reuse the shared focus trap (Tab stays in the palette; focus restores to
  // the trigger on close). Escape closes from anywhere — the input already handled it;
  // this also covers focus landing on a result row.
  const trapRef = useFocusTrap<HTMLDivElement>(open)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  return (
    <div
      ref={trapRef}
      className="fixed inset-0 z-[300] flex items-start justify-center px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={close} aria-hidden />

      {/* Panel */}
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        {/* Search input */}
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIdx(0) }}
            onKeyDown={onInputKeyDown}
            placeholder="Search pages, events, actions…"
            aria-label="Search commands"
            className="h-12 flex-1 bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <button
            type="button"
            onClick={close}
            aria-label="Close command palette"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Inline confirm for a reversible action */}
        {pending ? (
          <div className="p-5">
            <p className="text-[14px] font-semibold text-foreground">{pending.title}?</p>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {pending.subtitle} · This runs immediately through the existing event service.
            </p>
            <div className="mt-4 flex gap-2.5">
              <button
                type="button"
                onClick={() => setPending(null)}
                disabled={busy}
                className="flex-1 rounded-xl border border-border bg-card px-4 py-2.5 text-[13px] font-medium hover:bg-muted/60 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void performAction(pending)}
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-[13px] font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? 'Working…' : 'Confirm'}
              </button>
            </div>
          </div>
        ) : (
          /* Results */
          <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
            {results.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                No matches for “{query}”.
              </p>
            ) : (
              results.map((cmd, idx) => {
                const prev      = results[idx - 1]
                const showGroup = !prev || prev.group !== cmd.group
                const Icon      = cmd.icon
                const active    = idx === safeIdx
                return (
                  <div key={cmd.id}>
                    {showGroup && (
                      <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                        {cmd.group}
                      </p>
                    )}
                    <button
                      type="button"
                      data-idx={idx}
                      onMouseMove={() => setActiveIdx(idx)}
                      onClick={() => run(cmd)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2 text-left text-[13.5px] transition-colors',
                        active ? 'bg-muted text-foreground' : 'text-foreground/90 hover:bg-muted/50',
                      )}
                    >
                      {Icon
                        ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        : <span className="size-4 shrink-0" aria-hidden />}
                      <span className="min-w-0 flex-1 truncate">{cmd.title}</span>
                      {cmd.subtitle && (
                        <span className="shrink-0 truncate text-[12px] text-muted-foreground">{cmd.subtitle}</span>
                      )}
                      {active && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                    </button>
                  </div>
                )
              })
            )}
          </div>
        )}

        {/* Footer hint */}
        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span><kbd className="rounded border border-border bg-muted px-1">↑</kbd> <kbd className="rounded border border-border bg-muted px-1">↓</kbd> navigate</span>
          <span><kbd className="rounded border border-border bg-muted px-1">↵</kbd> select</span>
          <span><kbd className="rounded border border-border bg-muted px-1">esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
