// Phase P.2 (product-page) — CapabilityGrid. Server Component.
//
// Premium, equal-height capability cards. Titles are <h3>. Static.

import { cn } from '@/lib/utils/cn'
import { typography } from '@/lib/ds/typography'
import { Card } from '@/components/marketing/Card'
import { IconChip } from '@/components/marketing/IconChip'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import type { PlatformCapabilityItem } from '@/lib/marketing/platform/types'

export function CapabilityGrid({ items }: { items: PlatformCapabilityItem[] }) {
  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item, i) => {
        const Icon = MARKETING_ICONS[item.iconKey]
        return (
          <li key={i} className="flex">
            <Card className="flex h-full flex-col">
              <IconChip className="size-11">
                <Icon className="size-5 text-primary" aria-hidden />
              </IconChip>
              <h3 className={cn('mt-5 text-foreground', typography.cardTitle)}>{item.title}</h3>
              <p className={cn('mt-2 text-muted-foreground', typography.body)}>{item.description}</p>
            </Card>
          </li>
        )
      })}
    </ul>
  )
}
