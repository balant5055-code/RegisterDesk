// RD-RUNNER-01 · /events/{eventSlug}/photos — the participant's own race photos.
//
// A server component. Access is decided here, before anything renders, so the browser is
// never sent a photo it then has to be trusted not to show. The only client code is the
// grid (which pages) and the verification form (which reuses the existing attendee OTP).
//
// NEVER cached: the page is per-participant and its image URLs are short-lived signatures.
//
// CHROME: this route rendered a bare <main> and nothing else — no masthead, no footer, no
// skip link — so a participant who followed a photo link was on a page with no way back
// into the site. It now renders inside HomeShell like every other public route. HomeShell
// owns the <main id="main-content"> landmark, so what is below is a measured column, and
// BOTH the access-failure branch and the gallery branch are wrapped: a failure surface is
// exactly where someone needs the navigation most.

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Camera, IdCard } from 'lucide-react'
import { HomeShell } from '@/components/discovery/home/HomeShell'
import { Card, EmptyState } from '@/components/ui'
import { findPublicEvent } from '@/lib/events/publicEventAccess'
import { listRunnerPhotos, resolveRunner } from '@/features/runner-photos/services/photoAccess'
import { RunnerPhotoGallery } from '@/features/runner-photos/components/RunnerPhotoGallery'
import { PhotoVerifyPanel } from '@/features/runner-photos/components/PhotoVerifyPanel'
import { BASE_URL } from '@/lib/env'

export const dynamic = 'force-dynamic'   // per-participant; never statically rendered
export const revalidate = 0

type Params = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const event = await findPublicEvent(slug)
  const name  = (event?.eventDetails as { info?: { name?: string } } | undefined)?.info?.name
    ?? 'this event'

  return {
    title: `My photos — ${name}`,
    // Nothing here is for a search engine: the content is one participant's own photographs.
    robots: { index: false, follow: false },
  }
}

export default async function RunnerPhotosPage({ params }: Params) {
  const { slug } = await params

  // findPublicEvent, not a bare document read: this page used to render for a draft or
  // taken-down event because it only checked that the document existed.
  const event = await findPublicEvent(slug)
  if (!event) notFound()

  const eventName = (event.eventDetails as { info?: { name?: string } } | undefined)?.info?.name
    ?? 'this event'

  const resolved = await resolveRunner(slug)

  const header = (
    <header className="mb-6">
      <p className="text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {eventName}
      </p>
      <h1 className="mt-1 text-fs-2xl font-bold tracking-tight text-foreground">
        My photos
      </h1>
    </header>
  )

  if (!resolved.ok) {
    const reason = (resolved.outcome as { ok: false; reason: string }).reason

    return (
      <HomeShell>
        <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
          {header}

          {reason === 'unverified' && <PhotoVerifyPanel eventName={eventName} />}

          {reason === 'not_registered' && (
            <Card>
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted" aria-hidden>
                  <IdCard className="size-[18px] text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-fs-md font-semibold text-foreground">
                    We have no entry for you at {eventName}
                  </h2>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
                    Photos are matched to confirmed entries. If you registered with a different
                    email address, verify with that one instead — you can{' '}
                    <Link href="/attendee" className="font-semibold text-action hover:opacity-80">
                      see all your entries here
                    </Link>.
                  </p>
                </div>
              </div>
            </Card>
          )}

          {reason === 'no_bib' && (
            <EmptyState
              icon={IdCard}
              title="No bib number yet"
              description={`Your entry to ${eventName} is confirmed, but a bib number has not been assigned yet. Photos are matched by bib, so they will appear here once it is.`}
            />
          )}

          {reason === 'no_event' && (
            <EmptyState
              icon={Camera}
              title="No race photos are available yet."
              description="This event has no photo gallery."
            />
          )}
        </div>
      </HomeShell>
    )
  }

  const page = await listRunnerPhotos({ runner: resolved.runner })

  return (
    <HomeShell>
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        {header}
        <RunnerPhotoGallery
          eventSlug={slug}
          eventName={eventName}
          bibNumber={resolved.runner.bibNumber}
          initial={page}
          // The PAGE, not a photo. Whoever receives it sees their own photos, not the
          // sender's — sharing a link can never share the pictures.
          shareUrl={`${BASE_URL}/events/${slug}/photos`}
        />
      </div>
    </HomeShell>
  )
}
