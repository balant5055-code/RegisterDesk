// Phase P.2 — the capability grid. Server Component.
//
// 2026-09-23 LUXURY PASS (owner): hairline-framed tiles with no shadow, the icon in a
// bronze-outlined square, the title in ink and the description in soft ink. A capability
// that is not live yet keeps the same tile (the grid never breaks rhythm) with a muted
// icon and a small-caps "Coming soon" note.

import { cn } from '@/lib/utils/cn'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import type { PlatformCapabilityItem } from '@/lib/marketing/platform/types'

export function CapabilityGrid({ items }: { items: PlatformCapabilityItem[] }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
      {items.map((item, i) => {
        const Icon = MARKETING_ICONS[item.iconKey]
        const soon = item.status === 'coming_soon'
        return (
          <li key={i} className="flex">
            {/* Icon beside the text on a phone (compact), above it from sm (a tile). */}
            <div className="flex h-full w-full gap-4 rounded-lg border border-border/70 bg-card p-5 transition-colors duration-200 hover:border-border-strong sm:flex-col sm:gap-0 sm:p-6">
              <span
                aria-hidden
                className={cn(
                  'inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] border bg-card',
                  soon ? 'border-border text-muted-foreground' : 'border-hero-accent-rule/40 text-hero-accent-rule',
                )}
              >
                <Icon className="size-[18px]" strokeWidth={1.5} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 sm:mt-5">
                  <h3 className={cn('font-display text-fs-lg font-normal tracking-[-0.01em]', soon ? 'text-hero-ink-soft' : 'text-hero-ink')}>
                    {item.title}
                  </h3>
                  {soon && (
                    <span className="text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-eyebrow">
                      Coming soon
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-fs-sm leading-relaxed text-hero-ink-soft sm:mt-2">{item.description}</p>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
