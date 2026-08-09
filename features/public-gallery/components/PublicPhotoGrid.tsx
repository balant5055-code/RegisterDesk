'use client'

// RD-PUBGAL-01 · The public photo grid.
//
// The first page is rendered on the server and handed in, so the grid paints without a round
// trip and is in the HTML for a crawler. Later pages load on scroll, with an explicit button
// as well — infinite scroll alone strands anyone using a keyboard or a screen reader, and
// makes the page footer unreachable.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Check, Copy, Download, Loader2, Share2 } from 'lucide-react'
import { Button, EmptyState } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { photoAltText } from '@/features/public-gallery/utils/projection'
// RD-MEDIA-11 — ONE download implementation, shared with the organizer browser. The
// `download` attribute alone cannot work here: our route 302s to another origin and the
// attribute is dropped across that boundary. See the helper for the full reason.
// RD-PHOTO-03 — an ORDINARY download. Branding is already part of the stored photo, so
// there is nothing to composite, no overlay to fetch and no transform in the middle.
import { downloadFile, photoFilename } from '@/features/media-studio/utils/downloadFile'
// RD-MEDIA-10 — the SHARED viewer. This module used to ship its own `PhotoLightbox`, a
// second implementation of a component the public site already had. `ImageLightbox` gained
// optional prev/next for this, so there is now exactly one lightbox on the public site.
import { ImageLightbox } from '@/components/event-templates/shared/ui/ImageLightbox'
import { TYPE } from '@/components/event-templates/shared/ui/framework'
import type { PublicPhoto, PublicPhotoPage } from '@/features/public-gallery/types'
import type { PublicPhotosResponse } from '@/app/api/public/events/[slug]/photos/route'

export interface PublicPhotoGridProps {
  eventSlug:   string
  eventName:   string
  gallerySlug: string
  galleryName: string
  albumSlug:   string | null
  initial:     PublicPhotoPage
  /** Stable page URL a visitor copies. Never a storage URL. */
  shareUrl:    string
}

