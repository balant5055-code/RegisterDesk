// Phase P.1.6.10 — Homepage FAQ section. Server Component (zero client JS).
//
// Real organizer questions, grouped by category. Uses NATIVE <details>/<summary>
// for disclosure — no JavaScript accordion, no hydration. Registry-driven
// (reuses FAQ_ITEMS + FAQ_CATEGORIES); reuses SectionLayout + SectionHeader.
// Semantic HTML only — FAQ JSON-LD is emitted by the page via the existing
// seo.ts faqJsonLd helper (not generated here). White-first. Reusable parts
// (FAQSection · FAQGroup · FAQItem) are exported individually.

import Link from 'next/link'
import { typography } from '@/lib/ds/typography'
import { cn } from '@/lib/utils/cn'
import { ArrowRight, ChevronDown } from 'lucide-react'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { SectionHeader } from '@/components/marketing/layout/SectionHeader'
import { FAQ_ITEMS, FAQ_CATEGORIES, FAQ_HEADING } from '@/content/marketing/faq'
import type { FaqItem } from '@/lib/marketing/types'

export function FAQItem({ item }: { item: FaqItem }) {
  return (
    <details className="group border-b border-border/60 py-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded text-[var(--fs-md)] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
        {item.question}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-2 pr-8">
        <p className={`${typography.body} text-muted-foreground`}>{item.answer}</p>
        {item.href && (
          <Link
            href={item.href}
            className="mt-2 inline-flex items-center gap-1 rounded text-[var(--fs-sm)] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Learn more <ArrowRight className="size-3" aria-hidden />
          </Link>
        )}
      </div>
    </details>
  )
}

export function FAQGroup({ label, items }: { label: string; items: FaqItem[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <h3 className={cn(typography.cardTitle, 'text-foreground')}>{label}</h3>
      <div className="mt-2">
        {items.map(item => <FAQItem key={item.question} item={item} />)}
      </div>
    </div>
  )
}

export function FAQSection() {
  return (
    <SectionLayout background="white" labelledBy="faq-heading">
      <SectionHeader
        id="faq-heading"
        eyebrow={FAQ_HEADING.eyebrow}
        title={FAQ_HEADING.title}
        subtitle={FAQ_HEADING.subtitle}
        align="center"
      />
      <div className="mx-auto mt-12 max-w-3xl space-y-10">
        {FAQ_CATEGORIES.map(cat => (
          <FAQGroup
            key={cat.id}
            label={cat.label}
            items={FAQ_ITEMS.filter(i => i.category === cat.id).sort((a, b) => a.order - b.order)}
          />
        ))}
      </div>
    </SectionLayout>
  )
}
