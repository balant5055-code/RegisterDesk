'use client'

// ExperienceSection — "What Awaits You". Data-driven editorial grid of what an
// attendee receives. Consumes the shared framework primitives (RD-POLISH-02).

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { ExperienceItem } from '@/components/wizard/eventDetailsConfig'
import {
  SectionShell, SectionHeader, CARD, CARD_HOVER, reveal, hoverLift, renderIcon,
} from '@/components/event-templates/shared/ui/framework'

const HEX = /^#[0-9a-f]{6}$/i

// Column classes scale with the item count (never an awkward single-item row).
function gridClasses(n: number): string {
  if (n <= 1) return 'mx-auto max-w-sm grid-cols-1'
  if (n === 2) return 'mx-auto max-w-3xl grid-cols-1 sm:grid-cols-2'
  return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
}

// ─── Card ────────────────────────────────────────────────────────────────────────
// `grouped` controls only the heading level so the document outline stays correct:
// grouped → section h2 › group h3 › card h4; ungrouped → section h2 › card h3.
function ExperienceCard({ item, reduce, grouped }: { item: ExperienceItem; reduce: boolean | null; grouped: boolean }) {
  const hasImg = !!item.image?.trim()
  const iconEl = hasImg ? null : renderIcon(item.icon, 'size-5 transition-transform duration-150 group-hover:scale-110 motion-reduce:transform-none')
  const badge  = item.badge?.trim() || item.highlight?.trim() || ''
  const link   = item.link?.trim()
  const tint   = item.themeColor && HEX.test(item.themeColor) ? item.themeColor : ''

  const inner = (
    <>
      {badge && (
        <span className="absolute right-3 top-3 z-10 rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-bold text-primary">{badge}</span>
      )}

      {hasImg && (
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.image} alt="" loading="lazy" decoding="async"
            className="h-full w-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.04] motion-reduce:transform-none" />
        </div>
      )}

      <div className="flex flex-1 flex-col p-5">
        {iconEl && (
          <span
            className="mb-3.5 inline-flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"
            style={tint ? { backgroundColor: `${tint}1a`, color: tint } : undefined}
          >
            {iconEl}
          </span>
        )}

        {grouped
          ? <h4 className="text-[15.5px] font-bold leading-snug text-foreground">{item.title}</h4>
          : <h3 className="text-[15.5px] font-bold leading-snug text-foreground">{item.title}</h3>}

        {item.description?.trim() && (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{item.description}</p>
        )}

        {link && (
          <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-semibold text-primary">
            {item.cta?.trim() || 'Learn more'}
            <ArrowRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transform-none" aria-hidden />
          </span>
        )}
      </div>
    </>
  )

  const className = cn('group relative flex flex-col overflow-hidden', CARD, CARD_HOVER,
    link && 'outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2')

  return link ? (
    <motion.div whileHover={hoverLift(reduce, -4)} transition={{ duration: 0.16 }}>
      <Link href={link} className={cn(className, 'h-full')}>{inner}</Link>
    </motion.div>
  ) : (
    <motion.div whileHover={hoverLift(reduce, -4)} transition={{ duration: 0.16 }} className={className}>{inner}</motion.div>
  )
}

// ─── Section ─────────────────────────────────────────────────────────────────────
export interface ExperienceSectionProps {
  items:     ExperienceItem[]
  eyebrow?:  string
  title?:    string
  subtitle?: string
}

export function ExperienceSection({
  items, eyebrow = 'The Experience', title = 'What Awaits You', subtitle,
}: ExperienceSectionProps) {
  const reduce = useReducedMotion()

  const clean = (items ?? [])
    .filter(i => i && i.enabled !== false && i.title?.trim())
    .sort((a, b) => (a.displayOrder ?? a.priority ?? 0) - (b.displayOrder ?? b.priority ?? 0))

  if (clean.length === 0) return null

  const grouped = clean.some(i => i.category?.trim())
  const groups: { category: string | null; items: ExperienceItem[] }[] = []
  if (grouped) {
    const map = new Map<string, ExperienceItem[]>()
    const order: string[] = []
    for (const it of clean) {
      const cat = it.category?.trim() || 'More'
      if (!map.has(cat)) { map.set(cat, []); order.push(cat) }
      map.get(cat)!.push(it)
    }
    for (const cat of order) groups.push({ category: cat, items: map.get(cat)! })
  } else {
    groups.push({ category: null, items: clean })
  }

  return (
    <SectionShell maxW="6xl">
      <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />

      <div className="flex flex-col gap-10">
        {groups.map(group => (
          <div key={group.category ?? '_'}>
            {group.category && (
              <h3 className="mb-4 text-[13px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{group.category}</h3>
            )}
            <div className={cn('grid gap-5', gridClasses(group.items.length))}>
              {group.items.map((item, i) => (
                <motion.div key={item.id} {...reveal(reduce, Math.min(i, 5) * 0.05)}>
                  <ExperienceCard item={item} reduce={reduce} grouped={grouped} />
                </motion.div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  )
}
