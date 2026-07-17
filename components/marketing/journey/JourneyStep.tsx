// Marketing journey kit — JourneyStep. One node in the operating flow: an icon
// badge + title + short description, linking into the real module (registry
// href). Two orientations so the same step reads as a horizontal flow on desktop
// and a vertical journey on mobile. Server component; subtle CSS hover only.

import Link from 'next/link'
import { typography } from '@/lib/ds/typography'
import { cn } from '@/lib/utils/cn'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { TimelineBadge } from './TimelineBadge'
import type { JourneyStepDef } from '@/lib/marketing/types'

export function JourneyStep({ step, orientation }: { step: JourneyStepDef; orientation: 'horizontal' | 'vertical' }) {
  const Icon = MARKETING_ICONS[step.iconKey]
  const focus = 'rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2'

  if (orientation === 'horizontal') {
    return (
      <Link href={step.href} className={cn('group relative z-10 flex flex-col items-center px-1 text-center', focus)}>
        <TimelineBadge icon={Icon} />
        <h3 className="mt-4 whitespace-nowrap text-[16px] font-semibold leading-[1.3] text-foreground transition-colors group-hover:text-primary">{step.title}</h3>
        <p className={cn(typography.body, 'mt-1.5 line-clamp-2 text-muted-foreground leading-[1.6]')}>{step.description}</p>
      </Link>
    )
  }

  return (
    <Link href={step.href} className={cn('group flex items-start gap-4', focus)}>
      <TimelineBadge icon={Icon} />
      <div className="min-w-0 pt-1.5">
        <h3 className="whitespace-nowrap text-[16px] font-semibold leading-[1.3] text-foreground transition-colors group-hover:text-primary">{step.title}</h3>
        <p className={cn(typography.body, 'mt-1 line-clamp-2 text-muted-foreground leading-[1.6]')}>{step.description}</p>
      </div>
    </Link>
  )
}
