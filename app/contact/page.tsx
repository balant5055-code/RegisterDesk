// /contact — enterprise contact experience (UI shell). Server Component; the only
// client islands are the inquiry form and the motion-enabled channel rows.
//
// One official contact section only: the inquiry form beside a single Contact
// Information panel. RD-LAUNCH-02: the form posts to /api/contact, which stores the
// enquiry and notifies support. RD-LAUNCH-03 adds the business-identity block.
//
// DESIGN — the page is ONE elevated split panel, not a page of floating cards: a
// recessed aside (headline · channels · identity) hinged to a raised white form
// half, inside a single rounded, shadowed container. It reads as one designed
// object, and it removes the two competing white-on-white card surfaces an earlier
// revision had. The separation is built from DEPTH, not from a dark fill: the aside
// is surface-3 (--muted), the DS token for an inset/subtle surface, the form half is
// white, and a hairline runs the seam. Light-first throughout — no ink, no black.
//
// Composed from the shared primitives only: SectionLayout (band + rhythm +
// container), SectionHeader, Eyebrow, IconChip, MotionLink, Card, FAQItem.

import type { Metadata } from 'next'
import { Mail, LifeBuoy, CreditCard, MessageCircle, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { fs, typography } from '@/lib/ds/typography'
import { Card } from '@/components/marketing/Card'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import { IconChip } from '@/components/marketing/IconChip'
import { MotionLink } from '@/components/marketing/MotionLink'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { SectionHeader } from '@/components/marketing/layout/SectionHeader'
import { FAQItem } from '@/components/marketing/sections/FAQSection'
import { ContactInquiryForm } from '@/components/marketing/contact/ContactInquiryForm'
import { BUSINESS_IDENTITY } from '@/lib/marketing/ownership'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd, faqJsonLd } from '@/lib/marketing/seo'
import type { FaqItem } from '@/lib/marketing/types'

export const metadata: Metadata = buildMetadata({
  title:       'Contact | RegisterDesk',
  description: 'Talk to RegisterDesk — send an inquiry about your next event, or reach us by email or WhatsApp.',
  path:        '/contact',
})

// ─── The one official contact directory (real channels) ───────────────────────────

const CONTACTS: { icon: typeof Mail; title: string; value: string; href: string; external?: boolean }[] = [
  { icon: Mail,          title: 'General Enquiries', value: 'hello@registerdesk.in',   href: 'mailto:hello@registerdesk.in' },
  { icon: LifeBuoy,      title: 'Technical Support', value: 'support@registerdesk.in', href: 'mailto:support@registerdesk.in' },
  { icon: CreditCard,    title: 'Billing & Finance', value: 'finance@registerdesk.in', href: 'mailto:finance@registerdesk.in' },
  { icon: MessageCircle, title: 'WhatsApp',          value: '+91 93639 35055',         href: 'https://wa.me/919363935055', external: true },
]

// Typed as the shared FaqItem so these render through the SAME disclosure
// component as the homepage FAQ, and feed faqJsonLd without a second shape.
const FAQ: FaqItem[] = [
  { question: 'Can I schedule a demo?',               answer: 'Yes — use Book a Demo in the inquiry form, pick a preferred date, and our team will take it from there.', category: 'contact', order: 1 },
  { question: 'How long does onboarding take?',       answer: 'RegisterDesk is self-serve: create a free account and publish an event right away. For larger events, our team can help you get set up.', category: 'contact', order: 2 },
  { question: 'Do you support large events?',         answer: 'Yes. The platform runs everything from small workshops to multi-thousand-attendee marathons, with QR check-in, wallets and settlements.', category: 'contact', order: 3 },
  { question: 'Can RegisterDesk be white-labelled?',  answer: 'Yes. White-labelling puts your own brand on public event pages and emails on eligible plans.', category: 'contact', order: 4 },
  { question: 'Can I migrate from another platform?', answer: 'Reach out through the form and we will help you plan a migration that fits your data and timeline.', category: 'contact', order: 5 },
]

// ─── Aside cells ──────────────────────────────────────────────────────────────────
//
// The aside is a light INSET surface — surface-3 (--muted, slate-100), the token the
// DS already defines for "inset / subtle". White form on the right, recessed neutral
// on the left: the contrast that makes the panel read as one designed object comes
// from depth, not from a dark fill.
//
// Two cells, not one, and that is the whole mobile strategy: stacked, a single aside
// carrying headline + four channel rows + identity runs ~500px, so the form would
// open a screen and a half down. Split, the phone gets [headline] → [form] →
// [channels], and the form is visible immediately. At lg both cells occupy column 1
// on adjacent rows, so they read as one continuous inset column.

/** Decorative brand wash. Composed from --primary-rgb, so it tracks the token. */
function BrandWash({ className, alpha }: { className: string; alpha: number }) {
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute -z-10 rounded-full blur-3xl', className)}
      style={{ background: `radial-gradient(circle, rgb(var(--primary-rgb) / ${alpha}), transparent 70%)` }}
    />
  )
}

/** Seam hairline is declared here; each cell picks the edge its breakpoint needs. */
const ASIDE_CELL = 'relative isolate overflow-hidden border-border/60 bg-surface-3 px-6 sm:px-8 lg:px-10'

