'use client'

import { useState, useEffect, useCallback } from 'react'
import Link                                  from 'next/link'
import { TextLink } from '@/components/ui'
import { onAuthStateChanged, onIdTokenChanged } from 'firebase/auth'
import { auth }                              from '@/lib/firebase/auth'
import { cn }                               from '@/lib/utils/cn'
import { AlertCircle, ChevronLeft }         from 'lucide-react'
import type { EventDetailResponse }      from '@/app/api/organizer/events/[eventId]/route'
import type { RegistrationsApiResponse } from '@/app/api/organizer/events/[eventId]/registrations/route'
import { EVENT_TABS, isValidEventTab, type EventTabKey } from '@/lib/events/eventTabs'
import { SET_TAB_EVENT, REFRESH_EVENT } from '@/lib/commandPalette/bridge'
import EventCommandHeader from './EventCommandHeader'
import EventHomeTab       from './tabs/EventHomeTab'
import SetupCenterTab     from './tabs/SetupCenterTab'
import OverviewTab        from './tabs/OverviewTab'
import RegistrationsTab   from './tabs/RegistrationsTab'
import PassesTab          from './tabs/PassesTab'
import CommunicationsTab  from './tabs/CommunicationsTab'
import ReportsTab         from './tabs/ReportsTab'
import SettingsTab        from './tabs/SettingsTab'
import AttendanceTab      from './tabs/AttendanceTab'
import CertificatesTab   from './tabs/CertificatesTab'
import CouponsTab        from './tabs/CouponsTab'
import WaitlistTab       from './tabs/WaitlistTab'
import SportsTab                from './tabs/SportsTab'
import ExhibitionTab            from './tabs/ExhibitionTab'
import NominationsTab           from './tabs/NominationsTab'
import SpeakerApplicationsTab  from './tabs/SpeakerApplicationsTab'
import SponsorApplicationsTab  from './tabs/SponsorApplicationsTab'
import ConferenceTab           from './tabs/ConferenceTab'

// ─── Tabs ─────────────────────────────────────────────────────────────────────
// The canonical tab list lives in lib/events/eventTabs so the Command Palette
// (Phase H.4.2) can deep-link to the exact same tabs without duplicating them.

type TabKey = EventTabKey
const TABS = EVENT_TABS

// ─── Skeletons ────────────────────────────────────────────────────────────────

function HeroSkeleton() {
  return (
    <div className="border-b border-border">
      <div className="h-[90px] w-full animate-pulse bg-muted sm:h-[108px]" />
      <div className="space-y-3 px-5 py-4 sm:px-6">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="h-5 w-48 animate-pulse rounded bg-muted" />
            <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
          </div>
          <div className="h-3.5 w-32 animate-pulse rounded bg-muted" />
        </div>
        <div className="flex gap-1.5">
          {[72, 96, 120].map(w => (
            <div key={w} className="h-5 animate-pulse rounded-full bg-muted" style={{ width: w }} />
          ))}
        </div>
        <div className="flex gap-2">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-[62px] w-[84px] animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
        <div className="flex gap-2">
          {[88, 80, 88, 80].map((w, i) => (
            <div key={i} className="h-8 animate-pulse rounded-lg bg-muted" style={{ width: w }} />
          ))}
        </div>
      </div>
    </div>
  )
}

function TabSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ManageEventClient({ eventId, initialTab }: { eventId: string; initialTab?: string }) {
  const [event,      setEvent]     = useState<EventDetailResponse | null>(null)
  const [regData,    setRegData]   = useState<RegistrationsApiResponse | null>(null)
  const [token,      setToken]     = useState<string>('')
  const [loading,    setLoading]   = useState(true)
  const [error,      setError]     = useState<string | null>(null)
  // Seed from the deep-link (?tab=) when valid; otherwise Home (Phase H.4.2).
  const [activeTab,  setActiveTab] = useState<TabKey>(isValidEventTab(initialTab) ? initialTab : 'home')
  const [refreshKey, setRefreshKey] = useState(0)

  // ── Data fetch ──────────────────────────────────────────────────────────────

  const fetchData = useCallback(async (tok: string) => {
    const headers = { Authorization: `Bearer ${tok}` }
    const [eventRes, regRes] = await Promise.all([
      fetch(`/api/organizer/events/${eventId}`, { headers }),
      fetch(`/api/organizer/events/${eventId}/registrations`, { headers }),
    ])

    if (!eventRes.ok) {
      const body = await eventRes.json().catch(() => ({}))
      throw new Error((body as { error?: string }).error ?? `HTTP ${eventRes.status}`)
    }

    setEvent(await eventRes.json() as EventDetailResponse)

    if (regRes.ok) setRegData(await regRes.json() as RegistrationsApiResponse)
    // Draft events → 403 from registrations endpoint — that's expected; shows empty state
  }, [eventId])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) { setError('You must be signed in.'); setLoading(false); return }
      try {
        const tok = await user.getIdToken()
        setToken(tok)
        await fetchData(tok)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load event')
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [fetchData])

  // ── Keep token fresh for long-running sessions ──────────────────────────────
  // Firebase silently refreshes the ID token ~5 min before its 1-hour expiry,
  // firing onIdTokenChanged. Without this subscription the token stored in state
  // would expire, causing 401s on lifecycle actions (close reg, cancel, etc.)
  // taken after the user has been on the page for ~1 hour.
  useEffect(() => {
    const unsub = onIdTokenChanged(auth, async (u) => {
      if (!u) return
      const refreshedToken = await u.getIdToken()
      setToken(refreshedToken)
    })
    return unsub
  }, [])

  // ── Command Palette bridge (Phase H.4.2) ────────────────────────────────────
  // The palette can switch tabs on THIS already-mounted page (no navigation) and
  // ask us to refresh after it runs a safe action through the existing services.
  useEffect(() => {
    function onSetTab(e: Event) {
      const detail = (e as CustomEvent).detail as { eventId?: string; tab?: string } | undefined
      if (detail?.eventId === eventId && isValidEventTab(detail.tab)) setActiveTab(detail.tab)
    }
    function onRefresh(e: Event) {
      const detail = (e as CustomEvent).detail as { eventId?: string } | undefined
      if (detail?.eventId === eventId) setRefreshKey(k => k + 1)
    }
    window.addEventListener(SET_TAB_EVENT, onSetTab)
    window.addEventListener(REFRESH_EVENT, onRefresh)
    return () => {
      window.removeEventListener(SET_TAB_EVENT, onSetTab)
      window.removeEventListener(REFRESH_EVENT, onRefresh)
    }
  }, [eventId])

  // ── Re-fetch after lifecycle action ─────────────────────────────────────────
  useEffect(() => {
    if (!token || refreshKey === 0) return
    void (async () => {
      setLoading(true)
      try { await fetchData(token) }
      catch (e) { setError(e instanceof Error ? e.message : 'Failed to load event') }
      finally { setLoading(false) }
    })()
  }, [refreshKey, token, fetchData])

  function refresh() { setRefreshKey(k => k + 1) }

  // ── Error state ─────────────────────────────────────────────────────────────
  if (!loading && error) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="size-6 text-destructive" />
        </div>
        <p className="text-[15px] font-semibold">{error}</p>
        <TextLink href="/dashboard/events">← Back to Events</TextLink>
      </div>
    )
  }

  return (
    <div className="space-y-0">
      {/* Back nav */}
      <div className="flex items-center gap-2 border-b border-border px-5 py-3 sm:px-6">
        <Link
          href="/dashboard/events"
          className="flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          Events
        </Link>
      </div>

      {/* Command header */}
      {loading && !event ? (
        <HeroSkeleton />
      ) : event ? (
        <EventCommandHeader
          event={event}
          eventId={eventId}
          token={token}
          onSuccess={refresh}
        />
      ) : null}

      {/* Tab navigation */}
      <div className="border-b border-border">
        <nav className="-mb-px flex overflow-x-auto px-5 sm:px-6" role="tablist">
          {TABS.filter(t =>
            (!t.sportsOnly    || event?.eventType === 'sports')     &&
            (!t.exhibitionOnly || event?.eventType === 'exhibition') &&
            (!t.awardsOnly    || event?.eventType === 'awards')
          ).map(t => {
            const active = activeTab === t.key
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(t.key)}
                className={cn(
                  'shrink-0 whitespace-nowrap border-b-2 px-4 py-3 text-[14px] font-medium transition-colors',
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Tab content */}
      <div className="p-5 sm:p-6">
        {loading && !event ? (
          <TabSkeleton />
        ) : event ? (
          <>
            {activeTab === 'home' && (
              <EventHomeTab event={event} regData={regData} token={token} onOpenTab={(t) => setActiveTab(t as TabKey)} />
            )}
            {activeTab === 'setup' && (
              <SetupCenterTab event={event} token={token} onOpenTab={(t) => setActiveTab(t as TabKey)} />
            )}
            {activeTab === 'overview' && (
              <OverviewTab event={event} registrations={regData?.registrations ?? []} />
            )}
            {activeTab === 'attendance' && (
              <AttendanceTab eventId={eventId} token={token} />
            )}
            {activeTab === 'registrations' && (
              regData
                ? <RegistrationsTab data={regData} eventId={eventId} />
                : (
                  <div className="rounded-2xl border border-dashed border-border py-16 text-center">
                    <p className="text-[14px] font-semibold text-foreground">
                      {event.status === 'draft'
                        ? 'Publish this event to see registrations'
                        : 'No registration data available'}
                    </p>
                  </div>
                )
            )}
            {activeTab === 'passes' && <PassesTab passes={event.passes} />}
            {activeTab === 'coupons' && <CouponsTab eventId={eventId} token={token} />}
            {activeTab === 'waitlist' && <WaitlistTab eventId={eventId} token={token} />}
            {activeTab === 'conference' && <ConferenceTab eventId={eventId} token={token} />}
            {activeTab === 'sports'       && <SportsTab      eventId={eventId} token={token} />}
            {activeTab === 'exhibition'  && <ExhibitionTab  eventId={eventId} token={token} />}
            {activeTab === 'nominations'          && <NominationsTab          eventId={eventId} token={token} />}
            {activeTab === 'speaker-applications' && <SpeakerApplicationsTab  eventId={eventId} token={token} />}
            {activeTab === 'sponsor-applications' && <SponsorApplicationsTab  eventId={eventId} token={token} />}
            {activeTab === 'communications' && <CommunicationsTab event={event} token={token} />}
            {activeTab === 'reports' && (
              <ReportsTab event={event} registrations={regData?.registrations ?? []} />
            )}
            {activeTab === 'certificates' && (
              <CertificatesTab eventId={eventId} token={token} />
            )}
            {activeTab === 'settings' && (
              <SettingsTab
                event={event}
                eventId={eventId}
                token={token}
                onSuccess={refresh}
              />
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
