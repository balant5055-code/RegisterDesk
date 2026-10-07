// Phase P.2 — use cases. Server Component.
//
// 2026-09-23 LUXURY PASS (owner): an editorial index rather than a second grid of cards —
// each entry is numbered in bronze serif ("01") under a hairline, with its title in the
// display face and a line of soft ink. It reads differently from the capability tiles
// above it, which is the point: two sections, two voices.

import type { PlatformUseCaseItem } from '@/lib/marketing/platform/types'

const pad = (n: number) => String(n).padStart(2, '0')

export function UseCases({ items }: { items: PlatformUseCaseItem[] }) {
  return (
    <ol className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item, i) => (
        <li key={i} className="border-t border-border/70 pt-5">
          <span aria-hidden className="font-display text-fs-lg font-light tabular-nums text-hero-accent-rule">
            {pad(i + 1)}
          </span>
          <h3 className="mt-2 font-display text-fs-lg font-normal tracking-[-0.01em] text-hero-ink">{item.title}</h3>
          <p className="mt-2 text-fs-sm leading-relaxed text-hero-ink-soft">{item.description}</p>
        </li>
      ))}
    </ol>
  )
}
