// The RegisterDesk MARK on its own — no wordmark, no tagline.
//
// ═══ WHAT CHANGED, AND WHY THIS FILE STILL EXISTS ════════════════════════════
// public/logo/RegisterDesk-Logo.svg used to be a horizontal lockup with the wordmark drawn
// into the artwork (658×127). It is the mark ALONE now. Every public surface therefore moved
// to BrandLockup, which draws that mark beside "RegisterDesk" and the tagline as real text.
//
// This component remains for the ONE surface that is not part of the marketing site: the
// checkout top bar in app/events/[slug]/register. That route is deliberately out of scope for
// the branding pass, so it keeps a mark-only brand rather than silently gaining a tagline in
// a 56px-tall payment header.
//
// ═══ THE INTRINSIC SIZE IS THE BUG THIS FILE HAD ═════════════════════════════
// It once declared width={658} height={127} after the asset was replaced — a 5.18:1 box for a
// square image. `next/image` writes that ratio onto the element, so `h-6 w-auto` reserved
// roughly 124×24px and the mark letterboxed inside it, leaving ~100px of empty bar. The
// numbers below are the file's real viewBox, so the box fits the artwork.
//
// The artwork itself is untouched: no recolour, no filter, no gradient, no shadow, no plate.
//
// ═══ IT LOADS THE SAME CANONICAL MARK AS BrandLockup ═════════════════════════
// One asset, one path: /logo/RegisterDesk-Logo.svg. It previously pointed at a derived
// `-optimized.webp` that is not in public/ — that 404 was the broken image in this bar.
// `unoptimized` is required because /_next/image rejects SVG; see the full note in
// BrandLockup.tsx. Only the asset path changed here — the checkout bar's composition, size
// and placement are untouched.

import Link from 'next/link'
import Image from 'next/image'

export function MarketingLogo({
  className = 'h-7 w-auto',
  priority = false,
}: {
  className?: string
  priority?:  boolean
}) {
  return (
    <Link
      href="/"
      aria-label="RegisterDesk home"
      className="inline-flex items-center transition-opacity duration-200 hover:opacity-80"
    >
      <Image
        src="/logo/RegisterDesk-Logo.svg"
        // The link carries the accessible name, so a second one here would be announced twice.
        alt=""
        aria-hidden
        // The source file's own viewBox. next/image uses these only for the aspect ratio,
        // which `h-7 w-auto` then resolves the width against.
        width={1254}
        height={1254}
        // /_next/image answers 400 for SVG unless the platform-wide `dangerouslyAllowSVG` is
        // set, which would also admit organiser-uploaded SVGs. Scoped opt-out instead.
        unoptimized
        priority={priority}
        className={className}
      />
    </Link>
  )
}
