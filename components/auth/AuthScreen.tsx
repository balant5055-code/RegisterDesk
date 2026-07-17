'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { motion, type Variants } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'
import { ROUTES } from '@/config/navigation'
import { EASE, fadeUp } from './authMotion'
import { AuthShell } from './AuthShell'
import { OrganizerAuthHero } from './OrganizerAuthHero'
import { AuthCard } from './AuthCard'
import { AuthFooter } from './AuthFooter'

// ─── AuthScreen ───────────────────────────────────────────────────────────────
// THE single organizer authentication shell. Every organizer auth entry screen
// (login, signup, forgot-password, verify-email/OTP, verify-email-success)
// renders its center-card content through this so the marketing panel, gradient,
// aurora, card width, paddings, radius, shadow, responsive breakpoints, top-right
// helper link and bottom trust line are IDENTICAL everywhere — the only thing a
// page supplies is `children` (what goes inside the card).
//
// This is a verbatim extraction of the login page's chrome — migrating a page to
// it changes nothing visually; it only removes duplicated markup.

// Right-column entrance (slide in) + stagger for the card/links.
const slideIn: Variants = {
  hidden: { opacity: 0, x: 28 },
  show:   { opacity: 1, x: 0, transition: { duration: 0.7, ease: EASE, delay: 0.12 } },
}
const stagger: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.09, delayChildren: 0.2 } },
}

export interface AuthScreenProps {
  /** Content rendered inside the shared AuthCard. */
  children: ReactNode
}

export function AuthScreen({ children }: AuthScreenProps) {
  const formColumn = (
    <div className="relative flex flex-col md:h-full md:overflow-hidden">

      {/* Top-right helper — pinned to the panel's top-right edge, hidden on mobile. */}
      <div className="absolute right-8 top-7 z-10 hidden md:block xl:right-12 xl:top-9">
        <p className="text-[13px] text-muted-foreground">
          Not an organizer?{' '}
          <Link
            href={ROUTES.HOME}
            className="font-semibold text-foreground underline-offset-4 hover:underline"
          >
            Browse events
          </Link>
        </p>
      </div>

      {/* Scroll wrapper — fills the locked shell height, scrolls INTERNALLY when
          the card is taller than the viewport; the page itself never scrolls. */}
      <div className="flex flex-col md:h-full md:overflow-y-auto">

        {/* Mobile brand strip */}
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="px-6 pb-8 pt-8 md:hidden"
          style={{ backgroundImage: 'var(--primary-gradient)' }}
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex size-11 items-center justify-center rounded-[12px] bg-primary-foreground/15 ring-1 ring-primary-foreground/25">
              <span className="text-[13px] font-bold tracking-widest text-primary-foreground">RD</span>
            </div>
            <div>
              <p className="text-base font-semibold text-primary-foreground">RegisterDesk</p>
              <p className="mt-0.5 text-sm text-primary-foreground/65">
                Your command center for every event.
              </p>
            </div>
          </div>
        </motion.div>

        {/* Form area — vertically centres the card in the locked panel height. */}
        <motion.div
          variants={slideIn}
          initial="hidden"
          animate="show"
          className="flex flex-1 items-center justify-center px-5 py-6 sm:px-8 md:min-h-full"
        >
          <motion.div
            variants={stagger}
            initial="hidden"
            animate="show"
            className="w-full max-w-[560px]"
          >
            {/* Desktop back link */}
            <motion.div variants={fadeUp} className="mb-6 hidden lg:block">
              <Link
                href={ROUTES.HOME}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" aria-hidden />
                Back to home
              </Link>
            </motion.div>

            <AuthCard>{children}</AuthCard>

            {/* Bottom trust line */}
            <motion.div variants={fadeUp} className="mt-6">
              <AuthFooter>
                Secure and trusted by thousands of organizers worldwide.
              </AuthFooter>
            </motion.div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  )

  return <AuthShell left={<OrganizerAuthHero from="md" />} right={formColumn} />
}
