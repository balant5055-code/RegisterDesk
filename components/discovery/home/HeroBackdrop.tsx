// ─── Landing hero — the photographs ──────────────────────────────────────────
//
// A SERVER component. One full-stage photograph per slide, every one of them in the DOM;
// the stage publishes the active index as a data attribute and CSS (RD-HERO-03 in
// app/globals.css) crossfades between them. Nothing here is interactive, so next/image
// and the event data never enter the client bundle.
//
// ═══ WHAT A SLIDE SHOWS ══════════════════════════════════════════════════════
// The CURATED photographs, and only those. The stage used to pull a live event's banner
// in as slide art (with a "featured" credit linking to it), which put whichever event
// happened to be published at the top of the homepage. The landing hero is the product's
// own picture, not an event's, so nothing here reads event data any more.
//
// This is the ONLY place on the homepage where a non-event image appears. Every
// curated URL was probed for a 200; images.unsplash.com is already in next.config's
// `remotePatterns` and in APPROVED_IMAGE_HOSTS.
//
// ═══ THE SCRIM ═══════════════════════════════════════════════════════════════
// Gradients from --hero-ink, stated in the markup so a designer can read them: one
// rises from the bottom (the copy sits there), one comes in from the left (the copy is
// left-aligned), and a flat pass catches stray highlights. The photograph is fully
// visible top-right, which is where the eye is allowed to rest. There is no blur and no
// colour cast — the photograph is the material; the scrim only makes the ink legible.

import Image from 'next/image'
import { HERO_SLIDES } from './heroSlides'

/**
 * Curated photography — an auditorium audience · a crowd under confetti · runners at dawn.
 *
 * Chosen to be DARK IN THEMSELVES rather than darkened by the scrim. The first set was
 * lit and busy (a conference photograph whose subject was a projected screenshot), and
 * holding white type on it needed so much ink that the picture stopped being a picture.
 * These three already live in the hero's own navy register, so the scrim can be light
 * enough to leave the photograph visible. None of them is one of the three the login
 * carousel uses (components/auth/authCarouselSlides.ts) — the same photograph on the
 * landing page and on sign-in reads as a stock library, not as a brand.
 */
const CURATED_IMAGES = [
  'https://images.unsplash.com/photo-1531058020387-3be344556be6?w=2200&q=82&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=2200&q=82&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1552674605-db6ffd4facb5?w=2200&q=82&auto=format&fit=crop',
] as const

const COUNT = HERO_SLIDES.length

export interface HeroSlot {
  /** Always null: the stage shows curated photography, never an event's own art. */
  event: null
  src:   string
}

/**
 * One curated photograph per slide. Exported for the tests: that the hero credits and
 * shows NO event is the promise, not an implementation detail.
 */
export function buildHeroSlots(): HeroSlot[] {
  return Array.from({ length: COUNT }, (_, i) => ({ event: null, src: CURATED_IMAGES[i] }))
}

export function HeroBackdrop() {
  const slots = buildHeroSlots()
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden bg-hero-ink">
      {slots.map((slot, i) => (
        <figure key={HERO_SLIDES[i].id} data-hero-backdrop={i} className="absolute inset-0 m-0">
          <Image
            src={slot.src}
            alt=""
            fill
            // The first photograph is the largest element in the first viewport: it is
            // the LCP candidate and is fetched eagerly. The others wait.
            priority={i === 0}
            loading={i === 0 ? 'eager' : 'lazy'}
            sizes="100vw"
            className="object-cover"
          />
          {/* The scrim, in three passes. Measured on the real photographs: a conference
              shot with a lit projection screen puts a near-white rectangle exactly where
              the headline sits, and two soft gradients were not enough to hold white type
              on it. The bottom-up pass carries the copy, the left-in pass carries the
              first two-thirds of the headline, and a flat 10% over everything keeps a
              bright highlight anywhere in the frame from punching through. The top-right
              corner is still the lightest part of the picture — that is where the eye is
              allowed to rest. */}
          <span className="absolute inset-0 bg-gradient-to-t from-hero-ink via-hero-ink/70 to-hero-ink/15" />
          <span className="absolute inset-0 bg-gradient-to-r from-hero-ink/80 via-hero-ink/35 to-transparent" />
          <span className="absolute inset-0 bg-hero-ink/10" />
        </figure>
      ))}
      {/* A grain so fine it reads as paper, not as an effect. Static, and it is the one
          thing here allowed to sit above the scrim. */}
      <span className="rd-hero-grain pointer-events-none absolute inset-0 z-[2] opacity-[0.05] mix-blend-overlay" />
    </div>
  )
}
