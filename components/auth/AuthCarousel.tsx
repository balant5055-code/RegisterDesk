'use client'

import { useState, useCallback } from 'react'
import Image from 'next/image'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { AUTH_SLIDES, AUTH_CAROUSEL_FOOTNOTE } from './authCarouselSlides'

// ─── AuthCarousel ────────────────────────────────────────────────────────────
//
// The brand panel beside the sign-in form. Three editorial slides, moved by hand.
//
// ═══ NO AUTOPLAY ═════════════════════════════════════════════════════════════
// Deliberate, and a change from nothing rather than a removal: the panel it
// replaces (OrganizerAuthHero) had none either. Movement in the corner of the eye
// while someone is typing a password is a distraction, and an auto-advancing region
// beside a form is a WCAG 2.2.2 problem the moment it cannot be paused. The reader
// moves it or it stays still.
//
// ═══ EVERY SLIDE IS MOUNTED, ONE IS VISIBLE ══════════════════════════════════
// Cross-fading opacity rather than swapping the <img>, so an advance never shows a
// blank panel while the next file downloads. Only the FIRST carries `priority`; the
// other two are lazy, so the sign-in screen fetches one image, not three.
//
// ═══ IF AN IMAGE NEVER ARRIVES ═══════════════════════════════════════════════
// Unsplash is a third party and this is the sign-in screen. Each slide tracks its
// own failure and falls back to a token wash — the copy, the controls and the
// layout are unchanged, and nothing is logged to the console. The form is in the
// other column and never waits on any of this.
//
// The whole panel is aria-hidden by AuthSplitLayout: it is scenery, and announcing
// it to someone trying to sign in would be noise. The controls are therefore not
// reachable by keyboard either — which is correct for decorative content, and the
// reason none of the copy here carries information the form does not.
//
// ═══ THE PANEL IS ONE COMPOSITION, NOT THREE CORNERS ═════════════════════════
// The ordinal, the progress rules and the arrows used to sit in the top-right while
// the copy sat in the bottom-left, so the eye had to cross the whole panel to
// connect "02 / 03" with the sentence it counted. Everything that describes or
// moves the slide now lives in ONE bottom block: statement of purpose above,
// headline and body beneath it, counter and controls on the baseline. The top-right
// corner is empty on purpose — it is where a photograph's subject usually is.
//
// The copy is keyed on the index inside AnimatePresence, so it exchanges on a slide
// change rather than mutating under a fixed frame. That is a RESPONSE to a click,
// not ambient movement: it does not violate the no-autoplay rule above, and it is
// dropped entirely under prefers-reduced-motion by the variants below.

/** The neutral ground behind every slide, and the whole slide when an image fails.
 *  Token-only: the public action ramp at low alpha over the muted surface. */
const FALLBACK_WASH =
  'bg-[linear-gradient(160deg,rgb(var(--action-rgb)_/_0.16),rgb(var(--action-end-rgb)_/_0.10))]'

/** Copy exchange on a slide change. Short, and no travel worth calling movement. */
const COPY_MOTION = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit:    { opacity: 0, y: -6 },
  transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const },
}

