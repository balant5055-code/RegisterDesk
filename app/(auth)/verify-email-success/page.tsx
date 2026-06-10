'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { applyActionCode } from 'firebase/auth'
import { motion, type Variants } from 'framer-motion'
import {
  BadgeCheck,
  XCircle,
  Loader2,
  ArrowLeft,
  CalendarDays,
  Shield,
  Users,
  LogIn,
  RefreshCw,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { ROUTES } from '@/config/navigation'
import { auth, mapAuthError } from '@/lib/firebase/auth'

// ─── Animation constants (mirrors login / verify-email pages) ─────────────────

const EASE = [0.22, 1, 0.36, 1] as const

const panelVariants: Variants = {
  hidden: { opacity: 0, x: -32 },
  show:   { opacity: 1, x: 0, transition: { duration: 0.75, ease: EASE } },
}

const formVariants: Variants = {
  hidden: { opacity: 0, x: 28 },
  show:   { opacity: 1, x: 0, transition: { duration: 0.7, ease: EASE, delay: 0.12 } },
}

const stagger: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.09, delayChildren: 0.2 } },
}

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
}

// ─── Static data ──────────────────────────────────────────────────────────────

const FEATURES: { icon: LucideIcon; text: string }[] = [
  { icon: CalendarDays, text: 'Online registration & ticketing' },
  { icon: Shield,       text: 'QR-code check-in & verification' },
  { icon: Users,        text: 'Attendee management & analytics' },
]

const STATS = [
  { value: '500+',  label: 'Events'    },
  { value: '1.2M+', label: 'Check-ins' },
  { value: '99.9%', label: 'Uptime'    },
]

// ─── Types ────────────────────────────────────────────────────────────────────

