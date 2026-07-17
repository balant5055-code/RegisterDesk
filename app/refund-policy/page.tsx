// Phase P.3 — /refund-policy page. Server Component.

import type { Metadata } from 'next'
import { LegalPage } from '@/components/marketing/legal/LegalPage'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'

export const metadata: Metadata = buildMetadata({
  title:       'Refund Policy | RegisterDesk',
  description: 'How refunds work on RegisterDesk for event registrations, donations, and event licenses.',
  path:        '/refund-policy',
})

export default function RefundPolicyPage() {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Refund Policy', path: '/refund-policy' }]),
  ]
  return (
    <>
    <LegalPage
      title="Refund Policy"
      intro="This policy explains how refunds work on RegisterDesk. Refunds for event registrations and donations are set and issued by the organizer of the event; event license fees are handled by RegisterDesk."
      sections={[
        { heading: 'Event registrations and tickets', body: [
          'Each organizer sets their own refund terms for their event. If you registered for an event, please review that event’s terms and contact the organizer for refund requests.',
          'Organizers can issue full or partial refunds to attendees directly from their dashboard.',
        ] },
        { heading: 'Donations', body: [
          'Refunds for donations are at the organizer’s discretion and are processed through the platform when an organizer chooses to issue them.',
        ] },
        { heading: 'Event licenses', body: [
          'RegisterDesk uses one-time event licenses — one license per event, with no subscriptions or recurring billing. A paid license fee is charged once, before the event is published. Once a license has been used to publish an event, the fee is non-refundable except where required by law.',
        ] },
        { heading: 'Transaction fees', body: [
          'Transaction fees on completed payments are generally non-refundable, even where the underlying registration or donation is refunded.',
        ] },
        { heading: 'How to request a refund', body: [
          'Attendees and donors should contact the organizer of the relevant event. Organizers with questions about event license billing can reach us through our contact page.',
        ] },
      ]}
    />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
