// Phase P.2 — /platform/registration product page (CONFIG ONLY).
// Product sections only (no workflow/features/benefits/faq). Self-registers.

import { PLATFORM_PAGES } from '@/lib/marketing/platform/registry'
import type { PlatformPageConfig } from '@/lib/marketing/platform/types'

export const REGISTRATION_PAGE: PlatformPageConfig = {
  slug:            'registration',
  breadcrumbLabel: 'Registration',
  seo: {
    title:       'Registration | RegisterDesk',
    description: 'A complete event registration system — custom forms, tickets, coupons, approvals, payments, and confirmations, all connected to the rest of your event.',
  },
  hero: {
    eyebrow:      'Registration',
    headline:     'A complete registration system, not just a form',
    subheadline:  'Collect registrations with custom forms, tickets, coupons, and approvals — connected straight to payments, participants, check-in, and certificates.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
    screenshotId: 'public-event',
  },
  sections: [
    {
      kind: 'product_showcase', id: 'showcase', eyebrow: 'Product',
      title: 'Registration that connects to everything',
      subtitle: 'Every sign-up flows into the rest of your event automatically.',
      screenshotId: 'event-home',
      highlights: [
        { iconKey: 'registration', title: 'Custom forms & passes', description: 'Build the exact form and ticket types your event needs.' },
        { iconKey: 'fast',         title: 'Coupons & waitlists',   description: 'Discounts, capacity limits, and waitlists out of the box.' },
        { iconKey: 'workspace',    title: 'Connected to everything', description: 'Registrations flow into payments, participants, and check-in.' },
      ],
    },
    {
      kind: 'capability_grid', id: 'capabilities', eyebrow: 'Capabilities',
      title: 'Everything you need to take registrations',
      subtitle: 'One registration system, not a stack of disconnected tools.',
      items: [
        { iconKey: 'registration',   title: 'Registration forms',  description: 'Build branded registration forms for any event type.' },
        { iconKey: 'workspace',      title: 'Custom fields',       description: 'Collect exactly the data you need with custom fields.' },
        { iconKey: 'invoice',        title: 'Tickets & passes',    description: 'Offer multiple ticket types and passes per event.' },
        { iconKey: 'fast',           title: 'Coupons & discounts', description: 'Run coupon codes and discounts at checkout.' },
        { iconKey: 'verify',         title: 'Approval workflow',   description: 'Review and approve registrations where required.' },
        { iconKey: 'reports',        title: 'Capacity & waitlists', description: 'Set capacity, cut-offs, and waitlists per ticket.' },
        { iconKey: 'communications', title: 'Email confirmation',  description: 'Send automatic confirmation emails on registration.' },
        { iconKey: 'crm',            title: 'Participant dashboard', description: 'Manage every registrant from one participant view.' },
        { iconKey: 'finance',        title: 'Reports & export',    description: 'Track registrations and export to CSV anytime.' },
      ],
    },
    {
      kind: 'dashboard_preview', id: 'preview', eyebrow: 'In the product',
      title: 'Manage registrations in one workspace',
      subtitle: 'From the public form to the participant record — one connected place.',
      screenshotId: 'public-event',
    },
    {
      kind: 'integrations', id: 'integrations', eyebrow: 'Integrations',
      title: 'Connected to the rest of your event',
      subtitle: 'Registration feeds payments, participants, and reporting.',
      items: [
        { iconKey: 'payments',       title: 'Payments',       description: 'Collect registration fees through secure checkout.' },
        { iconKey: 'communications', title: 'Email',          description: 'Automatic confirmation emails on registration.' },
        { iconKey: 'reports',        title: 'CSV export',     description: 'Export registrations and reports anytime.' },
        { iconKey: 'api',            title: 'Developer API',  description: 'Read registrations programmatically.' },
      ],
    },
  ],
  cta: {
    headline:     'Ready to run registrations the modern way?',
    subheadline:  'Start free and take your first registrations today.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
  },
}

PLATFORM_PAGES.registration = REGISTRATION_PAGE
