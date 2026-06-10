'use client'

import { useState, useEffect, useCallback } from 'react'
import Link                                  from 'next/link'
import { onAuthStateChanged, onIdTokenChanged } from 'firebase/auth'
import { auth }                              from '@/lib/firebase/auth'
import { cn }                               from '@/lib/utils/cn'
import { ExternalLink, Copy, Check, AlertCircle, ChevronLeft, ScanLine } from 'lucide-react'
import type { EventDetailResponse }      from '@/app/api/organizer/events/[eventId]/route'
import type { RegistrationsApiResponse } from '@/app/api/organizer/events/[eventId]/registrations/route'
import type { EventLifecycleStatus }     from '@/types/events'
import EventActionsPanel  from './EventActionsPanel'
import OverviewTab        from './tabs/OverviewTab'
import RegistrationsTab   from './tabs/RegistrationsTab'
import PassesTab          from './tabs/PassesTab'
import CommunicationsTab  from './tabs/CommunicationsTab'
import ReportsTab         from './tabs/ReportsTab'
import SettingsTab        from './tabs/SettingsTab'
import AttendanceTab      from './tabs/AttendanceTab'
import CertificatesTab   from './tabs/CertificatesTab'

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type TabKey = 'overview' | 'attendance' | 'registrations' | 'passes' | 'communications' | 'reports' | 'certificates' | 'settings'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview',       label: 'Overview'      },
  { key: 'attendance',     label: 'Attendance'    },
  { key: 'registrations',  label: 'Registrations' },
  { key: 'passes',         label: 'Passes'        },
  { key: 'communications', label: 'Communications'},
  { key: 'reports',        label: 'Reports'       },
  { key: 'certificates',   label: 'Certificates'  },
  { key: 'settings',       label: 'Settings'      },
]

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ ls }: { ls: EventLifecycleStatus }) {
  const map: Record<EventLifecycleStatus, { label: string; cls: string }> = {
    draft:               { label: 'Draft',                cls: 'bg-muted text-muted-foreground' },
    published:           { label: 'Published',            cls: 'bg-emerald-100 text-emerald-700' },
    registration_closed: { label: 'Reg. Closed',          cls: 'bg-amber-100 text-amber-700'   },
    completed:           { label: 'Completed',            cls: 'bg-sky-100 text-sky-700'        },
    cancelled:           { label: 'Cancelled',            cls: 'bg-red-100 text-red-600'        },
    archived:            { label: 'Archived',             cls: 'bg-muted text-muted-foreground' },
  }
  const { label, cls } = map[ls] ?? map.draft
  return <span className={cn('rounded-full px-3 py-1 text-[13px] font-semibold', cls)}>{label}</span>
}

// ─── Copy Button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/60"
    >
      {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied!' : 'Copy link'}
    </button>
  )
}

// ─── Skeletons ────────────────────────────────────────────────────────────────

function HeroSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-48 w-full animate-pulse rounded-2xl bg-muted sm:h-64" />
      <div className="space-y-2 px-1">
        <div className="h-7 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
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

export default function ManageEventClient({ eventId }: { eventId: string }) {
  const [event,      setEvent]     = useState<EventDetailResponse | null>(null)
  const [regData,    setRegData]   = useState<RegistrationsApiResponse | null>(null)
  const [token,      setToken]     = useState<string>('')
  const [loading,    setLoading]   = useState(true)
  const [error,      setError]     = useState<string | null>(null)
  const [activeTab,  setActiveTab] = useState<TabKey>('overview')
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

  // ── Re-fetch after lifecycle action ─────────────────────────────────────────
  useEffect(() => {
    if (!token || refreshKey === 0) return
    setLoading(true)
    fetchData(token).catch(e => setError(e.message)).finally(() => setLoading(false))
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
        <Link href="/dashboard/events" className="text-[13px] text-primary hover:underline">← Back to Events</Link>
      </div>
    )
  }

  const publicUrl = event?.slug
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/events/${event.slug}`
    : null

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

      {/* Hero */}
      {loading && !event ? (
        <div className="p-5 sm:p-6"><HeroSkeleton /></div>
      ) : event ? (
        <div>
          {/* Banner */}
          {event.bannerUrl ? (
            <div className="relative h-48 w-full overflow-hidden sm:h-64">
              <img src={event.bannerUrl} alt="" className="h-full w-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
            </div>
          ) : (
            <div className="h-28 w-full bg-gradient-to-br from-[#fb5a6a]/20 via-[#e5277e]/10 to-transparent sm:h-36" />
          )}

          {/* Title + status */}
          <div className="space-y-4 px-5 py-4 sm:px-6">
            <div className="flex flex-wrap items-start gap-3">
              <h1 className="flex-1 text-[22px] font-bold text-foreground sm:text-[26px]">
                {event.name}
              </h1>
              <StatusBadge ls={event.lifecycleStatus} />
            </div>

            {/* Public URL row */}
            {publicUrl && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-lg bg-muted/40 px-3 py-1.5 font-mono text-[13px] text-muted-foreground">
                  {publicUrl}
                </span>
                <CopyButton text={publicUrl} />
                <Link
                  href={`/events/${event.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60"
                >
                  <ExternalLink className="size-3.5" />
                  View page
                </Link>
                {(event.lifecycleStatus === 'published' || event.lifecycleStatus === 'registration_closed' || event.lifecycleStatus === 'completed') && (
                  <Link
                    href={`/dashboard/events/${eventId}/checkin`}
                    className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-[13px] font-medium text-primary transition-colors hover:bg-primary/10"
                  >
                    <ScanLine className="size-3.5" />
                    Check-in
                  </Link>
                )}
              </div>
            )}

            {/* Cancellation reason */}
            {event.lifecycleStatus === 'cancelled' && event.cancelReason && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                <p className="text-[13px] font-semibold text-red-700">Cancellation reason</p>
                <p className="mt-0.5 text-[14px] text-red-600">{event.cancelReason}</p>
              </div>
            )}

            {/* Actions panel */}
            {token && (
              <EventActionsPanel event={event} token={token} onSuccess={refresh} />
            )}
          </div>
        </div>
      ) : null}

      {/* Tab navigation */}
      <div className="border-b border-border">
        <nav className="-mb-px flex overflow-x-auto px-5 sm:px-6" role="tablist">
          {TABS.map(t => {
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
            {activeTab === 'overview' && (
              <OverviewTab event={event} registrations={regData?.registrations ?? []} />
            )}
            {activeTab === 'attendance' && (
              <AttendanceTab eventId={eventId} token={token} />
            )}
            {activeTab === 'registrations' && (
              regData
                ? <RegistrationsTab data={regData} slug={event.slug ?? eventId} token={token} />
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
