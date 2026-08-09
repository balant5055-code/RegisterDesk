// RD-LAUNCH-06 — Support Centre taxonomy.
//
// Closes RD-LAUNCH-01 P1-2: the platform had FAQ content and (since RD-LAUNCH-02) a
// working contact form, but no place that gathered help in one location.
//
// REUSE FIRST. This file deliberately contains almost no prose. The 18 factual answers
// already in content/marketing/faq.ts are reused verbatim by the Support Centre — they
// are not copied here — and every topic below POINTS at a destination that already
// exists rather than restating what that page says. That keeps one source of truth per
// answer and stops the Support Centre drifting from the product.
//
// ACCURACY. Every destination was verified to exist before being listed, and every
// capability described was verified in code:
//   • Attendee self-serve pages: /attendee/registrations, /tickets, /certificates,
//     /donations (app/attendee/*).
//   • Signed receipt downloads: lib/receipts/token.ts + /api/receipts/[id].
//   • 80G donation receipts: lib/email/templates/donation-80g.ts.
//   • GST: applied at 18% to the PLATFORM FEE (lib/fees/config.ts) and itemised at
//     checkout — RegisterDesk does NOT issue GST tax invoices, so none is claimed.

export interface SupportLink {
  label: string
  href:  string
  /** Absent for internal routes. */
  external?: boolean
}

export interface SupportTopic {
  id:          string
  title:       string
  description: string
  links:       SupportLink[]
}

// ─── Organizer ────────────────────────────────────────────────────────────────

export const ORGANIZER_TOPICS: SupportTopic[] = [
  {
    id:          'events',
    title:       'Creating & managing events',
    description: 'Build an event, configure registration, publish it, and manage it once it is live.',
    links: [
      { label: 'Registration & forms',   href: '/platform/registration' },
      { label: 'Participants',           href: '/platform/participants' },
      { label: 'Identifiers & bibs',     href: '/platform/identifiers' },
    ],
  },
  {
    id:          'checkin',
    title:       'Check-in on event day',
    description: 'Scan QR tickets, admit participants, and handle entries without a connection.',
    links: [{ label: 'Check-in', href: '/platform/check-in' }],
  },
  {
    id:          'certificates',
    title:       'Certificates',
    description: 'Design certificates and issue them to participants after the event.',
    links: [{ label: 'Certificates', href: '/platform/certificates' }],
  },
  {
    id:          'money',
    title:       'Payments, refunds & settlements',
    description: 'How money reaches you, how refunds are issued, and how settlements are tracked.',
    links: [
      { label: 'Payments',       href: '/platform/payments' },
      { label: 'Finance',        href: '/platform/finance' },
      { label: 'Refund Policy',  href: '/refund-policy' },
    ],
  },
  {
    id:          'crm',
    title:       'Attendees & communication',
    description: 'Keep participant records together and send event emails from one place.',
    links: [{ label: 'CRM & communication', href: '/platform/crm' }],
  },
  {
    id:          'plans',
    title:       'Plans & pricing',
    description: 'What each event licence includes and what it costs.',
    links: [{ label: 'Pricing', href: '/pricing' }],
  },
]

// ─── Attendee ─────────────────────────────────────────────────────────────────
// Every link is a page an attendee can actually use today.

export const ATTENDEE_TOPICS: SupportTopic[] = [
  {
    id:          'register',
    title:       'Registering for an event',
    description: 'Find an event, choose a pass, and complete your registration.',
    links: [{ label: 'Browse events', href: '/events' }],
  },
  {
    id:          'tickets',
    title:       'Tickets & QR codes',
    description: 'Your ticket is emailed on confirmation and is always available in your account. Show the QR code at entry.',
    links: [
      { label: 'My tickets',       href: '/attendee/tickets' },
      { label: 'My registrations', href: '/attendee/registrations' },
    ],
  },
  {
    id:          'payment-issues',
    title:       'Payment problems',
    description: 'If a payment did not complete you are not charged, and your details are saved so you can retry safely.',
    links: [{ label: 'My registrations', href: '/attendee/registrations' }],
  },
  {
    id:          'refunds',
    title:       'Refunds',
    description: 'Refunds for a registration are issued by the event organiser under their own terms.',
    links: [{ label: 'Refund Policy', href: '/refund-policy' }],
  },
  {
    id:          'certificates-attendee',
    title:       'Certificates & results',
    description: 'Certificates issued by an organiser appear in your account, and published results are searchable.',
    links: [
      { label: 'My certificates', href: '/attendee/certificates' },
      { label: 'Results',         href: '/results' },
    ],
  },
  {
    id:          'account',
    title:       'Account & sign-in',
    description: 'Sign in to view everything you have registered for across events.',
    links: [
      { label: 'Attendee sign-in',  href: '/attendee/login' },
      { label: 'Organizer sign-in', href: '/login' },
    ],
  },
]

// ─── Payments detail ──────────────────────────────────────────────────────────
// Statements here are limited to behaviour verified in the codebase.

export const PAYMENT_FACTS: { heading: string; body: string }[] = [
  {
    heading: 'How payments are taken',
    body: 'Card, UPI, net banking and wallet payments are processed by Razorpay. RegisterDesk never sees or stores your card details.',
  },
  {
    heading: 'What you are charged',
    body: 'Before payment opens you are shown an itemised total — the ticket price, any platform fee, GST on that fee, and the payment-gateway charge. The amount you confirm is the amount taken.',
  },
  {
    heading: 'If a payment does not complete',
    body: 'You are not charged, and your registration details are kept. Retrying reuses the same order, so a cancelled or failed attempt can never charge you twice.',
  },
  {
    heading: 'Receipts',
    body: 'A receipt is available for every paid registration, and donations receive a donation receipt. Eligible donations to registered causes can also receive an 80G receipt where the organiser has enabled it.',
  },
  {
    heading: 'Refunds',
    body: 'Refunds are set and issued by the organiser of the event you registered for, under the terms published on that event. Contact the organiser first; the Refund Policy explains how the process works.',
  },
]

// ─── Legal ────────────────────────────────────────────────────────────────────

export const LEGAL_LINKS: SupportLink[] = [
  { label: 'Privacy Policy', href: '/privacy' },
  { label: 'Terms',          href: '/terms' },
  { label: 'Refund Policy',  href: '/refund-policy' },
  { label: 'Cookie Policy',  href: '/cookie-policy' },
]
