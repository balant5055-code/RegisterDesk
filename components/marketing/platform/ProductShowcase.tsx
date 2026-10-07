// Phase P.2 — the showcase: value highlights beside (or, with no product screenshot,
// instead of) a framed screenshot. Server Component. Never renders a fake screenshot.
//
// 2026-09-23 LUXURY PASS (owner): each highlight is an icon in a bronze-outlined square,
// a title in ink and a line of soft ink. With no screenshot — the case on every solution
// page today — the highlights are one centred row divided by hairlines rather than a
// narrow list with half the page empty beside it.

import { cn } from '@/lib/utils/cn'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { ScreenshotFrame } from '@/components/marketing/screenshots/ScreenshotFrame'
import { getScreenshot, hasScreenshot } from '@/content/marketing/screenshots'
import type { PlatformHighlightItem } from '@/lib/marketing/platform/types'

/** The bronze-outlined icon tile — the public site's one icon container. */
function IconTile({ iconKey }: { iconKey?: PlatformHighlightItem['iconKey'] }) {
  const Icon = iconKey ? MARKETING_ICONS[iconKey] : null
  if (!Icon) return null
  return (
    <span aria-hidden className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-hero-accent-rule/40 bg-card text-hero-accent-rule">
      <Icon className="size-[18px]" strokeWidth={1.5} />
    </span>
  )
}

/** One value highlight, as a row (beside a screenshot) or a centred column (on its own). */
function Highlight({ item, centred }: { item: PlatformHighlightItem; centred?: boolean }) {
  return (
    <li className={cn(centred ? 'flex flex-col items-center px-6 py-6 text-center sm:py-2' : 'flex gap-4')}>
      <IconTile iconKey={item.iconKey} />
      <div className={cn(centred && 'mt-4')}>
        <h3 className="text-fs-md font-medium text-hero-ink">{item.title}</h3>
        <p className="mt-1.5 text-fs-sm leading-relaxed text-hero-ink-soft">{item.description}</p>
      </div>
    </li>
  )
}

export function ProductShowcase({
  screenshotId, highlights,
}: {
  screenshotId: string
  highlights?: PlatformHighlightItem[]
}) {
  const media = hasScreenshot(screenshotId) ? getScreenshot(screenshotId) : undefined
  const hasHighlights = Boolean(highlights && highlights.length > 0)

  if (!media && !hasHighlights) return null

  if (!media) {
    // Up to three across; hairlines between them from sm, between rows on a phone.
    const cols = highlights!.length >= 3 ? 'sm:grid-cols-3' : highlights!.length === 2 ? 'sm:grid-cols-2' : ''
    return (
      <ul className={cn('mx-auto grid max-w-5xl divide-y divide-border/60 sm:divide-x sm:divide-y-0', cols)}>
        {highlights!.map((h, i) => <Highlight key={i} item={h} centred />)}
      </ul>
    )
  }

  if (!hasHighlights) {
    return (
      <div className="mx-auto max-w-5xl">
        <ScreenshotFrame screenshot={media} className="shadow-elevation-1 ring-1 ring-border/70" />
      </div>
    )
  }

  return (
    <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
      <ul className="order-2 space-y-7 lg:order-1">
        {highlights!.map((h, i) => <Highlight key={i} item={h} />)}
      </ul>
      <div className="order-1 lg:order-2">
        <ScreenshotFrame screenshot={media} className="shadow-elevation-1 ring-1 ring-border/70" />
      </div>
    </div>
  )
}
