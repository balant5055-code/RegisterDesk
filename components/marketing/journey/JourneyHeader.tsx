'use client'

// Journey heading — premium through typography only (no underline/brush/SVG).
// The brand gradient (same utility as the Hero) is applied to "event lifecycle"
// only; everything else stays #0F172A. Eyebrow · heading · subtitle fade up with
// a 60ms stagger on scroll into view. Respects prefers-reduced-motion.

import { motion, useReducedMotion } from 'framer-motion'
import { typography } from '@/lib/ds/typography'
import { Eyebrow } from '@/components/marketing/Eyebrow'
import { marketingType } from '@/lib/marketing/theme'
import { GradientText } from '@/components/marketing/GradientText'
import { JOURNEY_HEADING } from '@/content/marketing/journey'

const ACCENT = 'event lifecycle'
const BEFORE = JOURNEY_HEADING.title.split(ACCENT)[0]

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]
const CONTAINER = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } }
const ITEM = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } } }

export function JourneyHeader() {
  const reduce = useReducedMotion() ?? false
  return (
    <motion.div
      initial={reduce ? false : 'hidden'}
      whileInView="visible"
      viewport={{ once: true, amount: 0.5 }}
      variants={CONTAINER}
      className="mx-auto max-w-3xl text-center"
    >
      <motion.div variants={ITEM}>
        <Eyebrow>{JOURNEY_HEADING.eyebrow}</Eyebrow>
      </motion.div>

      <motion.h2
        variants={ITEM}
        id="journey-heading"
        className={`mx-auto mt-5 max-w-[720px] text-balance ${marketingType.sectionHeading}`}
      >
        {JOURNEY_HEADING.title.includes(ACCENT) ? (
          <>
            {BEFORE}
            <GradientText>{ACCENT}</GradientText>
          </>
        ) : (
          JOURNEY_HEADING.title
        )}
      </motion.h2>

      <motion.p variants={ITEM} className={`${typography.body} mx-auto mt-4 max-w-xl text-muted-foreground`}>
        {JOURNEY_HEADING.subtitle}
      </motion.p>
    </motion.div>
  )
}
