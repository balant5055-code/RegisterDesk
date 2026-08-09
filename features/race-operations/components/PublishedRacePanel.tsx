'use client'

// RD-RESULTS-FINAL-01 · The published race — version history, rollback and export.
//
// ═══ WHAT THIS FIXES ══════════════════════════════════════════════════════════
// `POST /races` (rollback) and `GET /races/export` shipped working and authorized, and
// nothing in the product called either. An organizer could correct results only by making a
// new import, and could not export at all without curl.
//
// ═══ WHAT IT IS NOT ═══════════════════════════════════════════════════════════
// Not a second results console. It reads the version records the publish path already
// writes and calls the two endpoints that already exist — no new state, no new endpoint, no
// duplicate of the import flow above it.

import { useCallback, useEffect, useState } from 'react'
import { Download, History, Loader2, RotateCcw } from 'lucide-react'
import { Banner, Button, Card, EmptyState, StatusChip, useConfirm, useToast } from '@/components/ui'
import { useAuth } from '@/components/auth/AuthProvider'
import type { SnapshotVersionRecord } from '@/features/race-operations/types/snapshot'
import type { RaceVersionsResponse } from '@/app/api/organizer/race-operations/races/route'

const API = '/api/organizer/race-operations/races'

const n = (v: number) => v.toLocaleString('en-IN')

function fmt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

export interface PublishedRacePanelProps {
  eventId:  string
  passId:   string
  raceName: string
  /** Bumped by the parent after a publish, so the list re-reads. */
  reloadKey?: number
}

export function PublishedRacePanel({
  eventId, passId, raceName, reloadKey = 0,
}: PublishedRacePanelProps) {
  const { getToken } = useAuth()
  const { showToast } = useToast()
  const { confirm } = useConfirm()

  const [versions, setVersions] = useState<SnapshotVersionRecord[]>([])
  const [loading,  setLoading]  = useState(true)
  const [busy,     setBusy]     = useState<'rollback' | 'export' | null>(null)
  const [error,    setError]    = useState<string | null>(null)

  const token = useCallback(async () => {
    const t = await getToken()
    if (!t) throw new Error('Your session has expired. Please sign in again.')
    return t
  }, [getToken])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!cancelled) { setLoading(true); setError(null) }
      try {
        const res = await fetch(
          `${API}?eventId=${encodeURIComponent(eventId)}&passId=${encodeURIComponent(passId)}`,
          { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' },
        )
        if (!res.ok) throw new Error('Could not load published versions.')
        const body = await res.json() as RaceVersionsResponse
        if (!cancelled) setVersions(body.versions)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load published versions.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [eventId, passId, token, reloadKey])

  /**
   * The version the public is currently served.
   *
   * A restored version is the live one even when a HIGHER version exists — that is what a
   * rollback means. Falling back to the highest covers the ordinary case where nothing has
   * been rolled back.
   */
  const restored = versions.filter(v => v.restoredAt)
    .sort((a, b) => Date.parse(b.restoredAt!) - Date.parse(a.restoredAt!))[0]
  const highest = versions.slice().sort((a, b) => b.version - a.version)[0]
  const live = restored ?? highest

  const rollback = useCallback(async (target: SnapshotVersionRecord) => {
    if (!live) return
    const ok = await confirm({
      title: `Restore version ${target.version}?`,
      // The comparison the organizer needs to make the decision, in the dialog rather than
      // somewhere they have to remember.
      message: `The public results page currently shows version ${live.version} `
        + `(${n(live.totalCount)} results, ${n(live.finisherCount)} finishers). `
        + `Restoring version ${target.version} will show ${n(target.totalCount)} results `
        + `(${n(target.finisherCount)} finishers) instead, immediately. `
        + `Certificates and finisher badges will follow. Nothing is deleted — you can restore `
        + `version ${live.version} again afterwards.`,
      confirmLabel: `Restore version ${target.version}`,
      tone: 'danger',
    })
    if (!ok) return

    setBusy('rollback'); setError(null)
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, passId, toVersion: target.version }),
      })
      const body = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) throw new Error(body?.error ?? 'The rollback could not be completed.')

      showToast(`Version ${target.version} is now live.`, 'success')
      // Re-read rather than patching locally: the server records `restoredAt`, and guessing
      // it here would make this panel disagree with History.
      const fresh = await fetch(
        `${API}?eventId=${encodeURIComponent(eventId)}&passId=${encodeURIComponent(passId)}`,
        { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' },
      )
      if (fresh.ok) setVersions((await fresh.json() as RaceVersionsResponse).versions)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The rollback could not be completed.')
    } finally {
      setBusy(null)
    }
  }, [confirm, eventId, passId, live, showToast, token])

  /**
   * Downloads the CURRENT published version.
   *
   * Fetched with the auth header and turned into an object URL rather than opening the URL
   * directly: the route is authorized, and a plain `<a href>` sends no bearer token.
   */
  const exportCsv = useCallback(async () => {
    setBusy('export'); setError(null)
    try {
      const res = await fetch(
        `${API}/export?eventId=${encodeURIComponent(eventId)}&passId=${encodeURIComponent(passId)}`,
        { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' },
      )
      if (res.status === 403) throw new Error('You do not have permission to export these results.')
      if (res.status === 404) throw new Error('These results have not been published yet.')
      if (!res.ok) throw new Error('The export could not be produced.')

      const blob = await res.blob()
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1]
        ?? `${raceName}-results.csv`

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = name
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export could not be produced.')
    } finally {
      setBusy(null)
    }
  }, [eventId, passId, raceName, token])

  if (loading) {
    return (
      <Card className="flex items-center justify-center py-8" aria-busy="true">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
      </Card>
    )
  }

  if (versions.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Not published yet"
        description={`Once you publish results for ${raceName}, every version appears here and can be restored or exported.`}
      />
    )
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-fs-md font-semibold text-foreground">{raceName} — published</h2>
          {live && (
            <p className="mt-0.5 text-fs-2xs text-muted-foreground">
              Version {live.version} is live · {n(live.totalCount)} results ·{' '}
              {n(live.finisherCount)} finishers
            </p>
          )}
        </div>
        <Button
          variant="outline" size="sm"
          onClick={() => void exportCsv()}
          disabled={busy !== null}
          isLoading={busy === 'export'}
        >
          <Download className="size-3.5" aria-hidden />
          {busy === 'export' ? 'Preparing…' : 'Export CSV'}
        </Button>
      </div>

      {error && <Banner tone="error" className="mt-3">{error}</Banner>}

      <ul className="mt-4 space-y-2">
        {versions.map(v => {
          const isLive = live?.version === v.version
          return (
            <li
              key={v.version}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-fs-sm"
            >
              <div className="min-w-0">
                <span className="flex items-center gap-2 font-medium text-foreground">
                  Version {v.version}
                  {isLive && <StatusChip tone="success">Live</StatusChip>}
                  {v.restoredAt && !isLive && <StatusChip tone="neutral">restored earlier</StatusChip>}
                </span>
                <span className="block text-fs-2xs text-muted-foreground">
                  {n(v.totalCount)} results · {n(v.finisherCount)} finishers · published {fmt(v.publishedAt)}
                </span>
              </div>

              {!isLive && (
                <Button
                  variant="ghost" size="xs"
                  onClick={() => void rollback(v)}
                  disabled={busy !== null}
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Restore
                </Button>
              )}
            </li>
          )
        })}
      </ul>

      <p className="mt-3 text-fs-2xs leading-relaxed text-muted-foreground">
        Publishing a new import creates a new version; nothing is overwritten. The export
        always contains the version that is live.
      </p>
    </Card>
  )
}
