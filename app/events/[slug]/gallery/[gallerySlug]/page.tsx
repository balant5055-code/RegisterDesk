// RD-PUBGAL-01 · /events/{eventSlug}/gallery/{gallerySlug} — one gallery.
//
// Albums are a FILTER on this page, carried as `?album=`, not a route of their own. A public
// URL therefore stays addressable at the gallery, and switching album does not lose the
// visitor's place in a route they will want to come back from.
//
// A server component: the first page of photos is in the HTML, so the grid paints without a
// round trip and a crawler sees real content.

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { cn } from '@/lib/utils/cn'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { EventPageShell } from '@/components/event-templates/shared/ui/EventPageShell'
import {
  EVENT_CONTAINER, SectionShell, TYPE,
} from '@/components/event-templates/shared/ui/framework'
import { GalleryHero } from '@/features/public-gallery/components/GalleryHero'
import { GalleryCta } from '@/features/public-gallery/components/GalleryCta'
import { BASE_URL } from '@/lib/env'
import { PublicPhotoGrid } from '@/features/public-gallery/components/PublicPhotoGrid'
import {
  getPublicGallery, listPublicPhotos, resolveAlbumId, resolveGalleryId,
  resolvePublicEvent,
} from '@/features/public-gallery/services/publicGalleryService'

type Params = {
  params:       Promise<{ slug: string; gallerySlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export const revalidate = 60

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, gallerySlug } = await params

  const ctx = await resolvePublicEvent(slug)
  if (!ctx) return { title: 'Photos', robots: { index: false, follow: false } }

  const detail = await getPublicGallery(ctx, gallerySlug)
  if (!detail) return { title: 'Photos', robots: { index: false, follow: false } }

  const title = `${detail.gallery.name} — ${ctx.eventName}`
  const description = detail.gallery.description
    ?? `${detail.gallery.photoCount.toLocaleString('en-IN')} photos from ${ctx.eventName}.`
  // Canonical WITHOUT the album filter: an album is a view of this page, not a separate
  // document, and indexing each one would split the same photos across several URLs.
  const url = `${BASE_URL}/events/${slug}/gallery/${gallerySlug}`

  return {
    title, description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: {
      title, description, url, type: 'website',
      images: detail.gallery.coverUrl ? [{ url: detail.gallery.coverUrl }] : undefined,
    },
    twitter: {
      card: detail.gallery.coverUrl ? 'summary_large_image' : 'summary',
      title, description,
      images: detail.gallery.coverUrl ? [detail.gallery.coverUrl] : undefined,
    },
  }
}

export default async function PublicGalleryDetailPage({ params, searchParams }: Params) {
  const { slug, gallerySlug } = await params
  const query = await searchParams

  const ctx = await resolvePublicEvent(slug)
  if (!ctx) notFound()

  const detail = await getPublicGallery(ctx, gallerySlug)
  if (!detail) notFound()

  const rawAlbum = query.album
  const albumSlug = typeof rawAlbum === 'string' && rawAlbum.trim() !== '' ? rawAlbum.trim() : null

  // An album filter is applied server-side, so the first page already reflects it. An album
  // slug that names nothing here is a 404 rather than a silent fall-through to everything.
  let initial = detail.initial
  if (albumSlug) {
    const galleryId = await resolveGalleryId(ctx, gallerySlug)
    const albumId   = galleryId ? await resolveAlbumId(ctx, galleryId, albumSlug) : null
    if (!galleryId || !albumId) notFound()
    initial = await listPublicPhotos(ctx, galleryId, { albumId })
  }

  const activeAlbum = albumSlug
    ? detail.albums.find(a => a.slug === albumSlug) ?? null
    : null

  const base = `/events/${slug}/gallery/${gallerySlug}`

  const shown = activeAlbum?.photoCount ?? detail.gallery.photoCount

  return (
    <EventPageShell variant="marketing" title={`${detail.gallery.name} — ${ctx.eventName}`}>
      <GalleryHero
        eventName={ctx.eventName}
        eventSlug={slug}
        title={detail.gallery.name}
        subtitle={`${shown.toLocaleString('en-IN')} photo${shown === 1 ? '' : 's'}${activeAlbum ? ` in ${activeAlbum.name}` : ''}`}
        description={detail.gallery.description}
        coverUrl={detail.gallery.coverUrl}
      />

      <div className={cn(EVENT_CONTAINER, 'pt-5')}>
        <Breadcrumbs
          items={[
            { label: 'Events', href: '/events' },
            { label: ctx.eventName, href: `/events/${slug}` },
            { label: 'Photos', href: `/events/${slug}/gallery` },
            { label: detail.gallery.name },
          ]}
        />
      </div>

      <SectionShell border={false}>
        {/* Album navigation — links, not buttons: each is a real shareable URL a crawler
            follows. Only albums with public photos appear. */}
        {detail.albums.length > 0 && (
          <nav aria-label="Albums" className="mb-5 flex flex-wrap gap-2">
            <Link
              href={base}
              aria-current={!albumSlug ? 'page' : undefined}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-fs-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                !albumSlug
                  ? 'border-primary/50 bg-primary/[0.06] text-foreground'
                  : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
              )}
            >
              All photos
            </Link>
            {detail.albums.map(album => {
              const active = album.slug === albumSlug
              return (
                <Link
                  key={album.slug}
                  href={`${base}?album=${encodeURIComponent(album.slug)}`}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-fs-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    active
                      ? 'border-primary/50 bg-primary/[0.06] text-foreground'
                      : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
                  )}
                >
                  {album.name}
                  <span className={cn(TYPE.metaSm, 'ml-1.5')}>{album.photoCount}</span>
                </Link>
              )
            })}
          </nav>
        )}

        <PublicPhotoGrid
          eventSlug={slug}
          eventName={ctx.eventName}
          gallerySlug={gallerySlug}
          galleryName={detail.gallery.name}
          albumSlug={albumSlug}
          initial={initial}
          shareUrl={albumSlug ? `${BASE_URL}${base}?album=${encodeURIComponent(albumSlug)}` : `${BASE_URL}${base}`}
        />
      </SectionShell>

      <GalleryCta eventName={ctx.eventName} eventSlug={slug} />
    </EventPageShell>
  )
}
