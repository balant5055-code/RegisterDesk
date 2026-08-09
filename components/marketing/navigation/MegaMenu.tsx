'use client'

// Phase P.1.4 — Reusable mega-menu panel.
//
// One component renders every mega menu from the navigation registry (groups +
// optional featured card). No hardcoded layouts. Animated; respects
// prefers-reduced-motion.
//
// The panel now opens with the menu's own `description`. That field is defined on
// NavMenu and populated in the registry ("Everything to run an event, end to end.",
// "Built for every event type.") but nothing had ever rendered it — the panel
// dropped straight into a link grid with no framing.
//
// Depth comes from a navy-tinted shadow and a brand hairline along the top edge,
// not from a heavier border: the panel floats over page content, so it needs to
// read as lifted rather than outlined.

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils/cn'
import { fs, typography } from '@/lib/ds/typography'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { EASE } from '@/lib/marketing/motion'
import type { NavMenu, NavGroup, NavLeaf } from '@/lib/marketing/types'

/** Navy-tinted lift — see the panel note above. */
const PANEL_SHADOW = '0 24px 60px -20px rgb(var(--brand-navy-rgb) / 0.28), 0 2px 8px -4px rgb(var(--brand-navy-rgb) / 0.10)'

function MegaMenuItem({ item, onClick }: { item: NavLeaf; onClick?: () => void }) {
  const Icon = item.iconKey ? MARKETING_ICONS[item.iconKey] : null
  return (
    <Link href={item.href} onClick={onClick}
      className="group flex items-start gap-3 rounded-xl p-2.5 transition-colors duration-150 hover:bg-primary/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      {Icon && (
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/[0.08] ring-1 ring-inset ring-primary/10 transition-colors duration-150 group-hover:bg-primary/[0.14] group-hover:ring-primary/25">
          <Icon className="size-4 text-primary" aria-hidden />
        </span>
      )}
      <span className="min-w-0">
        <span className={cn(typography.nav, 'flex items-center gap-1.5 font-semibold text-foreground transition-colors duration-150 group-hover:text-primary')}>
          {item.title}
          {item.badge && (
            <span className={cn(fs['2xs'], 'rounded-full bg-muted px-1.5 py-0.5 font-medium text-muted-foreground')}>
              {item.badge}
            </span>
          )}
        </span>
        {item.description && (
          <span className={cn(fs.xs, 'mt-0.5 block leading-relaxed text-muted-foreground')}>{item.description}</span>
        )}
      </span>
    </Link>
  )
}

function MegaMenuGroup({ group, onItemClick }: { group: NavGroup; onItemClick?: () => void }) {
  return (
    <div>
      {group.title && (
        <p className={cn(typography.overline, 'mb-2 px-2.5 text-muted-foreground/70')}>{group.title}</p>
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
      initial={reduce ? false : { opacity: 0, y: 8, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? undefined : { opacity: 0, y: 8, scale: 0.985 }}
      transition={{ duration: 0.2, ease: EASE }}
      style={{ boxShadow: PANEL_SHADOW, transformOrigin: 'top left' }}
      role="region" aria-label={`${menu.title} menu`}
      className={cn(
        'overflow-hidden rounded-2xl border border-border/60 bg-white',
        multi ? 'w-[min(46rem,94vw)]' : 'w-[min(24rem,92vw)]',
      )}
    >
      {/* Brand hairline along the top edge — the panel's only colour. */}
      <div
        aria-hidden
        className="h-px w-full"
        style={{ background: 'linear-gradient(90deg, transparent, rgb(var(--primary-rgb) / 0.45), transparent)' }}
      />

      <div className="p-4">
        {menu.description && (
          <p className={cn(typography.caption, 'mb-3 px-2.5 text-muted-foreground')}>{menu.description}</p>
        )}

        <div className={cn('grid gap-x-6 gap-y-5', multi && 'sm:grid-cols-2')}>
          {groups.map(g => <MegaMenuGroup key={g.id} group={g} onItemClick={onItemClick} />)}
        </div>

        {menu.featured && (
          <Link href={menu.featured.href} onClick={onItemClick}
            className="mt-4 flex items-center gap-3 rounded-xl border border-border/60 bg-surface-3 p-3 transition-colors duration-150 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            {FeaturedIcon && (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg text-primary-foreground" style={{ backgroundImage: 'var(--primary-gradient)' }}>
                <FeaturedIcon className="size-4" aria-hidden />
              </span>
            )}
            <span className="min-w-0">
              <span className={cn(typography.nav, 'block font-semibold text-foreground')}>{menu.featured.title}</span>
              {menu.featured.description && (
                <span className={cn(fs.xs, 'block text-muted-foreground')}>{menu.featured.description}</span>
              )}
            </span>
          </Link>
        )}
      </div>
    </motion.div>
  )
}
