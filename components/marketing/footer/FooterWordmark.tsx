// Oversized footer wordmark — Server Component, zero client JavaScript.
//
// The footer's visual anchor: the platform name set enormous, filled with the
// LOGO's own violet→pink gradient, and clipped by the footer's bottom edge so it
// reads as a masthead rather than a line of text. This is the one piece of scale
// in the footer — everything above it is small, dense navigation, and the contrast
// between the two is the point.
//
// Purely decorative: aria-hidden and unselectable. The name is already announced by
// the footer's own heading and by every logo link, so a reader that skips this
// loses nothing and is not read the brand a second time.
//
// The name comes from the branding config, the SAME source the copyright line uses,
// so it can never drift from the product name.

import { cn } from '@/lib/utils/cn'
import { FOOTER_RHYTHM } from '@/lib/marketing/layout'
import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

const PLATFORM_NAME = BUSINESS_CONFIG_DEFAULTS.branding.platformName

/** Fill and clip. `background-clip: text` needs the -webkit- prefix to hold in Safari. */
const FILL: React.CSSProperties = {
  backgroundImage:       'linear-gradient(96deg, var(--brand-violet) 0%, var(--brand-pink) 100%)',
  WebkitBackgroundClip:  'text',
  backgroundClip:        'text',
  color:                 'transparent',
}

export function FooterWordmark() {
  return (
    <div aria-hidden className={cn(FOOTER_RHYTHM.zone, 'pointer-events-none select-none px-4 sm:px-6 lg:px-8')}>
      {/*
        translate-y pushes the lower third of the glyphs past the footer's box; the
        footer's own overflow-hidden does the clipping. Because transforms do not
        affect layout, the footer keeps the height of the untranslated text, so the
        crop never changes how much space this occupies.
      */}
      {/*
        opacity is low on purpose. The canvas behind this is near-white, so the
        gradient reads far stronger here than it did over the old tinted band — at
        0.22 it stopped being a watermark and became a second pink element
        competing with the navigation above it.

        The negative bottom margin reclaims layout height that the translate does
        not: transforms are visual only, so without it the footer reserved the full
        line box and left a large empty band under the bottom bar.
      */}
      <p
        style={FILL}
        className="-mb-[0.16em] translate-y-[22%] text-center text-[clamp(2.75rem,14vw,12rem)] font-extrabold leading-none tracking-[-0.055em] opacity-[0.10]"
      >
        {PLATFORM_NAME}
      </p>
    </div>
  )
}
