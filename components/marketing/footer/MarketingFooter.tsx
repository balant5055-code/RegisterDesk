// Phase LS3.1 — Enterprise marketing footer. Server Component (no client JS).
//
// STRUCTURE — the footer is anchored by an oversized gradient wordmark clipped at
// the page's bottom edge (FooterWordmark), with dense navigation stacked above it.
// The contrast between one very large element and everything else being small is
// what gives the band presence; earlier revisions were uniformly mid-sized, which
// is why they read as flat no matter how the spacing was tuned.
//
// NO CARDS. Every previous revision boxed something — a brand card beside naked
// columns, then a full-width brand band — and the boxes were the problem: they made
// the footer look assembled from parts. Content now sits directly on the canvas, and
// the only raised objects are the small icon chips and capability pills, which is
// enough lift to keep everything legible.
//
// NO CTAs. "Start free" / "Book a demo" are removed: they are already the navbar's
// permanent, sticky job on every page, so repeating them here bought nothing and
// forced the brand zone into a card to hold them.
//
// SURFACE — a LOGO-MATCHED mesh gradient (--footer-gradient: violet from the
// top-left, pink from the bottom-right — the wordmark's own endpoints, in its own
// order — over a base cooling toward the wordmark navy), carried by FooterBackdrop
// with an SVG lattice, two drifting orbs in those hues, and a violet→pink seam rule.
// Every value is sampled from public/logo/logo-registerdesk.png.
//
// SPACING — every vertical value comes from FOOTER_RHYTHM (lib/marketing/layout).
//
// Still ZERO client JavaScript: this renders on every public page, so the animation
// is CSS and the hover states are CSS. Nothing here ships a bundle.

import { cn } from '@/lib/utils/cn'
import { fs, typography } from '@/lib/ds/typography'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { MARKETING_CONTAINER, FOOTER_RHYTHM } from '@/lib/marketing/layout'
import { FOOTER_COLUMNS, FOOTER_SOCIAL, FOOTER_TRUST, FOOTER_BRAND } from '@/content/marketing/footer'
import { MarketingLogo } from '@/components/marketing/MarketingLogo'
import { FooterBackdrop } from './FooterBackdrop'
import { FooterWordmark } from './FooterWordmark'
import { MarketingFooterColumn } from './MarketingFooterColumn'
import { MarketingFooterBottom } from './MarketingFooterBottom'

/**
 * Columns longer than this span two grid tracks and flow in two sub-columns, which
 * keeps the navigation band level. Derived from the data, not hardcoded per column,
 * so the band stays balanced as the nav registry grows.
 */
const WIDE_COLUMN_THRESHOLD = 7

export function MarketingFooter() {
  // Evaluated when the page is rendered — marketing pages are prerendered, so this
  // is the BUILD year. It refreshes on each deploy, which is accurate for any
  // normally-released site and costs no client JS to keep correct.
  const year = new Date().getFullYear()

  return (
    <footer
      aria-labelledby="footer-heading"
      className="relative isolate overflow-hidden border-t border-border/60 bg-white print:hidden"
    >
      <FooterBackdrop />
      <h2 id="footer-heading" className="sr-only">RegisterDesk footer</h2>

      <div className={cn(MARKETING_CONTAINER.page, 'pt-14 lg:pt-16')}>

        {/* ── Zone 1 — brand block + navigation, on a 12-track grid. The brand
               block is text on the canvas, not a card, so it sits in the same
               visual system as the columns beside it. ── */}
        <div className={cn(FOOTER_RHYTHM.columnGap, 'grid grid-cols-2 lg:grid-cols-12')}>

          <div className="col-span-2 lg:col-span-3">
            <MarketingLogo className="h-7 w-auto md:h-[30px]" />
            <p className={cn(typography.caption, 'mt-4 max-w-xs leading-relaxed text-muted-foreground')}>
              {FOOTER_BRAND.description}
            </p>
            {FOOTER_BRAND.contactEmail && (
              <a
                href={`mailto:${FOOTER_BRAND.contactEmail}`}
                className={cn(fs.sm, 'mt-4 inline-block rounded font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary')}
              >
                {FOOTER_BRAND.contactEmail}
              </a>
            )}
          </div>

          {/* Navigation. Four tracks inside the remaining nine: Platform takes two
              (it carries 9 links to Solutions' 5 and Company's 4), so the band
              stays level. Every row carries the icon the nav registry already
              defines for that destination (see MarketingFooterLink). */}
          <nav
            aria-label="Footer"
            className={cn(FOOTER_RHYTHM.columnGap, 'col-span-2 grid grid-cols-2 lg:col-span-9 lg:grid-cols-4')}
          >
            {FOOTER_COLUMNS.map(column => (
              <MarketingFooterColumn
                key={column.id}
                column={column}
                wide={column.links.length >= WIDE_COLUMN_THRESHOLD}
              />
            ))}
          </nav>
        </div>

        {/* ── Zone 2 — capability strip. These are shipped platform safeguards, NOT
               social proof: the registry documents them as "only REAL, shipped
               capabilities", so the label states exactly that and claims nothing
               about who uses the product. ── */}
        {FOOTER_TRUST.length > 0 && (
          <div className={FOOTER_RHYTHM.zone}>
            <p className={cn(typography.overline, 'text-muted-foreground')}>Built into every event</p>
            <ul className={cn(FOOTER_RHYTHM.label, 'flex flex-wrap items-center gap-2')} aria-label="Platform capabilities">
              {FOOTER_TRUST.map(t => {
                const Icon = MARKETING_ICONS[t.iconKey]
                return (
                  <li
                    key={t.label}
                    className={cn(fs.sm, 'inline-flex items-center gap-2 rounded-lg border border-border/60 bg-white px-3 py-1.5 text-muted-foreground shadow-sm')}
                  >
                    <Icon className="size-4 shrink-0 text-primary/70" aria-hidden />
                    {t.label}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* ── Zone 3 — bottom bar. The ONE hairline in the footer. ── */}
        <div className={FOOTER_RHYTHM.zone}>
          <MarketingFooterBottom year={year} social={FOOTER_SOCIAL} />
        </div>
      </div>

      {/* ── Zone 4 — the anchor. Outside the padded container so it can run to the
             page's bottom edge and be cropped by the footer's overflow-hidden. ── */}
      <FooterWordmark />
    </footer>
  )
}
