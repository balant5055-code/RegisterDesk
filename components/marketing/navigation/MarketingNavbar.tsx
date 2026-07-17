'use client'

// Phase P.1.4 — Marketing navbar (the only navigation system).
//
// Renders entirely from the navigation registry. Sticky; translucent → solid on
// scroll (white-first, visible on white pages — no invisible nav). Mega menus on
// hover/focus/click; mobile drawer below lg. Escape + outside-click close menus.
// Only interactive navigation is client; the registry stays pure data.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { AnimatePresence } from 'framer-motion'
import { Menu } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { PRIMARY_NAV } from '@/content/marketing/navigation'
import { getCta } from '@/lib/marketing/cta'
import { MegaMenu } from './MegaMenu'
import { MobileDrawer } from './MobileDrawer'
import { NavButton, NavCTA, NavLink } from './NavAtoms'
import { MarketingLogo } from '@/components/marketing/MarketingLogo'

type NavState = 'top' | 'visible' | 'hidden'

// Tuning constants for the predictive scroll feel.
const TOP_ZONE     = 20  // px from the top → always shown + transparent
const HIDE_AFTER   = 80  // px of continuous downward scroll before hiding
const UP_REVEAL    = 4   // px of upward movement that counts as "intent to reveal"

export function MarketingNavbar() {
  const [navState, setNavState]     = useState<NavState>('top')
  const [openId, setOpenId]         = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const navRef    = useRef<HTMLElement>(null)
  const lastY     = useRef(0)
  const downAccum = useRef(0)
  const stateRef  = useRef<NavState>('top')
  const pathname  = usePathname() ?? ''

  // Predictive smart-scroll as an explicit state machine (TOP · VISIBLE · HIDDEN),
  // rAF-driven. It does NOT derive visibility per-frame from scrollY>lastScrollY
  // (that flickers). Instead: hide only after ~80px of *continuous* downward
  // scroll; reveal on the first meaningful upward move (>4px) at any depth; reset
  // and stay shown near the top. Transform-only; the sole layout read is scrollY.
  useEffect(() => {
    lastY.current = window.scrollY
    let ticking = false
    const commit = (s: NavState) => {
      if (stateRef.current !== s) { stateRef.current = s; setNavState(s) }
    }
    const update = () => {
      ticking = false
      const y = window.scrollY
      if (y <= TOP_ZONE) {
        downAccum.current = 0
        lastY.current = y
        commit('top')
        return
      }
      const delta = y - lastY.current
      lastY.current = y
      if (delta < -UP_REVEAL) {                 // first upward intent → reveal now
        downAccum.current = 0
        commit('visible')
      } else if (delta > 0) {                   // downward → accumulate continuous distance
        downAccum.current += delta
        if (downAccum.current >= HIDE_AFTER)     commit('hidden')
        else if (stateRef.current === 'top')     commit('visible')
      }
      // |delta| within the dead zone (tiny up-jitter / no move) → ignored, no toggle.
    }
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update) } }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!openId) return
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenId(null) }
    const onDown = (e: MouseEvent) => { if (!navRef.current?.contains(e.target as Node)) setOpenId(null) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [openId])

  // Render straight from the state machine. A hover dropdown or the open mobile
  // panel always pins the bar on screen.
  const shown = navState !== 'hidden' || openId !== null || mobileOpen
  const atTop = navState === 'top'
  const signUpHref = getCta('startFree').href

  return (
    <>
    <header
      ref={navRef}
      style={{
        transform: shown ? 'translateY(0)' : 'translateY(-100%)',
        willChange: 'transform',
        transition:
          'transform 260ms var(--ease-emphasized), background-color var(--duration-normal) ease, backdrop-filter var(--duration-normal) ease, border-color var(--duration-normal) ease',
      }}
      className={cn(
        'fixed inset-x-0 top-0 z-[100]',
        atTop
          ? 'border-b border-transparent bg-transparent'
          : 'border-b border-border/60 bg-white/95 backdrop-blur-[20px] supports-[backdrop-filter]:bg-white/[0.88]',
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-2 px-4 sm:px-6 md:h-[68px] lg:h-[72px] lg:px-8">

        {/* Left — logo (flex-1 keeps the centered nav mathematically centered) */}
        <div className="flex flex-1 items-center">
          <MarketingLogo className="h-7 w-auto md:h-[30px] lg:h-[30px]" priority />
        </div>

        {/* Center — primary nav */}
        <nav className="hidden items-center gap-0.5 lg:flex" aria-label="Primary" onMouseLeave={() => setOpenId(null)}>
          {PRIMARY_NAV.map(menu => {
            const active = menu.href ? pathname === menu.href : pathname.startsWith(`/${menu.id}`)
            if (menu.href && !menu.groups) {
              return (
                <NavLink key={menu.id} href={menu.href} className={cn('inline-flex items-center rounded-xl px-2.5 py-2 hover:bg-muted/40', active && 'text-foreground')}>
                  {menu.title}
                </NavLink>
              )
            }
            const open = openId === menu.id
            return (
              <div key={menu.id} className="relative" onMouseEnter={() => setOpenId(menu.id)}>
                <NavButton
                  label={menu.title} expanded={open} active={active} controls={`mega-${menu.id}`}
                  onClick={() => setOpenId(open ? null : menu.id)} onMouseEnter={() => setOpenId(menu.id)}
                />
                <AnimatePresence>
                  {open && (
                    <div id={`mega-${menu.id}`} className="absolute left-0 top-full pt-2">
                      <MegaMenu menu={menu} onItemClick={() => setOpenId(null)} />
                    </div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
        </nav>

        {/* Right — auth (flex-1 justify-end) */}
        <div className="flex flex-1 items-center justify-end gap-2">
          <NavCTA ctaKey="login" size="sm" className="hidden h-9 rounded-xl px-3 sm:inline-flex" />
          <Link
            href={signUpHref}
            className="hidden h-9 items-center justify-center rounded-xl border border-border/60 bg-white px-3.5 text-[14px] font-semibold text-foreground shadow-sm transition-colors hover:border-primary hover:bg-muted/30 sm:inline-flex"
          >
            Sign up
          </Link>
          <button
            type="button" onClick={() => setMobileOpen(true)} aria-label="Open menu" aria-expanded={mobileOpen}
            className="rounded-xl p-2 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </button>
        </div>
      </div>
    </header>

    {/* In-flow spacer: preserves the navbar's former height so switching to
        position:fixed causes no layout shift — content underneath never moves. */}
    <div aria-hidden className="h-16 md:h-[68px] lg:h-[72px]" />

    {/* Rendered as a sibling (NOT inside the transformed header) so its
        position:fixed resolves against the viewport, not the navbar. */}
    <MobileDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} menus={PRIMARY_NAV} />
    </>
  )
}
