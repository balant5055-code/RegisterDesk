// Phase P.1.3 / P.1.6.10 — FAQ content (factual; matches shipped behaviour).
//
// Real organizer questions only — no invented questions, no generic SaaS filler,
// no fake limits or unsupported claims. Each item has a category + order so the
// section can group and sort without logic in the component. Optional `href`
// deep-links into the Platform IA. Schema is NOT generated here — the page emits
// FAQ JSON-LD via the existing seo.ts faqJsonLd helper (reads question/answer).

import type { FaqItem } from '@/lib/marketing/types'

export const FAQ_HEADING = {
  eyebrow:  'FAQ',
  title:    'Questions organizers ask before choosing RegisterDesk',
  subtitle: 'Straight answers about what the platform actually does today.',
}

export interface FaqCategory { id: string; label: string }

export const FAQ_CATEGORIES: FaqCategory[] = [
  { id: 'events',       label: 'Events & registration' },
  { id: 'participants', label: 'Participants & certificates' },
  { id: 'payments',     label: 'Payments & settlements' },
  { id: 'trust',        label: 'Team & security' },
  { id: 'plans',        label: 'Plans & access' },
]

export const FAQ_ITEMS: FaqItem[] = [
  // ── Events & registration ──
  { category: 'events', order: 1, question: 'What types of events can I manage?',
    answer: 'Marathons and sports, conferences, workshops, exhibitions, award ceremonies, fundraisers, corporate, and school or college events.' },
  { category: 'events', order: 2, id: 'multiple-events', question: 'Can I manage multiple events?',
    answer: 'Yes. Run and switch between many events from one workspace, each with its own registrations, participants, and finances.' },
  { category: 'events', order: 3, id: 'customize-forms', question: 'Can I customize registration forms?',
    answer: 'Yes. Build a registration form with the fields, passes, and pricing your event needs, including coupons and capacity limits.' },

  // ── Participants & certificates ──
  { category: 'participants', order: 1, id: 'identifiers', question: 'Can I assign participant identifiers?',
    answer: 'Yes. One identifier engine assigns bibs, badges, delegate IDs, or any numbering scheme, with assign, swap, reserve, and block controls.' },
  { category: 'participants', order: 2, id: 'certificates', question: 'Can I issue certificates?',
    answer: 'Yes. Design certificates, issue them in bulk, email them to attendees, and let recipients verify authenticity.' },
  { category: 'participants', order: 3, id: 'export-registrations', question: 'Can I export registrations?',
    answer: 'Yes. Export participants and reports to CSV, and run bulk operations on registrations.' },
  { category: 'participants', order: 4, id: 'participant-app', question: 'Do participants need to install an app?',
    answer: 'No. Everything attendees need works over the web and email — there is no app to install.' },

  // ── Payments & settlements ──
  { category: 'payments', order: 1, id: 'collect-payments', question: 'Can I collect payments online?',
    answer: 'Yes. Payments are processed securely through Razorpay, and card details are never stored on RegisterDesk.' },
  { category: 'payments', order: 2, id: 'refunds', question: 'Can I issue refunds?',
    answer: 'Refunds are handled by the RegisterDesk Super Admin team according to the RegisterDesk refund policy. Organizers do not issue refunds from their dashboard.' },
  { category: 'payments', order: 3, id: 'settlements', question: 'How are settlements handled?',
    answer: 'After an event collects revenue, funds are held briefly and then released to your available balance. You can request a settlement and receive payouts to your bank account or UPI.' },
  { category: 'payments', order: 4, id: 'transaction-fees', question: 'What are the transaction fees?',
    answer: 'Paid registrations carry a transaction fee. The standard rate is 2.5% of the ticket price — see the pricing page for current terms.',
    href: '/pricing' },

  // ── Team & security ──
  { category: 'trust', order: 1, id: 'team', question: 'Can my team collaborate?',
    answer: 'Yes. Role-based team access lets you invite admins, managers, check-in staff, and finance roles with scoped permissions.',
    href: '/security' },
  { category: 'trust', order: 2, id: 'data-security', question: 'How secure is my event data?',
    answer: 'Your data is scoped to your workspace and to each event, protected by role-based access and a recorded audit history.',
    href: '/security' },
  { category: 'trust', order: 3, id: 'offline-checkin', question: 'Does check-in work offline?',
    answer: 'Yes. QR check-in keeps working without a network connection and syncs automatically when you reconnect.' },

  // ── Plans & access ──
  { category: 'plans', order: 1, id: 'free-events', question: 'Does RegisterDesk support free events?',
    answer: 'Yes. Every event is free to run up to 100 registrations — no subscriptions and no monthly cost — and you can offer free, no-charge registrations. Above 100 you pay once for the extra capacity you need.',
    href: '/pricing' },
  { category: 'plans', order: 2, id: 'api', question: 'Is there an API?',
    answer: 'Yes. API keys and signed webhooks are included for every organizer, for reading registrations, donations, and events.' },
  { category: 'plans', order: 3, id: 'white-label', question: 'Do you support white-label and custom domains?',
    answer: 'White-label branding is included for every organizer, on every event. Custom domains are not available yet.',
    href: '/pricing' },
  { category: 'plans', order: 4, question: 'Can I run fundraisers?',
    answer: 'Yes. RegisterDesk supports donation campaigns with receipts, including 80G tax receipts where configured.' },
]
