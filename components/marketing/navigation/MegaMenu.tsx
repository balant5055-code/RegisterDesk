'use client'

// Phase P.1.4 — Reusable mega-menu panel.
//
// One component renders Platform, Solutions, Resources, Company, and Support
// menus from the navigation registry (groups + optional featured card). No
// hardcoded layouts. Animated; respects prefers-reduced-motion.

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils/cn'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { EASE } from '@/lib/marketing/motion'
import type { NavMenu, NavGroup, NavLeaf } from '@/lib/marketing/types'

function MegaMenuItem({ item, onClick }: { item: NavLeaf; onClick?: () => void }) {
  const Icon = item.iconKey ? MARKETING_ICONS[item.iconKey] : null
  return (
    <Link href={item.href} onClick={onClick}
      className="group flex items-start gap-3 rounded-xl p-2.5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      {Icon && (
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="size-4 text-primary" aria-hidden />
        </span>
      )}
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[14px] font-semibold text-foreground">
          {item.title}
          {item.badge && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{item.badge}</span>}
        </span>
        {item.description && <span className="block text-[12px] text-muted-foreground">{item.description}</span>}
      </span>
    </Link>
  )
}

function MegaMenuGroup({ group, onItemClick }: { group: NavGroup; onItemClick?: () => void }) {
  return (
    <div>
      {group.title && (
        <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">{group.title}</p>
      )}
      <ul className="space-y-0.5">
        {group.items.map(it => <li key={it.id}><MegaMenuItem item={it} onClick={onItemClick} /></li>)}
      </ul>
    </div>
  )
}

export function MegaMenu({ menu, onItemClick }: { menu: NavMenu; onItemClick?: () => void }) {
  const reduce = useReducedMotion()
  const groups = menu.groups ?? []
  const multi  = groups.length > 1
  const FeaturedIcon = menu.featured?.iconKey ? MARKETING_ICONS[menu.featured.iconKey] : null

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, y: 10 }}
      transition={{ duration: 0.22, ease: EASE }}
      role="region" aria-label={`${menu.title} menu`}
      className={cn('overflow-hidden rounded-[20px] border border-border/60 bg-white p-4 shadow-lg', multi ? 'w-[min(42rem,92vw)]' : 'w-[min(22rem,90vw)]')}
    >
      <div className={cn('grid gap-x-6 gap-y-4', multi && 'sm:grid-cols-2')}>
        {groups.map(g => <MegaMenuGroup key={g.id} group={g} onItemClick={onItemClick} />)}
      </div>
      {menu.featured && (
        <Link href={menu.featured.href} onClick={onItemClick}
          className="mt-4 flex items-center gap-3 rounded-xl border border-border/60 bg-muted/40 p-3 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {FeaturedIcon && (
            <span className="flex size-9 items-center justify-center rounded-lg text-primary-foreground" style={{ backgroundImage: 'var(--primary-gradient)' }}>
              <FeaturedIcon className="size-4" aria-hidden />
            </span>
          )}
          <span>
            <span className="block text-[14px] font-semibold text-foreground">{menu.featured.title}</span>
            {menu.featured.description && <span className="block text-[12px] text-muted-foreground">{menu.featured.description}</span>}
          </span>
        </Link>
      )}
    </motion.div>
  )
}
