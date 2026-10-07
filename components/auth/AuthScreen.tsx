'use client'

import type { ReactNode } from 'react'
import { motion, type Variants } from 'framer-motion'
import { BrandLockup } from '@/components/marketing/BrandLockup'
import { EASE, fadeUp } from './authMotion'
import { AuthShell } from './AuthShell'
import { AuthCard } from './AuthCard'
import { AuthFooter } from './AuthFooter'
import { PublicAccentScope } from './PublicAccentScope'

// ─── AuthScreen ───────────────────────────────────────────────────────────────
// THE shared shell for the organizer auth steps that are not /login itself:
// forgot-password, verify-email (OTP) and verify-email-success. A page supplies only
// `children` — what goes inside the card — so the three steps are identical around it.
//
// ═══ 2026-09-24 · ONE CENTRED COLUMN (owner: "I don't want this layout") ══════
// The magenta marketing panel and the mobile gradient strip are gone. These screens now
// share /login's composition: the tinted auth canvas, the 2px brand rule on the top
// edge, the canonical lockup, and one centred card — so moving from sign-in to the
// verification code no longer looks like arriving on a different product.
//
// ═══ THE PUBLIC ACCENT, SCOPED ═══════════════════════════════════════════════
// The step pages were written against the organizer accent (bg-primary/10, the
// `primary` Button, OTP focus in --primary) — magenta. Rather than rewrite three
// pages, this shell re-points the --primary family at --action for the duration of the
// screen, exactly as the public register route does (app/events/[slug]/register/
// layout.tsx). The organizer dashboard, which never mounts AuthScreen, is untouched.

// (The token remap itself lives in PublicAccentScope, shared with /welcome.)

const stagger: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
}

export interface AuthScreenProps {
  /** Content rendered inside the shared AuthCard. */
  children: ReactNode
}

export function AuthScreen({ children }: AuthScreenProps) {
  const column = (
    <div className="flex min-h-dvh flex-col px-5 py-8 sm:px-8">
      {/* The 2px brand rule across the top edge — the same signature /login carries. */}
      <span aria-hidden className="rd-brand-gradient fixed inset-x-0 top-0 z-10 h-0.5" />

      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: EASE }}
        className="flex justify-center"
      >
        <BrandLockup size="sm" />
      </motion.div>

      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="mx-auto mt-[clamp(1.5rem,6vh,4.5rem)] w-full max-w-[480px]"
      >
        {/* No back link out here: every step carries its own inside the card (Back to
            Sign In / Back to Home), and a second one below it repeated the same exit. */}
        <AuthCard>{children}</AuthCard>
      </motion.div>

      {/* The closing line — what RegisterDesk is, no claim, no number. */}
      <motion.div variants={fadeUp} initial="hidden" animate="show" className="mt-auto pt-10">
        <div className="mx-auto max-w-[480px] border-t border-border/60 pt-4">
          <AuthFooter>
            RegisterDesk — event operations for organizers.
          </AuthFooter>
        </div>
      </motion.div>
    </div>
  )

  return (
    <PublicAccentScope>
      <AuthShell right={column} />
    </PublicAccentScope>
  )
}
