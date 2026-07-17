// Organizer Workspace — a premium workspace gallery (visual redesign only).
// Same header rhythm as Hero / How it works / Platform (Eyebrow + gradient
// heading). Each workspace is a screenshot-led product tile: a large browser-
// framed preview on top, a compact icon · title · description · link below.
// White-first, hairline borders, soft shadows, subtle CSS hover (no client JS).
// Content/data/routes unchanged. Reuses ScreenshotFrame + Eyebrow + GradientText.

import Link from 'next/link'
import { typography } from '@/lib/ds/typography'
import { ArrowRight } from 'lucide-react'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { SectionLayout } from '@/components/marketing/layout/SectionLayout'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import { marketingType } from '@/lib/marketing/theme'
import { GradientText } from '@/components/marketing/GradientText'
import { ScreenshotFrame } from '@/components/marketing/screenshots/ScreenshotFrame'
import { getScreenshot } from '@/content/marketing/screenshots'
import { ORGANIZER_WORKSPACES, ORGANIZER_WORKSPACE_HEADING } from '@/content/marketing/organizer-workspace'
import type { WorkspaceItemDef } from '@/lib/marketing/types'

const TITLE_ACCENT = 'one operating system'
const TITLE_BEFORE = ORGANIZER_WORKSPACE_HEADING.title.split(TITLE_ACCENT)[0]

function WorkspaceCard({ item }: { item: WorkspaceItemDef }) {
  const Icon = MARKETING_ICONS[item.iconKey]
  const shot = getScreenshot(item.screenshotId)
  return (
    <Link
      href={item.href}
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-white shadow-sm transition-all duration-[220ms] hover:-translate-y-0.5 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {/* Screenshot — the hero of the tile */}
      <div className="overflow-hidden p-3">
        <ScreenshotFrame screenshot={shot} className="shadow-sm transition-transform duration-[220ms] group-hover:scale-[1.01]" />
      </div>

      {/* Details */}
      <div className="flex flex-1 flex-col px-5 pb-5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-white shadow-sm">
            <Icon className="size-5 text-primary" strokeWidth={1.8} aria-hidden />
          </span>
          <h3 className="text-[16px] font-semibold text-foreground">{item.title}</h3>
        </div>
        <p className={`${typography.body} mt-2 line-clamp-2 text-muted-foreground`}>{item.description}</p>
        <span className="mt-3 inline-flex items-center gap-1 text-[var(--fs-base)] font-semibold text-primary">
          Open {item.title} <ArrowRight className="size-3.5 transition-transform duration-[220ms] group-hover:translate-x-0.5" aria-hidden />
        </span>
      </div>
    </Link>
  )
}

export function OrganizerWorkspace() {
  return (
    <SectionLayout background="white" labelledBy="workspace-heading">
      {/* Header — same rhythm as the other sections */}
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow>{ORGANIZER_WORKSPACE_HEADING.eyebrow}</Eyebrow>
        <h2 id="workspace-heading" className={`mx-auto mt-5 max-w-[720px] text-balance ${marketingType.sectionHeading}`}>
          {ORGANIZER_WORKSPACE_HEADING.title.includes(TITLE_ACCENT) ? (
            <>
              {TITLE_BEFORE}
              <GradientText>{TITLE_ACCENT}</GradientText>
            </>
          ) : (
            ORGANIZER_WORKSPACE_HEADING.title
          )}
        </h2>
        <p className={`${typography.body} mx-auto mt-4 max-w-[640px] text-muted-foreground`}>
          {ORGANIZER_WORKSPACE_HEADING.subtitle}
        </p>
      </div>

      {/* Workspace gallery */}
      <ul className="mx-auto mt-12 grid max-w-6xl gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {ORGANIZER_WORKSPACES.map(item => (
          <li key={item.id} className="flex">
            <WorkspaceCard item={item} />
          </li>
        ))}
      </ul>
    </SectionLayout>
  )
}
