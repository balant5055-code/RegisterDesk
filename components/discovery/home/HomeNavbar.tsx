'use client'

// ─── THE public RegisterDesk header ──────────────────────────────────────────
//
// Every eligible public route renders HomeShell, HomeShell renders this, and the legacy
// MarketingNavbar was proven unreachable and deleted. This is the ONE public navbar — a
// change here is a change to the whole public site. It is NOT rendered by the organizer
// dashboard or the admin console, which carry their own chrome and are untouched by it.
//
// NO SECOND SOURCE OF TRUTH: destinations come from the PRIMARY_NAV registry and the CTA
// registry. Only the wording and the presentation are local. A destination is never
// invented here, and the retired platform section is never named.
//
// ═══ COMPOSITION — THREE ZONES ON A GLASS BAR ════════════════════════════════
// Identity on the left gutter, the sections dead-centre, the one action on the right
// gutter. A `grid-cols-[1fr_auto_1fr]` rather than a flex row with margins, so the
// centre column is centred on the PAGE and not on whatever is left after the logo and
// the button have taken their share — the two outer zones are always the same width.
//
// The previous revision was a masthead: wordmark, a hairline, then the links set at
// three levels of ink, all on the left. That is an editorial idea and it held up, but
// it is also what every site of that school looks like. What replaces it is the current
// product-web grammar — centred sections, a translucent bar, a soft highlight that
// travels with the pointer, one compact filled action — because the brief for this pass
// was "modern", by name, and this IS what modern means right now.
//
// ═══ CHROME ══════════════════════════════════════════════════════════════════
// Translucent --background with a blur behind it, and a hairline that fades in once the
// page has moved. No shadow, no gradient wash, no tint. At rest on the homepage the bar
// and the hero are one sheet; scrolled, whatever passes beneath it reads as frosted
// rather than cut. `supports-[backdrop-filter]` keeps the bar OPAQUE in the (rare) engine
// with no blur, so text never sits on unblurred imagery.
//
// It does NOT hide on scroll and its height is not its own: --disc-nav-h is published by
// the shell (64 / 72), the bar sets its height from it, <main> is padded by it, and the
// mobile sheet starts beneath it. Nothing here measures the DOM.
//
// ═══ THE HOVER HIGHLIGHT ═════════════════════════════════════════════════════
// One soft chip, shared by every link through a Framer `layoutId`, so moving the pointer
// along the row slides it from word to word instead of blinking a new one in under each.
// That travel is the whole affordance: it says "these are one set" without a border
// around them. The chip is --muted on a 6px corner — --radius-control, the token for an
// interactive control — and it is a hover state only; it is never used to mark the
// current page.
//
// The CURRENT page is marked by a 2px rule in --action under the word. It is a real
// pathname match and nothing else: nothing is underlined for being first or for looking
// important.
//
// ═══ 2026-09-23 · THE LUXURY PASS ═════════════════════════════════════════════
// Same structure, same registry, same three zones. What changed is the voice: the
// sections are set in small, widely-tracked capitals (the hero's eyebrow voice), and the
// grey hover chip became a BRONZE HAIRLINE (--hero-accent-rule, the warm accent of the
// hero's italic and the footer's rules) that glides under the word the pointer is on.
// The same hairline marks the current page. The mobile sheet reads as an index: large
// light serif sections, numbered, bronze arrows. The organizer button was the one saturated
// object; since the owner's follow-up the same day it is an OUTLINED frame (see
// OrganizerButton), so the bar carries no fill at all — --action appears only on hover.
//
// ═══ OVER THE HERO (homepage only) ═══════════════════════════════════════════
// On the homepage, before the page has scrolled, the bar has no surface at all: it sits ON
// the hero photograph (HomeHero pulls the stage up beneath it), with the lockup and the
// sections in the ink-on-media tokens. The first scroll cross-fades it into the glass bar
// below (background, blur, hairline and ink transition together) and it stays sticky from
// there. Every other route, and the open mobile sheet, always get the solid glass bar.
//
// ═══ SOLID ACTION, NOT THE GRADIENT ═════════════════════════════════════════
// The button and the active rule are --action flat, deliberately. The landing page
// allows the brand RAMP in exactly two places — the hero's emphasised phrase and the
// search CTA — and tests/unit/landingDesignSystem.test.ts enumerates them, because a
// third use is what turns a restrained accent into a gradient-heavy first screen. The
// bar sits above both of those on every landing; it takes the ramp's first stop and
// leaves the ramp itself to them.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { ArrowRight, ChevronDown, Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { container } from '@/lib/ds/containers'
import { PRIMARY_NAV } from '@/content/marketing/navigation'
import { getCta } from '@/lib/marketing/cta'
import { BrandLockup } from '@/components/marketing/BrandLockup'
import type { NavMenu } from '@/lib/marketing/types'

