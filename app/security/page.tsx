// Phase P.3 — /security trust page. Server Component (zero client JS).
//
// THE canonical security page. /platform/security used to render a second one — same
// <title>, same hero eyebrow, same screenshot, six of eight capability cards restating
// these — and now 307s here. Its one salvageable card arrived as "Managed infrastructure",
// with the replication claim nobody could verify stripped out on the way.
//
// Reads ONLY from the security registry (SECURITY_CAPABILITIES / SECURITY_FUTURE). Reuses
// the platform hero/section/capability/CTA components. Every claim maps to a real control —
// no compliance or certification claims.
//
// ═══ TWO SECTIONS, AND THE DIFFERENCE MUST SURVIVE ═══════════════════════════
// "Real controls, built in today" and "On our security roadmap" carry different promises,
// and the roadmap section used to render cards visually identical to the shipped ones —
// SSO, 2FA, SCIM, enterprise compliance and BYOK all looked available. The distinction now
// rides on `status`, carried through toItems() into CapabilityGrid, which prints the words
// "Coming soon" rather than relying on a tint. It reads the same on a phone, in the
// accessibility tree, and in a screenshot of a single card.
//
// ═══ NO SoftwareApplication JSON-LD, DELIBERATELY ════════════════════════════
// /platform/security emitted softwareAppJsonLd() — a whole-product entity with a
// price-0 Offer, keyed to the SITE url, not to anything on that page. It was not carried
// over. This is a company trust page, not a product listing; the nine remaining platform
// pages still carry that schema where it belongs, and duplicating it here would add a
// second product entity for no gain.
//
// (Written without the glob spelling of that path on purpose: a slash-star inside a line
// comment opens a block comment as far as every naive comment-stripper is concerned, and
// several source-reading tests here use one. It silently ate this file's import block.)

import type { Metadata } from 'next'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { PlatformHero, PlatformSection, CapabilityGrid, PlatformCTA } from '@/components/marketing/platform'
import { SECURITY_CAPABILITIES, SECURITY_FUTURE } from '@/content/marketing/security'
import type { PlatformCapabilityItem } from '@/lib/marketing/platform/types'
import type { SecurityCapabilityDef } from '@/lib/marketing/types'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'

/**
 * The registry → renderer projection. It used to map exactly three fields, which silently
 * discarded `status` — so the five SECURITY_FUTURE items rendered as cards identical to the
 * nine shipped controls, on the one page where that confusion matters most. The status now
 * survives the projection, and only 'coming_soon' is forwarded: 'available' is the default
 * the renderer already assumes, and 'beta' has no member today, so inventing a treatment
 * for it here would be a badge nothing can produce.
 */
const toItems = (rows: SecurityCapabilityDef[]): PlatformCapabilityItem[] =>
  rows.map(r => ({
    iconKey:     r.iconKey,
    title:       r.title,
    description: r.description,
    ...(r.status === 'coming_soon' ? { status: 'coming_soon' as const } : {}),
  }))

export const metadata: Metadata = buildMetadata({
  title:       'Security & Trust | RegisterDesk',
  description: 'How RegisterDesk protects your operations and your attendees’ data — workspace isolation, role-based access, audit history, data ownership, and secure payments.',
  path:        '/security',
})

export default function SecurityPage() {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Security', path: '/security' }]),
  ]

  return (
    <>
      <MarketingPageLayout>
        <PlatformHero
          hero={{
            eyebrow:      'Security & Trust',
            headline:     'Built so you can trust RegisterDesk with your events',
            subheadline:  'Every claim below maps to a real capability — access control, isolation, audit history, and secure payments — protecting your operations and your attendees’ data.',
            primaryCta:   'startFree',
            secondaryCta: 'bookDemo',
            screenshotId: 'security-center',
          }}
        />

        <PlatformSection id="controls" eyebrow="Controls" title="Real controls, built in today" subtitle="Everything below is shipped." background="muted">
          <CapabilityGrid items={toItems(SECURITY_CAPABILITIES)} />
        </PlatformSection>

        <PlatformSection id="roadmap" eyebrow="Future-ready" title="On our security roadmap" subtitle="Planned — not available yet, and we never present roadmap items as shipped." background="white">
          <CapabilityGrid items={toItems(SECURITY_FUTURE)} />
        </PlatformSection>

        <PlatformCTA
          cta={{
            headline:     'Run events on a platform you can trust.',
            subheadline:  'Start free with security and access control built in.',
            primaryCta:   'startFree',
            secondaryCta: 'bookDemo',
          }}
        />
      </MarketingPageLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
