// ─── Auth carousel slides ────────────────────────────────────────────────────
//
// The brand storytelling beside the sign-in form. Data only — no JSX, no state,
// no imports from the auth layer — so the copy and the imagery can be reviewed
// without reading a component.
//
// ═══ WHY THESE IMAGES, AND WHERE THEY COME FROM ══════════════════════════════
// `public/` holds no photography: only the logo, the favicon and og-image.png.
// The one precedent in this repo for editorial imagery on a public surface is
// HeroBackdrop's CURATED_IMAGES — curated images.unsplash.com URLs served
// through next/image. That host is already on APPROVED_IMAGE_HOSTS
// (lib/utils/imageUrl.ts) and in next.config's `remotePatterns`, and the CSP
// allows `img-src https:`. This reuses that exact mechanism rather than adding a
// provider or inventing assets.
//
// It inherits the same caveat, stated plainly: this is curated stock, not
// RegisterDesk's own photography. When real event photography exists, swap the
// three `src` values here and nothing else changes.
//
// ═══ WHAT THE IMAGERY DELIBERATELY IS NOT ════════════════════════════════════
// No marathon, runners, road race, bibs or track. RegisterDesk runs races among
// many other things, and leading the sign-in screen with one vertical tells an
// organizer of a conference or a school fest that the product is not for them.
// HeroBackdrop's third image IS a road race; it is specifically not reused here.
//
// The copy makes no product claim, cites no number, and names no customer. It
// says what the product is for, which is the one thing that needs no proof.

export interface AuthSlide {
  /** Two-digit ordinal shown in the corner — part of the editorial treatment. */
  ordinal:  string
  headline: string
  body:     string
  /** Absolute URL on an already-approved host. */
  src:      string
  /**
   * Alt text is intentionally EMPTY and unused: the panel is decorative and the
   * whole column is aria-hidden, so a description would announce scenery to a
   * screen-reader user trying to sign in. Kept as a field so a future
   * non-decorative use has somewhere to put it rather than inventing one.
   */
  alt:      ''
}

/** Shared query string: same width, quality and crop for all three, so the
 *  panel never shifts weight between slides. */
const RENDITION = 'w=1600&q=80&auto=format&fit=crop'

export const AUTH_SLIDES: readonly AuthSlide[] = [
  {
    ordinal:  '01',
    headline: 'Events bring people together.',
    body:     'Discover and experience moments that matter.',
    src:      `https://images.unsplash.com/photo-1505373877841-8d25f7d46678?${RENDITION}`,
    alt:      '',
  },
  {
    ordinal:  '02',
    headline: 'Ideas become experiences.',
    body:     'Create memorable events without operational friction.',
    src:      `https://images.unsplash.com/photo-1540575467063-178a50c2df87?${RENDITION}`,
    alt:      '',
  },
  {
    ordinal:  '03',
    headline: 'Every detail has a purpose.',
    body:     'Bring organizers, participants and communities together.',
    src:      `https://images.unsplash.com/photo-1511578314322-379afb476865?${RENDITION}`,
    alt:      '',
  },
] as const

/** The supporting line under the panel. A statement of purpose, not a claim. */
export const AUTH_CAROUSEL_FOOTNOTE = 'Tools for event organizers.'
