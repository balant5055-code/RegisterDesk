// Phase P.2 (UX redesign) — PlatformScreenshot. Server Component.
//
// Large, centered product screenshot on a soft brand backdrop (reuses the shared
// ScreenshotFrame — placeholder until a real capture exists). Static.

import { ScreenshotFrame } from '@/components/marketing/screenshots/ScreenshotFrame'
import { getScreenshot } from '@/content/marketing/screenshots'

export function PlatformScreenshot({ screenshotId }: { screenshotId: string }) {
  const shot = getScreenshot(screenshotId)
  return (
    <div className="relative mx-auto max-w-5xl">
      <div aria-hidden className="pointer-events-none absolute -inset-x-8 -top-10 bottom-0 -z-10 rounded-[2.5rem] bg-gradient-to-b from-primary/[0.06] to-transparent" />
      <ScreenshotFrame screenshot={shot} className="shadow-lg ring-1 ring-border/70" />
    </div>
  )
}
