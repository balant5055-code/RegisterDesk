'use client'

// "The Platform" — one connected operating system. Same visual rhythm as the Hero
// and "How it works": Eyebrow → gradient heading → supporting paragraph → a large
// centered product showcase (the focal point, on the Hero's elevation + ambient
// glow) → an Apple-style segmented module switcher. White-first, hairline borders,
// soft shadows, generous whitespace. Data-driven; reuses the shared design system.

import { useState } from 'react'
import { typography } from '@/lib/ds/typography'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import { marketingType } from '@/lib/marketing/theme'
import { GradientText } from '@/components/marketing/GradientText'
import { PlatformSwitcher } from '@/components/marketing/platform-overview/PlatformSwitcher'
import { PlatformPreview } from '@/components/marketing/platform-overview/PlatformPreview'
import { PLATFORM_MODULES, PLATFORM_HEADING } from '@/components/marketing/platform-overview/platform.data'

const PANEL_ID = 'platform-preview'
const TITLE_ACCENT = 'not a pile of tools'
const TITLE_BEFORE = PLATFORM_HEADING.title.split(TITLE_ACCENT)[0]

export function PlatformOverview() {
  const [active, setActive] = useState(PLATFORM_MODULES[0].id)

  return (
    <SectionLayout background="white" labelledBy="platform-heading">
      {/* Heading — same rhythm as Hero / How it works */}
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow>{PLATFORM_HEADING.eyebrow}</Eyebrow>
        <h2 id="platform-heading" className={`mx-auto mt-5 max-w-[720px] text-balance ${marketingType.sectionHeading}`}>
          {PLATFORM_HEADING.title.includes(TITLE_ACCENT) ? (
            <>
              {TITLE_BEFORE}
              <GradientText>{TITLE_ACCENT}</GradientText>
            </>
          ) : (
            PLATFORM_HEADING.title
          )}
        </h2>
        <p className={`${typography.body} mx-auto mt-4 max-w-[640px] text-muted-foreground`}>
          {PLATFORM_HEADING.description}
        </p>
      </div>

      {/* Product showcase — the focal point, on the Hero's elevation + ambient glow */}
      <div className="relative mx-auto mt-12 w-full max-w-5xl">
        <PlatformPreview active={active} panelId={PANEL_ID} labelId="platform-heading" />
      </div>

      {/* Module switcher */}
      <PlatformSwitcher modules={PLATFORM_MODULES} active={active} panelId={PANEL_ID} onActivate={setActive} className="mt-8" />
    </SectionLayout>
  )
}
