// Phase P.3 — Legal page renderer. Server Component (the document switcher is the only
// client island). One <h1>; <h2> per section. Every legal page — Privacy, Terms, Refund
// Policy, Cookie Policy — renders through this file, so the design lives here once.
//
// ═══ 2026-09-23 · THE LUXURY PASS (owner) ════════════════════════════════════
// A centred editorial masthead on a quiet band: the breadcrumb, a bronze-ruled "Legal"
// label, the title in the display face set light, the intro, and a switcher across the
// four documents. Below it, from lg, an "On this page" index stays in view beside the
// text; every section carries its number in bronze serif ("01") beside a serif heading,
// with hairlines between sections. The copy is untouched — only the setting changed.

import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { MarketingBreadcrumb } from '@/components/marketing/MarketingBreadcrumb'
import { container } from '@/lib/ds/containers'
import { cn } from '@/lib/utils/cn'
import { LegalNav } from './LegalNav'
import { PAGE_TITLE } from '@/lib/marketing/pageTitle'

export interface LegalSection { heading: string; body: string[] }

/** A stable in-page anchor from a section heading ("How we use information" → how-we-use-information). */
const anchorOf = (heading: string) =>
  heading.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

const pad = (n: number) => String(n).padStart(2, '0')

export function LegalPage({ title, intro, sections }: { title: string; intro: string; sections: LegalSection[] }) {
  const items = sections.map((s, i) => ({ ...s, id: anchorOf(s.heading) || `section-${i + 1}`, n: pad(i + 1) }))

  return (
    <MarketingPageLayout>
      <article>
        {/* ── The masthead ── */}
        <header className="border-b border-border/60 bg-surface-3/40">
          <div className={cn(container.content, 'py-10 text-center sm:py-14')}>
            <div className="flex justify-center">
              <MarketingBreadcrumb className="mb-7" />
            </div>

            <p className="flex items-center justify-center gap-3 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
              <span aria-hidden className="h-px w-8 shrink-0 bg-hero-accent-rule" />
              Legal
              <span aria-hidden className="h-px w-8 shrink-0 bg-hero-accent-rule" />
            </p>
            <h1 className={`mt-4 ${PAGE_TITLE}`}>
              {title}
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-fs-base leading-relaxed text-hero-ink-soft sm:text-fs-md">
              {intro}
            </p>

            <LegalNav className="mt-8 border-t border-border/60 pt-5" />
          </div>
        </header>

        {/* ── The document ── */}
        <div className={cn(container.page, 'py-10 sm:py-14')}>
          <div className="mx-auto max-w-[68rem] lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-16">
            {/* An index that stays in view while the text scrolls (lg+). */}
            <nav aria-label="On this page" className="hidden lg:block">
              <div className="sticky top-[calc(var(--disc-nav-h)+2rem)]">
                <p className="flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.2em] text-hero-eyebrow">
                  <span aria-hidden className="h-px w-5 shrink-0 bg-hero-accent-rule" />
                  On this page
                </p>
                <ol className="mt-4 space-y-0.5 border-l border-border/60">
                  {items.map(s => (
                    <li key={s.id}>
                      <a
                        href={`#${s.id}`}
                        className="-ml-px flex gap-3 border-l border-transparent py-1.5 pl-4 text-fs-sm text-hero-ink-soft transition-colors hover:border-hero-accent-rule hover:text-hero-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
                      >
                        <span className="font-display tabular-nums text-hero-accent-rule">{s.n}</span>
                        <span>{s.heading}</span>
                      </a>
                    </li>
                  ))}
                </ol>
              </div>
            </nav>

            <div className="max-w-[46rem]">
              {items.map((s, i) => (
                <section
                  key={s.id}
                  id={s.id}
                  aria-labelledby={`${s.id}-h`}
                  className={cn(
                    'scroll-mt-[calc(var(--disc-nav-h)+1.5rem)] py-7 sm:py-8',
                    i > 0 && 'border-t border-border/60',
                    i === 0 && 'pt-0 sm:pt-0',
                  )}
                >
                  <div className="flex items-baseline gap-4">
                    <span aria-hidden className="w-8 shrink-0 font-display text-fs-lg font-light tabular-nums text-hero-accent-rule">
                      {s.n}
                    </span>
                    <h2 id={`${s.id}-h`} className="font-display text-fs-xl font-normal tracking-[-0.01em] text-hero-ink sm:text-fs-2xl">
                      {s.heading}
                    </h2>
                  </div>
                  <div className="mt-3 space-y-3 sm:pl-12">
                    {s.body.map((p, j) => (
                      <p key={j} className="text-fs-base leading-[1.75] text-hero-ink-soft">{p}</p>
                    ))}
                  </div>
                </section>
              ))}

              <p className="mt-6 border-l-2 border-hero-accent-rule/70 py-1 pl-4 font-display text-fs-md italic font-light text-hero-ink-soft">
                We may update this policy from time to time; the latest version published on this page always applies.
              </p>
            </div>
          </div>
        </div>
      </article>
    </MarketingPageLayout>
  )
}
