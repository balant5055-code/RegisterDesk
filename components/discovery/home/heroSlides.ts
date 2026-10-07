// ─── Landing hero — carousel content ─────────────────────────────────────────
//
// PURE DATA. No 'use client', no component imports, no JSX — so this stays a plain
// module that any layer can read without dragging a render tree behind it.
//
// Icons are named by KEY rather than imported here, so this stays a module with no
// component imports. RD-HERO-03 draws the highlights as type alone — a label and a
// detail on a hairline — so the keys are currently not rendered; they are kept because
// they are part of the approved copy and cost nothing.
//
// This is MARKETING copy and nothing else. It states no event count, no registration
// figure, no city and no organizer name: the moment a hero asserts a number, that
// number has to be true, and the only source of truth for anything countable on this
// page is `listPublishedEvents`. The collage is where real events appear.
//
// The headline is deliberately TWO short lines with an explicit break. Letting it wrap
// on its own makes the break move between slides, which is the single biggest source of
// the layout shift this carousel is built to avoid.

/** The closed set of icons a highlight MAY name. Not drawn by the current hero. */
export type HeroIconKey =
  | 'compass' | 'users' | 'sparkles'
  | 'search' | 'ticket'
  | 'flag' | 'heart'

export interface HeroHighlight {
  icon: HeroIconKey
  label: string
  detail: string
}

export interface HeroSlide {
  /** Stable key — never the array index, so a re-order cannot re-key the animation. */
  id: string
  eyebrow: string
  /** Line one, solid ink. */
  headlineLead: string
  /** Line two. Solid ink apart from `headlineEmphasis`; the two lines read as one block. */
  headlineAccent: string
  /**
   * The ONE phrase in `headlineAccent` that carries the brand gradient.
   *
   * It is data, not a rule the renderer guesses, because the right word is a copy decision
   * and it differs per slide: the noun in "Every Experience.", the verb phrase in "Worth
   * Showing Up For." Deriving it — "the last word", say — would put the gradient on "For."
   *
   * MUST be a substring of `headlineAccent`. When it is not found the line renders solid,
   * so a copy edit that forgets to update this degrades to the previous design rather than
   * dropping the word.
   */
  headlineEmphasis: string
  description: string
  /** Exactly three. The row is a three-column grid and the layout assumes it. */
  highlights: readonly [HeroHighlight, HeroHighlight, HeroHighlight]
}

export const HERO_SLIDES: readonly HeroSlide[] = [
  {
    id: 'every-event',
    eyebrow: 'One platform. Endless possibilities.',
    headlineLead: 'Every Event.',
    headlineAccent: 'Every Experience.',
    headlineEmphasis: 'Experience.',
    description:
      'Discover conferences, concerts, sports, community gatherings and experiences that matter to you.',
    highlights: [
      { icon: 'compass',  label: 'Discover',      detail: 'Events worth experiencing' },
      { icon: 'users',    label: 'Connect',       detail: 'People and communities' },
      { icon: 'sparkles', label: 'Create Impact', detail: 'Be part of something meaningful' },
    ],
  },
  {
    id: 'discover',
    eyebrow: 'Discover what matters.',
    headlineLead: 'Find Experiences.',
    headlineAccent: 'Worth Showing Up For.',
    headlineEmphasis: 'Showing Up',
    description:
      'Explore events, meet new people and discover experiences that bring ideas and communities together.',
    highlights: [
      { icon: 'search', label: 'Explore',    detail: 'Find something new' },
      { icon: 'users',  label: 'Connect',    detail: 'Meet your community' },
      { icon: 'ticket', label: 'Experience', detail: 'Make every moment count' },
    ],
  },
  {
    id: 'participate',
    eyebrow: 'Come together. Make an impact.',
    headlineLead: 'More Than Events.',
    headlineAccent: 'Real Experiences.',
    headlineEmphasis: 'Experiences.',
    description:
      'From shared passions to meaningful causes, discover experiences that bring people closer together.',
    highlights: [
      { icon: 'flag',     label: 'Participate', detail: 'Be part of the moment' },
      { icon: 'heart',    label: 'Belong',      detail: 'Find your people' },
      { icon: 'sparkles', label: 'Impact',      detail: 'Create something meaningful' },
    ],
  },
] as const

/**
 * Autoplay dwell, in milliseconds.
 *
 * MUST match `--hero-autoplay` in styles/tokens.css. The progress line is a CSS
 * animation driven by that token while this timer drives the slide change; if the two
 * disagree the line visibly completes before or after the slide moves. HeroStage reads
 * the computed value at runtime — this constant is the fallback for the server render
 * and for a browser that returns nothing.
 */
export const HERO_AUTOPLAY_MS = 7600
