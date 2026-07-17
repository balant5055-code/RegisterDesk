// Phase P.3 — /privacy page. Server Component.

import type { Metadata } from 'next'
import { LegalPage } from '@/components/marketing/legal/LegalPage'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'

export const metadata: Metadata = buildMetadata({
  title:       'Privacy Policy | RegisterDesk',
  description: 'How RegisterDesk collects, uses, and protects personal data for organizers and attendees.',
  path:        '/privacy',
})

export default function PrivacyPage() {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Privacy Policy', path: '/privacy' }]),
  ]
  return (
    <>
    <LegalPage
      title="Privacy Policy"
      intro="This policy explains what information RegisterDesk collects, how we use it, and the choices you have. It applies to organizers who use the platform and to attendees who register through events run on it."
      sections={[
        { heading: 'Information we collect', body: [
          'Account information you provide when you sign up, such as your name and email address.',
          'Event and registration data that organizers configure and that attendees submit through registration forms, including the custom fields an organizer chooses to collect.',
          'Payment-related information needed to process transactions, and usage information generated as you use the platform.',
        ] },
        { heading: 'How we use information', body: [
          'To provide and operate the platform, process registrations and payments, send transactional emails such as confirmations and certificates, and provide support.',
          'Organizers are responsible for how they use the participant data they collect through their events.',
        ] },
        { heading: 'Payments', body: [
          'Payments are processed by Razorpay. Card and bank details are handled by the payment provider and are never stored on RegisterDesk.',
        ] },
        { heading: 'How we share information', body: [
          'We share data with service providers that help us run the platform, such as our payment gateway, email delivery, and cloud infrastructure, and where required by law.',
          'We do not sell personal data.',
        ] },
        { heading: 'Storage and security', body: [
          'Data is held on managed, replicated cloud infrastructure. Each organizer’s data is scoped to their own workspace and each event is isolated, and access is governed by role-based permissions.',
          'No method of transmission or storage is completely secure, but we take reasonable measures to protect your information.',
        ] },
        { heading: 'Your choices', body: [
          'You can access, correct, or export your data, and request deletion of your account. Attendees should contact the organizer of an event for data they submitted to that organizer.',
        ] },
        { heading: 'Data retention', body: [
          'We retain information for as long as needed to provide the service and to meet legal, accounting, and reporting obligations.',
        ] },
        { heading: 'Contact', body: [
          'For privacy questions, reach us through our contact page.',
        ] },
      ]}
    />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
