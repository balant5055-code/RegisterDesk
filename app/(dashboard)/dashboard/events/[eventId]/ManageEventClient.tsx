'use client'

// RD-EVENT-05 · The event workspace shell.
//
// ═══ WHAT CHANGED, AND WHY ═══════════════════════════════════════════════════
//
// 1. NAVIGATION IS THE URL. `activeTab` was `useState` + `setActiveTab`, so clicking
//    a tab changed nothing about the address. Refresh returned to whatever the URL
//    still said, Back left the page entirely, and no tab could be shared or
//    cmd-clicked. The active tab is now DERIVED from `?tab=`, and every tab is a real
//    anchor, so all four behaviours come for free.
//
// 2. REGISTRATIONS ARE FETCHED ONLY WHEN A TAB NEEDS THEM. The shell fetched
//    `/registrations` on mount unconditionally — 51 registration documents, carrying
//    attendee PII, downloaded to open Setup, Passes, Coupons, Certificates or any of
//    the other fourteen tabs that never read them. It is now fetched for the four
//    tabs that actually consume it, once, and kept.
//
// 3. FAILURES ARE ISOLATED. A registrations failure was swallowed by `if (regRes.ok)`,
//    so a genuine error rendered as "No registration data available" — identical to a
//    draft event with none. And an event-load failure replaced the whole page,
//    discarding the header and the tab bar with it.
//
// ═══ RD-EVENT-09 · ONE LANDING ═══════════════════════════════════════════════
// `activeTab` is now `EventTabKey | null`, and `null` means the ROOT — the Event
// Command Center. It is not a tab and has no `?tab=` value; it is the event route
// itself. The `home` and `overview` tabs it replaced are gone, and the old root-only
// `EventOverviewClient` chrome with them, so the shell no longer changes shape
// depending on whether a query string happens to be present.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertCircle, RotateCw } from 'lucide-react'
import { TextLink } from '@/components/ui'
import { useAuth } from '@/components/auth/AuthProvider'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type { RegistrationsApiResponse } from '@/app/api/organizer/events/[eventId]/registrations/route'
import { EVENT_TABS, applyIdentifierLabel, isValidEventTab, isRetiredEventTab, type EventTabKey } from '@/lib/events/eventTabs'
import { visibleEventTabs, isEventTabReachable } from '@/lib/events/eventCapabilities'
import { useFeatureFlags } from '@/lib/config/featureFlagsClient'
import { useWorkspacePermissions } from '@/lib/hooks/useWorkspacePermissions'
import { SET_TAB_EVENT, REFRESH_EVENT } from '@/lib/commandPalette/bridge'
import EventCommandHeader from './EventCommandHeader'
import EventCommandCenter from './EventCommandCenter'
import { EventTabsBar, tabId, tabPanelId, ROOT_TAB_ID } from './EventTabsBar'
import SetupCenterTab     from './tabs/SetupCenterTab'
import RegistrationsTab   from './tabs/RegistrationsTab'
import PassesTab          from './tabs/PassesTab'
import CommunicationsTab  from './tabs/CommunicationsTab'
import ReportsTab         from './tabs/ReportsTab'
import SettingsTab        from './tabs/SettingsTab'
import AttendanceTab      from './tabs/AttendanceTab'
import CertificatesTab    from './tabs/CertificatesTab'
import CouponsTab         from './tabs/CouponsTab'
import WaitlistTab        from './tabs/WaitlistTab'
import SportsTab                from './tabs/SportsTab'
import ExhibitionTab            from './tabs/ExhibitionTab'
import NominationsTab           from './tabs/NominationsTab'
import SpeakerApplicationsTab   from './tabs/SpeakerApplicationsTab'
import SponsorApplicationsTab   from './tabs/SponsorApplicationsTab'
import ConferenceTab            from './tabs/ConferenceTab'

type TabKey = EventTabKey

/**
 * The ONLY tabs that read the registration list.
 *
 * Kept here rather than in the shared tab registry: that file documents itself as
 * presentation metadata with no data access, and the Command Palette which also reads
 * it has no interest in fetch planning.
 */
