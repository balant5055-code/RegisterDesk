'use client'

import { startTransition, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion, type Variants } from 'framer-motion'
import {
  ArrowRight,
  CalendarPlus,
  CheckCircle2,
  LayoutDashboard,
  Settings,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { ROUTES } from '@/config/navigation'
import { auth } from '@/lib/firebase/auth'

// ─── Animation constants ──────────────────────────────────────────────────────

const EASE = [0.22, 1, 0.36, 1] as const

const stagger: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.1, delayChildren: 0.15 } },
}

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
}

const scaleFade: Variants = {
  hidden: { opacity: 0, scale: 0.85 },
  show:   { opacity: 1, scale: 1, transition: { duration: 0.55, ease: EASE } },
}

// ─── Action card data ─────────────────────────────────────────────────────────

const ACTIONS = [
  {
    icon:  CalendarPlus,
    title: 'Create an event',
    desc:  'Set up ticketing and registration in minutes.',
    href:  ROUTES.NEW_EVENT,
    cta:   'Get started',
  },
  {
    icon:  Settings,
    title: 'Complete your profile',
    desc:  'Add your logo, brand color, and support email.',
    href:  ROUTES.DASHBOARD_SETTINGS,
    cta:   'Go to settings',
  },
  {
    icon:  LayoutDashboard,
    title: 'Explore the dashboard',
    desc:  'View analytics, registrations, and check-in tools.',
    href:  ROUTES.DASHBOARD,
    cta:   'View dashboard',
  },
] as const

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WelcomePage() {
  const router    = useRouter()
  const [name, setName] = useState<string>('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const user = auth.currentUser
    if (!user) {
      router.replace(ROUTES.LOGIN)
      return
    }
    if (!user.emailVerified) {
      router.replace(ROUTES.VERIFY_EMAIL)
      return
    }
    startTransition(() => {
      setName(user.displayName?.split(' ')[0] ?? user.email?.split('@')[0] ?? 'there')
      setReady(true)
    })
  }, [router])

  if (!ready) return null

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-16 sm:px-8">

      {/* Subtle radial glow behind the card */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
      >
        <div className="h-[600px] w-[600px] rounded-full bg-primary/5 blur-3xl" />
      </div>

      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="relative z-10 w-full max-w-[480px]"
      >
        {/* ── Logo ── */}
        <motion.div variants={fadeUp} className="mb-10 flex justify-center">
          <Link
            href={ROUTES.HOME}
            className="flex items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="flex size-8 items-center justify-center rounded-[8px] bg-primary text-[11px] font-bold tracking-widest text-primary-foreground">
              RD
            </span>
            RegisterDesk
          </Link>
        </motion.div>

        {/* ── Card ── */}
        <motion.div
          variants={fadeUp}
          className="overflow-hidden rounded-2xl bg-card shadow-[0_4px_32px_rgb(0_0_0/0.1),0_1px_4px_rgb(0_0_0/0.05)] ring-1 ring-border"
        >
          {/* Brand bar */}
          <div
            className="h-2 w-full"
            style={{ backgroundImage: 'var(--primary-gradient)' }}
          />

          <div className="px-8 pb-8 pt-8 sm:px-10 sm:pb-10">

            {/* Hero emoji */}
            <motion.div variants={scaleFade} className="mb-6 flex justify-center">
              <span className="text-4xl leading-none" role="img" aria-label="Party">🎉</span>
            </motion.div>

            {/* Heading */}
            <motion.div variants={fadeUp} className="mb-3 text-center">
              <h1 className="text-[1.65rem] font-bold tracking-tight text-foreground">
                Welcome, {name}!
              </h1>
            </motion.div>

            {/* Sub-text */}
            <motion.p
              variants={fadeUp}
              className="mb-6 text-center text-sm leading-relaxed text-muted-foreground"
            >
              Your RegisterDesk account is ready. Start creating and managing
              professional events today.
            </motion.p>

            {/* Verified badge */}
            <motion.div variants={fadeUp} className="mb-8 flex justify-center">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1.5 text-sm font-semibold text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-400">
                <CheckCircle2 className="size-4" aria-hidden />
                Email Verified &amp; Account Activated
              </span>
            </motion.div>

            {/* Action cards */}
            <motion.div variants={fadeUp} className="mb-8 space-y-3">
              {ACTIONS.map(({ icon: Icon, title, desc, href, cta }) => (
                <Link
                  key={title}
                  href={href}
                  className="group flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-4 transition-colors duration-150 hover:bg-muted"
                >
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 transition-colors duration-150 group-hover:bg-primary/20">
                    <Icon className="size-4 text-primary" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="mb-0.5 text-sm font-semibold text-foreground">{title}</p>
                    <p className="text-[12.5px] leading-relaxed text-muted-foreground">{desc}</p>
                  </div>
                  <span className="mt-0.5 shrink-0 text-[12.5px] font-semibold text-primary opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    {cta} →
                  </span>
                </Link>
              ))}
            </motion.div>

            {/* Primary CTA */}
            <motion.div variants={fadeUp}>
              <Button
                variant="primary"
                size="lg"
                className="w-full cursor-pointer gap-2"
                onClick={() => router.push(ROUTES.DASHBOARD)}
              >
                Go to Dashboard
                <ArrowRight className="size-4" aria-hidden />
              </Button>
            </motion.div>

          </div>
        </motion.div>

        {/* Footer */}
        <motion.p
          variants={fadeUp}
          className="mt-6 text-center text-[13px] text-muted-foreground"
        >
          Need help?{' '}
          <a
            href="mailto:support@registerdesk.in"
            className="font-semibold text-foreground underline-offset-4 hover:underline"
          >
            Contact support
          </a>
        </motion.p>
      </motion.div>
    </main>
  )
}
