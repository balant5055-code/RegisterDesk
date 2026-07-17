// Phase LS3.1 — Enterprise marketing footer. Server Component (no client JS).
//
// Four zones: (1) a large brand anchor with the SHARED navbar logo + dual CTA,
// (2) a balanced navigation grid, (3) a single elegant trust strip, (4) a compact
// bottom bar. White-first, soft borders — no shadows, gradients, glass, or
// decoration. Renders entirely from the footer registry.

import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { getCta } from '@/lib/marketing/cta'
import { FOOTER_COLUMNS, FOOTER_SOCIAL, FOOTER_TRUST, FOOTER_BRAND } from '@/content/marketing/footer'
import { MarketingLogo } from '@/components/marketing/MarketingLogo'
import { MarketingFooterColumn } from './MarketingFooterColumn'
import { MarketingFooterBottom } from './MarketingFooterBottom'

export function MarketingFooter() {
  const year    = new Date().getFullYear()
  const primary = getCta(FOOTER_BRAND.ctaKey)
  const demo    = getCta(FOOTER_BRAND.secondaryCtaKey)

  return (
    <footer aria-labelledby="footer-heading" className="border-t border-border/60 bg-white">
      <h2 id="footer-heading" className="sr-only">RegisterDesk footer</h2>

      <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-12">

        {/* ── Zone 1 (brand anchor) + Zone 2 (navigation) ── */}
        <div className="grid gap-10 lg:grid-cols-[minmax(0,440px)_1fr] lg:gap-16">

          {/* Zone 1 — brand */}
          <div>
            <MarketingLogo className="h-7 w-auto md:h-[30px] lg:h-[30px]" />

            <p className="mt-5 max-w-md text-fs-sm leading-relaxed text-muted-foreground">
              {FOOTER_BRAND.description}
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link href={primary.href} className={buttonVariants({ variant: primary.variant, size: 'sm' })}>
                {primary.label}
              </Link>
              <Link href={demo.href} className={buttonVariants({ variant: demo.variant, size: 'sm' })}>
                {demo.label}
              </Link>
            </div>

            {FOOTER_BRAND.contactEmail && (
              <a
                href={`mailto:${FOOTER_BRAND.contactEmail}`}
                className="mt-5 inline-block text-fs-sm font-medium text-primary hover:underline"
              >
                {FOOTER_BRAND.contactEmail}
              </a>
            )}
          </div>

          {/* Zone 2 — navigation */}
          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {FOOTER_COLUMNS.map(column => <MarketingFooterColumn key={column.id} column={column} />)}
          </nav>
        </div>

        {/* ── Zone 3 — trust strip (real, shipped capabilities only) ── */}
        {FOOTER_TRUST.length > 0 && (
          <div className="mt-8 border-t border-border/60 pt-8">
            <p className="text-fs-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Trusted by professional event organizers
            </p>
            <ul className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3" aria-label="Capabilities">
              {FOOTER_TRUST.map(t => {
                const Icon = MARKETING_ICONS[t.iconKey]
                return (
                  <li key={t.label} className="flex items-center gap-2 text-fs-sm text-muted-foreground">
                    <Icon className="size-4 text-muted-foreground/50" aria-hidden />
                    {t.label}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* ── Zone 4 — bottom bar ── */}
        <div className="mt-8">
          <MarketingFooterBottom year={year} social={FOOTER_SOCIAL} />
        </div>
      </div>
    </footer>
  )
}
