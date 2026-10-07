'use client'

// ─── Landing hero — the statement ────────────────────────────────────────────
//
// Everything set over the photograph: the eyebrow, the headline, the description, the
// chapter controls and the three quiet highlights. It receives the slide index from the
// stage and animates the copy with the score in heroMotion.ts — the same five phases,
// the same upward travel, the same reduced-motion set as before. What changed is the
// material, not the choreography.
//
// ═══ THE HEADLINE ════════════════════════════════════════════════════════════
// Set in the display serif (font-display, Fraunces) at a size that makes it the largest
// thing in the viewport after the photograph — the one element at real scale. The
// emphasised phrase is ITALIC and warm (--hero-accent-rule), not a gradient: on a
// photograph, gradient text competes with the picture; an italic in a second colour
// reads as a hand-set line. Which phrase it is stays a copy decision in heroSlides.
//
// WEIGHT 300, NOT 400. Fraunces is a high-contrast serif: at display size its regular
// weight puts thick stems against a dark photograph and the line reads as BULK — the
// difference between a display face and a heavy one. The light weight keeps the
// hairline-to-stem contrast that is the reason to use this face at all, and lets the size
// stay generous without shouting. Tracking closes to -0.02em because the gaps a serif
// opens between letters grow with the point size; leading sits just above 1 so the two
// lines read as one lockup rather than as two sentences.
//
// The ceiling of the size clamp is set by the LONGEST accent line, not by the first
// slide: at 4.75rem every slide sets in two lines from 820px up (measured 1440 / 1280 /
// 820). Above that the longest line wrapped to three while the others stayed at two,
// and a headline that changes shape every 7.6 seconds reads as a bug. On a 390px phone
// that same line still takes three — the alternative is display type too small to carry
// the hero — and the copy grows UPWARD from its anchor, so nothing below it moves.
//
// ═══ CENTRED (owner, 2026-09-23) ════════════════════════════════════════════
// The statement is set on the centre axis: the eyebrow between two bronze hairlines, the
// headline and description centred under it, then — on lg — the three highlights as one
// centred row divided by hairlines, and the chapter controls centred at the foot as
// ‹ 01 / 03 ─── ›. A centred block reads as an invitation rather than a column of body
// copy, and the photograph is no longer weighted to one side.
//
// ═══ LAYOUT SHIFT ════════════════════════════════════════════════════════════
// The block is bottom-anchored: the copy grows up into the photograph and the controls
// beneath it never move, whatever a slide's copy runs to. The controls and the
// highlights sit below in normal flow; only the statement above them changes.

import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useSyncExternalStore, type ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { HERO_SLIDES } from './heroSlides'
import { HERO_MOTION, HERO_MOTION_REDUCED } from './heroMotion'

/** A store that never changes — useSyncExternalStore then only answers "server or client?". */
const subscribeNever = () => () => {}

/** "01 / 03" reads as a chapter; "1 / 3" reads as a fraction. */
const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The headline's second line with ONE phrase set in italic and the warm accent.
 * A phrase that is not found renders plain, so a copy edit that forgets to update
 * `headlineEmphasis` loses the treatment, never the word.
 */
function AccentLine({ text, emphasis }: { text: string; emphasis: string }) {
  const at = emphasis ? text.indexOf(emphasis) : -1
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <em className="not-italic">
        <span className="italic text-hero-accent-rule">{emphasis}</span>
      </em>
      {text.slice(at + emphasis.length)}
    </>
  )
}

const CONTROL =
  'inline-flex size-11 items-center justify-center rounded-full border border-ink-on-media/30 text-ink-on-media ' +
  'transition-colors hover:border-ink-on-media/80 hover:bg-ink-on-media/10 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-on-media/70 focus-visible:ring-offset-2 focus-visible:ring-offset-hero-ink'

export interface HeroCopyProps {
  index:   number
  onPrev:  () => void
  onNext:  () => void
  /** One server-rendered "Featured · event" credit per slide, or null for a curated one. */
  credits: readonly ReactNode[]
}