export function AuthCarousel() {
  const [index, setIndex] = useState(0)
  const [failed, setFailed] = useState<Record<number, true>>({})
  const count = AUTH_SLIDES.length

  const go = useCallback((delta: number) => {
    setIndex(i => (i + delta + count) % count)
  }, [count])

  const slide = AUTH_SLIDES[index]!

  return (
    <div className="relative size-full bg-muted">

      {/* ── The images ─────────────────────────────────────────────────────── */}
      {AUTH_SLIDES.map((s, i) => (
        <div
          key={s.ordinal}
          className={cn(
            'absolute inset-0 transition-opacity duration-700 ease-out motion-reduce:transition-none',
            i === index ? 'opacity-100' : 'opacity-0',
          )}
        >
          {failed[i] ? (
            <div className={cn('size-full', FALLBACK_WASH)} />
          ) : (
            <Image
              src={s.src}
              alt={s.alt}
              fill
              // The panel is 55% of the viewport from lg, so never more than ~60vw.
              sizes="(min-width: 1024px) 55vw, 0px"
              priority={i === 0}
              loading={i === 0 ? undefined : 'lazy'}
              // A slow, held zoom on the ACTIVE slide only. It is a scale on a
              // photograph, not a moving element, and it settles: nothing beside the
              // password field is still travelling a second after the exchange.
              className={cn(
                'object-cover transition-transform duration-[1200ms] ease-out motion-reduce:transition-none',
                i === index ? 'scale-100' : 'scale-105',
              )}
              onError={() => setFailed(f => ({ ...f, [i]: true }))}
            />
          )}
        </div>
      ))}

      {/* ── Readability scrim ──────────────────────────────────────────────────
             Two layers, both ink, present only so the copy clears WCAG on a
             photograph whose brightness is not ours to control. Neither is a brand
             wash and neither tints the whole panel:

               • bottom-weighted, for the block that sits on the baseline;
               • left-weighted, because the copy is left-aligned and a bright
                 subject on the left edge of the frame would otherwise eat it.

             The bottom stop is deeper than it was (from/85) — measured on slide 01,
             whose lower third is a lit audience, the previous /70 left the body copy
             at 3.9:1. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-black/10" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black/45 via-transparent to-transparent" />

      {/* ── The composition, all of it, on the baseline ─────────────────────────
             Everything editorial is ONE measured column on the left — the statement
             of purpose, its hairline, the copy, the counter and the progress rules
             all share a left edge and a right edge. Only the arrows leave it, for
             the far corner, because a control that moves the panel is not part of
             what the panel says.

             The column is measured in ch rather than px so the rule ends where the
             text does at every width. Spanning the full panel (which it did in the
             first pass) drew a 1150px line across a photograph, reading as damage to
             the image rather than as structure. */}
      <div className="absolute inset-x-8 bottom-8 xl:inset-x-12 xl:bottom-11">
        <div className="flex items-end justify-between gap-10">
          <div className="min-w-0 max-w-[34ch] flex-1">

            {/* The statement of purpose leads, above a hairline. It is the one line
                true of all three slides, so it belongs to the panel rather than to
                any of them — and it does not move when the slide does. */}
            <p className="text-fs-2xs font-medium uppercase tracking-[0.2em] text-white/55">
              {AUTH_CAROUSEL_FOOTNOTE}
            </p>
            <span aria-hidden className="mt-4 block h-px w-full bg-white/15" />

            {/* Fixed minimum height so the counter row below never jumps between a
                one-line and a two-line headline — the block is bottom-anchored, so a
                shorter slide would otherwise pull the counter up the panel.

                The values are MEASURED, not guessed: across the three slides the copy
                occupies at most 100px at 1024 and 134px at 1440. The first pass
                reserved 152/168 and left 116-141px of dead air between the body copy
                and the counter, which pushed the whole editorial block up into the
                photograph. */}
            <div className="mt-6 min-h-[6.75rem] xl:min-h-[8.75rem]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={slide.ordinal}
                  initial={COPY_MOTION.initial}
                  animate={COPY_MOTION.animate}
                  exit={COPY_MOTION.exit}
                  transition={COPY_MOTION.transition}
                >
                  <h2 className="text-fs-2xl font-semibold leading-[1.14] tracking-[-0.025em] text-white xl:text-fs-3xl">
                    {slide.headline}
                  </h2>
                  <p className="mt-3 text-fs-md leading-relaxed text-white/75">
                    {slide.body}
                  </p>
                </motion.div>
              </AnimatePresence>
            </div>

            {/* ── Counter + progress, on the column's own left edge ─────────── */}
            <div className="mt-2 flex min-w-0 items-center gap-4">
              <span className="text-fs-2xs font-semibold uppercase tracking-[0.18em] text-white/90 tabular-nums">
                {slide.ordinal} <span className="text-white/45">/ {String(count).padStart(2, '0')}</span>
              </span>
              {/* Rules, not dots: three equal segments reading as a measure of the
                  set. Each is a target as well as an indicator — the panel is
                  decorative, so they stay out of the tab order like the arrows do. */}
              <span className="flex gap-1.5">
                {AUTH_SLIDES.map((s, i) => (
                  <button
                    key={s.ordinal}
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    onClick={() => setIndex(i)}
                    className="group flex h-4 w-9 cursor-pointer items-center"
                  >
                    <span
                      className={cn(
                        'h-0.5 w-full transition-colors duration-300',
                        i === index ? 'bg-white' : 'bg-white/30 group-hover:bg-white/60',
                      )}
                    />
                  </button>
                ))}
              </span>
            </div>
          </div>

          {/* ── Controls. Square by the radius token — no pills. ─────────────
                 The only thing outside the editorial column: they move the panel,
                 they do not describe it. Bottom-aligned with the counter row. */}
          <div className="flex shrink-0 gap-2">
            {([['Previous', -1, ChevronLeft], ['Next', 1, ChevronRight]] as const).map(
              ([label, delta, Icon]) => (
                <button
                  key={label}
                  type="button"
                  tabIndex={-1}
                  aria-label={label}
                  onClick={() => go(delta)}
                  className={cn(
                    'flex size-11 cursor-pointer items-center justify-center rounded-control',
                    'border border-white/25 bg-white/5 text-white/80 backdrop-blur-sm',
                    'transition-colors duration-200',
                    'hover:border-white/60 hover:bg-white/15 hover:text-white',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                </button>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
