// ─── Landing hero — composition only ─────────────────────────────────────────
//
// RD-HERO-03. A SERVER component, and deliberately a thin one. It owns the section and
// the order of things; every part with behaviour or content of its own lives in its own
// file:
//
//   HeroStage       client · owns the slide index; the full-width stage
//   HeroCopy        client · the statement, the chapter controls, the highlights
//   HeroBackdrop    server · one full-stage CURATED photograph per slide — no event art
//   heroSlides.ts   data   · the copy, per slide
//   heroMotion.ts   data   · the animation score
//
// ═══ THE DESIGN ══════════════════════════════════════════════════════════════
// One photograph at a time, edge to edge, with the statement set over it in a display
// serif — one element at real scale, and everything else quiet. The search capsule is
// the only thing on the page that is allowed to cross the photograph's lower edge: it
// sits half on the picture and half on the paper below, the way a concierge desk sits
// in a lobby. Nothing else here is decorative: no chips, no metrics, no gradient text.
//
// ═══ GEOMETRY ════════════════════════════════════════════════════════════════
//   • The stage is the <section>'s own width. It reaches the browser edge because the
//     section does — never through a negative margin, never through 100vw — so it can
//     never run past the viewport and there is no horizontal scroll to suppress.
//   • The copy and the capsule share the page container (lib/ds/containers →
//     container.page), so the statement's left edge is the page's left edge.
//   • The capsule is pulled up over the stage with a negative TOP margin on its own
//     wrapper, which is a vertical overlap and the intended one.
//
// NO METRICS LINE, NO COUNTS, NO TESTIMONIALS. The hero states nothing countable: the
// only source of truth for anything numeric on this page is `listPublishedEvents`, and
// real events appear in Upcoming Events — never as the hero's photography.

import { Suspense } from 'react'
import { cn } from '@/lib/utils/cn'
import { container } from '@/lib/ds/containers'
import { HomeSearch, ActiveFilterChips, SEARCH_CAPSULE_MIN_H } from './HomeSearch'
import { BrowseShortcuts } from './BrowseShortcuts'
import { HeroBackdrop } from './HeroBackdrop'
import { HeroStage } from './HeroStage'
import { HERO_SLIDES } from './heroSlides'

export interface HomeHeroProps {
  cityCounts:  { name: string; count: number }[]
  stateCounts: { name: string; count: number }[]
}

/** Mirrors the capsule's footprint so hydration causes no layout shift. */
function SearchFallback() {
  return (
    <div
      aria-hidden
      className={cn(SEARCH_CAPSULE_MIN_H, 'w-full animate-pulse rounded-xl border border-border/70 bg-card')}
    />
  )
}

export function HomeHero({ cityCounts, stateCounts }: HomeHeroProps) {
  return (
    <section className="relative bg-background">
      {/* The stage shows curated photography only — no live event art, and so no
          per-slide event credit. HERO_SLIDES is still the single source of how many
          slides there are. */}
      {/* The photograph runs up BENEATH the fixed header, so on arrival the bar and the
          hero are one image (HomeNavbar renders over-the-hero on the homepage until
          scrolled). The wrapper pulls up by the header's height and the stage takes the
          same amount back as top padding, with box-content so its fixed height still
          measures the copy area alone. Net effect on the page below: zero. The top scrim
          keeps the white menu type legible over bright photographs. */}
      <div className="relative -mt-[var(--disc-nav-h)] [&>[data-hero-stage]]:box-content [&>[data-hero-stage]]:pt-[var(--disc-nav-h)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[calc(var(--disc-nav-h)+3rem)] bg-gradient-to-b from-black/45 to-transparent"
        />
        <HeroStage backdrop={<HeroBackdrop />} credits={HERO_SLIDES.map(() => null)} />
      </div>

      {/* ── The search capsule: half on the photograph, half on the page. The search
             component itself is untouched — same URL state, so search, category,
             location and date behave exactly as they did. ── */}
      <div className={cn(container.page, 'relative z-[4] -mt-10 sm:-mt-9')}>
        <div className="rounded-xl shadow-[0_24px_60px_-20px_rgb(11_21_51/0.45)]">
          <Suspense fallback={<SearchFallback />}>
            <HomeSearch cityCounts={cityCounts} stateCounts={stateCounts} />
            <ActiveFilterChips />
          </Suspense>
        </div>

        <div className="mt-6 pb-8 lg:mt-7 lg:pb-10">
          <BrowseShortcuts />
        </div>
      </div>
    </section>
  )
}
