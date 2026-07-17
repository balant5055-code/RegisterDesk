// Phase P.3 — /terms page. Server Component.

import type { Metadata } from 'next'
import { LegalPage } from '@/components/marketing/legal/LegalPage'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'

export const metadata: Metadata = buildMetadata({
  title:       'Terms of Service | RegisterDesk',
  description: 'The terms that govern your use of the RegisterDesk event operations platform.',
  path:        '/terms',
})

export default function TermsPage() {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Terms of Service', path: '/terms' }]),
  ]
  return (
    <>
    <LegalPage
      title="Terms of Service"
      intro="These terms govern your access to and use of RegisterDesk. By creating an account or using the platform, you agree to them."
      sections={[
        { heading: 'Accounts', body: [
          'You are responsible for keeping your account credentials secure and for activity that happens under your account.',
        ] },
        { heading: 'Acceptable use', body: [
          'You agree not to use RegisterDesk for unlawful, fraudulent, or abusive activity, or in a way that interferes with the platform or other users.',
        ] },
        { heading: 'Organizer responsibilities', body: [
          'As an organizer, you are responsible for the accuracy of your event information, for complying with applicable laws, and for handling your attendees’ data and refunds in line with your own published terms.',
        ] },
        { heading: 'Plans, fees, and payments', body: [
          'Paid plans and transaction fees apply as described on our pricing page. Fees may be exclusive of taxes, which you are responsible for where applicable. Payments are processed through our payment provider.',
        ] },
        { heading: 'Intellectual property', body: [
          'RegisterDesk and the platform are owned by us. You retain ownership of the content and data you upload, and you grant us the rights needed to operate the service for you.',
        ] },
        { heading: 'Service availability', body: [
          'The platform is provided on an “as is” and “as available” basis. We work to keep it reliable but do not guarantee uninterrupted or error-free service.',
        ] },
        { heading: 'Limitation of liability', body: [
          'To the maximum extent permitted by law, RegisterDesk is not liable for indirect, incidental, or consequential damages arising from your use of the platform.',
        ] },
        { heading: 'Termination', body: [
          'You may stop using the platform at any time. We may suspend or terminate access for violations of these terms.',
        ] },
        { heading: 'Changes', body: [
          'We may update these terms. Continued use of the platform after an update means you accept the revised terms.',
        ] },
        { heading: 'Contact', body: [
          'For questions about these terms, reach us through our contact page.',
        ] },
      ]}
    />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
