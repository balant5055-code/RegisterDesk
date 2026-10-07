// ─── THE public RegisterDesk footer ──────────────────────────────────────────
//
// A SERVER component. Zero client JavaScript: every interaction here is CSS.
//
// ═══ IT USED TO SIT BESIDE MarketingFooter ═══════════════════════════════════
// This was the landing's own footer while MarketingFooter served /causes, the marketing
// pages and every /events/[slug] page. The public chrome unification put all of them on
// HomeShell, and the retirement audit then proved the whole components/marketing/footer
// cone (MarketingFooter, its column/bottom/link/social parts, FooterWordmark and
// FooterBackdrop) unreachable from every production entry, so it was deleted. This is the
// ONE public footer. Same story as HomeNavbar.
//
// NO SECOND SOURCE OF TRUTH: every destination comes from the existing registries —
// PRIMARY_NAV and FOOTER_LEGAL. Not one URL is typed here, so nothing can drift from the
// navbar or 404 on its own.
//
// ═══ THE COMPOSITION: SIGNATURE + A THREE-LINE LEDGER (2026-09-23 ledger pass) ══
// Signature on the left, the index as a ruled ledger on the right, the fine print under:
//
//   ┌─────────────────────────────────────────────────────────────────────────┐
//   │ RegisterDesk     ── DISCOVER    Events  Causes  Pricing  Contact        │
//   │ ────             ─────────────────────────────────────────────────────  │
//   │                  ── SOLUTIONS   Sports & Marathons  Conferences  …      │
//   │                  ─────────────────────────────────────────────────────  │
//   │                  ── COMPANY     About  Contact  Support  Security       │
//   │ © year RegisterDesk…            Privacy  Terms  Refund Policy  Cookie…  │
//   └─────────────────────────────────────────────────────────────────────────┘
//
// History: three centred stacked bands (~800px at 1440) → one row of three columns (389px
// at 1440, ~614px at 390) → this ledger (289px at 1440, 450px at 390), each on the owner's
// "luxury, compact" request. Columns made the index as tall as its longest COLUMN; ledger
// lines make it as tall as its three ROWS. Every link still renders — nothing is hidden. The voice is unchanged: display-face wordmark, warm bronze
// hairlines, small-caps labels, editorial ink (--hero-ink / --hero-ink-soft).
//
// ═══ THE OPENING BAND WAS REMOVED ON REQUEST ═════════════════════════════════
// It held the brand lockup, FOOTER_BRAND.description and a "For organizers / Create and
// manage your next event / Log in" door in the opposite corner. All of it is gone.
//
// Two consequences, both deliberate and both worth stating so they are not re-introduced
// by accident:
//   • THE FOOTER NO LONGER CARRIES THE LOCKUP. HomeNavbar shows the identity at the top of
//     every public page, and the wordmark above spells the name in the display face, so
//     the brand is still present here — as the footer’s own masthead rather than a lockup
//     with a tagline. components/marketing/BrandLockup is untouched, with three consumers.
//   • THE FOOTER NO LONGER OFFERS THE ORGANIZER DOOR. `getCta('login')` still resolves and
//     the navbar's "For Organizers" button is unchanged; the footer simply stops repeating
//     it. Nothing in the registry changed, so restoring it is one <Link>.
//
// Wordmark, index, baseline. The <footer>'s own top rule opens the composition, so no
// band inside it carries a second rule above the index.
//
// ═══ THE INDEX IS LEVEL BY CONSTRUCTION ══════════════════════════════════════
// Three groups of 4, 5 and 4, one ledger line each. There were four: Platform held nine
// links across two tracks until the public Platform section was retired. Its column is not
// replaced and nothing was invented to fill the space — the band simply narrows to three.
//
// "Discover" exists because the previous horizontal line held Events, Causes, Pricing and
// Contact and nothing else does. Folding them into a column keeps every destination the
// footer had; none was dropped to make the composition tidier.
//
// ═══ WHAT IS DELIBERATELY ABSENT ═════════════════════════════════════════════
//   • social icons — FOOTER_SOCIAL is empty because no official profile is verified, and
//     a placeholder Instagram link is a lie with a hover state.
//   • a newsletter — NEWSLETTER_ENABLED is false; there is no backend to receive one.
//   • trust badges, counts, "trusted by" — the footer states no number it cannot source.
//   • cards, pills, fills, shadows, blur, gradient panels. The only non-type elements in
//     the entire footer are 1px rules (the ledger's, the bronze marks) and the hover
//     hairline under each link.
//
// TYPE, as ratios rather than numbers picked off a list: wordmark 28 → index 13 →
// label 11 → legal 12. The wordmark is the one large thing and the only one set in the
// display face, which is what makes the rest read as an index under it.

