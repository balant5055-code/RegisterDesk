'use client'

// RD-RESULTS-CLOSURE-01 · Race Operations — History.
//
// ═══ WHAT THIS REPLACES ═══════════════════════════════════════════════════════
// A Sprint-1 placeholder that fetched nothing and rendered a permanent empty state saying
// "no results have ever been imported or published, because no import or publish code exists
// yet". That was true when it was written and false from Sprint 3 onward, so an organizer who
// had published results was told they had none — on a page linked from the sidebar.
//
// ═══ WHAT IT READS ════════════════════════════════════════════════════════════
// Two EXISTING endpoints, no new storage and no new collection:
//   GET /sessions?eventId=   every import ever made for the event  (the import log)
//   GET /races?eventId&passId  the published version records       (the publish log)
//
// The version records carry `restoredAt`, so a rollback is visible as an event in the race's
// history rather than as a silent change of number.

import { useCallback, useEffect, useState } from 'react'
import { History, Loader2, RotateCcw } from 'lucide-react'
import { Card, EmptyState, StatusChip } from '@/components/ui'
import { useAuth } from '@/components/auth/AuthProvider'
import { EventSelector } from '@/features/race-operations/components/EventSelector'
import { useRaceOpsEvents } from '@/features/race-operations/hooks/useRaceOpsEvents'
import {
  IMPORT_SESSION_STATUS_LABEL, type ImportSessionView,
} from '@/features/race-operations/types/session'
import type { SnapshotVersionRecord } from '@/features/race-operations/types/snapshot'
import type { RaceVersionsResponse } from '@/app/api/organizer/race-operations/races/route'
import type { ListSessionsResponse } from '@/app/api/organizer/race-operations/sessions/route'

const TONE = { published: 'success', draft: 'warning', cancelled: 'danger' } as const

const n = (v: number) => v.toLocaleString('en-IN')

function fmt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * How long the import took, from upload to the publish decision.
 *
 * Derived rather than stored: both timestamps are already on the session, and adding a
 * duration field would be a second number that could disagree with them.
 */
