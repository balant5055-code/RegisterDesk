'use client'

// Marketing journey kit — JourneyTimeline. One continuous operating flow:
// horizontal on desktop, vertical on mobile. Premium entrance (once, on scroll):
// the connector draws first, then the nodes/titles/descriptions fade up left→
// right (40ms stagger). Respects prefers-reduced-motion. Reusable on platform pages.

import { motion, useReducedMotion } from 'framer-motion'
import { JourneyStep } from './JourneyStep'
import type { JourneyStepDef } from '@/lib/marketing/types'

const EASE = [0.16, 1, 0.3, 1] as const

const LINE_X = { hidden: { scaleX: 0 }, visible: { scaleX: 1, transition: { duration: 0.6, ease: EASE } } }
const LINE_Y = { hidden: { scaleY: 0 }, visible: { scaleY: 1, transition: { duration: 0.6, ease: EASE } } }
const LIST   = { hidden: {}, visible: { transition: { delayChildren: 0.3, staggerChildren: 0.04 } } }
const ITEM   = { hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } } }

export function JourneyTimeline({ steps }: { steps: JourneyStepDef[] }) {
  const reduce = useReducedMotion() ?? false
  const initial = reduce ? false : 'hidden'

  return (
    <>
      {/* Desktop — horizontal journey. One 1px line through the node centers,
          fading at both ends; the white nodes sit exactly on it. */}
      <motion.div
        initial={initial}
        whileInView="visible"
        viewport={{ once: true, amount: 0.4 }}
        className="relative mx-auto mt-9 hidden max-w-6xl lg:block"
      >
        <motion.span variants={LINE_X} aria-hidden className="absolute inset-x-[7.14%] top-[26px] h-px origin-left bg-gradient-to-r from-transparent via-border to-transparent" />
        <motion.ol variants={LIST} className="grid grid-cols-7 gap-4">
          {steps.map(step => (
            <motion.li key={step.id} variants={ITEM}>
              <JourneyStep step={step} orientation="horizontal" />
            </motion.li>
          ))}
        </motion.ol>
      </motion.div>

      {/* Mobile / tablet — vertical journey. */}
      <motion.div
        initial={initial}
        whileInView="visible"
        viewport={{ once: true, amount: 0.2 }}
        className="relative mx-auto mt-9 max-w-md lg:hidden"
      >
        <motion.span variants={LINE_Y} aria-hidden className="absolute bottom-[26px] left-[26px] top-[26px] w-px origin-top bg-gradient-to-b from-transparent via-border to-transparent" />
        <motion.ol variants={LIST} className="space-y-8">
          {steps.map(step => (
            <motion.li key={step.id} variants={ITEM}>
              <JourneyStep step={step} orientation="vertical" />
            </motion.li>
          ))}
        </motion.ol>
      </motion.div>
    </>
  )
}