type VerifyState = 'loading' | 'success' | 'error'

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VerifyEmailSuccessPage() {
  const searchParams = useSearchParams()
  const mode    = searchParams.get('mode')
  const oobCode = searchParams.get('oobCode')

  // If Firebase routed to this page with action params, process them.
  // If the user landed here via a plain redirect (continueUrl after Firebase verified), show success immediately.
  const hasActionCode = mode === 'verifyEmail' && Boolean(oobCode)

  const [verifyState, setVerifyState] = useState<VerifyState>(
    hasActionCode ? 'loading' : 'success',
  )
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const applied = useRef(false)

  useEffect(() => {
    if (!hasActionCode || applied.current) return
    applied.current = true
    void applyActionCode(auth, oobCode as string)
      .then(() => auth.currentUser?.reload())
      .then(() => setVerifyState('success'))
      .catch((err: unknown) => {
        setErrorMsg(mapAuthError(err))
        setVerifyState('error')
      })
  }, []) // intentional: oobCode is from the URL and doesn't change after mount

  return (
    <main className="min-h-screen bg-background">
      <div className="lg:grid lg:h-screen lg:grid-cols-[55%_45%]">

        {/* ── Left: brand panel ──────────────────────────────────────── */}
        <motion.aside
          variants={panelVariants}
          initial="hidden"
          animate="show"
          aria-hidden="true"
          className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between"
          style={{ backgroundImage: 'var(--primary-gradient)' }}
        >
          <div className="pointer-events-none absolute inset-0 select-none">
            <motion.div
              animate={{ scale: [1, 1.06, 1], opacity: [0.15, 0.28, 0.15] }}
              transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute -right-40 -top-40 h-[560px] w-[560px] rounded-full border border-primary-foreground/20"
            />
            <motion.div
              animate={{ scale: [1, 1.1, 1], opacity: [0.08, 0.18, 0.08] }}
              transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut', delay: 2.5 }}
              className="absolute -right-24 -top-24 h-[400px] w-[400px] rounded-full border border-primary-foreground/15"
            />
            <motion.div
              animate={{ y: [0, -24, 0] }}
              transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
              className="absolute -bottom-32 -left-32 h-[340px] w-[340px] rounded-full bg-primary-foreground/5 blur-3xl"
            />
            <motion.div
              animate={{ y: [0, 18, 0] }}
              transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut', delay: 3 }}
              className="absolute -left-16 top-1/3 h-64 w-64 rounded-full bg-primary-foreground/[0.06] blur-2xl"
            />
            <div
              className="absolute inset-0 opacity-[0.045]"
              style={{
                backgroundImage: `radial-gradient(circle, var(--primary-foreground) 1px, transparent 1px)`,
                backgroundSize: '30px 30px',
              }}
            />
          </div>

          <motion.div
            variants={stagger}
            initial="hidden"
            animate="show"
            className="relative flex flex-col gap-8 px-12 pt-12 xl:px-16 xl:pt-16"
          >
            <motion.div variants={fadeUp}>
              <Link
                href={ROUTES.HOME}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-foreground/60 transition-colors hover:text-primary-foreground"
              >
                <ArrowLeft className="size-3.5" aria-hidden />
                Back to home
              </Link>
            </motion.div>

            <motion.div variants={fadeUp} className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-[12px] bg-primary-foreground/15 ring-1 ring-primary-foreground/25 backdrop-blur-sm">
                <span className="text-sm font-bold tracking-widest text-primary-foreground">RD</span>
              </div>
              <span className="text-lg font-semibold text-primary-foreground">
                Register<span className="text-primary-foreground/60">Desk</span>
              </span>
            </motion.div>

            <motion.div variants={fadeUp} className="space-y-4">
              <h1 className="text-[2.15rem] font-bold leading-[1.15] tracking-tight text-primary-foreground xl:text-[2.5rem]">
                Your command center
                <br />
                for every event.
              </h1>
              <p className="max-w-[340px] text-base leading-relaxed text-primary-foreground/65">
                Manage registrations, check-ins, and real-time analytics —
                all from one powerful organizer dashboard.
              </p>
            </motion.div>

            <motion.ul variants={fadeUp} className="space-y-3">
              {FEATURES.map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-center gap-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-foreground/15">
                    <Icon className="size-3.5 text-primary-foreground" aria-hidden />
                  </span>
                  <span className="text-sm font-medium text-primary-foreground/80">{text}</span>
                </li>
              ))}
            </motion.ul>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, ease: EASE, delay: 0.6 }}
            className="relative px-12 pb-12 xl:px-16 xl:pb-16"
          >
            <div className="rounded-2xl bg-primary-foreground/10 px-6 py-5 ring-1 ring-primary-foreground/15 backdrop-blur-sm">
              <div className="flex items-center justify-around divide-x divide-primary-foreground/15">
                {STATS.map(({ value, label }) => (
                  <div key={label} className="flex flex-col items-center px-4 first:pl-0 last:pr-0">
                    <span className="text-[1.6rem] font-bold leading-none text-primary-foreground">{value}</span>
                    <span className="mt-1 text-xs font-medium text-primary-foreground/55">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        </motion.aside>

        {/* ── Right: content column ──────────────────────────────────── */}
        <div className="flex flex-col">

          {/* Mobile brand strip */}
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="px-6 pb-8 pt-8 lg:hidden"
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

          {/* Main content */}
          <motion.div
            variants={formVariants}
            initial="hidden"
            animate="show"
            className="flex flex-1 items-center justify-center px-5 py-12 sm:px-8 lg:min-h-screen"
          >
            <motion.div
              variants={stagger}
              initial="hidden"
              animate="show"
              className="w-full max-w-[420px]"
            >
              {/* Desktop back link — hidden while loading so it doesn't compete for attention */}
              {verifyState !== 'loading' && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="mb-8 hidden lg:block"
                >
                  <Link
                    href={verifyState === 'error' ? ROUTES.LOGIN : ROUTES.HOME}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
                  >
                    <ArrowLeft className="size-3.5" aria-hidden />
                    {verifyState === 'error' ? 'Back to sign in' : 'Back to home'}
                  </Link>
                </motion.div>
              )}

              {/* Card */}
              <motion.div
                variants={fadeUp}
                className="overflow-hidden rounded-2xl bg-card p-8 sm:p-10 shadow-[0_2px_28px_rgb(0_0_0/0.08),0_1px_4px_rgb(0_0_0/0.04)] ring-1 ring-border"
              >

                {/* ── Loading ─────────────────────────────────────────── */}
                {verifyState === 'loading' && (
                  <div className="flex flex-col items-center gap-5 py-4 text-center">
                    <div className="flex size-16 items-center justify-center rounded-2xl bg-muted ring-1 ring-border">
                      <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
                    </div>
                    <div>
                      <h2 className="text-[1.45rem] font-bold tracking-tight text-foreground">
                        Verifying your email
                      </h2>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Please wait a moment…
                      </p>
                    </div>
                  </div>
                )}

                {/* ── Success ─────────────────────────────────────────── */}
                {verifyState === 'success' && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.35, ease: EASE }}
                  >
                    <div className="mb-6 flex justify-center">
                      <motion.div
                        initial={{ opacity: 0, scale: 0.6 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.55, ease: EASE }}
                        className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20"
                      >
                        <BadgeCheck className="size-8 text-primary" aria-hidden />
                      </motion.div>
                    </div>

                    <div className="mb-8 text-center">
                      <h2 className="text-[1.45rem] font-bold tracking-tight text-foreground">
                        Email verified successfully
                      </h2>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        Your account is ready. You can now sign in and access your
                        organizer dashboard.
                      </p>
                    </div>

                    <div className="space-y-3">
                      <Link
                        href={ROUTES.LOGIN}
                        className={buttonVariants({
                          variant:   'primary',
                          size:      'lg',
                          className: 'w-full cursor-pointer',
                        })}
                      >
                        <LogIn className="size-4" aria-hidden />
                        Continue to Sign In
                      </Link>
                    </div>

                    <div className="mt-5 border-t border-border pt-5 text-center">
                      <Link
                        href={ROUTES.HOME}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
                      >
                        <ArrowLeft className="size-3.5" aria-hidden />
                        Back to Home
                      </Link>
                    </div>
                  </motion.div>
                )}

                {/* ── Error ───────────────────────────────────────────── */}
                {verifyState === 'error' && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.35, ease: EASE }}
                  >
                    <div className="mb-6 flex justify-center">
                      <div className="flex size-16 items-center justify-center rounded-2xl bg-destructive/10 ring-1 ring-destructive/20">
                        <XCircle className="size-8 text-destructive" aria-hidden />
                      </div>
                    </div>

                    <div className="mb-6 text-center">
                      <h2 className="text-[1.45rem] font-bold tracking-tight text-foreground">
                        Verification failed
                      </h2>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        {errorMsg ?? 'This link may have expired or already been used.'}
                      </p>
                    </div>

                    <div className="space-y-3">
                      <Link
                        href={ROUTES.VERIFY_EMAIL}
                        className={buttonVariants({
                          variant:   'primary',
                          size:      'lg',
                          className: 'w-full cursor-pointer',
                        })}
                      >
                        <RefreshCw className="size-4" aria-hidden />
                        Request a New Link
                      </Link>
                    </div>

                    <div className="mt-5 border-t border-border pt-5 text-center">
                      <Link
                        href={ROUTES.LOGIN}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
                      >
                        <ArrowLeft className="size-3.5" aria-hidden />
                        Back to Sign In
                      </Link>
                    </div>
                  </motion.div>
                )}

              </motion.div>

              {/* Footer — only when settled */}
              {verifyState !== 'loading' && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="mt-6 text-center text-[13px] text-muted-foreground"
                >
                  Not an organizer?{' '}
                  <Link
                    href={ROUTES.HOME}
                    className="font-semibold text-foreground underline-offset-4 hover:underline"
                  >
                    Browse events
                  </Link>
                </motion.p>
              )}
            </motion.div>
          </motion.div>
        </div>

      </div>
    </main>
  )
}
