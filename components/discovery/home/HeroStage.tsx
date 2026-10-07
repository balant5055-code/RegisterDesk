'use client'

// ─── Landing hero — the stage ────────────────────────────────────────────────
//
// The ONE owner of the hero's slide index. The photographs and the copy both respond to
// it, so it cannot live in either of them.
//
// ═══ WHAT STAYS ON THE SERVER ════════════════════════════════════════════════
// `backdrop` and `credits` arrive as ReactNode PROPS, already rendered by the server
// component above. React keeps a server-rendered subtree server-rendered when it is
// passed through a client component, so the photographs — and next/image with them —
// never enter the client bundle. The index is published as a data attribute and CSS
// does the crossfade (RD-HERO-03 in app/globals.css).
//
// ═══ AUTOPLAY ════════════════════════════════════════════════════════════════
// One setTimeout per slide, re-armed on each index change, cleared on unmount. Its
// duration is read from `--hero-autoplay` — the same custom property that drives the
// progress hairline and the photograph's drift — so none of the three can drift apart.
// The exported constant is only the fallback for a browser that returns nothing.
//
// It stops while the pointer is over the hero, while focus is anywhere inside it, and
// entirely under prefers-reduced-motion, where content that changes by itself is
// exactly what the preference is asking not to happen. `data-paused` pauses the CSS
// animations in the same tick, so the line and the drift freeze with the timer.
//
// ═══ GEOMETRY ════════════════════════════════════════════════════════════════
// The stage is the full width of the <section> — it IS the section's background, so it
// reaches the browser edge without a negative margin or a 100vw anywhere. The copy sits
// inside the same centred container every other section uses, bottom-anchored, with
// enough bottom padding for the search capsule that HomeHero pulls up over the stage's
// lower edge. Height is a viewport fraction with a floor and a ceiling: tall enough to
// be a picture, never so tall that the search is below the fold.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { container } from '@/lib/ds/containers'
import { HERO_SLIDES, HERO_AUTOPLAY_MS } from './heroSlides'
import { HeroCopy } from './HeroCopy'

const COUNT = HERO_SLIDES.length

/** `--hero-autoplay` is authored in ms; parseFloat also copes with a seconds value. */
function autoplayMs(): number {
  if (typeof window === 'undefined') return HERO_AUTOPLAY_MS
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--hero-autoplay').trim()
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n) || n <= 0) return HERO_AUTOPLAY_MS
  return raw.endsWith('ms') ? n : n * 1000
}

/**
 * The stage height. svh so a phone's collapsing address bar cannot resize the picture
 * mid-scroll; the floor keeps two lines of headline and the controls clear of the
 * capsule, the ceiling keeps the search above the fold on a tall display.
 *
 * THE CEILING IS WHAT SETS THE SPACE ABOVE THE EYEBROW. The copy is bottom-anchored, so
 * every pixel by which the stage exceeds the copy becomes empty photograph at the TOP —
 * a stage taller than it needs to be reads as a gap, not as air. Each ceiling here was
 * therefore MEASURED against the tallest copy that breakpoint has to hold, across all
 * three slides:
 *
 *   ≤419px   copy runs 318–354px (a 320 viewport wraps the accent line to three). At the
 *            old 26rem ceiling a 390 sat under 98–122px of dead sky. Floor and ceiling
 *            are now the SAME 23rem — a constant 368px — so the gap can no longer grow
 *            with the width, and 320 keeps the floor it needs for a three-line headline.
 *   ≥420px   a phone this wide sets the description in one line fewer, so the same 23rem
 *            reopened a 75px gap. 21.5rem (344px) brings it back to ~50, which is what
 *            every narrower phone shows. This is the one place the hero needs a step
 *            between 0 and sm: the copy changes shape there and `sm` is 220px away.
 *   sm       copy runs 302–310px; 22rem (352px) leaves 42–51px.
 *   lg       copy runs 348–368px as the headline takes its display sizes; 26.5rem (424px)
 *            left 56–76px. The CENTRED layout (2026-09-23) adds the highlights as their own
 *            row above the controls (~70px), so lg is now 29rem / 64svh.
 */
export const HERO_STAGE_H =
  'min-h-[23rem] h-[min(52svh,23rem)] ' +
  'min-[420px]:min-h-[21.5rem] min-[420px]:h-[min(52svh,21.5rem)] ' +
  'sm:min-h-[21rem] sm:h-[min(58svh,22rem)] ' +
  'lg:min-h-[26rem] lg:h-[min(64svh,29rem)]'

export interface HeroStageProps {
  /** Every slide's photograph, server-rendered (HeroBackdrop). */
  backdrop: ReactNode
  /** One server-rendered featured-event credit per slide, null for a curated slide. */
  credits:  readonly ReactNode[]
}

export function HeroStage({ backdrop, credits }: HeroStageProps) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [reduce, setReduce] = useState(false)

  // Read through an effect rather than useReducedMotion() so the TIMER can be switched
  // off, not just the animation. A listener keeps it live if the setting changes.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduce(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    if (paused || reduce) return
    const t = setTimeout(() => setIndex(i => (i + 1) % COUNT), autoplayMs())
    return () => clearTimeout(t)
  }, [index, paused, reduce])

  const next = useCallback(() => setIndex(i => (i + 1) % COUNT), [])
  const prev = useCallback(() => setIndex(i => (i - 1 + COUNT) % COUNT), [])

  // Left/Right step through the slides whenever focus is inside the hero — the standard
  // carousel keyboard contract. Any other key is left alone so Tab still works normally.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); prev() }
    if (e.key === 'ArrowRight') { e.preventDefault(); next() }
  }, [prev, next])

  return (
    <div
      data-hero-stage=""
      data-active={index}
      data-paused={paused ? 'true' : 'false'}
      role="group"
      aria-roledescription="carousel"
      aria-label="What you can do on RegisterDesk"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={onKeyDown}
      className={cn('relative isolate w-full', HERO_STAGE_H)}
    >
      {backdrop}

      {/* the copy, in the page container, bottom-anchored above the capsule's overlap */}
      <div className={cn(container.page, 'relative z-[3] flex h-full flex-col pb-12 pt-7 sm:pb-14 lg:pb-14')}>
        <HeroCopy index={index} onPrev={prev} onNext={next} credits={credits} />
      </div>
    </div>
  )
}
