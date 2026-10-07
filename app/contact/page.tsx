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
// ═══ 2026-09-23 · CENTRED EDITORIAL LAYOUT (owner) ═════════════════════════
// The split panel was retired for a centred composition: masthead (bronze-ruled label,
// light serif h1 with one italic bronze word) → the three email channels as one
// hairline-divided row → the form in its own framed panel → business identity as a
// quiet line → the FAQ under a centred heading. WhatsApp is no longer listed.
//
// Earlier the same day — THE LUXURY PASS (owner: "redesign luxury and nicely") ═════
// Same structure, same data, same form, same ids. What changed is the voice: the aside
// is the public site's editorial column — a bronze-ruled small-caps label, a LIGHT serif
// headline with one italic bronze word, and the channels as a hairline-divided index with
// bronze-outlined tiles instead of white shadowed cards. The panel lost its blur blobs and
// its heavy shadow (a hairline frame now), the form half opened with its own serif title,
// and the FAQ became an editorial heading beside a hairline list, not a card.
//
// Composed from the shared primitives only: SectionLayout (band + rhythm +
// container), MotionLink, FAQItem.

import type { Metadata } from 'next'
import { Mail, LifeBuoy, CreditCard, ArrowUpRight } from 'lucide-react'
import { MotionLink } from '@/components/marketing/MotionLink'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { FAQItem } from '@/components/marketing/sections/FAQSection'
import { ContactInquiryForm } from '@/components/marketing/contact/ContactInquiryForm'
import { BUSINESS_IDENTITY } from '@/lib/marketing/ownership'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd, faqJsonLd } from '@/lib/marketing/seo'
import type { FaqItem } from '@/lib/marketing/types'

export const metadata: Metadata = buildMetadata({
  title:       'Contact | RegisterDesk',
  description: 'Talk to RegisterDesk — send an inquiry about your next event, or reach us by email.',
  path:        '/contact',
})

// ─── The one official contact directory (real channels) ───────────────────────────

// WhatsApp was listed here until 2026-09-23; the owner removed it from the page.
const CONTACTS: { icon: typeof Mail; title: string; value: string; href: string }[] = [
  { icon: Mail,          title: 'General Enquiries', value: 'hello@registerdesk.in',   href: 'mailto:hello@registerdesk.in' },
  { icon: LifeBuoy,      title: 'Technical Support', value: 'support@registerdesk.in', href: 'mailto:support@registerdesk.in' },
  { icon: CreditCard,    title: 'Billing & Finance', value: 'finance@registerdesk.in', href: 'mailto:finance@registerdesk.in' },
]

// Typed as the shared FaqItem so these render through the SAME disclosure
// component as the homepage FAQ, and feed faqJsonLd without a second shape.
const FAQ: FaqItem[] = [
  { question: 'Can I schedule a demo?',               answer: 'Yes — use Book a Demo in the inquiry form, tell us when suits you in your message, and our team will take it from there.', category: 'contact', order: 1 },
  { question: 'How long does onboarding take?',       answer: 'RegisterDesk is self-serve: create a free account and publish an event right away. For larger events, our team can help you get set up.', category: 'contact', order: 2 },
  { question: 'Do you support large events?',         answer: 'Yes. The platform runs everything from small workshops to multi-thousand-attendee marathons, with QR check-in, wallets and settlements.', category: 'contact', order: 3 },
  { question: 'Can RegisterDesk be white-labelled?',  answer: 'Yes. White-labelling puts your own brand on public event pages and emails on eligible plans.', category: 'contact', order: 4 },
  { question: 'Can I migrate from another platform?', answer: 'Reach out through the form and we will help you plan a migration that fits your data and timeline.', category: 'contact', order: 5 },
]

// ─── Editorial pieces ─────────────────────────────────────────────────────────────

/** The public site's section label, centred: bronze rule · small caps · bronze rule. */
function Overline({ children, as: Tag = 'p' }: { children: React.ReactNode; as?: 'p' | 'h2' }) {
  return (
    <Tag className="flex items-center justify-center gap-3 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
      <span aria-hidden className="h-px w-8 shrink-0 bg-hero-accent-rule" />
      {children}
      <span aria-hidden className="h-px w-8 shrink-0 bg-hero-accent-rule" />
    </Tag>
  )
}

// ─── The channels — one centred row of three, hairlines between ───────────────────

