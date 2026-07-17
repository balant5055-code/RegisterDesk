'use client'

// Phase P.1.4 — Mobile navigation: fullscreen slide-in panel (not a drawer).
//
// Registry-driven, nested accordion groups, CTAs pinned at the bottom. Pure
// white, edge-to-edge. Accessible: focus trap, Escape to close, close on
// navigation, body scroll lock, visible focus rings. Respects
// prefers-reduced-motion. No horizontal scroll.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { X, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { MARKETING_ICONS } from '@/lib/marketing/icons'
import { EASE } from '@/lib/marketing/motion'
import { NavCTA, NAV_ICONS } from './NavAtoms'
import type { NavMenu } from '@/lib/marketing/types'

function MobileSection({ menu, onNavigate }: { menu: NavMenu; onNavigate: () => void }) {
  const [open, setOpen] = useState(false)
  const Icon = NAV_ICONS[menu.id]

  if (menu.href && !menu.groups) {
    return (
      <Link href={menu.href} onClick={onNavigate}
        className="flex items-center gap-3 rounded-xl px-3 py-3.5 text-[16px] font-semibold text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {Icon && <Icon className="size-[18px] text-muted-foreground" strokeWidth={1.8} aria-hidden />}
        {menu.title}
      </Link>
    )
  }

  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-3.5 text-left text-[16px] font-semibold text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {Icon && <Icon className="size-[18px] text-muted-foreground" strokeWidth={1.8} aria-hidden />}
        <span className="flex-1">{menu.title}</span>
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="space-y-0.5 pb-2 pl-3">
          {(menu.groups ?? []).flatMap(g => g.items).map(it => {
            const Icon = it.iconKey ? MARKETING_ICONS[it.iconKey] : null
            return (
              <Link key={it.id} href={it.href} onClick={onNavigate}
                className="flex items-center gap-3 rounded-lg px-3 py-3 text-[15px] text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                {it.title}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function MobileDrawer({ open, onClose, menus }: { open: boolean; onClose: () => void; menus: NavMenu[] }) {
  const reduce = useReducedMotion()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'Tab') {
        const f = panelRef.current?.querySelectorAll<HTMLElement>('a[href],button,input,[tabindex]:not([tabindex="-1"])')
        if (!f || f.length === 0) return
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    const t = setTimeout(() => panelRef.current?.querySelector<HTMLElement>('a[href],button')?.focus(), 50)
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; clearTimeout(t) }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panelRef} role="dialog" aria-modal="true" aria-label="Site navigation"
          initial={reduce ? false : { x: '100%' }} animate={{ x: 0 }} exit={reduce ? undefined : { x: '100%' }}
          transition={{ duration: 0.25, ease: EASE }}
          className="fixed inset-0 z-[110] flex flex-col overflow-x-hidden bg-white lg:hidden"
        >
          {/* Top: logo + close */}
          <div className="flex h-16 items-center justify-between px-4 sm:px-6">
            <Link href="/" onClick={onClose} aria-label="RegisterDesk home" className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-[9px] text-primary-foreground ring-1 ring-primary/20" style={{ backgroundImage: 'var(--primary-gradient)' }}>
                <span className="text-[11px] font-extrabold tracking-[0.1em]">RD</span>
              </span>
              <span className="text-[15px] font-bold tracking-tight text-foreground">Register<span className="text-muted-foreground/70">Desk</span></span>
            </Link>
            <button onClick={onClose} aria-label="Close menu"
              className="rounded-xl p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <X className="size-6" aria-hidden />
            </button>
          </div>

          <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4" aria-label="Mobile navigation">
            {menus.map(m => <MobileSection key={m.id} menu={m} onNavigate={onClose} />)}
          </nav>

          <div className="grid grid-cols-2 gap-3 border-t border-border/60 px-4 py-4 sm:px-6">
            <NavCTA ctaKey="login" size="md" onClick={onClose} className="w-full justify-center rounded-xl" />
            <NavCTA ctaKey="startFree" size="md" onClick={onClose} className="w-full justify-center rounded-xl" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