function ContactHero({ className }: { className?: string }) {
  return (
    <div className={cn(ASIDE_CELL, 'border-b pb-8 pt-8 sm:pt-10 lg:border-b-0 lg:border-r lg:pt-12', className)}>
      <BrandWash className="-left-20 -top-28 size-80" alpha={0.14} />

      <Eyebrow>Contact</Eyebrow>

      <h1 id="contact-heading" className="mt-5 text-fs-display-sm font-bold leading-[1.1] tracking-tight text-foreground">
        Talk to the RegisterDesk team
      </h1>
      <p className={cn(typography.body, 'mt-3 max-w-md text-muted-foreground')}>
        Tell us about your event and we will get back to you with the right person — or reach us
        directly on any channel listed here.
      </p>
    </div>
  )
}

function ContactRail({ className }: { className?: string }) {
  return (
    <div className={cn(ASIDE_CELL, 'border-t py-8 lg:border-r lg:border-t-0 lg:pb-12 lg:pt-0', className)}>
      <BrandWash className="-bottom-28 -right-20 size-72" alpha={0.10} />

      <h2 className={cn(typography.overline, 'text-muted-foreground')}>Direct channels</h2>
      <ul className="mt-3 space-y-2">
        {CONTACTS.map(c => (
          <li key={c.title}>
            {/* White rows lift off the inset surface — the same figure/ground the
                form half uses, so both halves belong to one system. */}
            <MotionLink
              href={c.href}
              {...(c.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              aria-label={`${c.title}: ${c.value}`}
              className="group flex items-center gap-3 rounded-xl border border-border/60 bg-white p-2.5 shadow-sm transition-colors duration-150 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <IconChip className="size-9 shrink-0">
                <c.icon className="size-4 text-primary" aria-hidden />
              </IconChip>
              <span className="min-w-0">
                <span className={cn(fs.sm, 'block font-semibold text-foreground')}>{c.title}</span>
                <span className={cn(fs.sm, 'block truncate text-muted-foreground transition-colors group-hover:text-primary')}>
                  {c.value}
                </span>
              </span>
              <ArrowUpRight
                className="ml-auto size-4 shrink-0 text-muted-foreground/40 transition-colors duration-150 group-hover:text-primary"
                aria-hidden
              />
            </MotionLink>
          </li>
        ))}
      </ul>

      {/* RD-LAUNCH-03 — business identity. An at-a-glance directory: the product, where
          to reach it, and where it lives. Only facts that exist in the codebase are
          listed; registered address and GSTIN are absent because no such values exist
          to publish. Ownership is disclosed through OWNERSHIP_SENTENCE on the about and
          legal pages and OWNERSHIP_SHORT in the footer — it is not restated here.
          Supporting detail at the foot of the aside column, not a card of its own. */}
      <div className="mt-7 border-t border-border/60 pt-6">
        <h2 className={cn(typography.overline, 'text-muted-foreground')}>Business identity</h2>
        <dl className="mt-3 space-y-1.5">
          {BUSINESS_IDENTITY.map(item => (
            <div key={item.label} className="flex items-baseline justify-between gap-4">
              <dt className={cn(fs.xs, 'shrink-0 text-muted-foreground')}>{item.label}</dt>
              <dd className={cn(fs.sm, 'min-w-0 break-words text-right font-medium text-foreground')}>{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────────

export default function ContactPage() {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Contact', path: '/contact' }]),
    faqJsonLd(FAQ),
  ]

  return (
    <>
      <MarketingPageLayout>
        {/* ── The split panel. One container, no page-level header above it: the
               panel's own <h1> is the page heading, so nothing is repeated. ── */}
        <SectionLayout id="inquiry" labelledBy="contact-heading">
          <div className="overflow-hidden rounded-3xl border border-border/60 shadow-elevation-4">
            {/* DOM order is hero → form → rail, which IS the mobile order, so the
                visual order never diverges from the focus order. At lg the two ink
                cells are placed into column 1 (rows 1 and 2) and the form spans
                both rows of column 2 — a continuous ink column, whatever the
                form's height. Explicit placement, not `order`, keeps that true. */}
            <div className="grid items-stretch bg-white lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:grid-rows-[auto_1fr]">
              {/* Placement classes go ON the ink cells, not on wrappers — a wrapper
                  would stretch to the row while its ink child kept content height,
                  leaving a white gap at the foot of the column. */}
              <ContactHero className="lg:col-start-1 lg:row-start-1" />
              <div className="px-6 py-8 sm:px-8 sm:py-10 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:px-10 lg:py-12">
                <ContactInquiryForm />
              </div>
              <ContactRail className="lg:col-start-1 lg:row-start-2" />
            </div>
          </div>
        </SectionLayout>

        {/* ── FAQ. Heading and answers sit side by side at lg (the heading column
               is dead space otherwise), stacking below it. Native <details> via the
               shared FAQItem — accessible, zero client JS. ── */}
        <SectionLayout id="faq" spacing="compact" labelledBy="faq-heading">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)] lg:gap-12">
            <SectionHeader
              id="faq-heading"
              align="left"
              eyebrow="FAQ"
              title="Common questions"
              subtitle="A few things people often ask before getting in touch."
              className="gap-3 lg:sticky lg:top-[calc(var(--nav-h)+2rem)] lg:self-start"
            />
            {/* last:border-b-0 closes the list cleanly — FAQItem draws a rule per row. */}
            <Card className="px-5 py-1 sm:px-6 [&>details:last-child]:border-b-0">
              {FAQ.map(item => <FAQItem key={item.question} item={item} />)}
            </Card>
          </div>
        </SectionLayout>
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
