'use client'

// MS-FINAL-02 · Bulk operations over a gallery or one of its albums.
//
// ═══ WHY SCOPE, NOT SELECTION ════════════════════════════════════════════════
// The bulk jobs infrastructure — built in RD-MEDIA-04, drained by `/api/cron/media-jobs` —
// operates on a SCOPE: every ready photo in a gallery, optionally narrowed to one album. The
// job document carries `{ galleryId, albumId }` and no asset-id list; its `fetchPage`
// re-queries that scope each pass rather than reading a stored list; its id is deterministic
// per (gallery, album, action); and its progress denominator is the gallery's own
// `assetCount`.
//
// So this panel offers exactly what the engine does. Per-photo multi-select would need an
// `assetIds` field, a new id scheme, a rewritten drain and a new progress basis — a redesign
// of working infrastructure that deletes photos for a living, not a wiring change.
//
// Per-photo actions already exist on each tile in the browser; this is for the whole scope.
//
// ═══ NOTHING HAPPENS SYNCHRONOUSLY ═══════════════════════════════════════════
// POST returns 202 with a queued job. The cron drains it. This panel only starts jobs and
// reads their progress — it moves no photo itself.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, FolderInput, Loader2, Trash2 } from 'lucide-react'
import { Banner, Button, Card, useConfirm, useToast } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import {
  isJobActive, jobPercent, summariseBulkJob, type BulkJobView,
} from '@/features/media-studio/utils/bulkOps'
import type { AlbumView } from '@/features/media-studio/types'

const API = '/api/organizer/media-studio'

/** How often progress is re-read WHILE a job runs. Stops entirely once it finishes. */
const POLL_MS = 4_000

type Action = 'delete' | 'move' | 'visibility'

interface JobRow extends BulkJobView { action: Action }

export interface BulkActionsPanelProps {
  galleryId: string
  /** Null when the whole gallery is in scope. */
  albumId:   string | null
  /** Name shown in the confirmation, so the organizer reads what they are about to affect. */
  scopeName: string
  /** How many photos the scope holds — the gallery's or album's own counter. */
  scopeCount: number
  /** Move targets. The current album is filtered out by the caller. */
  albums:    AlbumView[]
  /** Fired when a job finishes, so the browser re-reads its photos. */
  onJobSettled?: () => void
}

