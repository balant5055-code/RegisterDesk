// Phase P.3 — Legal page renderer. Server Component (zero client JS).
//
// Reading-width prose for policy pages, using the existing MarketingContentLayout
// (navbar + footer + reading container). One <h1>; <h2> per section.

import { MarketingContentLayout } from '@/components/marketing/layout/MarketingContentLayout'
import { MarketingBreadcrumb } from '@/components/marketing/MarketingBreadcrumb'
import { typography } from '@/lib/ds/typography'

export interface LegalSection { heading: string; body: string[] }

export function LegalPage({ title, intro, sections }: { title: string; intro: string; sections: LegalSection[] }) {
  return (
    <MarketingContentLayout>
      <article>
        <MarketingBreadcrumb className="mb-6" />
        <h1 className="text-fs-3xl font-bold tracking-tight text-foreground sm:text-fs-4xl">{title}</h1>
        <p className={`${typography.body} mt-4 text-muted-foreground`}>{intro}</p>

        <div className="mt-10 space-y-8">
          {sections.map((s, i) => (
            <section key={i}>
              <h2 className="text-fs-xl font-semibold text-foreground">{s.heading}</h2>
              {s.body.map((p, j) => (
                <p key={j} className={`${typography.body} mt-3 text-muted-foreground`}>{p}</p>
              ))}
            </section>
          ))}
        </div>

        <p className="mt-12 border-t border-border/60 pt-6 text-[var(--fs-sm)] text-muted-foreground">
          We may update this policy from time to time; the latest version published on this page always applies.
        </p>
      </article>
    </MarketingContentLayout>
  )
}