function duration(s: ImportSessionView): string {
  const from = s.uploadedAt ? Date.parse(s.uploadedAt) : NaN
  const to   = s.publishedAt ? Date.parse(s.publishedAt)
             : s.cancelledAt ? Date.parse(s.cancelledAt)
             : s.rankedAt    ? Date.parse(s.rankedAt)
             : NaN
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return '—'
  const secs = Math.round((to - from) / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return mins < 60 ? `${mins}m ${secs % 60}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}

export function HistoryPanel() {
  const { getToken } = useAuth()
  const eventsState = useRaceOpsEvents()
  const { events } = eventsState

  const [eventId,  setEventId]  = useState<string | null>(null)
  /**
   * Loaded history, TAGGED with the event it belongs to.
   *
   * Tagged rather than cleared in an effect: switching event must show nothing instantly,
   * and a `setState` on the effect's early-return path would render the previous event's
   * history for one frame — the wrong race's imports, which is worse than a blank.
   */
  const [loaded, setLoaded] = useState<{
    eventId:  string
    sessions: ImportSessionView[]
    versions: Record<string, SnapshotVersionRecord[]>
  } | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const event = events.find(e => e.eventId === eventId) ?? null

  const authedGet = useCallback(async <T,>(url: string): Promise<T | null> => {
    const token = await getToken()
    if (!token) throw new Error('Your session has expired. Please sign in again.')
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    if (!res.ok) return null
    return await res.json() as T
  }, [getToken])

  // Only the CURRENT event's history is ever rendered; anything else reads as empty.
  const sessions = loaded && loaded.eventId === eventId ? loaded.sessions : []
  const versions = loaded && loaded.eventId === eventId ? loaded.versions : {}

  useEffect(() => {
    if (!eventId || !event) return
    let cancelled = false

    const run = async () => {
      if (!cancelled) { setLoading(true); setError(null) }
      try {
        const list = await authedGet<ListSessionsResponse>(
          `/api/organizer/race-operations/sessions?eventId=${encodeURIComponent(eventId)}`,
        )
        if (cancelled) return
        const sessionRows = list?.sessions ?? []

        // Version history is per RACE, so one read per race on the event. An event has a
        // handful of races, not hundreds, and these are read in parallel.
        const perRace = await Promise.all(event.races.map(async race => {
          const v = await authedGet<RaceVersionsResponse>(
            `/api/organizer/race-operations/races?eventId=${encodeURIComponent(eventId)}`
            + `&passId=${encodeURIComponent(race.passId)}`,
          )
          return [race.passId, v?.versions ?? []] as const
        }))
        if (cancelled) return
        setLoaded({ eventId, sessions: sessionRows, versions: Object.fromEntries(perRace) })
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load history.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => { cancelled = true }
  }, [eventId, event, authedGet])

  const raceName = (passId: string) =>
    event?.races.find(r => r.passId === passId)?.name ?? passId

  return (
    <div className="space-y-4">
      <EventSelector
        state={eventsState}
        selectedEventId={eventId}
        onSelect={e => setEventId(e.eventId)}
      />

      {!eventId ? (
        <EmptyState
          icon={History}
          title="Choose an event"
          description="Import and publish history is recorded per event."
        />
      ) : loading ? (
        <Card className="flex items-center justify-center py-10" aria-busy="true">
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
        </Card>
      ) : error ? (
        <Card className="py-6 text-center text-fs-sm text-destructive">{error}</Card>
      ) : (
        <>
          {/* ── Published versions, per race ─────────────────────────────── */}
          {Object.entries(versions).map(([passId, records]) => records.length === 0 ? null : (
            <Card key={passId} className="p-4">
              <h2 className="text-fs-md font-semibold text-foreground">
                {raceName(passId)} — published versions
              </h2>
              <p className="mt-0.5 text-fs-2xs text-muted-foreground">
                The highest version is what the public sees, unless an earlier one was restored.
              </p>
              <ul className="mt-3 space-y-2">
                {records.slice().sort((a, b) => b.version - a.version).map(v => (
                  <li
                    key={v.version}
                    className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border/60 pt-2 text-fs-sm"
                  >
                    <span className="flex items-center gap-2 font-medium text-foreground">
                      Version {v.version}
                      {v.restoredAt && (
                        <StatusChip tone="info">
                          <RotateCcw className="mr-1 inline size-3" aria-hidden />
                          restored
                        </StatusChip>
                      )}
                    </span>
                    <span className="text-fs-2xs text-muted-foreground">
                      {n(v.totalCount)} results · {n(v.finisherCount)} finishers · {fmt(v.publishedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}

          {/* ── Every import ever made ───────────────────────────────────── */}
          <Card className="p-4">
            <h2 className="text-fs-md font-semibold text-foreground">Imports</h2>
            {sessions.length === 0 ? (
              <p className="mt-2 text-fs-sm text-muted-foreground">
                No results have been imported for this event yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {sessions.map(s => (
                  <li key={s.sessionId} className="border-t border-border/60 pt-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium text-foreground">{s.passName}</span>
                      <StatusChip tone={TONE[s.status]}>
                        {IMPORT_SESSION_STATUS_LABEL[s.status]}
                      </StatusChip>
                    </div>
                    <p className="mt-0.5 text-fs-2xs text-muted-foreground">
                      {s.fileName} · {n(s.storedRows)} stored of {n(s.totalRows)} rows
                      {s.warningCount > 0 && ` · ${n(s.warningCount)} warnings`}
                      {s.errorCount > 0 && ` · ${n(s.errorCount)} errors`}
                    </p>
                    <p className="text-fs-2xs text-muted-foreground">
                      {fmt(s.uploadedAt)} · took {duration(s)}
                      {s.cancelReason && ` · ${s.cancelReason}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
