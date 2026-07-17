// Phase P.3 — /about page. Server Component (zero client JS).
//
// Honest company page — mission + what we do. No fabricated team, stats, history,
// or funding. Reuses the platform hero/section/capability/CTA components. The IA
// (navbar/footer) links here at /about.

import type { Metadata } from 'next'
import { typography } from '@/lib/ds/typography'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { PlatformHero, PlatformSection, CapabilityGrid, PlatformCTA } from '@/components/marketing/platform'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'

export const metadata: Metadata = buildMetadata({
  title:       'About | RegisterDesk',
  description: 'RegisterDesk is the event operations platform — one connected system for registration, payments, identifiers, check-in, certificates, and settlements.',
  path:        '/about',
})

export default function AboutPage() {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'About', path: '/about' }]),
  ]

  return (
    <>
      <MarketingPageLayout>
        <PlatformHero
          hero={{
            eyebrow:      'About',
            headline:     'One platform for the whole event operation',
            subheadline:  'RegisterDesk replaces the patchwork of tools event teams stitch together with a single, connected platform — from the first registration to the final payout.',
            primaryCta:   'startFree',
            secondaryCta: 'bookDemo',
          }}
        />

        <PlatformSection id="mission" eyebrow="Why we built it" title="Events deserve one connected system" subtitle="Not a registration form bolted to a spreadsheet bolted to a payment tool." background="muted">
          <div className={`${typography.body} mx-auto max-w-2xl space-y-4 text-center text-muted-foreground`}>
            <p>Most teams run events by stitching together a registration form, a payment tool, a spreadsheet, and a check-in app — re-keying the same data at every step and hoping nothing falls through the cracks.</p>
            <p>RegisterDesk replaces that with one platform where every capability shares the same data: registrations flow into participants, participants carry identifiers, identifiers drive check-in, and every payment is tracked through to payout — with nothing to export or reconcile by hand.</p>
          </div>
        </PlatformSection>

        <PlatformSection id="what-we-do" eyebrow="What we do" title="The event operations platform" subtitle="Everything an organizer needs, in one place." background="white">
          <CapabilityGrid
            items={[
              { iconKey: 'workspace', title: 'One platform',          description: 'Registration, payments, identifiers, check-in, certificates, and settlements together.' },
              { iconKey: 'fast',      title: 'Built for operations',  description: 'Purpose-built workspaces for the day of the event.' },
              { iconKey: 'security',  title: 'Secure & reliable',     description: 'Role-based access, audit history, and workspace isolation.' },
              { iconKey: 'crm',       title: 'For every organizer',   description: 'Sports, conferences, schools, corporate, NGOs, and communities.' },
            ]}
          />
        </PlatformSection>

        <PlatformCTA
          cta={{
            headline:     'Run your next event on RegisterDesk.',
            subheadline:  'Start free — no credit card required.',
            primaryCta:   'startFree',
            secondaryCta: 'bookDemo',
          }}
        />
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
