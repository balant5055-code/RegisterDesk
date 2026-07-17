// Why RegisterDesk — a premium "why we exist" benefits grid (visual refinement
// only; content, routes, and IA unchanged). Same header rhythm + visual language
// as the rest of the homepage: Eyebrow + gradient heading, then light, breathing
// feature panels in a uniform 3 / 2 / 1 grid. White-first, hairline borders, soft
// shadows, generous whitespace. Server Component (zero client JS); hover is pure
// CSS. Reuses Eyebrow · GradientText · the shadow/border/radius/typography tokens.

import Link from 'next/link'
import { typography } from '@/lib/ds/typography'
import { ArrowRight } from 'lucide-react'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import { marketingType } from '@/lib/marketing/theme'
import { GradientText } from '@/components/marketing/GradientText'
import { WHY_PILLARS, WHY_HEADING } from '@/content/marketing/why-registerdesk'
import type { WhyPillarDef } from '@/lib/marketing/types'

const TITLE_ACCENT = 'how events actually run'
const TITLE_BEFORE = WHY_HEADING.title.split(TITLE_ACCENT)[0]

function PillarCard({ pillar }: { pillar: WhyPillarDef }) {
  const Icon = MARKETING_ICONS[pillar.iconKey]
  return (
    <li className="flex">
      <Link
        href={pillar.href}
        className="group flex h-full w-full flex-col rounded-2xl border border-border/60 bg-white p-8 shadow-sm transition-all duration-[220ms] hover:-translate-y-0.5 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {/* Icon — soft brand surface, subtle border, no heavy background */}
        <span className="flex size-[52px] shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/[0.08] transition-transform duration-[220ms] group-hover:rotate-2">
          <Icon className="size-6 text-primary" strokeWidth={1.8} aria-hidden />
        </span>

        <h3 className="mt-6 text-[16px] font-semibold leading-snug text-foreground">{pillar.title}</h3>
        <p className={`${typography.body} mt-2 text-muted-foreground`}>{pillar.description}</p>
        <span className="mt-auto inline-flex items-center gap-1.5 self-start pt-6 text-[var(--fs-base)] font-semibold text-primary">
          Learn more <ArrowRight className="size-4 transition-transform duration-[220ms] group-hover:translate-x-1" aria-hidden />
        </span>
      </Link>
    </li>
  )
}

export function WhyRegisterDesk() {
  return (
    <SectionLayout background="white" labelledBy="why-heading">
      {/* Header — same rhythm as the other sections */}
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow>{WHY_HEADING.eyebrow}</Eyebrow>
        <h2 id="why-heading" className={`mx-auto mt-5 max-w-[720px] text-balance ${marketingType.sectionHeading}`}>
          {WHY_HEADING.title.includes(TITLE_ACCENT) ? (
            <>
              {TITLE_BEFORE}
              <GradientText>{TITLE_ACCENT}</GradientText>
            </>
          ) : (
            WHY_HEADING.title
          )}
        </h2>
        <p className={`${typography.body} mx-auto mt-4 max-w-[640px] text-muted-foreground`}>
          {WHY_HEADING.subtitle}
        </p>
      </div>

      {/* Benefits grid — uniform, breathing panels */}
      <ul className="mx-auto mt-12 grid max-w-6xl gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {WHY_PILLARS.map(pillar => (
          <PillarCard key={pillar.id} pillar={pillar} />
        ))}
      </ul>
    </SectionLayout>
  )
}
