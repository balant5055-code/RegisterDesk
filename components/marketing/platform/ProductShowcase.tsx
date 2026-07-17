// Phase P.2 (product-page) — ProductShowcase. Server Component.
//
// Large product showcase: a prominent screenshot on a soft brand backdrop, with
// optional value highlights beside it. Reuses the shared ScreenshotFrame
// (placeholder until a real capture exists). Static, no client JS.

import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { typography } from '@/lib/ds/typography'
import { ScreenshotFrame } from '@/components/marketing/screenshots/ScreenshotFrame'
import { getScreenshot } from '@/content/marketing/screenshots'
import type { PlatformHighlightItem } from '@/lib/marketing/platform/types'

export function ProductShowcase({ screenshotId, highlights }: { screenshotId: string; highlights?: PlatformHighlightItem[] }) {
  const shot = getScreenshot(screenshotId)

  if (!highlights || highlights.length === 0) {
    return (
      <div className="relative mx-auto max-w-5xl">
        <div aria-hidden className="pointer-events-none absolute -inset-x-8 -top-10 bottom-0 -z-10 rounded-[2.5rem] bg-gradient-to-b from-primary/[0.06] to-transparent" />
        <ScreenshotFrame screenshot={shot} className="shadow-lg ring-1 ring-border/70" />
      </div>
    )
  }

  return (
    <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
      <ul className="order-2 space-y-6 lg:order-1">
        {highlights.map((h, i) => {
          const Icon = h.iconKey ? MARKETING_ICONS[h.iconKey] : null
          return (
            <li key={i} className="flex gap-4">
              {Icon && (
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-inset ring-primary/20">
                  <Icon className="size-5 text-primary" aria-hidden />
                </span>
              )}
              <div>
                <h3 className="text-[16px] font-semibold text-foreground">{h.title}</h3>
                <p className={`${typography.body} mt-1.5 text-muted-foreground`}>{h.description}</p>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="relative order-1 lg:order-2">
        <div aria-hidden className="pointer-events-none absolute -inset-x-6 -top-8 bottom-0 -z-10 rounded-[2.5rem] bg-gradient-to-b from-primary/[0.06] to-transparent" />
        <ScreenshotFrame screenshot={shot} className="shadow-lg ring-1 ring-border/70" />
      </div>
    </div>
  )
}
