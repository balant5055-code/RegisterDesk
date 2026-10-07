'use client'

// RD-MEDIA-08 · The effective limits for the workspace's event.
//
// Displays what the backend resolved and computes NOTHING. Every number here is the same
// number the upload API enforces, because both come from `resolveMediaConfig` — a limit the
// organizer is shown and a limit they hit can no longer disagree.

import { useCallback, useEffect, useState } from 'react'
import { Gauge } from 'lucide-react'
import { Card, StatusChip } from '@/components/ui'
import { useAuth } from '@/components/auth/AuthProvider'
import { useMediaStudio } from '@/features/media-studio/context/MediaStudioContext'
import type { MediaLimitsResponse } from '@/app/api/organizer/media-studio/limits/route'
import type { MediaLimitSource } from '@/lib/config/resolveMediaConfig'

const UNLIMITED = 'Unlimited'

function formatCount(n: number | null): string {
  return n === null ? UNLIMITED : n.toLocaleString('en-IN')
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/**
 * Where a value came from — shown for EVERY row (MS-SETTINGS-01).
 *
 * It used to render nothing for `global`, on the reasoning that the default case is
 * unremarkable. That was right while the page was a form and the chip meant "you changed
 * this". It is wrong now the page is the only explanation an organizer gets: a blank cell
 * reads as missing information, not as "platform default".
 */
function SourceChip({ source }: { source: MediaLimitSource | 'purchase' }) {
  // RD-PHOTO-01 — photo capacity is bought for the event; it has no resolver layer.
  if (source === 'purchase') return <StatusChip tone="info">Paid capacity</StatusChip>
  if (source === 'global') {
    return <StatusChip tone="neutral">Platform default</StatusChip>
  }
  return (
    <StatusChip tone={source === 'event' ? 'info' : 'neutral'}>
      {/* RD-CLOSE — the licence layer applies only to historical tier-priced licences. */}
      {source === 'event' ? 'Admin override' : 'Legacy licence limit'}
    </StatusChip>
  )
}

export function MediaLimitsPanel() {
  const { getToken } = useAuth()
  const { event } = useMediaStudio()

  const [data,    setData]    = useState<MediaLimitsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async (eventId: string) => {
    const token = await getToken()
    if (!token) throw new Error('Your session has expired. Please sign in again.')
    const res = await fetch(`/api/organizer/media-studio/limits?eventId=${encodeURIComponent(eventId)}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    })
    if (!res.ok) throw new Error('Could not read the limits for this event.')
    return await res.json() as MediaLimitsResponse
  }, [getToken])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!event) { if (!cancelled) { setData(null); setLoading(false) } return }
      if (!cancelled) { setLoading(true); setError(null) }
      try {
        const next = await load(event.eventId)
        if (!cancelled) setData(next)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read the limits.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [event, load])

  if (!event) return null

  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted" aria-hidden>
          <Gauge className="size-[18px] text-muted-foreground" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-fs-md font-semibold text-foreground">
              Limits for {event.name}
            </h2>
          </div>

          {loading ? (
            <p className="mt-1 text-fs-base text-muted-foreground">Checking…</p>
          ) : error ? (
            <p className="mt-1 text-fs-base text-muted-foreground">{error}</p>
          ) : data ? (
            <>
              <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {[
                  {
                    label: 'Photos',
                    value: `${data.photoCapacity.used.toLocaleString('en-IN')} of ${formatCount(data.photoCapacity.capacity)}`,
                    source: 'purchase' as const,
                  },
                  {
                    label: 'Galleries',
                    value: `${data.used.galleries.toLocaleString('en-IN')} of ${formatCount(data.limits.maxGalleriesPerEvent)}`,
                    source: data.source.maxGalleriesPerEvent,
                  },
                  {
                    label: 'Albums per gallery',
                    value: formatCount(data.limits.maxAlbumsPerGallery),
                    source: data.source.maxAlbumsPerGallery,
                  },
                  {
                    label: 'Largest photo',
                    value: formatBytes(data.limits.maxUploadFileSizeBytes),
                    source: data.source.maxUploadFileSizeBytes,
                  },
                  {
                    label: 'Files per batch',
                    value: formatCount(data.limits.maxUploadBatchSize),
                    source: data.source.maxUploadBatchSize,
                  },
                  {
                    label: 'Public gallery',
                    value: data.defaults.publicGalleryEnabled ? 'Enabled' : 'Disabled',
                    source: data.source.publicGalleryEnabled,
                  },
                ].map(row => (
                  <div key={row.label} className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5">
                    <dt className="text-fs-base text-muted-foreground">{row.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1.5 text-fs-base font-medium tabular-nums text-foreground">
                      {row.value}
                      <SourceChip source={row.source} />
                    </dd>
                  </div>
                ))}
              </dl>

              <p className="mt-2.5 text-fs-2xs leading-relaxed text-muted-foreground">
                Photos use this event’s paid photo capacity, bought on License &amp; Services (up to{' '}
                {data.photoCapacity.max.toLocaleString('en-IN')} per event). The other limits are platform
                defaults unless a chip marks an override.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </Card>
  )
}
