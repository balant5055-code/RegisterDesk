// Phase P.2 (product-page) — FeatureHighlights. Server Component.
//
// A small set of standout capabilities, presented larger in a 2-column layout.
// Titles are <h3>. Static.

import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { typography } from '@/lib/ds/typography'
import type { PlatformHighlightItem } from '@/lib/marketing/platform/types'

export function FeatureHighlights({ items }: { items: PlatformHighlightItem[] }) {
  return (
    <ul className="mx-auto grid max-w-4xl gap-x-10 gap-y-10 sm:grid-cols-2">
      {items.map((item, i) => {
        const Icon = item.iconKey ? MARKETING_ICONS[item.iconKey] : null
        return (
          <li key={i}>
            {Icon && (
              <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-inset ring-primary/20">
                <Icon className="size-6 text-primary" aria-hidden />
              </span>
            )}
            <h3 className="mt-4 text-[16px] font-semibold text-foreground">{item.title}</h3>
            <p className={`${typography.body} mt-2 text-muted-foreground`}>{item.description}</p>
          </li>
        )
      })}
    </ul>
  )
}
