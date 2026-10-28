// Custom Event template — the invitation hero (compact).
//
// Custom events are usually promoted with a designed POSTER dense with its own type. The
// legacy fallback darkened it behind the title, so two headlines fought. Here the poster
// is shown whole on a mat beside the title, and both sit INSIDE the page container — the
// hero shares the exact left and right edges of every section below it.
//
// Date, time, place and the register action live in the registration card directly
// below/beside, so the hero carries only identity: kicker, title, tagline, lede.

import { cn } from '@/lib/utils/cn'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import { buildEventBreadcrumbs } from '@/lib/events/breadcrumbs'
import { EVENT_CONTAINER } from '@/components/event-templates/shared/ui/framework'
import type { EventDetailProps } from '@/components/event-templates/types'
import { LuxeEyebrow } from './luxe'

export function CustomHero({ props, kicker }: { props: EventDetailProps; kicker: string | null }) {
  const { title, tagline, shortDesc, bannerUrl, logoUrl } = props
  const lede = shortDesc?.trim() || ''
  const presentedBy = props.showOrg && props.organizer?.name?.trim() ? props.organizer.name.trim() : null

  return (
    <section aria-label="Event overview" className="border-b border-border/60 bg-background">
      <div className={cn(EVENT_CONTAINER, 'pb-8 pt-6 sm:pb-10 lg:pb-12')}>
        <Breadcrumbs items={buildEventBreadcrumbs(null, title)} />

        <div className="mt-6 grid items-center gap-8 sm:mt-8 md:grid-cols-12 lg:gap-12">
          {/* ── Identity ──────────────────────────────────────────────── */}
          <div className="min-w-0 md:col-span-7">
            {/* RD-CUSTOM-PUBLIC-01 — the event logo (Branding & Media). The legacy page this
                template replaced showed it; the template had dropped it. */}
            {logoUrl?.trim() && (
              // eslint-disable-next-line @next/next/no-img-element -- organizer artwork of arbitrary aspect
              <img
                src={logoUrl}
                alt={`${title} logo`}
                className="mb-5 block size-14 rounded-control border border-border/60 bg-card object-contain p-1"
              />
            )}
            {kicker && <LuxeEyebrow>{kicker}</LuxeEyebrow>}
            <h1 className="mt-4 text-balance font-display text-fs-display-md font-light tracking-[-0.02em] text-hero-ink leading-[1.08]">
              {title}
            </h1>
            {tagline?.trim() && (
              <p className="mt-3 max-w-xl font-display text-fs-lg italic font-light text-hero-ink-soft leading-snug">
                {tagline}
              </p>
            )}
            {lede && lede !== tagline?.trim() && (
              <p className="mt-4 max-w-xl text-fs-base text-hero-ink-soft leading-relaxed sm:text-fs-md">{lede}</p>
            )}
            {presentedBy && (
              <p className="mt-5 text-fs-sm text-hero-ink-soft">
                Presented by <span className="font-medium text-hero-ink">{presentedBy}</span>
              </p>
            )}
          </div>

          {/* ── The poster, matted ────────────────────────────────────── */}
          <figure className="min-w-0 md:col-span-5">
            <div className="rounded-surface border border-border/70 bg-surface-3/60 p-2.5 sm:p-3">
              {bannerUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- organizer artwork of arbitrary aspect; shown whole
                <img
                  src={bannerUrl}
                  alt={`${title} — event poster`}
                  className="mx-auto block h-auto max-h-[26rem] w-full rounded-control border border-border/60 bg-card object-contain"
                  fetchPriority="high"
                />
              ) : (
                // No artwork: a typographic plate rather than an empty frame.
                <div className="flex aspect-[16/10] w-full flex-col items-center justify-center rounded-control border border-border/60 bg-card px-8 text-center">
                  <span aria-hidden className="font-display text-fs-5xl font-light text-hero-accent-rule leading-none">
                    {title.trim().charAt(0).toUpperCase()}
                  </span>
                  <span aria-hidden className="mt-4 h-px w-8 bg-hero-accent-rule" />
                  <span className="mt-4 font-display text-fs-md text-hero-ink">{title}</span>
                </div>
              )}
            </div>
          </figure>
        </div>
      </div>
    </section>
  )
}
