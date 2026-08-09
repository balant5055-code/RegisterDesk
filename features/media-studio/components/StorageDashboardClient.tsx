'use client'

// RD-MEDIA-01 · Storage dashboard.
// RD-MEDIA-UX-05 · Rebuilt as an analytics workspace.
//
// ═══ WHERE EVERY FIGURE COMES FROM ════════════════════════════════════════════
// Three EXISTING endpoints, all already consumed elsewhere in Media Studio. No route, query,
// repository or calculation was added or changed:
//
//   /storage?eventId=    totals — from gallery COUNTERS, not a scan, so a 50,000-photo
//                        event costs a handful of reads
//   /galleries?eventId=  per-gallery assetCount / bytesStored / bytesOriginalSource,
//                        the same call the Galleries page and Import already make
//   /limits?eventId=     resolved tier + limits + usage, the same call MediaLimitsPanel makes
//
// The breakdown and the percentages are computed HERE, in the browser, from rows the server
// already returns. Nothing new is asked of the backend.
//
// ═══ THERE IS NO STORAGE QUOTA ════════════════════════════════════════════════
// The platform caps PHOTOS per event, galleries per event, albums per gallery and upload
// file size. It does not cap bytes. So this page cannot show "storage remaining", and it
// does not invent one — the limits panel reports the caps that actually exist.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Coins, HardDrive, Images, Scale, Sigma } from 'lucide-react'
import { Banner, ErrorState, StatusChip } from '@/components/ui'
import { useAuth } from '@/components/auth/AuthProvider'
import { Panel, StorageNotConfigured } from './MediaStudioShell'
import {
  MEDIA_PAGE_STACK, MEDIA_RAIL_COLUMN, MEDIA_WORKSPACE_GRID, MediaEmptyState, MediaLoadingState,
  MediaMetricCard, MediaMetricRow, MediaWorkspaceBar, RailMetric,
} from './workspace'
import { useMediaStudio } from '@/features/media-studio/context/MediaStudioContext'
import { cn } from '@/lib/utils/cn'
import type { StorageUsageResponse } from '@/app/api/organizer/media-studio/storage/route'
import type { GalleryListResponse } from '@/app/api/organizer/media-studio/galleries/route'
import type { MediaLimitsResponse } from '@/app/api/organizer/media-studio/limits/route'
import type { GalleryView } from '@/features/media-studio/types'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / (1024 * 1024)
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`
}

/**
 * A proportion bar, token-styled.
 *
 * Deliberately not `ProgressBar`: that primitive reads as "task completion", and reusing it
 * for a share-of-total would say the wrong thing — a gallery holding 60% of an event's
 * photos is not 60% finished.
 */
function UsageBar({ percent, tone = 'default' }: { percent: number; tone?: 'default' | 'warning' }) {
  const width = Math.max(0, Math.min(100, percent))
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div
        className={cn('h-full rounded-full', tone === 'warning' ? 'bg-warning' : 'bg-primary')}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

export function StorageDashboardClient() {
  const { getToken } = useAuth()
  // RD-MEDIA-03: the workspace's event. This page no longer asks — it reports on whatever
  // the organizer is already working in.
  const { event } = useMediaStudio()

  const [data,      setData]      = useState<StorageUsageResponse | null>(null)
  const [galleries, setGalleries] = useState<GalleryView[]>([])
  const [limits,    setLimits]    = useState<MediaLimitsResponse | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const load = useCallback(async (eventId: string, signal: { cancelled: boolean }) => {
    setLoading(true); setError(null)
    try {
      const token = await getToken()
      if (!token) throw new Error('Your session has expired. Please sign in again.')
      const headers = { Authorization: `Bearer ${token}` }
      const qs = `eventId=${encodeURIComponent(eventId)}`

      // Concurrent: three independent reads, none of which depends on another.
      const [usageRes, galleriesRes, limitsRes] = await Promise.all([
        fetch(`/api/organizer/media-studio/storage?${qs}`,   { headers, cache: 'no-store' }),
        fetch(`/api/organizer/media-studio/galleries?${qs}`, { headers, cache: 'no-store' }),
        fetch(`/api/organizer/media-studio/limits?${qs}`,    { headers, cache: 'no-store' }),
      ])

      if (!usageRes.ok) {
        const detail = await usageRes.json().catch(() => null) as { error?: string } | null
        throw new Error(detail?.error ?? 'Could not load storage usage.')
      }
      const payload = await usageRes.json() as StorageUsageResponse
      if (!signal.cancelled) setData(payload)

      // The breakdown and the limits are enrichments. If either fails the page still
      // reports the totals rather than showing nothing.
      if (galleriesRes.ok) {
        const g = await galleriesRes.json() as GalleryListResponse
        if (!signal.cancelled) setGalleries(g.galleries)
      }
      if (limitsRes.ok) {
        const l = await limitsRes.json() as MediaLimitsResponse
        if (!signal.cancelled) setLimits(l)
      }
    } catch (e) {
      if (!signal.cancelled) setError(e instanceof Error ? e.message : 'Could not load storage usage.')
    } finally {
      if (!signal.cancelled) setLoading(false)
    }
  }, [getToken])

  useEffect(() => {
    if (!event) return
    const signal = { cancelled: false }
    const run = async () => { await load(event.eventId, signal) }
    void run()
    return () => { signal.cancelled = true }
  }, [event, load])

  const usage = data?.usage

  /** Largest first — the question is "which galleries use the most storage?". */
  const ranked = useMemo(() => {
    const total = galleries.reduce((n, g) => n + g.bytesStored, 0)
    return [...galleries]
      .sort((a, b) => b.bytesStored - a.bytesStored)
      .map(g => ({
        ...g,
        percent: total > 0 ? Math.round((g.bytesStored / total) * 100) : 0,
      }))
  }, [galleries])

  const photoLimit = limits?.limits.maxPhotosPerEvent ?? null
  const photosUsed = limits?.used.photos ?? usage?.photoCount ?? 0
  const photoPct   = photoLimit && photoLimit > 0
    ? Math.round((photosUsed / photoLimit) * 100)
    : 0
  const nearPhotoLimit = photoLimit !== null && photoPct >= 80

  return (
    <div className={MEDIA_PAGE_STACK}>
      <MediaWorkspaceBar eventName={event?.name ?? null} />

      {data && !data.storageReady && <StorageNotConfigured />}
      {error && <ErrorState message={error} />}

      {/* ── Metric row — the four numbers the page exists to answer ── */}
      {loading ? (
        <MediaLoadingState variant="metrics" />
      ) : usage ? (
        <MediaMetricRow>
          <MediaMetricCard
            icon={HardDrive} label="Storage used" value={formatBytes(usage.bytesStored)}
            hint={`${usage.galleryCount} galleries · ${usage.albumCount} albums`}
          />
          <MediaMetricCard
            icon={Sigma} label="Photos" value={usage.photoCount.toLocaleString('en-IN')}
            hint={photoLimit ? `of ${photoLimit.toLocaleString('en-IN')} allowed` : 'No photo limit'}
            tone={nearPhotoLimit ? 'warning' : 'default'}
          />
          <MediaMetricCard
            icon={Coins} label="Storage saved" value={formatBytes(usage.bytesSaved)}
            hint={usage.bytesSaved > 0 ? `${usage.savingsPercent}% smaller` : 'Nothing compressed yet'}
          />
          <MediaMetricCard
            icon={Scale} label="Average / photo" value={formatBytes(usage.averageFileSize)}
            hint={usage.photoCount > 0 ? 'After compression' : '—'}
          />
        </MediaMetricRow>
      ) : null}

      <div className={MEDIA_WORKSPACE_GRID}>

        {/* ═══ LEFT · storage by gallery ═══ */}
        <div className={MEDIA_RAIL_COLUMN}>
          <Panel
            label="Breakdown"
            title="Storage by gallery"
            action={ranked.length > 0
              ? <StatusChip tone="neutral">{ranked.length} galleries</StatusChip>
              : undefined}
          >
            {loading ? (
              <MediaLoadingState rows={4} />
            ) : ranked.length === 0 ? (
              <MediaEmptyState
                icon={Images}
                title="No galleries yet"
                description="Import media for this event and the breakdown will fill in."
              />
            ) : (
              <>
                {/* Column heads. Hidden below `sm`, where each row becomes a stacked card —
                    a four-column table on a phone is the only way this page could scroll
                    horizontally, so it does not become one. */}
                <div className="hidden border-b border-border pb-1.5 sm:grid sm:grid-cols-[minmax(0,1fr)_5rem_6rem_8rem] sm:gap-3">
                  {['Gallery', 'Photos', 'Storage', 'Share'].map((h, i) => (
                    <span
                      key={h}
                      className={cn(
                        'text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground',
                        i > 0 && i < 3 && 'text-right',
                      )}
                    >
                      {h}
                    </span>
                  ))}
                </div>

                <ul className="divide-y divide-border">
                  {ranked.map(g => (
                    <li
                      key={g.galleryId}
                      className="grid gap-1 py-2 sm:grid-cols-[minmax(0,1fr)_5rem_6rem_8rem] sm:items-center sm:gap-3"
                    >
                      <span className="truncate text-fs-base font-medium text-foreground">
                        {g.name}
                      </span>
                      <span className="text-fs-sm tabular-nums text-muted-foreground sm:text-right">
                        <span className="sm:hidden">Photos: </span>
                        {g.assetCount.toLocaleString('en-IN')}
                      </span>
                      <span className="text-fs-sm font-semibold tabular-nums text-foreground sm:text-right">
                        {formatBytes(g.bytesStored)}
                      </span>
                      <span className="flex items-center gap-2">
                        <UsageBar percent={g.percent} />
                        <span className="w-9 shrink-0 text-right text-fs-2xs tabular-nums text-muted-foreground">
                          {g.percent}%
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
        </div>

        {/* ═══ RIGHT · limits and compression ═══ */}
        <div className="min-w-0 space-y-4">

          <Panel
            label="Plan"
            title="Limits for this event"
            action={limits?.tier
              ? <StatusChip tone="neutral">{limits.tier}</StatusChip>
              : undefined}
          >
            {loading ? (
              <MediaLoadingState rows={2} />
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <RailMetric
                    label="Photos"
                    value={photoLimit === null
                      ? `${photosUsed.toLocaleString('en-IN')} · unlimited`
                      : `${photosUsed.toLocaleString('en-IN')} of ${photoLimit.toLocaleString('en-IN')}`}
                  />
                  {photoLimit !== null && (
                    <UsageBar percent={photoPct} tone={nearPhotoLimit ? 'warning' : 'default'} />
                  )}
                </div>

                <dl className="space-y-1.5 border-t border-border pt-3">
                  <RailMetric
                    label="Galleries"
                    value={limits
                      ? `${limits.used.galleries} of ${limits.limits.maxGalleriesPerEvent}`
                      : String(usage?.galleryCount ?? 0)}
                  />
                  <RailMetric label="Storage used" value={formatBytes(usage?.bytesStored ?? 0)} />
                </dl>

                {nearPhotoLimit && (
                  <Banner tone="warning" title="Approaching the photo limit">
                    {(photoLimit! - photosUsed).toLocaleString('en-IN')} photos remaining on
                    this event.
                  </Banner>
                )}

                {/* Said plainly rather than shown as a bar that would have to be invented. */}
                <p className="border-t border-border pt-3 text-fs-2xs leading-relaxed text-muted-foreground">
                  Storage is not capped — the limits that apply are photos per event,
                  galleries per event and upload file size.
                </p>
              </div>
            )}
          </Panel>

          <Panel label="Compression" title="What re-encoding saved">
            {loading ? (
              <MediaLoadingState rows={2} />
            ) : usage && usage.photoCount > 0 ? (
              <dl className="space-y-1.5">
                <RailMetric label="Original size" value={formatBytes(usage.bytesOriginalSource)} />
                <RailMetric label="Current size"  value={formatBytes(usage.bytesStored)} />
                <RailMetric label="Space saved"   value={formatBytes(usage.bytesSaved)} emphasis />
                <div className="pt-1">
                  <UsageBar percent={usage.savingsPercent} />
                  <p className="mt-1 text-fs-2xs tabular-nums text-muted-foreground">
                    {usage.savingsPercent}% smaller than the originals
                  </p>
                </div>
              </dl>
            ) : (
              <MediaEmptyState
                icon={Images}
                title="Nothing compressed yet"
                description="Figures appear after your first import."
              />
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