function ContactChannels() {
  return (
    <nav aria-label="Direct channels" className="mx-auto mt-10 max-w-4xl">
      <h2 className="sr-only">Direct channels</h2>
      <ul className="grid divide-y divide-border/60 border-y border-border/60 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {CONTACTS.map(c => (
          <li key={c.title}>
            <MotionLink
              href={c.href}
              aria-label={`${c.title}: ${c.value}`}
              className="group flex h-full items-center gap-3.5 rounded-[var(--radius-control)] px-1 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2 sm:flex-col sm:gap-2.5 sm:px-4 sm:py-7 sm:text-center"
            >
              <span aria-hidden className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-hero-accent-rule/40 bg-card text-hero-accent-rule transition-colors duration-200 group-hover:border-action/40 group-hover:text-action">
                <c.icon className="size-[18px]" strokeWidth={1.5} />
              </span>
              {/* A row on a phone (icon · text), a centred column from sm. */}
              <span className="flex min-w-0 flex-col sm:items-center sm:gap-2.5">
              <span className="text-fs-2xs font-semibold uppercase tracking-[0.18em] text-hero-eyebrow sm:mt-1">{c.title}</span>
              <span className="mt-0.5 inline-flex items-center gap-1.5 sm:mt-0 text-fs-base text-hero-ink transition-colors group-hover:text-action">
                {c.value}
                <ArrowUpRight
                  className="size-3.5 shrink-0 text-hero-ink-soft/50 transition-[color,translate] duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-action motion-reduce:transition-none"
                  aria-hidden
                />
              </span>
              </span>
            </MotionLink>
          </li>
        ))}
      </ul>
    </nav>
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
        <SectionLayout id="inquiry" labelledBy="contact-heading">
          {/* ── 1 · The centred masthead ── */}
          <header className="mx-auto max-w-2xl text-center">
            <Overline>Contact</Overline>
            {/* ONE line on every device (owner): min(6vw, the shared PAGE_TITLE size) — the same
                size as every other public title wherever the line fits, shrinking with the
                viewport only on phones so it never wraps. */}
            <h1 id="contact-heading" className="mt-5 whitespace-nowrap font-display text-[length:min(6vw,var(--fs-display-sm))] font-light tracking-[-0.015em] leading-[1.15] text-hero-ink">
              Talk to the RegisterDesk <em className="italic text-hero-accent-rule">team.</em>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-fs-md leading-relaxed text-hero-ink-soft">
              Tell us about your event and we will get back to you with the right person — or
              write to us directly at any of the addresses below.
            </p>
          </header>

          {/* ── 2 · The three channels ── */}
          <ContactChannels />

          {/* ── 3 · The form — its own framed panel on the centre axis ── */}
          <div className="mx-auto mt-12 max-w-3xl rounded-xl border border-border/70 bg-card px-6 py-8 shadow-elevation-1 sm:px-10 sm:py-10">
            <div className="mb-7 text-center">
              <h2 className="font-display text-fs-2xl font-light text-hero-ink sm:text-fs-3xl">Send an enquiry</h2>
              <span aria-hidden className="mx-auto mt-3 block h-px w-8 bg-hero-accent-rule" />
              <p className="mt-3 text-fs-sm text-hero-ink-soft">
                Fields marked <span className="text-action">*</span> are required.
              </p>
            </div>
            <ContactInquiryForm />
          </div>

          {/* ── 4 · Business identity — one quiet centred line. RD-LAUNCH-03: only facts
                 that exist in the codebase; no registered address or GSTIN is published
                 because none exists. Ownership is disclosed on the about and legal pages. ── */}
          <div className="mx-auto mt-8 max-w-3xl text-center">
            <h2 className="sr-only">Business identity</h2>
            <dl className="flex flex-wrap items-baseline justify-center gap-x-6 gap-y-2">
              {BUSINESS_IDENTITY.map(item => (
                <div key={item.label} className="flex items-baseline gap-2">
                  <dt className="text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-eyebrow">{item.label}</dt>
                  <dd className="text-fs-sm text-hero-ink">{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </SectionLayout>

        {/* ── 5 · FAQ — a centred heading over a hairline list. Native <details> via the
               shared FAQItem — accessible, zero client JS. ── */}
        <SectionLayout id="faq" spacing="compact" labelledBy="faq-heading">
          <div className="mx-auto max-w-3xl">
            <div className="text-center">
              <Overline>FAQ</Overline>
              <h2 id="faq-heading" className="mt-4 font-display text-fs-3xl font-light tracking-[-0.015em] text-hero-ink">
                Common questions
              </h2>
              <p className="mt-2 text-fs-base leading-relaxed text-hero-ink-soft">
                A few things people often ask before getting in touch.
              </p>
            </div>
            <div className="mt-8 border-t border-border/60">
              {FAQ.map(item => <FAQItem key={item.question} item={item} />)}
            </div>
          </div>
        </SectionLayout>
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