export function HeroCopy({ index, onPrev, onNext, credits }: HeroCopyProps) {
  const reduce = useReducedMotion()
  // HYDRATION: the server cannot know the visitor's motion preference, so it always renders
  // the full score. Choosing the reduced set during the FIRST client render made the
  // initial styles differ from the server HTML — a hydration mismatch on every device with
  // Reduce Motion on. `hydrated` is false for that first render and true after, so the
  // reduced set applies one commit later instead of disagreeing with the server.
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false)
  const m = hydrated && reduce ? HERO_MOTION_REDUCED : HERO_MOTION
  const slide = HERO_SLIDES[index]

  return (
    <div className="relative z-[3] flex h-full flex-col justify-end">
      {/* ── The statement. One box for every slide; the copy changes inside it. ── */}
      <div className="mx-auto w-full max-w-[52rem] text-center">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={slide.id}
            variants={m.copyGroup}
            initial="initial"
            animate="enter"
            exit="exit"
            aria-live="polite"
          >
            <motion.p
              variants={m.eyebrow}
              className="flex items-center justify-center gap-3 text-fs-2xs font-medium uppercase tracking-[0.22em] text-ink-on-media/75 sm:tracking-[0.3em]"
            >
              <span aria-hidden className="hidden h-px w-10 shrink-0 bg-hero-accent-rule sm:block" />
              {slide.eyebrow}
              <span aria-hidden className="hidden h-px w-10 shrink-0 bg-hero-accent-rule sm:block" />
            </motion.p>

            <motion.h1
              variants={m.headline}
              className={cn(
                'mt-3.5 font-display font-light text-ink-on-media',
                'text-[clamp(2.125rem,4.6vw,4rem)] leading-[1.04] tracking-[-0.02em]',
                'text-balance',
              )}
            >
              <span className="block">{slide.headlineLead}</span>
              <span className="block">
                <AccentLine text={slide.headlineAccent} emphasis={slide.headlineEmphasis} />
              </span>
            </motion.h1>

            <motion.p
              variants={m.description}
              className="mx-auto mt-5 max-w-[36rem] text-fs-md leading-relaxed text-ink-on-media-muted"
            >
              {slide.description}
            </motion.p>

            {credits[index] ? (
              <motion.div variants={m.description} className="mt-5 flex justify-center">
                {credits[index]}
              </motion.div>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── The highlights (lg) and the chapter controls, centred. Normal flow, below the
             statement, so they never move when the copy above changes. ── */}
      <div className="mt-7 flex flex-col items-center gap-6 lg:mt-8 lg:gap-7">
        <AnimatePresence mode="wait" initial={false}>
          <motion.ul
            key={slide.id}
            variants={m.highlightGroup}
            initial="initial"
            animate="enter"
            exit="exit"
            className="hidden divide-x divide-ink-on-media/20 lg:flex"
          >
            {slide.highlights.map(h => (
              <motion.li key={h.label} variants={m.highlight} className="px-9 text-center">
                <p className="text-fs-2xs font-medium uppercase tracking-[0.18em] text-ink-on-media">{h.label}</p>
                <p className="mt-1 text-fs-sm text-ink-on-media-muted">{h.detail}</p>
              </motion.li>
            ))}
          </motion.ul>
        </AnimatePresence>

        <div className="flex items-center gap-4 sm:gap-5">
          <button type="button" onClick={onPrev} className={CONTROL} aria-label="Previous">
            <ArrowLeft className="size-4" aria-hidden />
          </button>

          <div className="flex items-center gap-4">
            <p className="flex items-baseline gap-1.5 font-display text-fs-lg font-light tabular-nums text-ink-on-media" aria-live="polite">
              <motion.span key={slide.id} {...m.numeral}>{pad(index + 1)}</motion.span>
              <span className="text-ink-on-media/40">/</span>
              <span className="text-ink-on-media/60">{pad(HERO_SLIDES.length)}</span>
            </p>
            {/* the progress hairline — its animation is keyed to the slide, restarting
                with each change; paused with the timer by data-paused on the stage */}
            <span className="relative block h-px w-20 overflow-hidden bg-ink-on-media/20 sm:w-28" aria-hidden>
              <span key={slide.id} className="rd-hero-progress absolute inset-0 bg-hero-accent-rule" />
            </span>
          </div>

          <button type="button" onClick={onNext} className={CONTROL} aria-label="Next">
            <ArrowRight className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  )
}
