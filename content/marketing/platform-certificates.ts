// Phase P.2 — /platform/certificates product page (CONFIG ONLY).

import { PLATFORM_PAGES } from '@/lib/marketing/platform/registry'
import type { PlatformPageConfig } from '@/lib/marketing/platform/types'

export const CERTIFICATES_PAGE: PlatformPageConfig = {
  slug:            'certificates',
  breadcrumbLabel: 'Certificates',
  seo: {
    title:       'Certificates | RegisterDesk',
    description: 'Automated certificate generation with dynamic templates — merge participant data, generate in bulk, deliver downloads, and verify authenticity.',
  },
  hero: {
    eyebrow:      'Certificates',
    headline:     'Automated certificates, generated in bulk',
    subheadline:  'Design dynamic templates, merge participant data automatically, and issue verifiable certificates to everyone — no editing them one by one.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
    screenshotId: 'certificates',
  },
  sections: [
    {
      kind: 'product_showcase', id: 'showcase', eyebrow: 'Product',
      title: 'Design once, issue to thousands',
      subtitle: 'Branded templates with dynamic data merge and bulk issuance.',
      screenshotId: 'certificates',
      highlights: [
        { iconKey: 'certificates', title: 'Dynamic templates', description: 'Branded templates with merge fields.' },
        { iconKey: 'fast',         title: 'Bulk issuance',     description: 'Generate certificates for everyone at once.' },
        { iconKey: 'security',     title: 'Verifiable',        description: 'Anyone can verify a certificate is authentic.' },
      ],
    },
    {
      kind: 'capability_grid', id: 'capabilities', eyebrow: 'Capabilities',
      title: 'Everything you need to issue certificates',
      subtitle: 'Design once, issue to thousands — no manual editing.',
      items: [
        { iconKey: 'certificates',   title: 'Certificate templates', description: 'Design branded certificate templates.' },
        { iconKey: 'reuse',          title: 'Dynamic tokens',        description: 'Merge participant data with dynamic tokens.' },
        { iconKey: 'fast',           title: 'Bulk generation',       description: 'Generate certificates for everyone in one click.' },
        { iconKey: 'verify',         title: 'Eligibility rules',     description: 'Issue only to eligible participants.' },
        { iconKey: 'communications', title: 'Participant download',  description: 'Attendees download via a secure link.' },
        { iconKey: 'security',       title: 'Verification',          description: 'Recipients and others can verify authenticity.' },
        { iconKey: 'workspace',      title: 'Organizer preview',     description: 'Preview certificates before issuing.' },
        { iconKey: 'reports',        title: 'Certificate history',   description: 'Track every certificate issued.' },
        { iconKey: 'finance',        title: 'Exports',               description: 'Export certificate records to CSV.' },
        { iconKey: 'integrations',   title: 'Automation',            description: 'Automate issuance after the event.' },
      ],
    },
    {
      kind: 'feature_highlights', id: 'highlights', eyebrow: 'Highlights',
      title: 'Built for real certificate workflows',
      subtitle: 'The parts that save the most time.',
      items: [
        { iconKey: 'reuse',    title: 'Dynamic data merge',    description: 'Participant names and details merge automatically into every certificate.' },
        { iconKey: 'security', title: 'Verification workflow', description: 'Recipients and third parties can confirm a certificate is authentic.' },
        { iconKey: 'fast',     title: 'Issue in bulk',         description: 'Design once and issue to thousands in a single pass.' },
      ],
    },
    {
      kind: 'integrations', id: 'integrations', eyebrow: 'Integrations',
      title: 'Connected to your event',
      subtitle: 'Eligibility and delivery come straight from the platform.',
      items: [
        { iconKey: 'checkin',        title: 'Attendance',     description: 'Eligibility from check-in attendance.' },
        { iconKey: 'communications', title: 'Email delivery', description: 'Deliver certificates by email.' },
        { iconKey: 'reports',        title: 'CSV export',     description: 'Export certificate records.' },
      ],
    },
  ],
  cta: {
    headline:     'Issue certificates without the busywork.',
    subheadline:  'Start free and deliver verifiable certificates in bulk.',
    primaryCta:   'startFree',
    secondaryCta: 'bookDemo',
  },
}

PLATFORM_PAGES.certificates = CERTIFICATES_PAGE
