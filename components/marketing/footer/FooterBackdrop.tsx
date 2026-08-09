// Footer ambient backdrop — Server Component, zero client JavaScript.
//
// Four decorative layers behind the footer content, back to front:
//   0. the brand mesh canvas (--footer-gradient) — a layered coral/magenta wash
//      over a neutral base, so the footer is a graded surface rather than one flat
//      tone. The token composes from the brand RGB triplets and lives in
//      styles/tokens.css, so the palette is defined once;
//   1. an inline SVG lattice (vector, crisp at any DPR, no image request),
//      radially masked so it dissolves before it reaches the edges;
//   2. two orbs in the LOGO's own gradient endpoints — violet from the top-left,
//      pink from the bottom-right, the same order the wordmark runs — drifting on
//      a slow CSS loop (.rd-orb-a/.rd-orb-b in globals.css: composited transforms
//      only, and static under prefers-reduced-motion);
//   3. a violet→pink seam rule, echoing the gradient rules that flank the logo's
//      "POWERING EVENTS. SIMPLIFYING OPERATIONS." tagline.
//
// Everything decorative here is drawn from the sampled logo palette (--brand-navy
// / --brand-violet / --brand-pink) so the footer matches the wordmark exactly.
// Interactive states stay on --primary: those belong to the design system, and
// splitting them per-surface is how a footer starts disagreeing with the app.
//
// Entirely aria-hidden and pointer-events-none: it carries no meaning, so a reader
// that skips it loses nothing.

const LATTICE_ID = 'rd-footer-lattice'

/** Radial fade so the lattice never collides with the page edges or the bottom bar. */
const LATTICE_MASK = 'radial-gradient(120% 90% at 50% 0%, #000 0%, #000 45%, transparent 78%)'

export function FooterBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {/* 0 — brand mesh canvas */}
      <div className="absolute inset-0" style={{ background: 'var(--footer-gradient)' }} />

      {/* 1 — vector lattice */}
      {/* Slightly stronger than before: the canvas it sits on is near-white now, so
          the lattice can carry the surface texture the colour used to. */}
      <svg
        className="absolute inset-0 size-full text-foreground/[0.07]"
        style={{ maskImage: LATTICE_MASK, WebkitMaskImage: LATTICE_MASK }}
      >
        <defs>
          <pattern id={LATTICE_ID} width="56" height="56" patternUnits="userSpaceOnUse">
            <path d="M56 0H0V56" fill="none" stroke="currentColor" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${LATTICE_ID})`} />
      </svg>

      {/* 2 — drifting orbs, one per LOGO gradient endpoint.
             Alphas are intentionally near-subliminal. These sit ON TOP of the
             canvas tint, so their cost compounds with it: at 0.18 the pair turned
             the whole band pink-lavender. At this strength they register as the
             surface quietly breathing, which is all ambient motion should do. */}
      <div
        className="rd-orb-a absolute -left-40 -top-48 size-[32rem] rounded-full blur-3xl will-change-transform"
        style={{ background: 'radial-gradient(circle, rgb(var(--brand-violet-rgb) / 0.06), transparent 70%)' }}
      />
      <div
        className="rd-orb-b absolute -bottom-60 -right-32 size-[28rem] rounded-full blur-3xl will-change-transform"
        style={{ background: 'radial-gradient(circle, rgb(var(--brand-pink-rgb) / 0.055), transparent 72%)' }}
      />

      {/* 3 — seam rule, violet → pink like the logo's tagline rules */}
      <div
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, rgb(var(--brand-violet-rgb) / 0.55) 28%, rgb(var(--brand-pink-rgb) / 0.55) 72%, transparent 100%)',
        }}
      />
    </div>
  )
}
