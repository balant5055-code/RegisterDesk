// Phase P.1.3 — Marketing theme extensions.
//
// ADDITIVE, marketing-only design tokens. Does NOT modify the application design
// system (styles/tokens.css) — it only centralizes the few marketing-scale
// extensions (large display sizes, surface bands) as Tailwind class strings so
// components never hardcode them. White-first; no dark theme (the inverse band is
// a deliberate contrast section, not a page theme).

// Marketing-only display sizes (the app `fs` scale tops out at 48px; heroes need
// larger). Centralized here via clamp() so they are standardized, not arbitrary.
export const marketingType = {
  /** ~40 → 72px — hero headline on large screens */
  display: 'text-[clamp(2.5rem,6vw,4.5rem)] font-extrabold tracking-tight leading-[1.05]',
  /** ~32 → 52px — hero headline on small/medium screens, page titles */
  hero:    'text-[clamp(2rem,5vw,3.25rem)] font-bold tracking-tight leading-[1.1]',
  /** ~28 → 40px — homepage section H2. Single shared source for every homepage
      Section H2 (LS2.2A convergence). LS2.2B calibration: reduced from
      clamp(34→48)/extrabold to clamp(28→40)/bold for a lighter, more premium
      feel (Stripe/Linear/Vercel). Same 4vw slope, tracking, line-height, color. */
  sectionHeading: 'text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-[1.05] tracking-[-0.03em] text-[#0F172A]',
} as const

// L1 foundation: every marketing section sits on a pure white canvas. `white` and
// `muted` both resolve to bg-white — sections never carry a gray band; only
// cards/components use subtle surfaces. `inverse` is reserved for a deliberate
// dark contrast band (currently unused).
export const SURFACES = {
  white:   'bg-white text-foreground',
  muted:   'bg-white text-foreground',
  inverse: 'bg-[#0e0e13] text-white',
} as const
export type SurfaceBand = keyof typeof SURFACES

/** Brand gradient as an inline style (matches --primary-gradient). */
export const brandGradientStyle = { backgroundImage: 'var(--primary-gradient)' } as const

/** Eyebrow / overline class (brand, uppercase) — reused by SectionHeader. */
export const EYEBROW_CLASS = 'text-[var(--fs-xs)] font-semibold uppercase tracking-[0.08em] text-primary'