export function PublicPhotoGrid({
  eventSlug, eventName, gallerySlug, galleryName, albumSlug, initial, shareUrl,
}: PublicPhotoGridProps) {
  const [photos, setPhotos] = useState<PublicPhoto[]>(initial.photos)
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor)
  const [busy,   setBusy]   = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [lightbox, setLightbox] = useState<number | null>(null)
  // Which photo is being fetched, so its button can show progress and refuse a second click.
  const [downloading, setDownloading] = useState<string | null>(null)

  const sentinelRef = useRef<HTMLDivElement>(null)
  // Mirrors state for the observer callback, which closes over its first render otherwise.
  const stateRef = useRef({ cursor, busy })
  useEffect(() => { stateRef.current = { cursor, busy } }, [cursor, busy])

  const loadMore = useCallback(async () => {
    const { cursor: at, busy: running } = stateRef.current
    if (!at || running) return

    setBusy(true); setError(null)
    try {
      const params = new URLSearchParams({ gallery: gallerySlug, cursor: at })
      if (albumSlug) params.set('album', albumSlug)

      const res = await fetch(
        `/api/public/events/${encodeURIComponent(eventSlug)}/photos?${params.toString()}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error('Could not load more photos.')

      const data = await res.json() as PublicPhotosResponse
      setPhotos(prev => {
        // De-duplicated by id: a photo deleted between pages shifts the cursor window, and
        // React would otherwise warn about a duplicate key and render the tile twice.
        const seen = new Set(prev.map(p => p.photoId))
        return [...prev, ...data.photos.filter(p => !seen.has(p.photoId))]
      })
      setCursor(data.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more photos.')
    } finally {
      setBusy(false)
    }
  }, [eventSlug, gallerySlug, albumSlug])

  // Infinite scroll, as an ENHANCEMENT over the button below — never the only way through.
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) void loadMore()
    }, { rootMargin: '600px' })   // start fetching before the visitor reaches the end

    observer.observe(node)
    return () => observer.disconnect()
  }, [loadMore])

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
      // The PAGE, never a photo URL — a storage link would bypass every gate on the way in.
      await navigator.share({ title: `${eventName} — ${galleryName}`, url: shareUrl })
    } catch { /* the sheet was dismissed */ }
  }, [eventName, galleryName, shareUrl])

  /**
   * Saves one photo.
   *
   * Stops propagation so the tile's own click never fires — pressing Download must not also
   * open the lightbox behind it.
   */
  const download = useCallback(async (photo: PublicPhoto, position: number) => {
    if (downloading) return
    setDownloading(photo.photoId)
    try {
      const outcome = await downloadFile(
        photo.downloadUrl,
        photoFilename(`${eventName}-${galleryName}`, photo.photoId),
      )

      if (outcome === 'failed') {
        setError('That photo could not be downloaded. Please try again.')
      } else if (outcome === 'opened') {
        // The bucket did not permit a direct read, so the browser navigated instead. Say so
        // rather than letting it look like nothing happened.
        setError('Your browser opened the photo instead of saving it. Use "Save image as…" to keep a copy.')
      } else {
        setError(null)
      }
    } finally {
      setDownloading(null)
    }
    void position
  }, [downloading, eventName, galleryName])

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  if (photos.length === 0) {
    return (
      <EmptyState
        icon={Camera}
        title="No photos here yet"
        description={`${galleryName} has no published photos at the moment. Check back after the event.`}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={TYPE.cardBody}>
          Showing {photos.length.toLocaleString('en-IN')} photo{photos.length === 1 ? '' : 's'}
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

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
        {photos.map((photo, i) => (
          // `group` drives the desktop hover reveal. The download control is a SIBLING of
          // the image button, never nested inside it — a button inside a button is invalid
          // markup and breaks keyboard navigation.
          <li key={photo.photoId} className="group relative">
            <button
              type="button"
              onClick={() => setLightbox(i)}
              aria-label={`Open photo ${i + 1} of ${photos.length}`}
              className={cn(
                'block w-full overflow-hidden rounded-xl border border-border bg-muted',
                'transition-opacity hover:opacity-90',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
              )}
            >
              {/* A plain <img>: the source is a durable public object-storage URL already
                  sized by Media Studio, and next/image would add a second optimisation pass
                  over an already-optimised file. `loading="lazy"` is the lazy loading. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo.url}
                alt={photoAltText(eventName, galleryName, i)}
                width={photo.width ?? undefined}
                height={photo.height ?? undefined}
                loading="lazy"
                decoding="async"
                className="aspect-square w-full object-cover"
              />
            </button>

            <button
              type="button"
              onClick={e => { e.stopPropagation(); void download(photo, i) }}
              disabled={downloading === photo.photoId}
              aria-label={`Download photo ${i + 1} of ${photos.length}`}
              className={cn(
                'absolute right-2 top-2 flex size-9 items-center justify-center rounded-lg',
                'bg-slate-900/70 text-white backdrop-blur-sm transition-all',
                'hover:bg-slate-900/90 disabled:opacity-60',
                // Mobile: always visible — there is no hover to reveal it with.
                // Desktop (hover-capable pointers only): revealed on hover, and ALWAYS on
                // keyboard focus so it can never be reached but not seen.
                'opacity-100 [@media(hover:hover)]:opacity-0',
                '[@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100',
                'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
              )}
            >
              {downloading === photo.photoId
                ? <Loader2 className="size-4 animate-spin" aria-hidden />
                : <Download className="size-4" aria-hidden />}
            </button>
          </li>
        ))}
      </ul>

      {error && <p role="alert" className={cn(TYPE.cardBody, 'text-destructive')}>{error}</p>}

      {/* Both the trigger for infinite scroll and the accessible way through it. */}
      <div ref={sentinelRef} className="flex justify-center py-2">
        {cursor ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadMore()}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {busy ? 'Loading…' : 'Load more photos'}
          </Button>
        ) : (
          photos.length > 12 && (
            <p className={TYPE.metaSm}>That is all the photos.</p>
          )
        )}
      </div>

      <ImageLightbox
        open={lightbox !== null}
        src={lightbox !== null ? (photos[lightbox]?.largeUrl ?? '') : ''}
        alt={lightbox !== null ? photoAltText(eventName, galleryName, lightbox) : ''}
        onClose={() => setLightbox(null)}
        downloadHref={lightbox !== null ? photos[lightbox]?.downloadUrl : undefined}
        // The SAME helper the tiles use, so the viewer saves rather than opening a tab.
        onDownload={() => {
          const photo = lightbox !== null ? photos[lightbox] : null
          if (photo) void download(photo, lightbox ?? 0)
        }}
        // Wraps, so the last photo's Next returns to the first rather than dead-ending.
        onPrev={() => setLightbox(i => (i === null ? null : (i - 1 + photos.length) % photos.length))}
        onNext={() => setLightbox(i => (i === null ? null : (i + 1) % photos.length))}
        index={lightbox !== null ? lightbox + 1 : undefined}
        total={photos.length}
      />
    </div>
  )
}
