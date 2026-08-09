// RD-LAUNCH-06 — /support. Server Component (the only client island is the search box).
//
// Closes RD-LAUNCH-01 P1-2. Built REUSE-FIRST: the answers come from the existing
// content/marketing/faq.ts (18 factual items, unchanged), the topic cards point at
// pages that already exist, and the contact form is LINKED rather than duplicated —
// there is exactly one contact form on the site, on /contact.
//
// Nothing here claims a capability that was not verified in code first; see the notes
// in content/marketing/support.ts.

import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowUpRight, LifeBuoy, Mail, MessageCircle, Scale } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { typography } from '@/lib/ds/typography'
import { Card } from '@/components/marketing/Card'
import { IconChip } from '@/components/marketing/IconChip'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { PlatformSection } from '@/components/marketing/platform'
import { SupportSearch } from '@/components/marketing/support/SupportSearch'
import { FAQ_ITEMS, FAQ_CATEGORIES } from '@/content/marketing/faq'
import {
  ORGANIZER_TOPICS, ATTENDEE_TOPICS, PAYMENT_FACTS, LEGAL_LINKS,
  type SupportTopic,
} from '@/content/marketing/support'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd, faqJsonLd } from '@/lib/marketing/seo'

export const metadata: Metadata = buildMetadata({
  title:       'Support Centre | RegisterDesk',
  description: 'Help for organizers and attendees — registration, payments, refunds, tickets, certificates and check-in, plus how to contact the RegisterDesk team.',
  path:        '/support',
})

const LINK_CLS =
  'inline-flex items-center gap-1 rounded text-[13px] font-medium text-primary underline-offset-2 outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2'