import Link from 'next/link'
import { cn } from '@/lib/utils/cn'
import { container } from '@/lib/ds/containers'
import { PRIMARY_NAV } from '@/content/marketing/navigation'
import { FOOTER_LEGAL } from '@/content/marketing/footer'
// BRAND_NAME only: the lockup itself is no longer drawn here, but the closing signature
// must keep spelling the product from the one file that owns its name.
import { BRAND_NAME } from '@/components/marketing/BrandLockup'
import type { NavMenu } from '@/lib/marketing/types'

interface Dest { label: string; href: string }

const menuOf = (id: string): NavMenu | undefined => PRIMARY_NAV.find(m => m.id === id)
/** A dropdown entry has no href of its own; its overview page is the featured item. */
const hrefOf = (m: NavMenu | undefined): string | null => m?.href ?? m?.featured?.href ?? null

/**
 * Discover — the four flat destinations, resolved from the registry rather than typed.
 *
 * "Events" resolves to /events and MUST stay there: /events is a 307 to `/`
 * (app/events/page.tsx), and that indirection is the public contract — every link,
 * bookmark and index entry that already says /events keeps working. Pointing it at `/`
 * would quietly retire a live URL.
 */
const DISCOVER = {
  title: 'Discover',
  links: ([
    ['events',  'Events'],
    ['causes',  'Causes'],
    ['pricing', 'Pricing'],
    ['contact', 'Contact'],
  ] as const)
    .map(([id, label]): Dest | null => {
      const href = hrefOf(menuOf(id))
      return href ? { label, href } : null
    })
    .filter((d): d is Dest => d !== null),
}

/** A registry dropdown flattened into an index column. Never a second list of links. */
function fromNav(id: string, title: string): { title: string; links: Dest[] } {
  const menu = menuOf(id)
  const links = (menu?.groups ?? []).flatMap(g => g.items).map(i => ({ label: i.title, href: i.href }))
  // The overview page comes from the registry's own `featured` entry, so if that is ever
  // re-pointed this follows rather than going stale.
  const overview = menu?.featured
  if (overview) links.unshift({ label: `${title} overview`, href: overview.href })
  return { title, links }
}

const SOLUTIONS = fromNav('solutions', 'Solutions')
/** Company is footer-specific; every href is a route that exists (verified). */
const COMPANY = {
  title: 'Company',
  links: [
    { label: 'About',    href: '/about' },
    { label: 'Contact',  href: '/contact' },
    { label: 'Support',  href: '/support' },
    { label: 'Security', href: '/security' },
  ] as Dest[],
}

// ── Link chrome ──────────────────────────────────────────────────────────────
// One interaction language everywhere, and the same one the header uses: ink deepens
// toward the action colour and a hairline grows under the words. No lift, no shadow, no
// glow, no scale, no radius.
//
// `transition-[scale]` and NOT `transition-transform` — Tailwind v4 compiles `scale-x-*`
// to the independent CSS `scale` property, so a transition naming only `transform` leaves
// the rule snapping open instead of growing. That mistake has shipped twice here.
const RULE =
  'pointer-events-none absolute inset-x-0 -bottom-px h-px origin-left scale-x-0 bg-action ' +
  'transition-[scale] duration-200 ease-out group-hover/l:scale-x-100 motion-reduce:transition-none'

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-4'

function IndexLink({ label, href }: Dest) {
  return (
    <Link
      href={href}
      className={cn(
        // /65 rather than muted-foreground: at 13px the muted token reads as disabled,
        // which is most of what makes a footer index look like discarded small print.
        // ═══ THE GAP IS INSIDE THE LINK, NOT BETWEEN THE LINKS ═══════════════
        // On a phone this is min-h-8: a 32px hit area, up from 26px, while the list's own
        // gap goes to zero. Pitch 36px → 32px and target 26px → 32px in the same change,
        // because the dead space between rows became part of the rows.
        //
        // `lg:min-h-0` gives the desktop its compact geometry back: pointer targets there do
        // not need the 32px phone floor.
        'group/l relative inline-flex w-fit items-center py-1 text-fs-sm text-hero-ink-soft',
        'min-h-8 lg:min-h-0',
        'transition-colors duration-200 ease-out hover:text-hero-ink',
        FOCUS,
      )}
    >
      {label}
      <span aria-hidden className={RULE} />
    </Link>
  )
}

