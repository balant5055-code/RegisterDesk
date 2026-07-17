// /contact — enterprise contact experience (UI shell). Server Component; the only
// client island is the inquiry form.
//
// One official contact section only: the inquiry form beside a single Contact
// Information card. The form validates client-side and its submit is a safe no-op
// until a backend inquiry endpoint is built (separate task).

import type { Metadata } from 'next'
import { Mail, LifeBuoy, CreditCard, MessageCircle, ArrowUpRight, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { typography } from '@/lib/ds/typography'
import { Card } from '@/components/marketing/Card'
import { IconChip } from '@/components/marketing/IconChip'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { PlatformSection } from '@/components/marketing/platform'
import { ContactInquiryForm } from '@/components/marketing/contact/ContactInquiryForm'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'

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

const FAQ: { q: string; a: string }[] = [
  { q: 'Can I schedule a demo?',            a: 'Yes — use Book a Demo in the inquiry form above, pick a preferred date, and our team will take it from there.' },
  { q: 'How long does onboarding take?',    a: 'RegisterDesk is self-serve: create a free account and publish an event right away. For larger events, our team can help you get set up.' },
  { q: 'Do you support large events?',      a: 'Yes. The platform runs everything from small workshops to multi-thousand-attendee marathons, with QR check-in, wallets and settlements.' },
  { q: 'Can RegisterDesk be white-labelled?', a: 'Yes. White-labelling puts your own brand on public event pages and emails on eligible plans.' },
  { q: 'Can I migrate from another platform?', a: 'Reach out through the form above and we will help you plan a migration that fits your data and timeline.' },
]

export default function ContactPage() {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Contact', path: '/contact' }]),
  ]

  return (
    <>
      <MarketingPageLayout>
        {/* The enquiry section is the page hero; this visually-hidden H1 preserves the
            document outline the removed marketing hero used to provide (a11y + SEO). */}
        <h1 className="sr-only">Contact RegisterDesk</h1>

        {/* ── Inquiry form (left) + the one Contact Information card (right) ── */}
        <PlatformSection id="inquiry" eyebrow="Enterprise inquiry" title="Tell us about your event" subtitle="Share a few details and our team will get back to you.">
          <div className="grid gap-8 lg:grid-cols-[1.35fr_1fr] lg:gap-12">
            <ContactInquiryForm />

            <aside>
              <Card className="p-6 sm:p-8">
                <h3 className={cn(typography.subsectionHeading, 'text-foreground')}>Get in touch</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
                  We&apos;re here to help you launch successful events. Reach out through your preferred channel and
                  our team will respond as soon as possible.
                </p>

                <ul className="mt-6 space-y-1.5">
                  {CONTACTS.map(c => (
                    <li key={c.title}>
                      <a
                        href={c.href}
                        {...(c.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                        aria-label={`${c.title}: ${c.value}`}
                        className="group flex items-center gap-4 rounded-xl border border-transparent p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-border/60 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        <IconChip className="size-11 shrink-0">
                          <c.icon className="size-5 text-primary" aria-hidden />
                        </IconChip>
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold text-foreground">{c.title}</p>
                          <p className="truncate text-[13.5px] text-muted-foreground transition-colors group-hover:text-primary">{c.value}</p>
                        </div>
                        <ArrowUpRight className="ml-auto size-4 shrink-0 text-muted-foreground/50 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
                      </a>
                    </li>
                  ))}
                </ul>
              </Card>
            </aside>
          </div>
        </PlatformSection>

        {/* ── FAQ preview (native <details> — accessible, zero-JS) ── */}
        <PlatformSection id="faq" eyebrow="FAQ" title="Common questions" subtitle="A few things people often ask before getting in touch.">
          <div className="mx-auto max-w-3xl divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-white">
            {FAQ.map(f => (
              <details key={f.q} className="group px-5 sm:px-6">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[15px] font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" aria-hidden />
                </summary>
                <p className="pb-5 pr-8 text-[14px] leading-relaxed text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </PlatformSection>
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
