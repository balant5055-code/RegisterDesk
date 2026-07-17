// Phase P.1.6.12 — Homepage section registry (composition only, no business logic).
//
// The single ordered source of truth for the homepage. The page iterates this
// list and renders each section — ordering is NEVER hardcoded in the page. Every
// section is an existing reusable marketing component (no duplication). The
// navbar and footer are provided by MarketingPageLayout, not listed here.

import type { ComponentType } from 'react'
import { Hero } from '@/components/marketing/hero/Hero'
import { Journey } from '@/components/marketing/sections/Journey'
import { PlatformOverview } from '@/components/marketing/sections/PlatformOverview'
import { OrganizerWorkspace } from '@/components/marketing/sections/OrganizerWorkspace'
import { ParticipantExperience } from '@/components/marketing/sections/ParticipantExperience'
import { WhyRegisterDesk } from '@/components/marketing/sections/WhyRegisterDesk'
import { IntegrationsSection } from '@/components/marketing/sections/IntegrationsSection'
import { SecuritySection } from '@/components/marketing/sections/SecuritySection'
import { FAQSection } from '@/components/marketing/sections/FAQSection'

export interface HomepageSection {
  id:        string
  Component: ComponentType
}

export const HOMEPAGE_SECTIONS: HomepageSection[] = [
  { id: 'hero',                  Component: Hero },
  { id: 'journey',               Component: Journey },
  { id: 'platform',              Component: PlatformOverview },
  { id: 'organizerWorkspace',    Component: OrganizerWorkspace },
  { id: 'participantExperience', Component: ParticipantExperience },
  { id: 'whyRegisterDesk',       Component: WhyRegisterDesk },
  { id: 'integrations',          Component: IntegrationsSection },
  { id: 'security',              Component: SecuritySection },
  { id: 'faq',                   Component: FAQSection },
]