const TABS_NEEDING_REGISTRATIONS = new Set<TabKey>([
  'registrations', 'reports',
])

/**
 * Does the current view read the registration list?
 *
 * RD-EVENT-09 · `null` — the Event Command Center — does, for its status distribution
 * and its "Recent registrations" section. It reuses the ONE page the shell already
 * fetches rather than issuing a second registrations request of its own; the trend and
 * the setup signals it also shows are server-side aggregates that transfer no documents.
 *
 * The retired `overview` tab is deliberately absent from the set above: RD-EVENT-07
 * moved it onto aggregates, and that stays true of the trend inside the command center.
 */
function viewNeedsRegistrations(tab: TabKey | null): boolean {
  return tab === null || TABS_NEEDING_REGISTRATIONS.has(tab)
}

/** The only error codes the shell recognises; anything else becomes `unavailable`. */
const KNOWN_ERRORS = new Set(['not-found', 'forbidden', 'signed-out', 'unavailable'])

// ─── Skeletons ────────────────────────────────────────────────────────────────

function HeroSkeleton() {
  return (
    <div className="border-b border-border" aria-busy="true" aria-live="polite">
      <div className="flex flex-col gap-3 px-4 py-4 sm:px-6 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex items-center gap-2">
            <div className="h-6 w-56 max-w-full animate-pulse rounded-control bg-muted" />
            <div className="h-5 w-20 animate-pulse rounded-pill bg-muted" />
          </div>
          <div className="h-3.5 w-72 max-w-full animate-pulse rounded bg-muted" />
          <div className="flex flex-wrap gap-1.5">
            {[80, 120, 160].map(w => <div key={w} className="h-5 animate-pulse rounded-pill bg-muted" style={{ width: w }} />)}
          </div>
          <div className="h-4 w-64 max-w-full animate-pulse rounded bg-muted" />
        </div>
        <div className="flex shrink-0 gap-2">
          {[0, 1, 2].map(i => <div key={i} className="h-9 w-28 animate-pulse rounded-control bg-muted" />)}
        </div>
      </div>
      <span className="sr-only">Loading event…</span>
    </div>
  )
}

function TabSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      {[0, 1, 2, 3].map(i => <div key={i} className="h-20 animate-pulse rounded-surface bg-muted" />)}
      <span className="sr-only">Loading…</span>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ManageEventClient({ eventId, initialTab }: { eventId: string; initialTab?: string }) {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const { user, token: authToken, getToken } = useAuth()
  const token = authToken ?? ''

  // Capability inputs. Both are already in memory for this page: `useFeatureFlags` reads
  // the business-config context, and `useWorkspacePermissions` shares a module-level cache
  // with the sidebar. Neither adds a request. While permissions are still loading `has()`
  // answers optimistically, so the bar never flashes a shortened list.
  const flags = useFeatureFlags()
  const perms = useWorkspacePermissions(true)

  const [event,   setEvent]   = useState<EventDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // Registration data is its own concern: its own loading flag, its own error, and it
  // is only ever requested by a tab that reads it.
  const [regData,  setRegData]  = useState<RegistrationsApiResponse | null>(null)
  const [regState, setRegState] = useState<'idle' | 'loading' | 'ok' | 'error' | 'forbidden'>('idle')

  /**
   * The active tab IS the URL. `initialTab` seeds only the very first paint (the server
   * already parsed it), after which `?tab=` is the single source — so there is no second
   * copy of this state to fall out of sync.
   */
  //
  // RD-EVENT-09 · `null` = the Event Command Center, the root route. An unrecognised
  // `?tab=` value also lands here rather than on an error, because the command center is
  // a complete, correct page for "this event" no matter how the reader arrived.
  const urlTab = searchParams.get('tab') ?? initialTab
  const requestedTab: TabKey | null = isValidEventTab(urlTab) ? urlTab : null

  const rootHref = useMemo(
    () => `/dashboard/events/${encodeURIComponent(eventId)}`,
    [eventId],
  )
  const hrefFor = useCallback(
    (k: TabKey) => `/dashboard/events/${encodeURIComponent(eventId)}?tab=${k}`,
    [eventId],
  )

  // ── Which sections this event actually has ────────────────────────────────
  //
  // RD-EVENT-16 · the bar used to show every tab in `EVENT_TABS` regardless of what the
  // organizer had configured — a Waitlist tab on an event with no waitlist, a Speakers
  // tab on an event that never invited speaker applications. `visibleEventTabs` is the
  // single resolver; the More menu (which is just the overflow of this list), the routing
  // fallback below and the Command Palette all read the same answer.
  //
  // ZERO network cost: `flags` comes from the business-config context the shell already
  // has, `perms` from a module-cached workspace fetch the dashboard already made, and the
  // capability fields ride on the event detail this component already loaded.
  const capabilityCtx = useMemo(() => ({
    eventType:         event?.eventType ?? null,
    registrationRules: event?.registrationRules ?? null,
    applications:      event?.applications ?? null,
    gate:              { flags, has: perms.has },
  }), [event?.eventType, event?.registrationRules, event?.applications, flags, perms])

  // RD-BIB-UX-04 · the workspace tab reads in the event's own vocabulary — "BIB
  // Numbers", "Delegate Numbers" — rather than the generic "Identifiers" the shell
  // used to show beside a workspace that called itself something else. The noun is
  // data; a missing label leaves the tab exactly as it was.
  const visibleTabs = useMemo(
    () => visibleEventTabs(applyIdentifierLabel(EVENT_TABS, event?.identifierLabel), capabilityCtx),
    [capabilityCtx, event?.identifierLabel],
  )

  /**
   * A `?tab=` that this event does not have resolves to the Event Command Center.
   *
   * RD-EVENT-16 · exactly the treatment an unrecognised tab key already received, and for
   * the same reason: the command center is a complete, correct page for "this event" no
   * matter how the reader arrived. It is NOT an error, and NOT a security boundary —
   * every route re-checks server-side.
   *
   * The fallback waits for the event to load. Until then the capability context is empty,
   * and resolving against it would bounce a perfectly valid deep link off its own tab.
   */
  const activeTab: TabKey | null = event === null || isEventTabReachable(requestedTab, EVENT_TABS, capabilityCtx)
    ? requestedTab
    : null

  // Keep the address bar honest: a deep link to a section this event does not have should
  // not leave `?tab=` sitting in the URL describing a page that is not on screen.
  useEffect(() => {
    if (event === null) return
    if (requestedTab !== null && activeTab === null) {
      router.replace(rootHref, { scroll: false })
    }
  }, [event, requestedTab, activeTab, router, rootHref])

  /** The DOM id half of the tab/panel pair — the root uses a name, not a tab key. */
  const panelKey = activeTab ?? ROOT_TAB_ID

  // ── Event detail ────────────────────────────────────────────────────────────
  const loadEvent = useCallback(async (tok: string) => {
    const res = await fetch(`/api/organizer/events/${encodeURIComponent(eventId)}`, {
      headers: { Authorization: `Bearer ${tok}` },
      cache: 'no-store',
    })
    if (res.status === 404) throw new Error('not-found')
    if (res.status === 403) throw new Error('forbidden')
    if (!res.ok) throw new Error('unavailable')
    return await res.json() as EventDetailResponse
  }, [eventId])

  useEffect(() => {
    if (user === undefined) return
    let cancelled = false

    const run = async () => {
      if (!user) { setError('signed-out'); setLoading(false); return }
      setLoading(true)
      setError(null)
      try {
        const tok = await getToken()
        if (cancelled || !tok) return
        const data = await loadEvent(tok)
        if (cancelled) return
        setEvent(data)
      } catch (e) {
        // Normalised to a known code at the boundary. A raw message (a network
        // TypeError, a provider string) must never reach this state, even though the
        // renderer only ever uses it to pick fixed copy.
        if (!cancelled) {
          const code = e instanceof Error ? e.message : ''
          setError(KNOWN_ERRORS.has(code) ? code : 'unavailable')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [user, getToken, loadEvent, refreshKey])

  // ── Registrations, on demand ────────────────────────────────────────────────
  //
  // Requested the first time a tab that reads them becomes active, then kept. A
  // failure marks THIS dataset unavailable and leaves the rest of the shell working.
  const needsReg = viewNeedsRegistrations(activeTab)

  /**
   * RD-EVENT-12 · Which SHAPE of the registrations dataset this view needs.
   *
   * The Registrations tab is a summary surface — it shows counters and hands the
   * organizer to the Registration Manager. It used to receive the same 51-document page
   * as everything else, fifty attendees' names and email addresses, to render a
   * five-row decorative preview. `?view=summary` returns the identical counter-backed
   * `stats` and NO rows, so opening that tab now transfers no attendee PII at all.
   *
   * The mode is part of the load key, so moving between a summary view and a row view
   * refetches the shape the new view actually needs rather than reusing the wrong one.
   *
   * RD-REPORT-02 · Reports joins it, for the same reason and one worse symptom. The tab
   * renders only aggregates, but it was receiving a 50-row page and COUNTING IT — so an
   * event with 1,200 registrations reported 50, directly beneath a header that read 1,052.
   * Summary mode answers with counter-backed totals and a per-pass breakdown over the
   * whole event, and transfers no attendee rows at all.
   */
  const regMode: 'rows' | 'summary' =
    activeTab === 'registrations' || activeTab === 'reports' ? 'summary' : 'rows'

  /**
   * Which load this dataset currently belongs to.
   *
   * RD-EVENT-09 · This was a plain `requested` boolean plus a per-effect `cancelled` flag,
   * and the combination had two defects that browser QA made visible:
   *
   *   • The boolean was set BEFORE the request resolved, and the cleanup then discarded
   *     the response. Any re-run of the effect — React's development double-invoke is the
   *     reliable one — left the flag set and the data thrown away, so the page showed
   *     "—" against a request that had in fact succeeded.
   *   • `retryRegistrations` cleared the flag but changed nothing the effect depends on,
   *     so the "Try again" button never issued a second request at all.
   *
   * Keying on the TARGET rather than on the effect instance fixes both: a re-run for the
   * same target is a no-op that leaves the in-flight request free to commit, a retry is a
   * new target, and a response whose target is no longer current is ignored — which is
   * the only thing the cancellation was ever for.
   */
  const regKey     = useRef('')
  const [regAttempt, setRegAttempt] = useState(0)

  useEffect(() => {
    if (!needsReg || !token) return
    const key = `${eventId}|${regMode}|${regAttempt}`
    if (regKey.current === key) return
    regKey.current = key

    setRegState('loading')
    void (async () => {
      try {
        const res = await fetch(
          `/api/organizer/events/${encodeURIComponent(eventId)}/registrations${regMode === 'summary' ? '?view=summary' : ''}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
        )
        if (regKey.current !== key) return          // superseded by a newer load
        // A draft event answers 403 by design — that is "not open yet", not a fault.
        if (res.status === 403) { setRegState('forbidden'); return }
        if (!res.ok) { setRegState('error'); return }
        const data = await res.json() as RegistrationsApiResponse
        if (regKey.current !== key) return
        setRegData(data)
        setRegState('ok')
      } catch {
        if (regKey.current === key) setRegState('error')
      }
    })()
  }, [needsReg, token, eventId, regMode, regAttempt])

  // A lifecycle action can change the registration picture, so the next view that needs
  // it asks again rather than showing a figure from before the action.
  const refresh = useCallback(() => {
    setRegData(null)
    setRegState('idle')
    setRegAttempt(a => a + 1)
    setRefreshKey(k => k + 1)
  }, [])

  const retryRegistrations = useCallback(() => {
    setRegState('idle')
    setRegAttempt(a => a + 1)
  }, [])

  // ── Command Palette bridge ──────────────────────────────────────────────────
  // The palette can switch tabs on this already-mounted page. It now navigates, so the
  // address bar agrees with the palette instead of drifting from it.
  useEffect(() => {
    function onSetTab(e: Event) {
      const detail = (e as CustomEvent).detail as { eventId?: string; tab?: string } | undefined
      if (detail?.eventId !== eventId) return
      if (isValidEventTab(detail.tab)) {
        router.push(hrefFor(detail.tab), { scroll: false })
      } else if (isRetiredEventTab(detail.tab)) {
        // A stale palette entry from a session opened before RD-EVENT-09 still lands
        // somewhere correct instead of doing nothing.
        router.push(rootHref, { scroll: false })
      }
    }
    function onRefresh(e: Event) {
      const detail = (e as CustomEvent).detail as { eventId?: string } | undefined
      if (detail?.eventId === eventId) refresh()
    }
    window.addEventListener(SET_TAB_EVENT, onSetTab)
    window.addEventListener(REFRESH_EVENT, onRefresh)
    return () => {
      window.removeEventListener(SET_TAB_EVENT, onSetTab)
      window.removeEventListener(REFRESH_EVENT, onRefresh)
    }
  }, [eventId, router, hrefFor, rootHref, refresh])

  const listRef = useRef<HTMLDivElement>(null)

  // Arrow / Home / End move between tabs, following the APG tab pattern. Selection
  // follows focus because switching is cheap and reversible — same as a click.
  //
  // RD-EVENT-09 · The root (command center) is position 0 in the ring. It is a real tab
  // stop, so a keyboard user can walk back to the front of the workspace the same way
  // they walk anywhere else in the bar.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const order: (TabKey | null)[] = [null, ...visibleTabs.map(t => t.key)]
    const i = order.indexOf(activeTab)
    if (i < 0) return
    let next: number
    switch (e.key) {
      case 'ArrowRight': next = (i + 1) % order.length; break
      case 'ArrowLeft':  next = (i - 1 + order.length) % order.length; break
      case 'Home':       next = 0; break
      case 'End':        next = order.length - 1; break
      default: return
    }
    e.preventDefault()
    const key = order[next]
    router.push(key === null ? rootHref : hrefFor(key), { scroll: false })
    listRef.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(tabId(key ?? ROOT_TAB_ID))}`)
      ?.focus()
  }

  // ── Whole-event failure ─────────────────────────────────────────────────────
  // Only these genuinely leave nothing to render. Everything else degrades in place.
  if (!loading && error) {
    const copy = error === 'not-found' || error === 'forbidden'
      // Deliberately the SAME message for both: telling an unauthorised caller that an
      // event exists is itself a disclosure.
      ? { title: 'Event not available',
          body: 'This event does not exist in your workspace, or your access to it was removed.' }
      : error === 'signed-out'
        ? { title: 'You are signed out', body: 'Sign in again to manage this event.' }
        : { title: "Couldn't load this event", body: 'Something went wrong while loading this event.' }

    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-pill bg-destructive/10">
          <AlertCircle className="size-6 text-destructive" aria-hidden />
        </div>
        <div>
          <p className="text-fs-md font-semibold text-foreground">{copy.title}</p>
          <p className="mt-1 text-fs-sm text-muted-foreground">{copy.body}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          {error !== 'not-found' && error !== 'forbidden' && (
            <button
              type="button"
              onClick={() => setRefreshKey(k => k + 1)}
              className="inline-flex h-11 items-center gap-1.5 rounded-control border border-border px-3 text-fs-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <RotateCw className="size-3.5" aria-hidden /> Try again
            </button>
          )}
          <TextLink href="/dashboard/events">← Back to Events</TextLink>
        </div>
      </div>
    )
  }

  const regUnavailable = regState === 'error'

  return (
    <div>
      {loading && !event ? <HeroSkeleton /> : event ? (
        <EventCommandHeader event={event} eventId={eventId} token={token} onSuccess={refresh} />
      ) : null}

      {/* ── Tab navigation ─────────────────────────────────────────────────── */}
      {/* RD-EVENT-08 · The bar measures itself and moves whatever does not fit into a
          "More" menu, rather than hiding it behind a horizontal scroll with no
          affordance. Every tab is still a real anchor. */}
      <div ref={listRef} onKeyDown={onKeyDown}>
        <EventTabsBar tabs={visibleTabs} active={activeTab} rootHref={rootHref} hrefFor={hrefFor} />
      </div>

      {/* ── Panel content ──────────────────────────────────────────────────── */}
      <div
        id={tabPanelId(panelKey)}
        role="tabpanel"
        aria-labelledby={tabId(panelKey)}
        tabIndex={-1}
        className="min-w-0 p-5 focus:outline-none sm:p-6"
      >
        {loading && !event ? <TabSkeleton /> : event ? (
          <>
            {/* One quiet line when the registration dataset failed — the tab below still
                renders everything it can, and the failure is never shown as "none". */}
            {/* The command center is excluded from both the shell-level banner and the
                shell-level skeleton: it consumes the same dataset but degrades section by
                section, so a registrations failure must not blank its readiness, trend or
                schedule, and it owns its own retry. */}
            {activeTab !== null && needsReg && regUnavailable && (
              <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 rounded-control border border-border bg-muted/30 px-3 py-2">
                <p className="min-w-0 flex-1 text-fs-xs text-muted-foreground">
                  Registration data couldn&apos;t be loaded. Figures that depend on it are
                  unavailable — they are not zero.
                </p>
                <button
                  type="button"
                  onClick={retryRegistrations}
                  className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-fs-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <RotateCw className="size-3.5" aria-hidden /> Try again
                </button>
              </div>
            )}

            {activeTab !== null && needsReg && regState === 'loading' ? <TabSkeleton /> : (
              <>
                {activeTab === null && (
                  <EventCommandCenter
                    event={event}
                    regData={regData}
                    regState={regState}
                    token={token}
                    onRetryRegistrations={retryRegistrations}
                  />
                )}
                {activeTab === 'setup' && (
                  <SetupCenterTab event={event} token={token} />
                )}
                {activeTab === 'attendance' && <AttendanceTab eventId={eventId} token={token} event={event} />}
                {activeTab === 'registrations' && (
                  // RD-EVENT-12 · A draft answers 403 by design — registration has not
                  // opened, which is a state, not a fault. Everything else the tab
                  // renders itself from counters, including the unavailable case, so it
                  // takes `regData` directly rather than being replaced by a placeholder.
                  regState === 'forbidden' || event.status === 'draft' ? (
                    <div className="rounded-surface border border-dashed border-border py-16 text-center">
                      <p className="text-fs-sm font-semibold text-foreground">
                        Publish this event to start taking registrations
                      </p>
                      <p className="mx-auto mt-1 max-w-sm text-fs-sm text-muted-foreground">
                        Registrations and the Registration Manager open once the event is live.
                      </p>
                    </div>
                  ) : (
                    <RegistrationsTab data={regData} eventId={eventId} />
                  )
                )}
                {activeTab === 'passes' && <PassesTab event={event} />}
                {activeTab === 'coupons' && <CouponsTab event={event} token={token} />}
                {activeTab === 'waitlist' && <WaitlistTab event={event} token={token} />}
                {activeTab === 'conference' && <ConferenceTab event={event} token={token} />}
                {activeTab === 'sports' && <SportsTab eventId={eventId} token={token} />}
                {activeTab === 'exhibition' && <ExhibitionTab eventId={eventId} token={token} />}
                {activeTab === 'nominations' && <NominationsTab eventId={eventId} token={token} />}
                {activeTab === 'speaker-applications' && <SpeakerApplicationsTab eventId={eventId} token={token} />}
                {activeTab === 'sponsor-applications' && <SponsorApplicationsTab eventId={eventId} token={token} />}
                {activeTab === 'communications' && <CommunicationsTab event={event} token={token} />}
                {activeTab === 'reports' && (
                  <ReportsTab event={event} data={regData} eventId={eventId} />
                )}
                {activeTab === 'certificates' && (
                  <CertificatesTab eventId={eventId} token={token} eventSlug={event?.slug} />
                )}
                {activeTab === 'settings' && (
                  <SettingsTab event={event} eventId={eventId} token={token} onSuccess={refresh} />
                )}
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
