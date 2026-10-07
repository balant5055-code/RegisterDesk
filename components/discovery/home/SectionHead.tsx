// ─── Landing — the section head ──────────────────────────────────────────────
//
// A SERVER component, and the ONE place the homepage's section titles are drawn. Upcoming
// Events and Recently Completed both used a left-aligned 28px/24px semibold sans heading:
// the same object the dashboard uses for a panel title. On a page whose hero is a
// photograph with a Fraunces statement over it, that reads as an admin screen pasted under
// a magazine cover — which is exactly what it looked like.
//
// ═══ WHAT MAKES IT READ AS THE SAME PRODUCT AS THE HERO ══════════════════════
// Three things, all of them already in the design system, none of them new colour:
//
//   the face     font-display (Fraunces) at LIGHT weight, the hero's own register. A
//                high-contrast serif at section size is the whole premium cue; asking for
//                it in bold would put thick stems on a white page and read as bulk again.
//   the eyebrow  --fs-2xs uppercase at 0.3em tracking, the SAME lockup the hero eyebrow
//                uses. It names the section so the title itself never has to explain it.
//   the rule     a 2.5rem hairline in --hero-accent-rule, the warm metal the hero's italic
//                accent is set in. It is the only ornament, it is centred, and it is what
//                turns a heading into a masthead.
//
// ═══ CENTRED, AND WHY THAT IS SAFE HERE ══════════════════════════════════════
// Centred type needs a short measure or it stops being readable. Both titles are two or
// three words and the lede is capped at 52ch, so no line here can run long enough for the
// ragged left edge to cost anything. The CARDS below stay left-aligned: centring a grid's
// contents is what makes a page look like a template.
//
// ═══ THE HIERARCHY IS SCALE, NOT WEIGHT ══════════════════════════════════════
// Both levels are the same face at the same weight, and 'primary' is simply bigger:
// --fs-display-sm (28→40px, the token's own documented job) against --fs-xl at a flat 24px.
// The secondary step is --fs-xl and NOT --fs-2xl for a measured reason: --fs-2xl is 28px,
// which is exactly where --fs-display-sm's clamp bottoms out, so on a phone the two
// headings rendered at the identical size and the hierarchy vanished on the width where
// most of this page is read. Weight is not used to separate them, because two weights of
// the same serif at similar sizes reads as an accident.
//
// NOTHING HERE STATES A QUANTITY. The eyebrow and the lede describe what the section is,
// never how much it holds: a count would be a fact this component cannot see and the page
// would have to keep true.

import { cn } from '@/lib/utils/cn'

export interface SectionHeadProps {
  /** The id the section's aria-labelledby points at. It belongs to the <h2>. */
  id:       string
  /** The small uppercase label above the title. Names the section, never counts it. */
  eyebrow:  string
  title:    string
  /** One honest sentence about what the section shows. Optional. */
  lede?:    string
  /** 'primary' is the page's main section; 'secondary' is an epilogue to it. */
  level?:   'primary' | 'secondary'
  className?: string
}

export function SectionHead({ id, eyebrow, title, lede, level = 'primary', className }: SectionHeadProps) {
  return (
    <header className={cn('flex flex-col items-center text-center', className)}>
      <p className="text-fs-2xs font-medium uppercase tracking-[0.3em] text-muted-foreground">
        {eyebrow}
      </p>

      <h2
        id={id}
        className={cn(
          'mt-3 font-display font-light tracking-[-0.02em] text-foreground',
          level === 'primary' ? 'text-fs-display-sm leading-[1.1]' : 'text-fs-xl leading-[1.15]',
        )}
      >
        {title}
      </h2>

      {/* The one ornament. aria-hidden: it is a rule, not content. */}
      <span aria-hidden className="mt-4 block h-px w-10 bg-hero-accent-rule" />

      {lede ? (
        <p className="mt-4 max-w-[52ch] text-fs-base leading-relaxed text-muted-foreground">
          {lede}
        </p>
      ) : null}
    </header>
  )
}