const MOBILE_PANEL_ID = 'home-nav-mobile'
const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]

/**
 * WHICH registry entries this header shows, and in what order.
 *
 * PRIMARY_NAV carries six: home, events, causes, solutions, pricing, contact. This bar
 * shows four. Two are deliberately not here:
 *
 *   home       the wordmark already goes to `/`; a nav item pointing at the page you
 *              are standing on is furniture.
 *   solutions  its entry point is the footer, which reads the same registry.
 *
 * An ordered ALLOW-LIST of registry ids, so no destination is duplicated and restoring
 * an item is one line. The Platform entry was removed with its section; nothing here
 * points at a route that 404s.
 */
const NAV_ITEMS: readonly { id: string }[] = [
  { id: 'events' },
  { id: 'causes' },
  { id: 'pricing' },
  { id: 'contact' },
]

/**
 * Wording overrides for THIS header only. Destinations still come from PRIMARY_NAV —
 * nothing is re-pointed. On a discovery site the two discovery sections carry the verb.
 */
const NAV_LABEL: Record<string, string> = {
  events: 'Discover Events',
  causes: 'Discover Causes',
}

/**
 * The organizer entry — the ONLY action in this header, and the SAME door Sign In used:
 * `getCta('login').href`, the canonical destination in the CTA registry (→ /login).
 * Nothing new is routed. It is the one framed object on the bar; everything else is
 * type on glass.
 */
const ORGANIZERS_LABEL = 'For Organizers'

/** Registry entries resolved in this header's order. Missing ids are skipped. */
const NAV_ENTRIES: NavMenu[] = NAV_ITEMS
  .map(({ id }) => PRIMARY_NAV.find(m => m.id === id))
  .filter((m): m is NavMenu => Boolean(m))

const labelOf = (menu: NavMenu) => NAV_LABEL[menu.id] ?? menu.title
/** A dropdown entry has no href of its own; its overview page is the featured item. */
const hrefOf = (menu: NavMenu) => menu.href ?? menu.featured?.href ?? null

/** Only the hairline is scroll-dependent; the bar is otherwise the same at any offset. */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    let frame = 0
    const read = () => { frame = 0; setScrolled(window.scrollY > 4) }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read) }
    read()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { if (frame) cancelAnimationFrame(frame); window.removeEventListener('scroll', onScroll) }
  }, [])
  return scrolled
}

// ── Link chrome ──────────────────────────────────────────────────────────────
// Padded, because the hover chip needs a box to fill. h-9 is the same height as the
// action button on the right, so the row and the button share a baseline.
const LINK_BASE =
  'group/nav relative inline-flex h-10 items-center gap-1.5 px-4 text-fs-xs font-medium uppercase tracking-[0.16em] ' +
  'rounded-[var(--radius-control)] transition-colors duration-200 ease-out ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2'
const LINK_REST = 'text-hero-ink-soft hover:text-hero-ink'
const LINK_ON   = 'text-hero-ink'
/** The same two states on the homepage photograph, before the bar turns solid. */
const LINK_REST_MEDIA = 'text-ink-on-media-muted hover:text-ink-on-media'
const LINK_ON_MEDIA   = 'text-ink-on-media'

/**
 * The shared hover chip. Rendered inside whichever item the pointer is over, with ONE
 * layoutId, so Framer animates it between positions. `-z-10` behind the label; the
 * label's own colour transition carries the rest.
 */
