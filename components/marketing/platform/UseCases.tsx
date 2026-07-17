// Phase P.2 (product-page) — UseCases. Server Component.
//
// Scenario cards (title + description). Static.

import type { PlatformUseCaseItem } from '@/lib/marketing/platform/types'
import { typography } from '@/lib/ds/typography'
import { cn } from '@/lib/utils/cn'
import { Card } from '@/components/marketing/Card'

export function UseCases({ items }: { items: PlatformUseCaseItem[] }) {
  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item, i) => (
        <li key={i} className="flex">
          <Card className="flex h-full flex-col">
            <h3 className={cn(typography.cardTitle, 'text-foreground')}>{item.title}</h3>
            <p className={`${typography.body} mt-2 text-muted-foreground`}>{item.description}</p>
          </Card>
        </li>
      ))}
    </ul>
  )
}
