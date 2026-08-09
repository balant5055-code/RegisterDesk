'use client'

// RD-RUNNER-01 · "My Photos".
//
// A grid, a download and a share. No editing, no folders, no organizer controls, no album
// navigation — a participant wants their photos, not a file manager.
//
// The first page is rendered on the server and handed in, so the gallery paints without a
// round trip. Later pages are fetched with the cursor the server returned.

import { useCallback, useState } from 'react'
import { Camera, Check, Copy, Download, Loader2, Share2 } from 'lucide-react'
import { Button, Card, EmptyState } from '@/components/ui'
import type { RunnerPhotoPage, RunnerPhotoView } from '@/features/runner-photos/types'
import type { AttendeePhotosResponse } from '@/app/api/attendee/photos/route'

export interface RunnerPhotoGalleryProps {
  eventSlug: string
  eventName: string
  bibNumber: string
  initial:   RunnerPhotoPage
  /** Stable page URL a participant copies and shares. Never a storage URL. */
  shareUrl:  string
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function RunnerPhotoGallery({
  eventSlug, eventName, bibNumber, initial, shareUrl,
}: RunnerPhotoGalleryProps) {
  const [photos, setPhotos] = useState<RunnerPhotoView[]>(initial.photos)
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor)
  const [busy,   setBusy]   = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const loadMore = useCallback(async () => {
    if (!cursor || busy) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(
        `/api/attendee/photos?eventSlug=${encodeURIComponent(eventSlug)}&cursor=${encodeURIComponent(cursor)}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error('Could not load more photos.')
      const data = await res.json() as AttendeePhotosResponse
      if (!data.ok) throw new Error('Your session expired. Please refresh the page.')
      setPhotos(prev => [...prev, ...data.photos])
      setCursor(data.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more photos.')
    } finally {
      setBusy(false)
    }
  }, [cursor, busy, eventSlug])

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Your browser would not let us copy the link. You can copy it from the address bar.')
    }
  }, [shareUrl])

  const nativeShare = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.share) return
    try {
      // The PAGE, never a photo URL. A storage link would work for whoever received it;
      // this one only works for the person it belongs to, because opening it asks them to
      // verify as themselves.
      await navigator.share({
        title: `My ${eventName} photos`,
        text:  `Race photos for bib ${bibNumber}`,
        url:   shareUrl,
      })
    } catch { /* the sheet was dismissed — not an error worth surfacing */ }
  }, [eventName, bibNumber, shareUrl])

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  if (photos.length === 0) {
    return (
      <EmptyState
        icon={Camera}
        title="No race photos are available yet."
        // Deliberately says nothing about whether unapproved matches exist. A count of
        // photos "awaiting review" would be a signal derived from links a human has not
        // checked — including any that are wrong about who is in them.
        description={`No photos have been published for bib ${bibNumber} at ${eventName} yet. The organizer reviews matches before they appear here, so it is worth checking back after the event.`}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-fs-sm text-muted-foreground">
          {photos.length.toLocaleString('en-IN')} photo{photos.length === 1 ? '' : 's'} matched
          to bib <strong className="text-foreground">{bibNumber}</strong>
        </p>
        <div className="flex flex-wrap gap-2">
          {canNativeShare && (
            <Button size="sm" variant="outline" onClick={() => void nativeShare()}>
              <Share2 className="size-4" aria-hidden /> Share
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void copyLink()}>
            {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            {copied ? 'Link copied' : 'Copy link'}
          </Button>
        </div>
      </div>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {photos.map(photo => {
          const uploaded = formatDate(photo.uploadedAt)
          return (
            <li key={photo.photoId}>
              <Card padded={false} className="h-full overflow-hidden">
                {/* A plain <img>: the source is a short-lived signed URL, and next/image
                    would try to proxy and cache a URL that is about to expire. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.thumbnailUrl}
                  alt={`Race photo from ${photo.galleryName}`}
                  width={photo.width ?? undefined}
                  height={photo.height ?? undefined}
                  loading="lazy"
                  decoding="async"
                  className="aspect-[4/3] w-full bg-muted object-cover"
                />
                <div className="flex items-center justify-between gap-2 p-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-foreground">
                      {photo.galleryName}
                    </p>
                    {/* Labelled as UPLOADED. The platform has no capture time — EXIF is
                        discarded when the photo is compressed — and presenting one as the
                        other would be a small lie repeated thousands of times. */}
                    {uploaded && (
                      <p className="truncate text-fs-2xs text-muted-foreground">
                        Uploaded {uploaded}
                      </p>
                    )}
                  </div>
                  <a
                    href={photo.downloadUrl}
                    className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-label={`Download photo from ${photo.galleryName}`}
                  >
                    <Download className="size-4" aria-hidden />
                  </a>
                </div>
              </Card>
            </li>
          )
        })}
      </ul>

      {error && <p role="alert" className="text-[13.5px] text-destructive">{error}</p>}

      {cursor && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadMore()}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {busy ? 'Loading…' : 'Load more photos'}
          </Button>
        </div>
      )}
    </div>
  )
}
