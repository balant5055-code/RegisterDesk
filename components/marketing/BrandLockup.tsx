// ─── RegisterDesk brand lockup ───────────────────────────────────────────────
//
// The ONE public identity: mark, name, tagline, in that spatial relationship.
//
//     [icon]  RegisterDesk
//             POWERING EVENTS. SIMPLIFYING OPERATIONS.
//
// ═══ WHY THIS COMPONENT EXISTS ═══════════════════════════════════════════════
// public/logo/RegisterDesk-Logo.svg used to be a horizontal lockup with the wordmark drawn
// INTO the artwork (658×127). It is the mark ALONE now, so every surface that scaled that file
// to a wordmark's proportions was suddenly rendering a small icon letterboxed inside a wide
// box — the brand name gone. The name and tagline are therefore TEXT now, set in the product's
// own type, and this file is the only place they are written. Nothing else in the public site
// may spell "RegisterDesk" as a logo or repeat the tagline.
//
// ═══ THE ARTWORK IS NOT TOUCHED ══════════════════════════════════════════════
// No recolour, no filter, no gradient, no shadow, no background plate, no CSS reconstruction
// of the mark. It is the source artwork, at its true intrinsic ratio, and only its height is
// set.
//
// ═══ ACCESSIBILITY ═══════════════════════════════════════════════════════════
// The whole lockup is one link to `/` whose accessible name is exactly "RegisterDesk". That
// name comes from the visible wordmark, so the mark is decorative (`alt=""`) and the tagline
// is `aria-hidden` — otherwise a screen reader would announce the brand twice and then read a
// marketing sentence as if it were the destination. There is deliberately no `aria-label` on
// the link: one would silently override the visible text.

import Link from 'next/link'
import Image from 'next/image'
import { cn } from '@/lib/utils/cn'

/** The canonical brand strings. Written once, here, and nowhere else in the public site. */
export const BRAND_NAME = 'RegisterDesk'
export const BRAND_TAGLINE = 'POWERING EVENTS. SIMPLIFYING OPERATIONS.'

/**
 * ═══ THE CANONICAL MARK IS THE SVG ITSELF ════════════════════════════════════
 *
 * `public/logo/RegisterDesk-Logo.svg` is THE brand asset. Every surface that draws the
 * RegisterDesk mark loads this one path and nothing else.
 *
 * This previously pointed at `/logo/RegisterDesk-Logo-optimized.webp`, a raster derived from an
 * earlier version of the artwork. That file is not in `public/` — the request 404s, which is
 * exactly the broken-image icon that appeared beside the wordmark on every public page, in the
 * dashboard sidebar and in the checkout bar. There is no derivative to fall back to and, by
 * standing rule, the source SVG is what ships.
 */
const ICON_SRC = '/logo/RegisterDesk-Logo.svg'

/**
 * The SAME mark with its white ground removed and trimmed tight (public/logo/
 * RegisterDesk-Mark.png, 256×256, generated from ICON_SRC — never redrawn). The canonical
 * file is a raster on a white square, which on the homepage photograph read as a white
 * app-icon tile. tone='media' draws this instead, so the R sits directly on the image.
 */
const MARK_ON_MEDIA_SRC = '/logo/RegisterDesk-Mark.png'

/**
 * ═══ WHY `unoptimized` IS REQUIRED, AND WHY IT IS NOT A WORKAROUND ═══════════
 *
 * `next/image` routes every src through `/_next/image`, and that endpoint REFUSES SVG unless
 * `images.dangerouslyAllowSVG` is set — it answers 400 `"url" parameter is valid but image type
 * is not allowed`. So simply repointing `src` at the .svg swaps one broken image for another.
 *
 * The global switch is the wrong lever. `images.remotePatterns` already admits organiser-supplied
 * hosts (Firebase Storage, R2, Cloudinary), so enabling SVG optimisation platform-wide would let
 * an uploaded SVG — an active document that can carry script — be served back from our own
 * origin. That is a stored-XSS surface opened to fix a logo.
 *
 * `unoptimized` is scoped to this one first-party asset: the element emits `src` verbatim, the
 * optimizer is never consulted, and the SVG is served by the static handler as `image/svg+xml`.
 * The platform SVG policy is untouched.
 *
 * `sizes` is deliberately absent. It existed to steer the optimizer's srcset; with no optimizer
 * in the path there is no srcset to steer, and leaving it would describe behaviour that no
 * longer happens.
 */
const ICON_UNOPTIMIZED = true

/**
 * The LAYOUT box: the source file's own viewBox, `0 0 1254 1254`.
 *
 * These reserve the correct box before the image loads, which is what keeps the lockup from
 * shifting mid-load, and they are what `w-auto` resolves the width against. The artwork is
 * SQUARE — the mark drawn at `h-[38px]` therefore occupies 38×38 rather than the 33×38 the
 * previous portrait asset did.
 *
 * ⚠ Two properties of the artwork that are the file's, not this component's, and that only a
 * re-export from the design source can change:
 *   • It has NO transparency — an opaque near-white (#fefefe) plate fills the square, so the
 *     mark carries a pale rectangle on any non-white surface.
 *   • The glyph occupies ~72% of the height and ~69% of the width; the rest is the artwork's
 *     own safe-area margin. The mark therefore reads slightly smaller in a given box than a
 *     tightly-cropped asset would.
 */