export function BulkActionsPanel({
  galleryId, albumId, scopeName, scopeCount, albums, onJobSettled,
}: BulkActionsPanelProps) {
  const { getToken }  = useAuth()
  const { showToast } = useToast()
  // `confirm`, not `prompt` — this asks a yes/no question, not for a reason.
  const { confirm }   = useConfirm()

  const [jobs,    setJobs]    = useState<JobRow[]>([])
  const [busy,    setBusy]    = useState<Action | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [moveTo,  setMoveTo]  = useState<string>('')

  // Remembers whether anything was running, so `onJobSettled` fires on the transition to
  // finished rather than on every poll.
  const wasActive = useRef(false)

  const readProgress = useCallback(async () => {
    try {
      const token = await getToken()
      const q = new URLSearchParams({ galleryId })
      if (albumId) q.set('albumId', albumId)
      const res = await fetch(`${API}/jobs?${q.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const body = await res.json() as { jobs: (BulkJobView & { action: Action })[] }
      const next = body.jobs ?? []
      setJobs(next)

      // The settle transition is detected HERE, after an await, rather than in an effect.
      // `onJobSettled` reloads the parent, and calling a parent setState synchronously
      // from an effect body is the cascading-render pattern React warns about.
      const active = next.some(isJobActive)
      if (wasActive.current && !active) onJobSettled?.()
      wasActive.current = active
    } catch {
      // Progress is informational. A failed read must not replace the panel with an error —
      // the job is running on the server either way.
    }
  }, [getToken, galleryId, albumId, onJobSettled])

  // Read once on mount / scope change, then only WHILE something is running.
  //
  // Wrapped rather than called directly so the first state write happens after the token and
  // the fetch resolve, never during the effect body itself.
  useEffect(() => {
    void (async () => { await readProgress() })()
  }, [readProgress])

  // Polling stops the moment nothing is active — a finished batch costs no requests, and
  // an idle gallery page makes none at all.
  const anyRunning = jobs.some(isJobActive)
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => { void readProgress() }, POLL_MS)
    return () => clearInterval(t)
  }, [anyRunning, readProgress])

  const start = useCallback(async (action: Action, extra: Record<string, unknown> = {}) => {
    setBusy(action)
    setError(null)
    try {
      const token = await getToken()
      // ONE request for the whole scope. Never one per photo — the engine pages server-side.
      const res = await fetch(`${API}/jobs`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ action, galleryId, albumId, ...extra }),
      })
      const body = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) throw new Error(body?.error ?? 'This batch could not be started.')

      showToast('Batch queued. It runs in the background — you can leave this page.', 'success')
      await readProgress()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This batch could not be started.')
    } finally {
      setBusy(null)
    }
  }, [getToken, galleryId, albumId, showToast, readProgress])

  const confirmThen = useCallback(async (
    action: Action, title: string, message: string, confirmLabel: string,
    extra: Record<string, unknown> = {},
  ) => {
    const ok = await confirm({ title, message, confirmLabel, tone: action === 'delete' ? 'danger' : 'default' })
    if (ok) await start(action, extra)
  }, [confirm, start])

  const scopeLabel = albumId ? `the album “${scopeName}”` : `the gallery “${scopeName}”`

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-fs-sm font-semibold text-foreground">Bulk actions</h3>
        <p className="text-fs-2xs text-muted-foreground">
          Applies to every photo in {scopeLabel} — {scopeCount.toLocaleString('en-IN')} in total.
        </p>
      </div>

      {/* ── Progress. One banner per running or recently-finished job. ───────── */}
      <div aria-live="polite" className="mt-3 space-y-2 empty:mt-0">
        {jobs.map(j => {
          const s = summariseBulkJob(j.action, j)
          if (!s) return null
          return (
            <Banner key={j.action} tone={s.tone === 'neutral' ? 'info' : s.tone} title={s.title}>
              <p>{s.detail}</p>
              {isJobActive(j) && (
                <div
                  className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={jobPercent(j)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${j.action} progress`}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-500"
                    style={{ width: `${jobPercent(j)}%` }}
                  />
                </div>
              )}
            </Banner>
          )
        })}
      </div>

      {error && <Banner tone="error" title="Could not start" className="mt-2">{error}</Banner>}

      {/* ── Actions ─────────────────────────────────────────────────────────── */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm" variant="outline" disabled={busy !== null || scopeCount === 0}
          onClick={() => void confirmThen(
            'visibility',
            'Publish every photo?',
            `All ${scopeCount.toLocaleString('en-IN')} photos in ${scopeLabel} will become publicly visible.`,
            'Publish all',
            { visibility: 'PUBLIC' },
          )}
        >
          {busy === 'visibility' ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
          Publish all
        </Button>

        <Button
          size="sm" variant="outline" disabled={busy !== null || scopeCount === 0}
          onClick={() => void confirmThen(
            'visibility',
            'Withdraw every photo?',
            `All ${scopeCount.toLocaleString('en-IN')} photos in ${scopeLabel} will become private. Public links stop working.`,
            'Withdraw all',
            { visibility: 'PRIVATE' },
          )}
        >
          <EyeOff className="size-3.5" aria-hidden />
          Withdraw all
        </Button>

        {albums.length > 0 && (
          <div className="flex items-center gap-1.5">
            <label className="sr-only" htmlFor="bulk-move-target">Move all photos to album</label>
            <select
              id="bulk-move-target"
              value={moveTo}
              onChange={e => setMoveTo(e.target.value)}
              disabled={busy !== null || scopeCount === 0}
              className={cn(
                'rounded-lg border border-border bg-background px-2.5 py-1.5 text-fs-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              <option value="">Move all to…</option>
              {albums.map(a => <option key={a.albumId} value={a.albumId}>{a.name}</option>)}
            </select>
            <Button
              size="sm" variant="outline" disabled={busy !== null || !moveTo}
              onClick={() => void confirmThen(
                'move',
                'Move every photo?',
                `All ${scopeCount.toLocaleString('en-IN')} photos in ${scopeLabel} will move to the album you chose.`,
                'Move all',
                { toAlbumId: moveTo },
              )}
            >
              <FolderInput className="size-3.5" aria-hidden />
              Move
            </Button>
          </div>
        )}

        <Button
          size="sm" variant="outline" disabled={busy !== null || scopeCount === 0}
          className="text-destructive"
          onClick={() => void confirmThen(
            'delete',
            'Delete every photo?',
            `All ${scopeCount.toLocaleString('en-IN')} photos in ${scopeLabel} will be deleted. This cannot be undone.`,
            'Delete all',
          )}
        >
          <Trash2 className="size-3.5" aria-hidden />
          Delete all
        </Button>
      </div>

      <p className="mt-2.5 text-fs-2xs text-muted-foreground">
        {anyRunning
          ? 'This runs in the background. You can leave this page — progress is kept.'
          : 'Batches run in the background. A photo that fails does not stop the rest, and re-running retries only the ones that failed.'}
      </p>
    </Card>
  )
}
