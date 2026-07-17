'use client'

// Homepage hero — the product focal point (client). A near-full-width RegisterDesk
// operations console in a browser frame, floated on an elegant brand-tinted
// backdrop. The window dominates the page; the modules live inside it (sidebar,
// table, and a detail rail), so no floating chrome is needed. Reuses the product
// UI kit; entrance respects reduced motion.

import { motion, useReducedMotion } from 'framer-motion'
import { BrowserFrame } from '@/components/marketing/product/BrowserFrame'
import { RegistrationsConsole } from '@/components/marketing/product/RegistrationsConsole'

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]

export function HeroProduct() {
  const reduce = useReducedMotion() ?? false

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 32, scale: 0.985 }}
      animate={reduce ? undefined : { opacity: 1, y: 0, scale: 1 }}
      transition={reduce ? undefined : { duration: 0.8, delay: 0.15, ease: EASE }}
      className="relative mx-auto w-full max-w-7xl"
    >
      <BrowserFrame url="app.registerdesk.in/registrations">
        <RegistrationsConsole />
      </BrowserFrame>
    </motion.div>
  )
}