const ICON_W = 1254
const ICON_H = 1254

export type BrandLockupSize = 'sm' | 'md' | 'lg'

/**
 * Three sizes, one set of proportions.
 *
 * The relationship never changes — only the scale — so the navbar and the footer read as the
 * same identity rather than as two designs. Each step keeps the mark roughly 1.7× the
 * wordmark's cap height and the tagline roughly 0.38× the wordmark, which is what stops it
 * drifting into either "huge icon, tiny text" or "tiny icon, huge text".
 *
 * The tagline sizes are arbitrary values on purpose: the type scale bottoms out at 11px
 * (--fs-2xs), and a 40-character tagline set at 11px would be wider than the navigation it
 * sits beside. 7–8.5px with restrained tracking is small but still read as words; it is never
 * taken below 7px, where it would become texture rather than language.
 */
const SIZES: Record<BrandLockupSize, { icon: string; name: string; tag: string; gap: string }> = {
  // Marketing navbar, marketing footer, mobile drawer.
  sm: {
    icon: 'h-[26px] sm:h-[30px]',
    name: 'text-[16px] sm:text-[18px]',
    tag:  'text-[6.5px] sm:text-[7px] tracking-[0.085em]',
    gap:  'gap-2 sm:gap-2.5',
  },
  // Homepage footer.
  md: {
    icon: 'h-[30px] md:h-[34px]',
    name: 'text-[18px] md:text-[20px]',
    tag:  'text-[7px] md:text-[7.5px] tracking-[0.085em]',
    gap:  'gap-2.5',
  },
  // Homepage navbar — the largest the brand is ever drawn.
  lg: {
    icon: 'h-[32px] md:h-[38px]',
    name: 'text-[19px] md:text-[22px]',
    tag:  'text-[7px] md:text-[8px] tracking-[0.08em]',
    gap:  'gap-2.5 md:gap-3',
  },
}

export function BrandLockup({
  size = 'sm',
  className,
  priority = false,
  tone = 'default',
}: {
  size?: BrandLockupSize
  /**
   * 'media' sets the NAME and TAGLINE in the ink-on-media tokens for when the lockup sits
   * directly on photography (the homepage header before it turns solid). The mark itself is
   * never recoloured. Colours transition, so a header changing tone cross-fades.
   */
  tone?: 'default' | 'media'
  /** Layout only — position and spacing. Not for restyling the identity. */
  className?: string
  /** True only where the lockup is above the fold on a landing route. */
  priority?: boolean
}) {
  const s = SIZES[size]

  return (
    <Link
      href="/"
      className={cn(
        'inline-flex shrink-0 items-center transition-opacity duration-200 hover:opacity-80',
        'rounded-none outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2',
        s.gap,
        className,
      )}
    >
      <Image
        src={tone === 'media' ? MARK_ON_MEDIA_SRC : ICON_SRC}
        // Decorative: the wordmark beside it already names the brand, and a second name here
        // would be announced twice.
        alt=""
        aria-hidden
        width={tone === 'media' ? 256 : ICON_W}
        height={tone === 'media' ? 256 : ICON_H}
        // The optimizer rejects SVG; see the note on ICON_UNOPTIMIZED. Without this the
        // element requests /_next/image and renders a broken image.
        unoptimized={ICON_UNOPTIMIZED}
        priority={priority}
        // `w-auto` with the true intrinsic width/height above is what preserves the ratio;
        // only the height is ever set.
        className={cn('w-auto shrink-0', s.icon, tone === 'media' && 'scale-[0.84]')}
      />

      {/* The name and the tagline are ONE block, left-aligned to each other, so the tagline
          reads as the line beneath the name rather than as a separate caption floating near
          it. `leading-none` on both keeps that pair tight enough to be one object; the
          wrapper, not a margin, supplies the small space between them. */}
      <span className="flex min-w-0 flex-col justify-center gap-[3px]">
        {/* `leading-none` comes AFTER the font-size class in both spans, deliberately:
            tailwind-merge drops a `leading-*` that precedes a `text-[…]` size, and a lockup
            whose two lines silently inherited normal line-height would sit apart. */}
        <span className={cn(s.name, 'font-semibold tracking-[-0.02em] transition-colors duration-300', tone === 'media' ? 'text-ink-on-media' : 'text-foreground', 'leading-none')}>
          {BRAND_NAME}
        </span>
        <span
          aria-hidden
          className={cn(s.tag, 'font-medium uppercase whitespace-nowrap transition-colors duration-300', tone === 'media' ? 'text-ink-on-media-muted' : 'text-muted-foreground', 'leading-none')}
        >
          {BRAND_TAGLINE}
        </span>
      </span>
    </Link>
  )
}
