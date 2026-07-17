// Phase P.2 (product-page) — IntegrationsBlock. Server Component.
//
// Page-specific integration points (icon + title + description). No fake logos.
// Static.

import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { typography } from '@/lib/ds/typography'
import { cn } from '@/lib/utils/cn'
import { Card } from '@/components/marketing/Card'
import { IconChip } from '@/components/marketing/IconChip'
import type { PlatformIntegrationItem } from '@/lib/marketing/platform/types'

export function IntegrationsBlock({ items }: { items: PlatformIntegrationItem[] }) {
  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item, i) => {
        const Icon = MARKETING_ICONS[item.iconKey]
        return (
          <li key={i} className="flex">
            <Card className="flex h-full items-start gap-3">
              <IconChip className="size-10 shrink-0">
                <Icon className="size-5 text-primary" aria-hidden />
              </IconChip>
              <div>
                <h3 className={cn(typography.cardTitle, 'text-foreground')}>{item.title}</h3>
                <p className={`${typography.body} mt-1 text-muted-foreground`}>{item.description}</p>
              </div>
            </Card>
          </li>
        )
      })}
    </ul>
  )
}
