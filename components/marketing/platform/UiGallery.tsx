// Phase P.2 (product-page) — UiGallery. Server Component.
//
// A small grid of product screenshots (placeholders until real captures exist).
// Static.

import { ScreenshotFrame } from '@/components/marketing/screenshots/ScreenshotFrame'
import { getScreenshot } from '@/content/marketing/screenshots'

export function UiGallery({ screenshotIds }: { screenshotIds: string[] }) {
  return (
    <div className="mx-auto grid max-w-5xl gap-6 sm:grid-cols-2">
      {screenshotIds.map((id, i) => (
        <ScreenshotFrame key={i} screenshot={getScreenshot(id)} className="shadow-lg ring-1 ring-border/70" />
      ))}
    </div>
  )
}
