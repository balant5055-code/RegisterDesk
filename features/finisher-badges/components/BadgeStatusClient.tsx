'use client'

// RD-BADGE-01 · Organizer Finisher Badges screen.
//
// Shows generation status per race and drives the chunked generate / regenerate loop.

import { useCallback, useEffect, useState } from 'react'
import { Award, CheckCircle2, Clock, Play, RefreshCw, XCircle } from 'lucide-react'
import {
  Banner, Button, Card, EmptyState, ErrorState, ProgressBar, Skeleton, StatusChip,
  useConfirm, useToast,
} from '@/components/ui'
import { useAuth } from '@/components/auth/AuthProvider'
import { MediaEventPicker } from '@/features/media-studio/components/MediaStudioShell'
import type { MediaEventRow } from '@/features/media-studio/hooks/useMediaEvents'
import type { BadgeRaceStatusView } from '@/features/finisher-badges/types'
import type {
  BadgeStatusResponse, BadgeGenerateResponse,
} from '@/app/api/organizer/race-operations/badges/route'

const API = '/api/organizer/race-operations/badges'

/** Hard stop on the drive-loop so a server bug cannot spin the browser forever. */
const MAX_CALLS = 1000

export function BadgeStatusClient() {
  const { getToken }  = useAuth()
  const { showToast } = useToast()
  const { confirm }   = useConfirm()

  const [event,   setEvent]   = useState<MediaEventRow | null>(null)
  const [races,   setRaces]   = useState<BadgeRaceStatusView[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)

  const call = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const token = await getToken()
    if (!token) throw new Error('Your session has expired. Please sign in again.')
    const res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(detail?.error ?? 'That request could not be completed.')
    }
    return await res.json() as T
  }, [getToken])

  const refresh = useCallback(async (eventId: string, signal: { cancelled: boolean }) => {
    setLoading(true)
    try {
      const data = await call<BadgeStatusResponse>(`${API}?eventId=${encodeURIComponent(eventId)}`)
      if (!signal.cancelled) { setRaces(data.races); setError(null) }
    } catch (e) {
      if (!signal.cancelled) setError(e instanceof Error ? e.message : 'Could not load badge status.')
    } finally {
      if (!signal.cancelled) setLoading(false)
    }
  }, [call])

  useEffect(() => {
    if (!event) return
    const signal = { cancelled: false }
    const run = async () => { await refresh(event.eventId, signal) }
    void run()
    return () => { signal.cancelled = true }
  }, [event, refresh])

  /** Drives the chunked generate loop until the server reports done. */
  async function generate(race: BadgeRaceStatusView, force: boolean) {
    if (!event) return

    if (force) {
      const ok = await confirm({
        title: `Regenerate ${race.raceName} badges?`,
        message: `All ${race.eligible.toLocaleString('en-IN')} badges for this race will be re-rendered `
          + 'and overwritten. Existing links keep working and will show the new image.',
        confirmLabel: 'Regenerate',
      })
      if (!ok) return
    }

    setBusySlug(race.passSlug)
    setProgress(0)

    try {
      let cursor: number | null = null
      let done = false
      let calls = 0
      let total = 0

      while (!done) {
        if (++calls > MAX_CALLS) throw new Error('Generation did not finish. Please try again.')

        const body: { eventId: string; passSlug: string; force: boolean; cursor?: number } = {
          eventId: event.eventId, passSlug: race.passSlug, force,
        }
        if (cursor !== null) body.cursor = cursor

        const res: BadgeGenerateResponse = await call<BadgeGenerateResponse>(API, {
          method: 'POST', body: JSON.stringify(body),
        })

        total += res.generated + res.skipped
        done   = res.done
        cursor = res.nextCursor
        setProgress(race.eligible > 0 ? Math.min(100, Math.round((total / race.eligible) * 100)) : 100)
      }

      showToast(`Badges ready for ${race.raceName}.`, 'success')
      const signal = { cancelled: false }
      await refresh(event.eventId, signal)
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Badge generation failed.', 'error')
    } finally {
      setBusySlug(null)
      setProgress(0)
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-fs-lg font-semibold tracking-tight text-foreground">
          Select event
        </h2>
        <MediaEventPicker selectedEventId={event?.eventId ?? null} onSelect={setEvent} />
      </section>

      {error && <ErrorState message={error} />}

      {loading && (
        <div className="space-y-2.5" aria-busy="true">
          {[0, 1].map(i => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
        </div>
      )}

      {event && !loading && races.length === 0 && !error && (
        <EmptyState
          icon={Award}
          title="No published results yet"
          description="Badges are generated from published results. Publish a race first."
          action={{ label: 'Publish results', href: '/dashboard/race-operations/publish-results' }}
        />
      )}

      {races.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-fs-lg font-semibold tracking-tight text-foreground">
            Races
          </h2>

          <Banner tone="info" title="Badges generate on demand">
            A badge is rendered the first time a participant opens their result, so most races
            need no action here. Use Generate to pre-render them all ahead of a results
            announcement.
          </Banner>

          <ul className="space-y-2.5">
            {races.map(race => {
              const busy = busySlug === race.passSlug
              return (
                <li key={race.passSlug}>
                  <Card>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <h3 className="text-fs-md font-semibold text-foreground">
                          {race.raceName}
                        </h3>
                        <p className="mt-1 text-fs-sm text-muted-foreground">
                          {race.eligible.toLocaleString('en-IN')} finishers · snapshot v{race.snapshotVersion}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <StatusChip tone="success">
                            <CheckCircle2 className="mr-1 inline size-3 align-[-2px]" aria-hidden />
                            {race.generated.toLocaleString('en-IN')} generated
                          </StatusChip>
                          <StatusChip tone="neutral">
                            <Clock className="mr-1 inline size-3 align-[-2px]" aria-hidden />
                            {race.pending.toLocaleString('en-IN')} pending
                          </StatusChip>
                          {race.failed > 0 && (
                            <StatusChip tone="danger">
                              <XCircle className="mr-1 inline size-3 align-[-2px]" aria-hidden />
                              {race.failed.toLocaleString('en-IN')} failed
                            </StatusChip>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button
                          size="sm" variant="outline" disabled={busy || busySlug !== null}
                          onClick={() => void generate(race, false)}
                        >
                          <Play className="size-4" aria-hidden /> Generate
                        </Button>
                        <Button
                          size="sm" variant="ghost" disabled={busy || busySlug !== null}
                          onClick={() => void generate(race, true)}
                        >
                          <RefreshCw className="size-4" aria-hidden /> Regenerate
                        </Button>
                      </div>
                    </div>

                    {busy && (
                      <div className="mt-3">
                        <ProgressBar value={progress} label={`Generating — ${progress}%`} />
                      </div>
                    )}
                  </Card>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
