'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { ROUTES } from '@/config/navigation'

// ─── Constants ────────────────────────────────────────────────────────────────

const NAV_LINKS = [
  { label: 'Features',  href: '/features'   },
  { label: 'Solutions', href: '/solutions'   },
  { label: 'Pricing',   href: ROUTES.PRICING },
  { label: 'Resources', href: '/resources'   },
] as const

// ─── Scroll behavior hook ─────────────────────────────────────────────────────
// Tracks scroll position (for transparent ↔ opaque background) and direction
// (for intelligent hide on scroll-down / show on scroll-up).
// Uses RAF debouncing to avoid layout thrash on every scroll event.

function useScrollBehavior() {
  const [isAtTop,   setIsAtTop]   = useState(true)
  const [isVisible, setIsVisible] = useState(true)
  const lastY = useRef(0)

  useEffect(() => {
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const y     = window.scrollY
        const delta = y - lastY.current

        setIsAtTop(y < 60)

        if (y < 60) {
          setIsVisible(true)
        } else if (delta > 8) {
          setIsVisible(false)   // scrolling down — hide
        } else if (delta < -8) {
          setIsVisible(true)    // scrolling up — show
        }

        lastY.current = y
      })
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf) }
  }, [])

  return { isAtTop, isVisible }
}

// ─── Logo ─────────────────────────────────────────────────────────────────────

function Logo({ light }: { light: boolean }) {
  return (
    <Link
      href={ROUTES.HOME}
      aria-label="RegisterDesk — home"
      className="group flex shrink-0 items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
    >
      <div
        className="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg ring-1 ring-inset ring-white/20 transition-transform duration-300 group-hover:scale-105 group-active:scale-95"
        style={{ backgroundImage: 'var(--primary-gradient)' }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-500 group-hover:translate-x-full"
        />
        <span className="relative text-[9px] font-extrabold leading-none tracking-[0.10em] text-white">
          RD
        </span>
      </div>
      <span className={cn(
        'text-[17px] font-bold tracking-tight transition-colors duration-300',
        light ? 'text-white' : 'text-slate-900',
      )}>
        Register
        <span className={cn('transition-colors duration-300', light ? 'text-white/70' : 'text-primary')}>
          Desk
        </span>
      </span>
    </Link>
  )
}

// ─── Desktop nav link ─────────────────────────────────────────────────────────

function NavLink({
  href, active, light, children,
}: {
  href: string; active: boolean; light: boolean; children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'text-sm font-medium transition-colors duration-200',
        'rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        light
          ? active ? 'text-white'      : 'text-white/70 hover:text-white'
          : active ? 'text-slate-900 font-semibold' : 'text-slate-500 hover:text-slate-900',
      )}
    >
      {children}
    </Link>
  )
}

// ─── Navbar ───────────────────────────────────────────────────────────────────