function TopicCard({ topic }: { topic: SupportTopic }) {
  return (
    <Card className="flex h-full flex-col p-6">
      <h3 className="text-[15px] font-semibold text-foreground">{topic.title}</h3>
      <p className="mt-1.5 flex-1 text-[13.5px] leading-relaxed text-muted-foreground">{topic.description}</p>
      <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
        {topic.links.map(l => (
          <li key={l.href}>
            <Link href={l.href} className={LINK_CLS}>{l.label}</Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export default function SupportPage() {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Support', path: '/support' }]),
    // Reuses the SAME items rendered below — the structured data can never describe
    // answers the page does not show.
    faqJsonLd(FAQ_ITEMS.map(i => ({ question: i.question, answer: i.answer }))),
  ]

  const byCategory = FAQ_CATEGORIES
    .map(c => ({ ...c, items: FAQ_ITEMS.filter(i => i.category === c.id).sort((a, b) => a.order - b.order) }))
    .filter(c => c.items.length > 0)

  return (
    <>
      <MarketingPageLayout>
        {/* ── Hero + search ── */}
        <PlatformSection
          id="support-home"
          eyebrow="Support"
          title="How can we help?"
          subtitle="Answers for organizers running events and for attendees registering for them."
        >
          <h1 className="sr-only">RegisterDesk Support Centre</h1>
          <SupportSearch items={FAQ_ITEMS} />
        </PlatformSection>

        {/* ── Organizer ── */}
        <PlatformSection
          id="organizers"
          eyebrow="For organizers"
          title="Running your event"
          subtitle="Setting up, taking registrations, and operating on the day."
        >
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {ORGANIZER_TOPICS.map(t => <TopicCard key={t.id} topic={t} />)}
          </div>
        </PlatformSection>

        {/* ── Attendee ── */}
        <PlatformSection
          id="attendees"
          eyebrow="For attendees"
          title="Registering and attending"
          subtitle="Your registrations, tickets, certificates and payments — all in your account."
        >
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {ATTENDEE_TOPICS.map(t => <TopicCard key={t.id} topic={t} />)}
          </div>
        </PlatformSection>

        {/* ── Payments & refunds ── */}
        <PlatformSection
          id="payments"
          eyebrow="Payments & refunds"
          title="How money works on RegisterDesk"
          subtitle="What you are charged, how receipts work, and who issues refunds."
        >
          <div className="mx-auto max-w-3xl divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-white">
            {PAYMENT_FACTS.map(f => (
              <div key={f.heading} className="px-5 py-5 sm:px-6">
                <h3 className="text-[14.5px] font-semibold text-foreground">{f.heading}</h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </PlatformSection>

        {/* ── Common questions — the EXISTING FAQ, grouped. Native <details>, zero JS. ── */}
        <PlatformSection
          id="faq"
          eyebrow="Common questions"
          title="Frequently asked questions"
          subtitle="The questions organizers ask most often, grouped by topic."
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-8">
            {byCategory.map(c => (
              <section key={c.id} aria-labelledby={`faq-${c.id}`}>
                <h3 id={`faq-${c.id}`} className="mb-3 text-[13px] font-bold uppercase tracking-wide text-muted-foreground">
                  {c.label}
                </h3>
                <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-white">
                  {c.items.map(item => (
                    <details key={item.question} className="group px-5 sm:px-6">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[14.5px] font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50 [&::-webkit-details-marker]:hidden">
                        {item.question}
                        <span aria-hidden className="shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-45">+</span>
                      </summary>
                      <p className="pb-4 text-[13.5px] leading-relaxed text-muted-foreground">{item.answer}</p>
                    </details>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </PlatformSection>

        {/* ── Contact — LINKED, never duplicated. One contact form exists, on /contact. ── */}
        <PlatformSection
          id="contact"
          eyebrow="Still need help?"
          title="Contact the team"
          subtitle="If you could not find an answer here, get in touch and we will help."
        >
          <div className="mx-auto grid max-w-3xl gap-5 sm:grid-cols-3">
            <Card className="flex flex-col items-start p-6">
              <IconChip className="size-10"><MessageCircle className="size-5 text-primary" aria-hidden /></IconChip>
              <h3 className="mt-3 text-[14.5px] font-semibold text-foreground">Send an enquiry</h3>
              <p className="mt-1 flex-1 text-[13px] leading-relaxed text-muted-foreground">
                Tell us about your event or your issue and we will get back to you.
              </p>
              <Link href="/contact" className={cn(LINK_CLS, 'mt-3')}>
                Go to Contact<ArrowUpRight className="size-3.5" aria-hidden />
              </Link>
            </Card>

            <Card className="flex flex-col items-start p-6">
              <IconChip className="size-10"><Mail className="size-5 text-primary" aria-hidden /></IconChip>
              <h3 className="mt-3 text-[14.5px] font-semibold text-foreground">Email support</h3>
              <p className="mt-1 flex-1 text-[13px] leading-relaxed text-muted-foreground">
                Already registered for an event? Your event organiser can help fastest with
                registration and refund questions.
              </p>
              <a href="mailto:support@registerdesk.in" className={cn(LINK_CLS, 'mt-3')}>
                support@registerdesk.in
              </a>
            </Card>

            <Card className="flex flex-col items-start p-6">
              <IconChip className="size-10"><Scale className="size-5 text-primary" aria-hidden /></IconChip>
              <h3 className="mt-3 text-[14.5px] font-semibold text-foreground">Legal & policies</h3>
              <ul className="mt-2 flex flex-1 flex-col gap-1.5">
                {LEGAL_LINKS.map(l => (
                  <li key={l.href}><Link href={l.href} className={LINK_CLS}>{l.label}</Link></li>
                ))}
              </ul>
            </Card>
          </div>

          <p className={cn(typography.body, 'mx-auto mt-8 max-w-2xl text-center text-muted-foreground')}>
            <LifeBuoy className="mr-1.5 inline size-4 align-[-2px] text-primary" aria-hidden />
            Registration, ticket and refund questions for a specific event are handled by that
            event&apos;s organiser — their contact details are on the event page.
          </p>
        </PlatformSection>
      </MarketingPageLayout>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
