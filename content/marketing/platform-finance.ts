// Phase P.2 — /platform/finance product page (CONFIG ONLY).

import { PLATFORM_PAGES } from '@/lib/marketing/platform/registry'
import type { PlatformPageConfig } from '@/lib/marketing/platform/types'

export const FINANCE_PAGE: PlatformPageConfig = {
  slug:            'finance',
  breadcrumbLabel: 'Finance',
  seo: {
    title:       'Finance & Payouts | RegisterDesk',
    description: 'Track revenue and get paid — a built-in wallet, transparent settlements, refunds, payouts to your account, transaction history, and financial reports.',
  },
  hero: {
    eyebrow:      'Finance & Payouts',
    headline:     'Track revenue and get paid, all in one place',
    subheadline:  'A built-in wallet, clear settlements, refunds, and payouts to your bank or UPI — with every transaction recorded and reconciled automatically.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
    screenshotId: 'finance',
  },
  sections: [
    {
      kind: 'product_showcase', id: 'showcase', eyebrow: 'Product',
      title: 'See your finances at a glance',
      subtitle: 'Wallet, revenue, refunds, settlements, and payouts in one center.',
      screenshotId: 'finance',
      highlights: [
        { iconKey: 'finance',     title: 'Revenue in real time', description: 'Revenue, fees, and net at a glance.' },
        { iconKey: 'settlements', title: 'Clear settlements',    description: "Know what you earned and when you'll be paid." },
        { iconKey: 'invoice',     title: 'Payouts',              description: 'Settle to your bank account or UPI.' },
      ],
    },
    {
      kind: 'capability_grid', id: 'capabilities', eyebrow: 'Capabilities',
      title: 'One financial home for every event',
      subtitle: 'No separate accounting tool, no manual reconciliation.',
      items: [
        { iconKey: 'wallet',      title: 'Wallet',              description: 'Track your collected balance per event.' },
        { iconKey: 'finance',     title: 'Revenue tracking',    description: 'See revenue, fees, and net in real time.' },
        { iconKey: 'reuse',       title: 'Refunds',             description: 'Issue full or partial refunds, fully reconciled.' },
        { iconKey: 'settlements', title: 'Settlements',         description: 'Request settlements of your available balance.' },
        { iconKey: 'invoice',     title: 'Payouts',             description: 'Get paid to your bank account or UPI.' },
        { iconKey: 'verify',      title: 'Transaction history', description: 'Every payment, refund, and settlement recorded.' },
        { iconKey: 'reports',     title: 'Financial reports',   description: 'Revenue and payout reports in real time.' },
        { iconKey: 'security',    title: 'Fee transparency',    description: 'See exactly what fees apply to each plan.' },
      ],
    },
    {
      kind: 'feature_highlights', id: 'highlights', eyebrow: 'Highlights',
      title: 'Financial clarity without the spreadsheets',
      subtitle: 'Know what you earned and when you will be paid.',
      items: [
        { iconKey: 'settlements', title: 'Transparent settlements', description: 'See exactly what you have earned and when you will be paid.' },
        { iconKey: 'reuse',       title: 'Automatic reconciliation', description: 'Revenue ties to registrations automatically — no spreadsheets.' },
        { iconKey: 'finance',     title: 'Real-time reporting',     description: 'Revenue, fees, refunds, and payouts in real time.' },
      ],
    },
    {
      kind: 'integrations', id: 'integrations', eyebrow: 'Integrations',
      title: 'Connected to your money flow',
      subtitle: 'Finance draws on payments and feeds payouts and the API.',
      items: [
        { iconKey: 'payments',    title: 'Payments',      description: 'Revenue flows in from checkout.' },
        { iconKey: 'settlements', title: 'Payouts',       description: 'Settlements to bank or UPI.' },
        { iconKey: 'api',         title: 'Developer API', description: 'Read finance and settlement data.' },
      ],
    },
  ],
  cta: {
    headline:     'Get paid without the paperwork.',
    subheadline:  'Start free and track every rupee from payment to payout.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
  },
}

PLATFORM_PAGES.finance = FINANCE_PAGE