/**
 * ═══ ONE LEDGER ROW PER GROUP (2026-09-23 ledger pass) ═══════════════════════
 * The owner found the column index tall and uneven at every width ("mobile and other
 * screens look bad"). Each group is now ONE ruled line of a ledger: a small-caps label
 * with a short bronze rule in a fixed label track, and its links flowing along the line.
 * Three lines replace three columns, so the index is as tall as its longest ROW rather
 * than its longest COLUMN — and nothing is hidden to get there: every link still renders,
 * no accordion, no disclosure. Links stay `inline-flex w-fit` so each hover hairline
 * measures its WORD.
 *
 * Below `sm` the label sits above its links (a 96px label track would leave ~260px for
 * a four-link line at 390); from `sm` it moves into its own track beside them.
 */
function IndexRow({ title, links }: { title: string; links: Dest[] }) {
  return (
    <div className="grid gap-y-1 py-3 sm:grid-cols-[8.5rem_1fr] sm:items-baseline sm:gap-x-6 lg:py-3.5">
      <h3 className="flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.2em] text-hero-eyebrow">
        <span aria-hidden className="block h-px w-4 shrink-0 bg-hero-accent-rule/70" />
        {title}
      </h3>
      <ul className="flex flex-wrap items-baseline gap-x-5 gap-y-0 lg:gap-x-7">
        {links.map(l => (
          <li key={`${l.href}-${l.label}`}><IndexLink {...l} /></li>
        ))}
      </ul>
    </div>
  )
}

export function HomeFooter() {
  // Evaluated at render. `/` is prerendered with a 60s revalidate, so this refreshes on
  // every deploy and revalidation and costs no client JavaScript to keep correct.
  const year = new Date().getFullYear()

  return (
    <footer
      aria-labelledby="home-footer-heading"
      className="border-t border-border/60 bg-background print:hidden"
    >
      <h2 id="home-footer-heading" className="sr-only">RegisterDesk</h2>

      <div className={cn(container.page, 'pb-5 pt-7 lg:pb-7 lg:pt-10')}>

        {/* ══ ONE ROW — signature left, the ledger right ══
               The signature is the page's display face with the warm hairline every section
               masthead carries. Aria-hidden wordmark; BRAND_NAME keeps the product spelled
               in exactly one file. From lg it takes 3/12 and the ledger 9/12; the ledger's
               first rule sits level with the wordmark's cap line. */}
        <div className="grid gap-5 lg:grid-cols-12 lg:gap-8">
          <div className="flex flex-col items-start lg:col-span-3 lg:pt-3.5">
            <p
              aria-hidden
              className="select-none font-display text-fs-2xl font-light leading-none tracking-[0.01em] text-hero-ink"
            >
              {BRAND_NAME}
            </p>
            <span aria-hidden className="mt-3 block h-px w-10 bg-hero-accent-rule" />
          </div>

          {/* ══ The ledger ══ Three ruled lines, hairlines BETWEEN them only. */}
          <nav aria-label="Site index" className="lg:col-span-9">
            <div className="divide-y divide-border/50 border-y border-border/50 lg:border-t-0">
              <IndexRow title={DISCOVER.title} links={DISCOVER.links} />
              <IndexRow title={SOLUTIONS.title} links={SOLUTIONS.links} />
              <IndexRow title={COMPANY.title} links={COMPANY.links} />
            </div>
          </nav>
        </div>

        {/* ══ The baseline ══
               SPLIT, and on ONE LINE from `sm`: copyright left, legal right, neither wraps
               (`whitespace-nowrap` on both halves, `flex-nowrap` on the list). Below `sm` the
               pair cannot fit on one line (~540px needed), so the halves stack, legal first. */}
        <div className="mt-4 pt-1 lg:mt-5 lg:pt-1">
          <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6 lg:gap-8">
            <ul className="order-1 flex flex-nowrap items-baseline justify-center gap-x-3.5 sm:order-2 sm:gap-x-6">
              {FOOTER_LEGAL.map(l => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className={cn(
                      'group/l relative inline-flex items-center whitespace-nowrap py-1 text-fs-xs text-hero-ink-soft',
                      'min-h-8 lg:min-h-0',
                      'transition-colors duration-200 ease-out hover:text-hero-ink',
                      FOCUS,
                    )}
                  >
                    {l.label}
                    <span aria-hidden className={RULE} />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="order-2 whitespace-nowrap text-fs-xs text-hero-ink-soft/80 sm:order-1">
              © {year} RegisterDesk. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  )
}
