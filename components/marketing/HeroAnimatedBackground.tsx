// HeroAnimatedBackground — a premium ATMOSPHERIC wash for hero sections.
//
// "Light moving across premium paper." One <svg> (absolute · inset-0 ·
// pointer-events-none) with: two translucent light gradients, subtle mesh curves,
// three-to-five flowing Bezier ribbons, and one slow light sweep. Colours come ONLY
// from the design tokens (--primary / --primary-from / --primary-to) at 2–8% opacity.
//
// Motion is transform-only and EXTREMELY slow (48–60s), oscillating so it never loops
// obviously — nothing pulses, floats, scales, or flashes. The page should feel alive,
// not animated. No filters, no canvas/Lottie/Three/GSAP/framer. Server component —
// zero client JS. Keyframes live in globals.css, gated behind prefers-reduced-motion.

import type { CSSProperties } from 'react'

// Flowing ribbons. Staggered (negative-delay) durations so they never sync.
const RIBBONS: { d: string; w: number; dur: string; delay: string }[] = [
  { d: 'M -120 280 C 320 200, 620 360, 940 280 S 1560 200, 1540 300', w: 3,   dur: '46s', delay: '0s'   },
  { d: 'M -120 400 C 360 340, 700 470, 1040 400 S 1560 330, 1540 420', w: 2.5, dur: '52s', delay: '-9s'  },
  { d: 'M -120 540 C 300 610, 640 470, 980 560 S 1560 640, 1540 560',  w: 2,   dur: '56s', delay: '-18s' },
  { d: 'M -120 680 C 380 620, 720 740, 1060 660 S 1560 600, 1540 680', w: 2.5, dur: '60s', delay: '-27s' },
]

export function HeroAnimatedBackground() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-hidden"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        {/* Two translucent light gradients (soft falloff — no blur filter) */}
        <radialGradient id="rdAtmoA" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="var(--primary-from)" stopOpacity="0.08" />
          <stop offset="55%"  stopColor="var(--primary-from)" stopOpacity="0.03" />
          <stop offset="100%" stopColor="var(--primary-from)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="rdAtmoB" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="var(--primary-to)" stopOpacity="0.06" />
          <stop offset="55%"  stopColor="var(--primary-to)" stopOpacity="0.025" />
          <stop offset="100%" stopColor="var(--primary-to)" stopOpacity="0" />
        </radialGradient>
        {/* Ribbon stroke — fades in/out at the ends, so each reads as a ribbon of light */}
        <linearGradient id="rdAtmoRibbon" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="var(--primary-from)" stopOpacity="0" />
          <stop offset="30%"  stopColor="var(--primary)"      stopOpacity="0.05" />
          <stop offset="70%"  stopColor="var(--primary)"      stopOpacity="0.05" />
          <stop offset="100%" stopColor="var(--primary-to)"   stopOpacity="0" />
        </linearGradient>
        {/* Soft vertical light band for the sweep */}
        <linearGradient id="rdAtmoSweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="var(--primary-from)" stopOpacity="0" />
          <stop offset="50%"  stopColor="var(--primary-from)" stopOpacity="0.045" />
          <stop offset="100%" stopColor="var(--primary-to)"   stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Layer 1/2 — two translucent light gradients (ultra-slow drift) */}
      <ellipse className="rd-atmo-a" cx="360"  cy="120" rx="820" ry="560" fill="url(#rdAtmoA)" />
      <ellipse className="rd-atmo-b" cx="1180" cy="820" rx="820" ry="560" fill="url(#rdAtmoB)" />

      {/* Layer 3 — subtle mesh curves (static) */}
      <g fill="none" stroke="var(--primary-to)" strokeWidth="1" opacity="0.025">
        <path d="M -80 200 C 420 100, 900 300, 1520 180" />
        <path d="M -80 720 C 460 820, 940 620, 1520 760" />
      </g>

      {/* Layer 4 — flowing Bezier ribbons */}
      <g fill="none" stroke="url(#rdAtmoRibbon)" strokeLinecap="round">
        {RIBBONS.map((r, i) => (
          <path
            key={i}
            className="rd-atmo-ribbon"
            style={{ '--rd-atmo-dur': r.dur, '--rd-atmo-delay': r.delay } as CSSProperties}
            strokeWidth={r.w}
            d={r.d}
          />
        ))}
      </g>

      {/* Layer 5 — one slow light sweep */}
      <rect className="rd-atmo-sweep" x="370" y="-80" width="700" height="1060" fill="url(#rdAtmoSweep)" />
    </svg>
  )
}
