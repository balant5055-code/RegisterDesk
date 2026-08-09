// RD-PUBGAL-01 · /events/{eventSlug}/gallery — the public photo gallery landing page.
//
// ─── Why `gallery` and not `photos` ──────────────────────────────────────────
// `/events/{slug}/photos` is ALREADY the participant's own verified gallery (RD-RUNNER-01):
// email-verified, bib-scoped, no-store, noindex. This one is the opposite in every respect —
// anonymous, event-wide, cached and indexable. Two routes, because they are two different
// things; collapsing them would mean one page whose access model depends on who is looking.
//
// RD-MEDIA-10: the page now sits inside the SHARED public chrome. Before this it rendered
// a bare <main> — no navbar, no footer, no breadcrumb, its own container width and its own
// type sizes. It was a correct page that did not look like part of RegisterDesk.
//
// Structure: Header → Hero → Information → Grid → CTA → Footer, all from
// `EventPageShell` and `components/event-templates/shared/ui/framework`.
//
// A server component. Both gates run here, before anything renders.

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Camera, ImageIcon } from 'lucide-react'
import { Card, EmptyState } from '@/components/ui'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { cn } from '@/lib/utils/cn'
import { EventPageShell } from '@/components/event-templates/shared/ui/EventPageShell'
import {
  CARD, EVENT_CONTAINER, GRID_GAP, SectionShell, TYPE,
} from '@/components/event-templates/shared/ui/framework'
import { GalleryHero } from '@/features/public-gallery/components/GalleryHero'
import { GalleryCta } from '@/features/public-gallery/components/GalleryCta'
import { BASE_URL } from '@/lib/env'
import {
  getPublicGalleryIndex, resolvePublicEvent,
} from '@/features/public-gallery/services/publicGalleryService'

type Params = { params: Promise<{ slug: string }> }

/** Matches the public event page. The payload is identical for every visitor. */
export const revalidate = 60

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const ctx = await resolvePublicEvent(slug)
  if (!ctx) return { title: 'Photos', robots: { index: false, follow: false } }

  const index = await getPublicGalleryIndex(ctx)
  const title = `Photos — ${ctx.eventName}`
  const description = index.totalPhotos > 0
    ? `Browse ${index.totalPhotos.toLocaleString('en-IN')} photos from ${ctx.eventName}.`
    : `Photos from ${ctx.eventName}.`
  const url = `${BASE_URL}/events/${slug}/gallery`
  const cover = index.galleries.find(g => g.coverUrl)?.coverUrl

  return {
    title,
    description,
    alternates: { canonical: url },
    // Indexable, unlike the participant's private gallery — these photos are published.
    // An event with no public photos is left out of the index rather than offering a crawler
    // an empty page.
    robots: index.totalPhotos > 0
      ? { index: true, follow: true }
      : { index: false, follow: true },
    openGraph: {
      title, description, url, type: 'website',
      images: cover ? [{ url: cover }] : undefined,
    },
    twitter: {
      card: cover ? 'summary_large_image' : 'summary',
      title, description,
      images: cover ? [cover] : undefined,
    },
  }
}

export default async function PublicGalleryPage({ params }: Params) {
  const { slug } = await params

  const ctx = await resolvePublicEvent(slug)
  if (!ctx) notFound()

  const index = await getPublicGalleryIndex(ctx)

  const cover = index.galleries.find(g => g.coverUrl)?.coverUrl ?? null

  return (
    <EventPageShell variant="marketing" title={`Photos — ${ctx.eventName}`}>
      <GalleryHero
        eventName={ctx.eventName}
        eventSlug={slug}
        title="Event photos"
        subtitle={index.totalPhotos > 0
          ? `${index.totalPhotos.toLocaleString('en-IN')} photo${index.totalPhotos === 1 ? '' : 's'} across ${index.galleries.length} ${index.galleries.length === 1 ? 'gallery' : 'galleries'}`
          : undefined}
        coverUrl={cover}
      />

      {/* Breadcrumb — the SAME component every Event Details page uses. */}
      <div className={cn(EVENT_CONTAINER, 'pt-5')}>
        <Breadcrumbs
          items={[
            { label: 'Events', href: '/events' },
            { label: ctx.eventName, href: `/events/${slug}` },
            { label: 'Photos' },
          ]}
        />
      </div>

      <SectionShell border={false}>
        {index.galleries.length === 0 ? (
          <EmptyState
            icon={Camera}
            title="No photos have been published yet"
            description={`${ctx.eventName} has no public photo galleries at the moment. Check back after the event.`}
          />
        ) : (
          <ul className={cn('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3', GRID_GAP)}>
            {index.galleries.map(gallery => (
              <li key={gallery.slug}>
                <Link
                  href={`/events/${slug}/gallery/${gallery.slug}`}
                  className="group block h-full rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  <Card padded={false} className={cn(CARD, 'h-full overflow-hidden')}>
                    <div className="aspect-[4/3] w-full bg-muted">
                      {gallery.coverUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={gallery.coverUrl}
                          alt={`${gallery.name} — ${ctx.eventName}`}
                          loading="lazy"
                          decoding="async"
                          className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                        />
                      ) : (
                        <div className="flex size-full items-center justify-center" aria-hidden>
                          <ImageIcon className="size-8 text-muted-foreground/40" />
                        </div>
                      )}
                    </div>
                    <div className="p-4">
                      <h2 className={TYPE.cardTitle}>{gallery.name}</h2>
                      <p className={cn(TYPE.metaSm, 'mt-0.5')}>
                        {gallery.photoCount.toLocaleString('en-IN')} photo
                        {gallery.photoCount === 1 ? '' : 's'}
                      </p>
                      {gallery.description && (
                        <p className={cn(TYPE.cardBody, 'mt-1.5 line-clamp-2')}>
                          {gallery.description}
                        </p>
                      )}
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionShell>

      <GalleryCta eventName={ctx.eventName} eventSlug={slug} />
    </EventPageShell>
  )
}