function HoverChip({ animate }: { animate: boolean }) {
  // Luxury pass: a bronze hairline under the word, not a filled chip behind it.
  const className = 'absolute inset-x-4 bottom-1.5 h-[1.5px] bg-hero-accent-rule'
  if (!animate) return <span aria-hidden className={className} />
  return (
    <motion.span
      aria-hidden
      layoutId="home-nav-hover"
      className={className}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ layout: { duration: 0.22, ease: EASE }, opacity: { duration: 0.15 } }}
    />
  )
}

/**
 * The current-page marker: a 2px rule in --action, inset to the label's padding so it
 * sits under the WORD rather than under the chip. `layoutId` lets it slide between
 * sections; under reduced motion it simply appears.
 */
function ActiveRule({ animate }: { animate: boolean }) {
  const className = 'absolute inset-x-4 bottom-1.5 h-[1.5px] bg-hero-accent-rule'
  if (!animate) return <span aria-hidden className={className} />
  return (
    <motion.span
      aria-hidden
      layoutId="home-nav-active"
      className={className}
      transition={{ duration: 0.22, ease: EASE }}
    />
  )
}

function DesktopItem({
  menu, active, hovered, animate, onHover, overHero,
}: {
  menu: NavMenu
  active: boolean
  hovered: boolean
  animate: boolean
  onHover: (id: string | null) => void
  /** True while the bar sits on the homepage photograph. */
  overHero: boolean
}) {
  const rest = overHero ? LINK_REST_MEDIA : LINK_REST
  const on   = overHero ? LINK_ON_MEDIA : LINK_ON
  const [open, setOpen] = useState(false)
  const items = (menu.groups ?? []).flatMap(g => g.items)
  const href = hrefOf(menu)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const chrome = (
    <>
      {hovered && <HoverChip animate={animate} />}
      {active && !hovered && <ActiveRule animate={animate} />}
    </>
  )

  if (!items.length && href) {
    return (
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        onMouseEnter={() => onHover(menu.id)}
        onFocus={() => onHover(menu.id)}
        className={cn(LINK_BASE, active ? on : rest)}
      >
        {chrome}
        {labelOf(menu)}
      </Link>
    )
  }

  return (
    <div
      className="relative"
      onMouseEnter={() => { onHover(menu.id); setOpen(true) }}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onFocus={() => onHover(menu.id)}
        className={cn(LINK_BASE, 'cursor-pointer', active || open ? on : rest)}
      >
        {chrome}
        {labelOf(menu)}
        <ChevronDown
          className={cn(
            'mt-px size-3 transition-transform duration-200 ease-out motion-reduce:transition-none',
            open && 'rotate-180',
          )}
          strokeWidth={2}
          aria-hidden
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={animate ? { opacity: 0, y: 6 } : { opacity: 0 }}
            animate={{ opacity: 1, y: 0 }}
            exit={animate ? { opacity: 0, y: 4 } : { opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="absolute left-1/2 top-full z-50 w-[20rem] -translate-x-1/2 pt-3"
          >
            <div className="overflow-hidden rounded-[var(--radius-surface)] border border-border/70 bg-background/95 p-1.5 shadow-[0_24px_48px_-28px_rgb(11_21_51_/_0.35)] backdrop-blur-xl">
              {items.map(item => (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-[var(--radius-control)] px-3 py-2.5 transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
                >
                  <span className="block font-display text-fs-md text-hero-ink">{item.title}</span>
                  {item.description && (
                    <span className="mt-0.5 block text-fs-xs text-hero-ink-soft">{item.description}</span>
                  )}
                </Link>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * The organizer entry. An OUTLINED button (owner, 2026-09-23: "change the For Organizers
 * button like this" — the hairline-framed ghost it showed over the hero photograph). It no
 * longer fills: a 1px frame and small-caps type, in the same ink as the links beside it,
 * so the bar reads as one quiet line. Over the homepage photograph the frame and type are
 * ink-on-media; on the solid bar they are editorial ink. Hover is where --action appears —
 * the frame and type take the action colour on the solid bar, and a faint white wash lifts
 * it over the photograph. 6px corner: --radius-control, the same as every other control.
 */
function OrganizerButton({ href, className, onClick, onMedia = false }: {
  href: string; className?: string; onClick?: () => void; onMedia?: boolean
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        'group/org inline-flex h-10 items-center justify-center gap-2 rounded-[var(--radius-control)] px-5',
        'border bg-transparent text-fs-xs font-semibold uppercase tracking-[0.14em]',
        onMedia
          ? 'border-ink-on-media/45 text-ink-on-media hover:border-ink-on-media/80 hover:bg-ink-on-media/10'
          : 'border-hero-ink/25 text-hero-ink hover:border-action hover:text-action',
        'transition-colors duration-200 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2',
        className,
      )}
    >
      {ORGANIZERS_LABEL}
      <ArrowRight
        className="size-3.5 transition-[translate] duration-200 ease-out group-hover/org:translate-x-[3px] motion-reduce:transition-none"
        strokeWidth={2.25}
        aria-hidden
      />
    </Link>
  )
}

// ── Mobile ───────────────────────────────────────────────────────────────────
// A full-height sheet under the bar, on the same glass. The sections enter one after
// another — a 40ms stagger, nothing theatrical — and the action closes the list as a
// full-width button, so the phone gets the same three things the desktop bar has:
// identity (the bar), sections, one door.
function MobilePanel({ open, onClose, organizersHref, reduce }: {
  open: boolean
  onClose: () => void
  organizersHref: string
  reduce: boolean
}) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey) }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          id={MOBILE_PANEL_ID}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: EASE }}
          className={cn(
            'fixed inset-x-0 bottom-0 top-[var(--disc-nav-h)] z-[99] flex flex-col overflow-y-auto lg:hidden',
            // 96, not the bar's 75: the sheet is a reading surface, and at 90 the blurred hero
            // imagery bled through as smudges behind the list. Enough glass to feel like the
            // same material; enough white to read on.
            'bg-background supports-[backdrop-filter]:bg-background/96 supports-[backdrop-filter]:backdrop-blur-xl',
          )}
        >
          <nav aria-label="Primary" className={cn(container.page, 'flex-1 pt-5')}>
            <p className="mb-2 flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
              <span aria-hidden className="h-px w-6 bg-hero-accent-rule" />
              Menu
            </p>
            {NAV_ENTRIES.map((menu, i) => {
              const href = hrefOf(menu)
              if (!href) return null
              return (
                <motion.div
                  key={menu.id}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.28, ease: EASE, delay: reduce ? 0 : 0.04 * i }}
                >
                  <Link
                    href={href}
                    onClick={onClose}
                    className={cn(
                      'group/m flex items-center gap-3.5 border-b border-border/60 py-3.5',
                      'font-display text-fs-xl font-light tracking-[-0.01em] text-hero-ink',
                      'transition-colors duration-200 hover:text-action',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action',
                    )}
                  >
                    <span aria-hidden className="w-6 shrink-0 font-sans text-fs-2xs font-semibold tabular-nums tracking-[0.16em] text-hero-accent-rule">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="flex-1">{labelOf(menu)}</span>
                    <ArrowRight
                      className="size-4 text-hero-accent-rule transition-[translate,color] duration-200 ease-out group-hover/m:translate-x-[3px] group-hover/m:text-action motion-reduce:transition-none"
                      strokeWidth={2}
                      aria-hidden
                    />
                  </Link>
                </motion.div>
              )
            })}
          </nav>

          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: EASE, delay: reduce ? 0 : 0.04 * NAV_ENTRIES.length }}
            className={cn(container.page, 'pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-4')}
          >
            <OrganizerButton href={organizersHref} onClick={onClose} className="h-11 w-full" />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function HomeNavbar() {
  const scrolled = useScrolled()
  const reduce = useReducedMotion() ?? false
  const [mobileOpen, setMobileOpen] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const pathname = usePathname() ?? '/'

  const closeMobile = useCallback(() => setMobileOpen(false), [])
  const clearHover  = useCallback(() => setHovered(null), [])

  // The canonical sign-in destination, straight from the CTA registry. "For Organizers"
  // is a label on this door, not a new one.
  const organizersHref = getCta('login').href

  // Homepage, at the top, menu closed: the bar sits on the hero photograph.
  const overHero = pathname === '/' && !scrolled && !mobileOpen

  return (
    <>
      <header
        className={cn(
          'fixed inset-x-0 top-0 z-[100] border-b transition-[border-color,background-color,backdrop-filter] duration-300 ease-out print:hidden',
          // Glass. Opaque where the engine cannot blur, so type never sits on raw imagery.
          //
          // `bg-clip-padding` stops the background at the PADDING edge instead of the
          // border edge. At rest this border is `border-transparent`, and a transparent
          // border over a border-box background shows the element's own white — a 1px
          // white strip painted across whatever sits beneath the bar. The shell pads
          // <main> by --disc-nav-h while the header's box is --disc-nav-h + that 1px, so
          // the strip lands exactly on the first row of the landing hero: invisible at 1x,
          // but a pale seam at 1.25x and 2x, where it straddles device pixels (measured
          // rgb(211,213,217) at 1.25x, rgb(202,203,206) at 2x). Clipping to the padding box
          // lets the transparent border reveal what is actually behind the bar, so the hero
          // meets the navbar with nothing between them. When `scrolled` turns the border
          // opaque, the border paints its own colour and nothing here changes.
          overHero
            ? 'bg-clip-padding border-transparent bg-transparent'
            : cn(
                'bg-clip-padding bg-background supports-[backdrop-filter]:bg-background/75 supports-[backdrop-filter]:backdrop-blur-xl',
                scrolled ? 'border-border/70' : 'border-transparent',
              ),
        )}
      >
        {/* container.page — the SAME container the hero and the search capsule use, so
            the wordmark and the button land on the page's own gutters. */}
        <div className={cn(container.page, 'grid h-[var(--disc-nav-h)] grid-cols-[1fr_auto_1fr] items-center')}>

          {/* Left gutter: identity. The mark + name + tagline as text, from the ONE
              lockup component — the SVG is the mark alone. */}
          <div className="flex items-center justify-start">
            <BrandLockup size="lg" priority tone={overHero ? 'media' : 'default'} />
          </div>

          {/* Centre: the sections. The pointer-tracking chip lives on this <nav> so a
              single mouse-leave clears it for every item at once. */}
          <nav
            aria-label="Primary"
            onMouseLeave={clearHover}
            onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) clearHover() }}
            className="hidden items-center gap-1 lg:flex"
          >
            {NAV_ENTRIES.map(menu => {
              const href = hrefOf(menu)
              const active = menu.href
                ? pathname === menu.href
                : pathname.startsWith(`/${menu.id}`)
              return (
                <DesktopItem
                  key={menu.id}
                  menu={menu}
                  active={Boolean(href) && active}
                  hovered={hovered === menu.id}
                  animate={!reduce}
                  onHover={setHovered}
                  overHero={overHero}
                />
              )
            })}
          </nav>

          {/* Right gutter: the one action, and the menu control on a phone. */}
          <div className="col-start-3 flex items-center justify-end gap-2">
            <OrganizerButton href={organizersHref} onMedia={overHero} className="hidden sm:inline-flex" />

            <button
              type="button"
              onClick={() => setMobileOpen(o => !o)}
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileOpen}
              aria-controls={MOBILE_PANEL_ID}
              className={cn(
                'flex size-9 cursor-pointer items-center justify-center rounded-[var(--radius-control)]',
                'border transition-colors duration-300',
                overHero
                  ? 'border-white/30 text-ink-on-media hover:bg-white/10'
                  : 'border-border text-foreground hover:bg-muted',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2 lg:hidden',
              )}
            >
              {/* The icon swaps; it does not spin. */}
              {mobileOpen ? <X className="size-[18px]" aria-hidden /> : <Menu className="size-[18px]" aria-hidden />}
            </button>
          </div>
        </div>
      </header>

      <MobilePanel
        open={mobileOpen}
        onClose={closeMobile}
        organizersHref={organizersHref}
        reduce={reduce}
      />
    </>
  )
}
