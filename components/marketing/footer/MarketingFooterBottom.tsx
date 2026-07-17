// Phase LS3.0 — Footer bottom bar (copyright · legal · social · version).
// Server Component.

import Link from 'next/link'
import { FOOTER_LEGAL, APP_VERSION } from '@/content/marketing/footer'
import { MarketingFooterSocial } from './MarketingFooterSocial'
import type { SocialLink } from '@/lib/marketing/types'
import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

// RD-CONF-10: platform name sourced from the branding code default (one source of
// truth). This footer is a static Server Component, so it reads the default rather
// than Firestore to keep marketing pages prerendered.
const PLATFORM_NAME = BUSINESS_CONFIG_DEFAULTS.branding.platformName

export function MarketingFooterBottom({ year, social = [] }: { year: number; social?: SocialLink[] }) {
  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-border/60 pt-6 sm:flex-row">
      <p className="text-fs-xs text-muted-foreground">
        © {year} {PLATFORM_NAME}. All rights reserved.
        {APP_VERSION && <span className="ml-2 text-muted-foreground/60">v{APP_VERSION}</span>}
      </p>

      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
        <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
          {FOOTER_LEGAL.map(l => (
            <li key={l.href}>
              <Link href={l.href} className="text-fs-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <MarketingFooterSocial items={social} className="" />
      </div>
    </div>
  )
}
