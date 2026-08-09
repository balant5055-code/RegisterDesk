// Phase LS3.0 — Footer bottom bar (copyright · legal · social · version).
// Server Component.
//
// Legal links render through the SHARED MarketingFooterLink at its `xs` size — this
// file used to re-declare its own near-identical anchor class, which meant footer
// link styling had two sources that could drift apart.

import { cn } from '@/lib/utils/cn'
import { fs } from '@/lib/ds/typography'
import { FOOTER_LEGAL, APP_VERSION } from '@/content/marketing/footer'
import { OWNERSHIP_SHORT } from '@/lib/marketing/ownership'
import { MarketingFooterLink } from './MarketingFooterLink'
import { MarketingFooterSocial } from './MarketingFooterSocial'
import type { SocialLink } from '@/lib/marketing/types'
import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

// RD-CONF-10: platform name sourced from the branding code default (one source of
// truth). This footer is a static Server Component, so it reads the default rather
// than Firestore to keep marketing pages prerendered.
const PLATFORM_NAME = BUSINESS_CONFIG_DEFAULTS.branding.platformName

export function MarketingFooterBottom({ year, social = [] }: { year: number; social?: SocialLink[] }) {
  return (
    <div className="flex flex-col items-center justify-between gap-4 border-t border-border/60 pt-6 sm:flex-row">
      {/* RD-LAUNCH-03: ownership sits under the existing copyright line, one step
          quieter than it, so the legal entity is findable without competing with the
          RegisterDesk brand above it. The copyright style itself is unchanged. */}
      <div className="text-center sm:text-left">
        <p className={cn(fs.xs, 'text-muted-foreground')}>
          © {year} {PLATFORM_NAME}. All rights reserved.
          {APP_VERSION && <span className="ml-2 text-muted-foreground/60">v{APP_VERSION}</span>}
        </p>
        <p className={cn(fs['2xs'], 'mt-1 text-muted-foreground/70')}>{OWNERSHIP_SHORT}</p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
        <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5">
          {FOOTER_LEGAL.map(l => (
            <li key={l.href}>
              <MarketingFooterLink link={l} size="xs" />
            </li>
          ))}
        </ul>
        <MarketingFooterSocial items={social} />
      </div>
    </div>
  )
}
