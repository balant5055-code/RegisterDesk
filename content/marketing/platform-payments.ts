// Phase P.2 — /platform/payments product page (CONFIG ONLY).

import { PLATFORM_PAGES } from '@/lib/marketing/platform/registry'
import type { PlatformPageConfig } from '@/lib/marketing/platform/types'

export const PAYMENTS_PAGE: PlatformPageConfig = {
  slug:            'payments',
  breadcrumbLabel: 'Payments',
  seo: {
    title:       'Payments | RegisterDesk',
    description: 'Collect payments securely for free and paid events — online checkout, automatic verification, refunds, wallet, and transparent settlements.',
  },
  hero: {
    eyebrow:      'Payments',
    headline:     'Collect payments securely — for free and paid events',
    subheadline:  'Take online payments through a trusted gateway with automatic verification, refunds, a wallet, and clear settlements to your account.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
    screenshotId: 'public-event',
  },
  sections: [
    {
      kind: 'product_showcase', id: 'showcase', eyebrow: 'Product',
      title: 'One financial workflow, end to end',
      subtitle: 'Every rupee is tracked from checkout through to payout.',
      screenshotId: 'finance',
      highlights: [
        { iconKey: 'payments',    title: 'Secure checkout',       description: 'Online payments via Razorpay — cards are never stored.' },
        { iconKey: 'verify',      title: 'Automatic verification', description: 'Every payment is verified before a registration confirms.' },
        { iconKey: 'settlements', title: 'Settlements & payouts', description: 'Get paid to your bank account or UPI.' },
      ],
    },
    {
      kind: 'capability_grid', id: 'capabilities', eyebrow: 'Capabilities',
      title: 'Everything you need to handle the money',
      subtitle: 'One financial system — no separate payment tool or spreadsheet.',
      items: [
        { iconKey: 'payments',    title: 'Online payments',     description: 'Secure online checkout through Razorpay.' },
        { iconKey: 'fast',        title: 'Free & paid events',  description: 'Run free events or sell paid tickets with the same flow.' },
        { iconKey: 'invoice',     title: 'Pricing & tickets',   description: 'Multiple ticket types and price points per event.' },
        { iconKey: 'verify',      title: 'Payment verification', description: 'Payments are verified automatically before a registration confirms.' },
        { iconKey: 'reuse',       title: 'Refunds',             description: 'Issue full or partial refunds, including donations.' },
        { iconKey: 'wallet',      title: 'Wallet',              description: 'Track your collected balance in a built-in wallet.' },
        { iconKey: 'settlements', title: 'Settlements',         description: 'Request settlements and get paid to your bank or UPI.' },
        { iconKey: 'finance',     title: 'Transaction history', description: 'Every payment, refund, and settlement is recorded.' },
        { iconKey: 'reports',     title: 'Financial reports',   description: 'Revenue, fees, and payout reports in real time.' },
      ],
    },
    {
      kind: 'dashboard_preview', id: 'preview', eyebrow: 'In the product',
      title: 'Checkout your attendees actually complete',
      subtitle: 'A fast, secure checkout connected to your event.',
      screenshotId: 'public-event',
    },
    {
      kind: 'integrations', id: 'integrations', eyebrow: 'Integrations',
      title: 'Connected to your finances',
      subtitle: 'Payments flow into settlements, reporting, and the API.',
      items: [
        { iconKey: 'payments',    title: 'Razorpay',       description: 'Secure online payment processing.' },
        { iconKey: 'settlements', title: 'Settlements',    description: 'Payouts to your bank account or UPI.' },
        { iconKey: 'finance',     title: 'Finance reports', description: 'Revenue, fees, and payout reporting.' },
        { iconKey: 'api',         title: 'Developer API',  description: 'Read payment and settlement data.' },
      ],
    },
  ],
  cta: {
    headline:     'Start collecting payments today.',
    subheadline:  'Free to start — secure checkout, automatic verification, and clear settlements.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
  },
}

PLATFORM_PAGES.payments = PAYMENTS_PAGE
