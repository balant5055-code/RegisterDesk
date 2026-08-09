'use client'

// Phase P.1.4 — Marketing navbar (the only navigation system).
//
// Renders entirely from the navigation registry. Mega menus on hover/focus/click;
// mobile drawer below lg. Escape + outside-click close menus. Only interactive
// navigation is client; the registry stays pure data.
//
// CHROME — the bar is a FLOATING PILL, not a full-bleed band. At the top of the
// page it is invisible chrome (transparent, borderless) so the hero owns the
// viewport; once scrolled it materialises as a rounded, blurred, shadowed pill
// inset within the page container. The pill's height is fixed and only colour,
// border, shadow and blur transition, so materialising never animates layout.
//
// The outer band stays --nav-h tall at all times and the in-flow spacer matches it,
// so nothing below the nav ever moves.

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Menu } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { PRIMARY_NAV } from '@/content/marketing/navigation'
import { MegaMenu } from './MegaMenu'
import { MobileDrawer } from './MobileDrawer'
import { NavButton, NavCTA, NavLink, NAV_ITEM_BASE, navItemTone } from './NavAtoms'
import { MarketingLogo } from '@/components/marketing/MarketingLogo'

type NavState = 'top' | 'visible' | 'hidden'

// Tuning constants for the predictive scroll feel.
const TOP_ZONE     = 20  // px from the top → always shown + transparent
const HIDE_AFTER   = 80  // px of continuous downward scroll before hiding
const UP_REVEAL    = 4   // px of upward movement that counts as "intent to reveal"

export function MarketingNavbar() {
  const [navState, setNavState]     = useState<NavState>('top')
  const [openId, setOpenId]         = useState<string | null>(null)
  const [hoverId, setHoverId]       = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const navRef    = useRef<HTMLElement>(null)
  const lastY     = useRef(0)
  const downAccum = useRef(0)
  const stateRef  = useRef<NavState>('top')
  const pathname  = usePathname() ?? ''
  const reduce    = useReducedMotion()

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

  // Where the gliding indicator sits: the pointer wins, then an open menu, then the
  // current route. Resolved once here so the indicator can never be rendered in two
  // items at the same time — Framer would tear the shared layout animation apart.
  const activeMenu = PRIMARY_NAV.find(m =>
    m.href ? pathname === m.href : pathname.startsWith(`/${m.id}`),
  )
  const indicatorId = hoverId ?? openId ?? activeMenu?.id ?? null

  return (
    <>
    <header
      ref={navRef}
      style={{
        transform: shown ? 'translateY(0)' : 'translateY(-100%)',
        willChange: 'transform',
        transition: 'transform 260ms var(--ease-emphasized)',
      }}
      className="fixed inset-x-0 top-0 z-[100]"
    >
      <div
        style={{
          transition:
            'background-color var(--duration-normal) ease, border-color var(--duration-normal) ease, backdrop-filter var(--duration-normal) ease',
        }}
        className={cn(
          'border-b',
          atTop
            ? 'border-transparent bg-transparent'
            : 'border-border/50 bg-white/70 backdrop-blur-xl supports-[backdrop-filter]:bg-white/60',
        )}
      >
      <div className="mx-auto flex h-[var(--nav-h)] w-full max-w-7xl items-center px-4 sm:px-6 lg:px-8">

        {/* Left — logo (flex-1 keeps the centered nav mathematically centered) */}
        <div className="flex flex-1 items-center">
          <MarketingLogo className="h-7 w-auto md:h-[30px] lg:h-[30px]" priority />
        </div>

        {/* Center — primary nav as a SEGMENTED CONTROL.
            A recessed track holding a single white indicator that GLIDES between
            items (Framer layoutId), rather than each item toggling its own
            background. One moving object instead of N blinking ones is what makes
            a nav feel continuous; the previous version had no motion at all, so
            hover was an instant tone swap with nothing connecting the states.

            The indicator follows hover, falls back to the open menu, and rests on
            the active route — so it is never orphaned. */}
        <nav
          className="relative hidden items-center gap-0.5 rounded-full border border-border/50 bg-foreground/[0.035] p-1 lg:flex"
          aria-label="Primary"
          onMouseLeave={() => { setOpenId(null); setHoverId(null) }}
        >
          {PRIMARY_NAV.map(menu => {
            const active = menu.href ? pathname === menu.href : pathname.startsWith(`/${menu.id}`)
            const open   = openId === menu.id
            const lit    = indicatorId === menu.id

            // The gliding indicator. Rendered inside whichever item is lit; Framer
            // animates it across the gap because the layoutId is shared.
            const indicator = lit && (
              <motion.span
                layoutId="nav-indicator"
                aria-hidden
                className="absolute inset-0 rounded-full bg-white shadow-[0_1px_2px_rgb(var(--brand-navy-rgb)/0.10),0_4px_12px_-4px_rgb(var(--brand-navy-rgb)/0.16)] ring-1 ring-border/50"
                transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 36, mass: 0.7 }}
              />
            )

            if (menu.href && !menu.groups) {
              return (
                <div key={menu.id} className="relative" onMouseEnter={() => { setHoverId(menu.id); setOpenId(null) }}>
                  {indicator}
                  <NavLink
                    href={menu.href}
                    current={active}
                    className={cn(NAV_ITEM_BASE, 'relative z-10', navItemTone({ active: lit }))}
                  >
                    {menu.title}
                  </NavLink>
                </div>
              )
            }

            return (
              <div key={menu.id} className="relative" onMouseEnter={() => { setHoverId(menu.id); setOpenId(menu.id) }}>
                {indicator}
                <NavButton
                  label={menu.title} expanded={open} active={lit} controls={`mega-${menu.id}`}
                  className="relative z-10"
                  onClick={() => setOpenId(open ? null : menu.id)}
                />
                <AnimatePresence>
                  {open && (
                    <div id={`mega-${menu.id}`} className="absolute left-1/2 top-full -translate-x-1/2 pt-3">
                      <MegaMenu menu={menu} onItemClick={() => setOpenId(null)} />
                    </div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
        </nav>

        {/* Right — auth (flex-1 justify-end). Both controls resolve from the CTA
            registry. The primary was previously a hand-rolled <Link> labelled
            "Sign up" that pointed at the startFree CTA's href — so the same
            destination was called "Sign up" here and "Start free" everywhere else,
            which is exactly what the registry exists to prevent. */}
        <div className="flex flex-1 items-center justify-end gap-1.5">
          <NavCTA ctaKey="login" size="sm" className="hidden h-9 rounded-full px-3 sm:inline-flex" />
          <NavCTA ctaKey="startFree" size="sm" className="hidden h-9 rounded-full px-4 sm:inline-flex" />
          <button
            type="button" onClick={() => setMobileOpen(true)} aria-label="Open menu" aria-expanded={mobileOpen}
            className="rounded-full border border-border/50 p-2 text-foreground transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </button>
        </div>
      </div>
      </div>
    </header>

    {/* In-flow spacer: preserves the navbar's former height so switching to
        position:fixed causes no layout shift — content underneath never moves. */}
    <div aria-hidden className="h-[var(--nav-h)]" />

    {/* Rendered as a sibling (NOT inside the transformed header) so its
        position:fixed resolves against the viewport, not the navbar. */}
    <MobileDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} menus={PRIMARY_NAV} />
    </>
  )
}
