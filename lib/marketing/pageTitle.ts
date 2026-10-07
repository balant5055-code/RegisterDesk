// THE public page title — one style for every public page's <h1> (owner, 2026-09-24:
// "maintain the correct title size, not bulky … a consistent design in all devices").
//
// The display face set LIGHT, at --fs-display-sm: clamp(28px, 3vw, 40px). That is 28px on
// every phone, 40px from ~1330px up, and a smooth ramp between — large enough to be the
// page's one headline, small enough that a two- or three-word title ("Discover Causes",
// "Privacy Policy", "Event images") always sits on one line.
//
// Deliberately NOT used by the homepage hero or the event detail heroes: those are the
// site's two "real scale" moments and keep their own display sizes.
//
// Colour is --hero-ink; a title over a photograph overrides it (cn() resolves the later
// colour class). `leading-*` comes AFTER the size class on purpose — a later text-fs-*
// silently drops an earlier leading-* in cn().
//
// Plain string, no imports: safe in Server and Client Components alike.

export const PAGE_TITLE =
  'text-balance font-display text-fs-display-sm font-light tracking-[-0.015em] leading-[1.15] text-hero-ink'
