// Attendee Journey — the real attendee lifecycle as a premium product gallery
// (visual redesign only; copy, routes, screenshots, functionality unchanged).
// A strict, uniform 4-column grid: every card has the exact same structure —
// a fixed-height BrowserFrame screenshot, a step badge, title, description, and a
// bottom-aligned "Learn more". No zig-zag, no offsets, no uneven heights. Same
// header rhythm + visual language as Hero / Platform / Organizer Workspace.
// Server Component (zero client JS); hover is pure CSS. Reuses BrowserFrame ·
// Eyebrow · GradientText · the shadow/border/radius/typography tokens.

import Image from 'next/image'
import { typography } from '@/lib/ds/typography'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import { marketingType } from '@/lib/marketing/theme'
import { GradientText } from '@/components/marketing/GradientText'
import { BrowserFrame } from '@/components/marketing/product/BrowserFrame'
import { getScreenshot } from '@/content/marketing/screenshots'
import { PARTICIPANT_STEPS, PARTICIPANT_HEADING } from '@/content/marketing/participant-experience'
import type { ParticipantStepDef } from '@/lib/marketing/types'

const TITLE_ACCENT = 'sign-up to certificate'
const TITLE_BEFORE = PARTICIPANT_HEADING.title.split(TITLE_ACCENT)[0]
const FRAME_URL = 'registerdesk.in'

// A single, uniform screenshot surface: identical browser chrome + a fixed 16:10
// area, so every card is exactly the same height (skeleton until a real capture
// exists — never a fake screenshot).
function StepShot({ step }: { step: ParticipantStepDef }) {
  const shot = getScreenshot(step.screenshotId)
  const available = shot?.status === 'available' && !!shot.imagePath
  return (
    <BrowserFrame url={FRAME_URL} className="transition-transform duration-[220ms] group-hover:scale-[1.01]">
      <div className="aspect-[16/10] w-full overflow-hidden bg-gradient-to-br from-muted to-muted/40">
        {available && shot ? (
          <Image
            src={shot.imagePath as string}
            alt={shot.alt || ''}
            width={shot.width ?? 2400}
            height={shot.height ?? 1500}
            className="size-full object-cover object-top"
          />
        ) : (
          <div className="size-full animate-pulse" aria-hidden />
        )}
      </div>
    </BrowserFrame>
  )
}

function StepCard({ step, index }: { step: ParticipantStepDef; index: number }) {
  const Icon = MARKETING_ICONS[step.iconKey]
  return (
    <li className="flex">
      <Link
        href={step.href}
        className="group flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-white shadow-sm transition-all duration-[220ms] hover:-translate-y-0.5 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {/* Screenshot — uniform height across every card */}
        <div className="p-3">
          <StepShot step={step} />
        </div>

        {/* Body — identical structure; link pinned to the bottom for alignment */}
        <div className="flex flex-1 flex-col px-5 pb-5">
          <span className="inline-flex items-center gap-2 self-start rounded-full border border-border/60 bg-white px-2.5 py-1 shadow-sm">
            <Icon className="size-4 text-primary" strokeWidth={1.8} aria-hidden />
            <span className="text-[var(--fs-xs)] font-semibold text-foreground">Step {index + 1}</span>
          </span>
          <h3 className="mt-3 text-[16px] font-semibold text-foreground">{step.title}</h3>
          <p className={`${typography.body} mt-2 line-clamp-2 text-muted-foreground`}>{step.description}</p>
          <span className="mt-auto inline-flex items-center gap-1 self-start pt-4 text-[var(--fs-base)] font-semibold text-primary">
            Learn more <ArrowRight className="size-3.5 transition-transform duration-[220ms] group-hover:translate-x-0.5" aria-hidden />
          </span>
        </div>
      </Link>
    </li>
  )
}

export function ParticipantExperience() {
  return (
    <SectionLayout background="white" labelledBy="participant-heading">
      {/* Header — same rhythm as the other sections */}
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow>{PARTICIPANT_HEADING.eyebrow}</Eyebrow>
        <h2 id="participant-heading" className={`mx-auto mt-5 max-w-[720px] text-balance ${marketingType.sectionHeading}`}>
          {PARTICIPANT_HEADING.title.includes(TITLE_ACCENT) ? (
            <>
              {TITLE_BEFORE}
              <GradientText>{TITLE_ACCENT}</GradientText>
            </>
          ) : (
            PARTICIPANT_HEADING.title
          )}
        </h2>
        <p className={`${typography.body} mx-auto mt-4 max-w-[640px] text-muted-foreground`}>
          {PARTICIPANT_HEADING.subtitle}
        </p>
      </div>

      {/* Product gallery — clean, uniform 4 / 2 / 1 grid */}
      <ul className="mx-auto mt-12 grid max-w-6xl grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {PARTICIPANT_STEPS.map((step, i) => (
          <StepCard key={step.id} step={step} index={i} />
        ))}
      </ul>
    </SectionLayout>
  )
}
