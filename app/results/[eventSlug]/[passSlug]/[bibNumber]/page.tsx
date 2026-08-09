// Runner result — /results/{eventSlug}/{passSlug}/{bibNumber}
//
// Mobile-first. Server component; the bib lookup is a single Firestore document GET
// (the entry id IS the normalised bib), so this page costs two reads total.

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Award, Camera, Clock, Hash, ImageOff, Medal, Timer } from 'lucide-react'
import {
  ResultsBreadcrumb, ResultsShell,
} from '@/features/race-operations/components/public/ResultsChrome'
import { getRunnerResult } from '@/features/race-operations/services/publicResults'
import { formatRaceTime } from '@/features/race-operations/import/validation/time'
import { RACE_RESULT_STATUS_LABEL } from '@/features/race-operations/types/results'
import { BadgeShare } from '@/features/finisher-badges/components/BadgeShare'
// RD-RESULTS-PUBLIC-FIX-01 · the EXISTING gallery readers, through one resolver.
import { resolveResultPhotos } from '@/features/race-operations/services/resultPhotos'
import { PrintResultButton } from '@/features/race-operations/components/public/PrintResultButton'
import { cn } from '@/lib/utils/cn'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

export const revalidate = 300

type Params = { params: Promise<{ eventSlug: string; passSlug: string; bibNumber: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { eventSlug, passSlug, bibNumber } = await params
  const found = await getRunnerResult(eventSlug, passSlug, decodeURIComponent(bibNumber)).catch(() => null)
  if (!found) return { title: 'Result not found — RegisterDesk', robots: { index: false } }

  const { race, result } = found
  const who   = result.name ?? `Bib ${result.bibNumber}`
  const title = `${who} — ${race.passName} Result`
  const time  = result.chipTimeMs !== null ? formatRaceTime(result.chipTimeMs) : null
  const description = time
    ? `${who} finished ${race.passName} at ${race.eventName} in ${time}.`
    : `${who} — ${race.passName} result at ${race.eventName}.`
  const url = `${BASE_URL}/results/${eventSlug}/${passSlug}/${encodeURIComponent(result.bibNumber)}`

  return {
    title, description,
    metadataBase: new URL(BASE_URL),
    alternates: { canonical: url },
    openGraph: { type: 'profile', url, siteName: 'RegisterDesk', title, description },
    // RD-RESULTS-PUBLIC-FIX-01 · large card: this page has a finisher badge to show, and a
    // shared result is the single most likely thing to be posted from this product.
    twitter:   { card: 'summary_large_image', title, description },
  }
}

function Stat({
  icon: Icon, label, value, emphasis = false,
}: { icon: typeof Clock; label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={cn(
      'rounded-xl border p-4',
      emphasis ? 'border-primary/30 bg-primary/[0.04]' : 'border-border bg-card',
    )}>
      <div className="flex items-center gap-1.5 text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </div>
      <p className={cn(
        'mt-1.5 font-bold tabular-nums text-foreground',
        emphasis ? 'text-[28px] leading-none' : 'text-fs-xl leading-none',
      )}>
        {value}
      </p>
    </div>
  )
}

export default async function RunnerResultPage({ params }: Params) {
  const { eventSlug, passSlug, bibNumber } = await params
  const bib = decodeURIComponent(bibNumber)

  const found = await getRunnerResult(eventSlug, passSlug, bib).catch(() => null)

  // Resolved in parallel with nothing else to wait on. Fails soft to `unavailable`, so a
  // gallery problem can never stop a runner seeing their finish time.
  const photos = found ? await resolveResultPhotos(eventSlug) : null
  if (!found) notFound()

  const { race, result } = found
  const who      = result.name ?? `Bib ${result.bibNumber}`
  const finished = result.status === 'finished'

  return (
    <ResultsShell>
      <ResultsBreadcrumb items={[
        { label: 'Results',      href: '/results' },
        { label: race.eventName, href: `/results/${eventSlug}` },
        { label: race.passName,  href: `/results/${eventSlug}/${passSlug}` },
        { label: `Bib ${result.bibNumber}` },
      ]} />

      {/* ── Hero ── */}
      <header className="mb-6 rounded-2xl border border-border bg-card p-6 sm:p-8">
        <p className="text-fs-2xs font-semibold uppercase tracking-[0.12em] text-primary">
          {race.eventName} · {race.passName}
        </p>
        <h1 className="mt-2 text-fs-xl font-bold tracking-tight text-foreground sm:text-[28px]">
          {who}
        </h1>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-fs-base text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Hash className="size-3.5" aria-hidden />
            {result.bibNumber}
          </span>
          <span className={cn(
            'inline-flex rounded-md px-2 py-0.5 text-fs-2xs font-semibold',
            finished ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning',
          )}>
            {RACE_RESULT_STATUS_LABEL[result.status]}
          </span>
        </p>
      </header>

      {/* ── Official numbers ── */}
      <section aria-label="Official result" className="mb-6 grid gap-3 sm:grid-cols-2">
        <Stat
          icon={Timer}
          label="Official chip time"
          value={result.chipTimeMs !== null ? formatRaceTime(result.chipTimeMs) : '—'}
          emphasis
        />
        <Stat
          icon={Medal}
          label="Overall position"
          value={result.overallRank !== null ? `#${result.overallRank}` : '—'}
          emphasis
        />
        {result.gunTimeMs !== null && (
          <Stat icon={Clock} label="Gun time" value={formatRaceTime(result.gunTimeMs)} />
        )}
        <Stat
          icon={Hash}
          label="Finishers in this race"
          value={race.finisherCount.toLocaleString('en-IN')}
        />
      </section>

      {/* ── Finisher badge (RD-BADGE-01) ──
          The image endpoint generates the PNG on first request from the OFFICIAL SNAPSHOT and
          serves the stored one thereafter. It is safe to render unconditionally: this page
          only exists when a live snapshot already contains this bib. */}
      <BadgeShare
        badgeUrl={`/api/public/badges/${eventSlug}/${passSlug}/${encodeURIComponent(result.bibNumber)}`}
        shareUrl={`${BASE_URL}/results/${eventSlug}/${passSlug}/${encodeURIComponent(result.bibNumber)}`}
        runnerName={who}
        raceName={race.passName}
      />

      {/* ── Certificate ──
          Links to the EXISTING certificate module. It deliberately does NOT serve a PDF
          from this page: a certificate is reached by registrationId, which is a
          non-guessable capability token, while a bib is printed on a shirt and published
          right here. Serving by bib would make every participant's certificate publicly
          enumerable. The participant signs in and downloads through the flow that already
          exists. */}
      <section aria-label="Certificate" className="mb-6">
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3.5">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted" aria-hidden>
              <Award className="size-[18px] text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <h2 className="text-fs-md font-semibold text-foreground">Your certificate</h2>
              <p className="mt-1 text-fs-sm leading-relaxed text-muted-foreground">
                Certificates carry your finish time and position. Sign in with the email you
                registered with to download yours.
              </p>
            </div>
          </div>
          <Link
            href="/attendee/certificates"
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-5 text-fs-base font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            style={{ backgroundImage: 'var(--primary-gradient)' }}
          >
            <Award className="size-4" aria-hidden />
            Get certificate
          </Link>
        </div>
      </section>

      {/* ── RD-RESULTS-PUBLIC-FIX-01 · Photos ────────────────────────────────
          The comment that used to sit here said photos and badges were "out of scope
          … an empty promise is worse than no promise". The badge above it had since
          shipped, and so had both photo surfaces — so the promise was no longer empty and
          the journey ended for no reason.

          Three states, three different sentences. "None yet" is a promise, "no gallery"
          is a decision, and saying one when the other is true is the mistake that comment
          was guarding against. When there is no gallery this renders NOTHING. */}
      {photos && photos.state !== 'unavailable' && (
        <section aria-label="Photos" className="mb-6">
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3.5">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted" aria-hidden>
                {photos.state === 'available'
                  ? <Camera className="size-[18px] text-muted-foreground" />
                  : <ImageOff className="size-[18px] text-muted-foreground" />}
              </div>
              <div className="min-w-0">
                <h2 className="text-fs-md font-semibold text-foreground">Race photos</h2>
                <p className="mt-1 text-fs-sm leading-relaxed text-muted-foreground">
                  {photos.state === 'available'
                    ? `${photos.photoCount.toLocaleString('en-IN')} photos from this event are published. Find yours, or browse the full gallery.`
                    : 'Photos from this event have not been published yet. Check back after the organizer uploads them.'}
                </p>
              </div>
            </div>

            {photos.state === 'available' && photos.myPhotosHref && photos.galleryHref && (
              <div className="flex shrink-0 flex-wrap gap-2">
                {/* The participant page verifies identity itself — the bib is never a
                    parameter, so this link reveals nothing about who ran. */}
                <Link
                  href={photos.myPhotosHref}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-fs-base font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                >
                  <Camera className="size-4" aria-hidden />
                  View my photos
                </Link>
                <Link
                  href={photos.galleryHref}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border px-5 text-fs-base font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Full gallery
                </Link>
              </div>
            )}
          </div>
        </section>
      )}

      {/* RD-RESULTS-PUBLIC-FIX-01 · print. A client island for one button rather than a
          client page — the result itself stays server-rendered and indexable. */}
      <div className="mb-6">
        <PrintResultButton />
      </div>

      <Link
        href={`/results/${eventSlug}/${passSlug}`}
        className="inline-flex items-center gap-1.5 text-fs-base font-semibold text-primary hover:underline"
      >
        View the full {race.passName} leaderboard
      </Link>
    </ResultsShell>
  )
}
