'use client'

// RD-MEDIA-05 · Media maintenance — the manual trigger.
//
// Replaces the production dependency on a scheduler. The page runs the SAME service a cron
// tick would; it holds none of the pipeline itself.
//
// Platform-admin only. A non-admin is told so plainly rather than shown a button that 401s.

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Clock, HardDrive, Layers, Loader2, PlayCircle, ShieldAlert,
} from 'lucide-react'
import { Banner, Button, Card } from '@/components/ui'
import { useAuth } from '@/components/auth/AuthProvider'
import { Panel, StudioBusy, StudioStat } from './MediaStudioShell'
import type {
  MaintenanceRunResponse, MaintenanceStatusResponse,
} from '@/app/api/organizer/media-studio/maintenance/route'

const API = '/api/organizer/media-studio/maintenance'

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Never'
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

export function MaintenanceClient() {
  const { user, getToken } = useAuth()

  const [status,  setStatus]  = useState<MaintenanceStatusResponse | null>(null)
  const [result,  setResult]  = useState<MaintenanceRunResponse['run'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [denied,  setDenied]  = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = await getToken()
    if (!token) throw new Error('Your session has expired. Please sign in again.')

    const res = await fetch(API, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    })
    if (res.status === 401) { setDenied(true); return null }
    if (!res.ok) throw new Error('Could not read the maintenance status.')
    return await res.json() as MaintenanceStatusResponse
  }, [getToken])

  useEffect(() => {
    if (user === undefined) return          // auth still resolving
    let cancelled = false

    const run = async () => {
      if (!user) { setLoading(false); return }
      try {
        const data = await load()
        if (!cancelled && data) setStatus(data)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read the status.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => { cancelled = true }
  }, [user, load])

  const execute = useCallback(async () => {
    setRunning(true); setError(null)
    try {
      const token = await getToken()
      if (!token) throw new Error('Your session has expired. Please sign in again.')

      const res = await fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (res.status === 401) { setDenied(true); return }
      if (!res.ok) throw new Error('The maintenance run could not be started.')

      const data = await res.json() as MaintenanceRunResponse
      setResult(data.run)
      // The status returned is the state AFTER the run — what is left, not what there was.
      setStatus(data.status)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The maintenance run failed.')
    } finally {
      setRunning(false)
    }
  }, [getToken])

  if (loading) return <StudioBusy label="Checking maintenance status…" />

  if (denied) {
    return (
      <Banner tone="warning" title="Platform administrators only">
        Media maintenance advances bulk jobs and reclaims storage across every workspace on
        the platform, not just yours — so it is restricted to platform administrators. Nothing
        on this page is scoped to a single event.
      </Banner>
    )
  }

  return (
    <div className="space-y-6">
      {error && <Banner tone="error" title="Something went wrong">{error}</Banner>}

      {status && !status.storageReady && (
        <Banner tone="warning" title="Media storage is not configured">
          Maintenance cannot remove any object until this deployment has object-storage
          credentials. A run will complete immediately and do nothing.
        </Banner>
      )}

      <Panel label="Pending work"
        title="What a maintenance run would find right now."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StudioStat
            label="Pending reservations"
            value={(status?.pendingReservations ?? 0).toLocaleString('en-IN')}
            icon={Clock}
            hint="Uploads authorized but never finished"
          />
          <StudioStat
            label="Failed deletions"
            value={(status?.failedDeletions ?? 0).toLocaleString('en-IN')}
            icon={AlertTriangle}
            hint="Records deleted whose objects may remain"
          />
          <StudioStat
            label="Pending bulk jobs"
            value={(status?.pendingBulkJobs ?? 0).toLocaleString('en-IN')}
            icon={Layers}
            hint="Open batches awaiting a run"
          />
          <StudioStat
            label="Last run"
            value={formatWhen(status?.lastRun?.ranAt)}
            icon={HardDrive}
            hint={status?.lastRun
              ? `${status.lastRun.trigger === 'cron' ? 'Scheduled' : 'Manual'} · ${formatDuration(status.lastRun.durationMs)}`
              : 'Maintenance has never been executed'}
          />
        </div>
      </Panel>

      <Panel label="Run maintenance"
        title="Advances open bulk jobs, then reclaims objects that nothing points at. Safe to run at any time — every step is idempotent and bounded."
      >
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-fs-base leading-relaxed text-muted-foreground">
              One run processes a bounded chunk. If there is more work than fits, run it
              again — each run resumes exactly where the last one stopped.
            </p>
            <Button onClick={() => void execute()} disabled={running}>
              {running
                ? <Loader2 className="size-4 animate-spin" aria-hidden />
                : <PlayCircle className="size-4" aria-hidden />}
              {running ? 'Running…' : 'Run maintenance now'}
            </Button>
          </div>
        </Card>
      </Panel>

      {result && (
        <Panel label="Result" title={`Completed in ${formatDuration(result.durationMs)}.`}>
          {result.reason === 'storage_not_configured' ? (
            <Banner tone="warning" title="Nothing ran">
              Object storage is not configured, so no job was advanced and no object was
              reclaimed.
            </Banner>
          ) : (
            <Banner
              tone={result.bulk.failed > 0 || result.reclaim.objectsFailed > 0 ? 'warning' : 'success'}
              title={result.bulk.failed > 0 || result.reclaim.objectsFailed > 0
                ? 'Completed with some failures'
                : 'Maintenance complete'}
            >
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="size-4" aria-hidden />
                {result.bulk.advanced} of {result.bulk.scanned} bulk job
                {result.bulk.scanned === 1 ? '' : 's'} advanced
                {result.bulk.failed > 0 && `, ${result.bulk.failed} failed`}.
              </span>
            </Banner>
          )}

          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Records scanned',  value: result.reclaim.scanned },
              { label: 'Objects removed',  value: result.reclaim.objectsRemoved },
              { label: 'Records purged',   value: result.reclaim.recordsPurged },
              { label: 'Deferred',         value: result.reclaim.deferred },
            ].map(stat => (
              <div key={stat.label} className="rounded-xl border border-border bg-card p-4">
                <dt className="text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {stat.label}
                </dt>
                <dd className="mt-1.5 text-fs-xl font-bold leading-none tabular-nums text-foreground">
                  {stat.value.toLocaleString('en-IN')}
                </dd>
              </div>
            ))}
          </dl>

          {result.reclaim.objectsFailed > 0 && (
            <p className="text-fs-base text-muted-foreground">
              <ShieldAlert className="mr-1 inline size-4 align-text-bottom" aria-hidden />
              {result.reclaim.objectsFailed.toLocaleString('en-IN')} object
              {result.reclaim.objectsFailed === 1 ? '' : 's'} could not be removed and{' '}
              {result.reclaim.deferred.toLocaleString('en-IN')} record
              {result.reclaim.deferred === 1 ? ' was' : 's were'} left in place. They are
              retried on the next run — deleting an object that is already gone succeeds, so
              nothing is lost by running again.
            </p>
          )}
        </Panel>
      )}
    </div>
  )
}