export function Navbar() {
  const pathname = usePathname()
  const { isAtTop, isVisible } = useScrollBehavior()
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => { setIsOpen(false) }, [pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [isOpen])

  // light  = transparent navbar over dark hero image → white text
  // showBg = navbar has scrolled away from top or menu is open → opaque bg
  const light   = isAtTop && !isOpen
  const showBg  = !isAtTop || isOpen
  // Never hide while the mobile menu is open
  const shouldHide = !isVisible && !isOpen

  return (
    <motion.header
      role="banner"
      animate={{ y: shouldHide ? '-100%' : 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="fixed inset-x-0 top-0 z-50 w-full"
    >

      {/* ── Background layer ───────────────────────────────────────────────────
          Single absolute element that fades from transparent → blur-white.
          Covers the full header height including the open mobile menu.
      ──────────────────────────────────────────────────────────────────────── */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 transition-all duration-300',
          showBg
            ? isOpen
              ? 'bg-white border-b border-slate-100 shadow-[0_4px_24px_rgba(0,0,0,0.06)]'
              : 'bg-white/[0.88] backdrop-blur-xl border-b border-black/[0.06] shadow-[0_1px_16px_rgba(0,0,0,0.04)]'
            : 'bg-transparent',
        )}
      />

      {/* ══ MOBILE (< md) ═══════════════════════════════════════════════════
          Full-width edge-to-edge bar. Hamburger slides down a menu below it.
          No pill, no rounded container, no outer horizontal padding.
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="relative md:hidden">

        {/* Bar */}
        <div className="flex h-14 w-full items-center justify-between px-4 sm:px-5">
          <Logo light={light} />
          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls="mobile-menu"
            aria-label={isOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setIsOpen(v => !v)}
            className={cn(
              'interactive inline-flex size-9 shrink-0 items-center justify-center rounded-lg',
              'transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              light
                ? 'text-white/80 hover:bg-white/10 hover:text-white'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700',
            )}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={isOpen ? 'x' : 'menu'}
                initial={{ opacity: 0, rotate: -30, scale: 0.8 }}
                animate={{ opacity: 1, rotate: 0,   scale: 1   }}
                exit={{    opacity: 0, rotate:  30,  scale: 0.8 }}
                transition={{ duration: 0.13 }}
                className="inline-flex"
              >
                {isOpen
                  ? <X    className="size-5" aria-hidden />
                  : <Menu className="size-5" aria-hidden />}
              </motion.span>
            </AnimatePresence>
          </button>
        </div>

        {/* Slide-down menu — height: 0 → auto, no separate overlay */}
        <AnimatePresence>
          {isOpen && (
            <motion.div
              id="mobile-menu"
              key="mobile-menu"
              role="navigation"
              aria-label="Mobile navigation"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="w-full overflow-hidden bg-white"
            >
              <div className="w-full px-4 pb-5">

                {/* Nav links */}
                <div className="flex flex-col gap-1 pt-2">
                  {NAV_LINKS.map(link => (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setIsOpen(false)}
                      aria-current={pathname === link.href ? 'page' : undefined}
                      className={cn(
                        'interactive flex h-12 w-full items-center rounded-xl px-3 text-base',
                        'transition-colors duration-150',
                        pathname === link.href
                          ? 'bg-primary/[0.05] font-semibold text-primary'
                          : 'font-medium text-slate-700 hover:bg-slate-50 hover:text-slate-900',
                      )}
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>

                {/* CTAs */}
                <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4">
                  <Link
                    href={ROUTES.LOGIN}
                    onClick={() => setIsOpen(false)}
                    className="interactive flex h-12 w-full items-center justify-center rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900"
                  >
                    Organizer Login
                  </Link>
                  <Link
                    href={ROUTES.LOGIN}
                    onClick={() => setIsOpen(false)}
                    className="interactive flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-white shadow-[0_4px_16px_rgba(229,39,126,0.28)] transition-all hover:shadow-[0_6px_22px_rgba(229,39,126,0.40)]"
                  >
                    Start Free
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </div>

              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>

      {/* ══ DESKTOP (md+) ═══════════════════════════════════════════════════
          Full-width bar — no pill, no outer margins, no rounded container.
          Content is contained within max-w-7xl for readable line lengths.
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="relative hidden md:block">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-10">

          <Logo light={light} />

          <nav aria-label="Main navigation" className="flex items-center gap-8 lg:gap-10">
            {NAV_LINKS.map(link => (
              <NavLink
                key={link.href}
                href={link.href}
                active={pathname === link.href || pathname.startsWith(link.href + '/')}
                light={light}
              >
                {link.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-1">
            <Link
              href={ROUTES.LOGIN}
              className={cn(
                'interactive rounded-lg px-4 py-2 text-sm font-medium transition-colors duration-200',
                light
                  ? 'text-white/85 hover:bg-white/10 hover:text-white'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
              )}
            >
              Organizer Login
            </Link>
            <Link
              href={ROUTES.LOGIN}
              className={cn(
                'interactive inline-flex h-9 items-center gap-1.5 rounded-lg px-4',
                'text-sm font-semibold text-white',
                'bg-primary shadow-[0_2px_12px_rgba(229,39,126,0.28)]',
                'transition-all duration-200',
                'hover:-translate-y-px hover:shadow-[0_4px_20px_rgba(229,39,126,0.42)]',
                'active:translate-y-0 active:scale-[0.98]',
              )}
            >
              Start Free
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>

        </div>
      </div>

    </motion.header>
  )
}
