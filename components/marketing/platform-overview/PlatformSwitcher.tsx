'use client'

// "The Platform" — the module switcher. An Apple-style segmented control: one
// white pill bar (hairline border, soft shadow, rounded-full) with a thumb that
// slides smoothly between modules. Selecting a module crossfades the browser.
// Centered on desktop; scrolls horizontally on mobile. No sidebar, no tabs-that-
// look-like-bootstrap.

import { motion } from 'framer-motion'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { cn } from '@/lib/utils/cn'
import type { PlatformModuleData } from './platform.data'

export function PlatformSwitcher({ modules, active, panelId, onActivate, className }: {
  modules: PlatformModuleData[]
  active: string
  panelId: string
  onActivate: (id: string) => void
  className?: string
}) {
  return (
    <div className={cn('-mx-4 overflow-x-auto px-4 lg:mx-0 lg:overflow-visible lg:px-0', className)}>
      <div role="tablist" aria-label="Platform modules" className="mx-auto flex w-max items-center gap-1 rounded-full border border-border/60 bg-white p-1 shadow-sm">
        {modules.map(m => {
          const Icon = MARKETING_ICONS[m.iconKey]
          const isActive = active === m.id
          return (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={panelId}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onActivate(m.id)}
              onFocus={() => onActivate(m.id)}
              className="relative inline-flex items-center gap-2 rounded-full px-4 py-2 text-[var(--fs-base)] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {isActive && (
                <motion.span
                  layoutId="platform-segment"
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-muted/70"
                  transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                />
              )}
              <Icon className={cn('relative z-10 size-4 shrink-0 transition-colors duration-200', isActive ? 'text-primary' : 'text-muted-foreground')} strokeWidth={1.8} aria-hidden />
              <span className={cn('relative z-10 whitespace-nowrap transition-colors duration-200', isActive ? 'text-foreground' : 'text-muted-foreground')}>{m.title}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
