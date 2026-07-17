'use client'

// Intelligent first-run onboarding /welcome (GA-3 S2). Refinement, not redesign.
// Reuse-first: MarketingLogo, Card / Button / StatusChip / ProgressBar, framer-motion,
// brand tokens. Content adapts to REAL organizer state fetched from EXISTING APIs
// (/api/organizer/dashboard + /api/organizer/payout-profile) — the loading is genuine.
// Motion respects prefers-reduced-motion. Routing/redirects/CTA targets preserved.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import {
  ArrowRight, CheckCircle2, CalendarPlus, Settings, Wallet, BarChart3, PartyPopper,
} from 'lucide-react'
import { Button, Card, StatusChip, ProgressBar } from '@/components/ui'
import { MarketingLogo } from '@/components/marketing/MarketingLogo'
import { ROUTES } from '@/config/navigation'
import { auth } from '@/lib/firebase/auth'
import type { DashboardData } from '@/app/api/organizer/dashboard/route'
import type { PayoutProfileGetResponse } from '@/lib/payout/types'

// ─── Motion vocabulary (reuses the existing easing) ────────────────────────────

const EASE = [0.22, 1, 0.36, 1] as const
const container: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } } }
const item: Variants     = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE } } }
const cardIn: Variants   = { hidden: { opacity: 0, y: 24, scale: 0.96 }, show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 260, damping: 24, mass: 0.9 } } }
const pop: Variants      = { hidden: { opacity: 0, scale: 0.5 }, show: { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 380, damping: 15 } } }

const LOADING_STEPS = ['Authentication', 'Loading Workspace', 'Loading Profile', 'Loading Permissions'] as const
const CONFETTI = Array.from({ length: 12 }, (_, i) => {
  const angle = (i / 12) * Math.PI * 2
  const dist  = 64 + (i % 3) * 16
  const colors = ['var(--primary)', 'var(--primary-from)', 'var(--primary-to)']
  return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist, color: colors[i % colors.length] }
})
const AUTO_REDIRECT_SECONDS = 5
const WELCOME_FLAG = 'rd_welcome_celebrated'

// ─── First-visit persistence (no dedicated profile-preference field exists → the
//     sanctioned localStorage fallback). Guarded; SSR-safe (called from effects). ─
function readFirstVisit(): boolean {
  try { return !localStorage.getItem(WELCOME_FLAG) } catch { return false }
}
function markVisited(): void { try { localStorage.setItem(WELCOME_FLAG, new Date().toISOString()) } catch { /* ignore */ } }
function playSuccessSound(): void { /* future-ready hook — intentionally disabled (no audio) */ }

// ─── Smart onboarding derivation (from existing dashboard/payout data) ─────────

interface SmartAction { label: string; href: string }
function smartPrimary(d: DashboardData | null): SmartAction {
  if (!d) return { label: 'Open Dashboard', href: ROUTES.DASHBOARD }
  const ls = d.licenseSummary
  if (ls.pendingApproval > 0) return { label: 'View Pending Event', href: ROUTES.DASHBOARD_EVENTS }
  if (ls.published > 0)        return { label: 'Manage Events',       href: ROUTES.DASHBOARD_EVENTS }
  if (ls.changesRequested > 0 || ls.rejected > 0) return { label: 'Manage Events', href: ROUTES.DASHBOARD_EVENTS }
  return { label: 'Create your first event', href: ROUTES.NEW_EVENT }
}

interface NextStep { key: string; label: string; href: string; icon: typeof CalendarPlus; priority?: boolean }
function buildNextSteps(d: DashboardData | null, payoutMissing: boolean): NextStep[] {
  const done = new Map((d?.healthScore.items ?? []).map(i => [i.label, i.done] as const))
  const eventPublished = done.get('Event published') ?? false
  const profileDone    = (done.get('Organization name') ?? false) && (done.get('Organization logo') ?? false) && (done.get('Support email address') ?? false)

  const steps: NextStep[] = []
  if (!eventPublished) steps.push({ key: 'event',   label: 'Create your first event',       href: ROUTES.NEW_EVENT,                     icon: CalendarPlus, priority: true })
  if (!profileDone)    steps.push({ key: 'profile', label: 'Complete Organization Profile',  href: ROUTES.DASHBOARD_SETTINGS,            icon: Settings })
  if (payoutMissing)   steps.push({ key: 'payout',  label: 'Configure Payout Details',       href: ROUTES.DASHBOARD_FINANCE_PAYOUT_PROFILE, icon: Wallet })
  if (steps.length === 0) steps.push({ key: 'analytics', label: 'Explore Analytics', href: ROUTES.DASHBOARD, icon: BarChart3 })
  return steps.slice(0, 4)
}

// ─── Subtle brand background (gentle gradient movement; reduced-motion aware) ───

function BrandBackground({ reduced }: { reduced: boolean }) {
  const drift = (delay: number) =>
    reduced ? {} : { animate: { scale: [1, 1.08, 1], opacity: [0.75, 1, 0.75] }, transition: { duration: 9, repeat: Infinity, ease: 'easeInOut' as const, delay } }
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <motion.div {...drift(0)}   className="absolute left-1/2 top-[-12%] size-[560px] -translate-x-1/2 rounded-full bg-primary/10 blur-[130px]" />
      <motion.div {...drift(1.5)} className="absolute bottom-[-18%] left-[12%] size-[380px] rounded-full bg-primary-from/10 blur-[120px]" />
      <motion.div {...drift(3)}   className="absolute right-[8%] top-[18%] size-[320px] rounded-full bg-primary-to/10 blur-[120px]" />
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WelcomePage() {
  const router  = useRouter()
  const reduced = !!useReducedMotion()

  const [name, setName]           = useState('')
  const [ready, setReady]         = useState(false)
  const [progress, setProgress]   = useState(0)
  const [step, setStep]           = useState(0)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [payoutMissing, setPayoutMissing] = useState(false)
  const [celebrate, setCelebrate] = useState(false)
  const [count, setCount]         = useState(AUTO_REDIRECT_SECONDS)
  const [cancelled, setCancelled] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Genuine loading — waits on two real API calls, with a short premium floor.
  useEffect(() => {
    const user = auth.currentUser
    if (!user) { router.replace(ROUTES.LOGIN); return }
    if (!user.emailVerified) { router.replace(ROUTES.VERIFY_EMAIL); return }
    const first = user.displayName?.split(' ')[0] ?? user.email?.split('@')[0] ?? 'there'

    let alive = true
    let dash: DashboardData | null = null
    let payoutNull = false
    let settled = false

    void (async () => {
      try {
        const token = await user.getIdToken()
        const headers = { authorization: `Bearer ${token}` }
        const [dRes, pRes] = await Promise.all([
          fetch('/api/organizer/dashboard', { headers, cache: 'no-store' }).catch(() => null),
          fetch('/api/organizer/payout-profile', { headers, cache: 'no-store' }).catch(() => null),
        ])
        if (dRes?.ok) dash = await dRes.json() as DashboardData
        if (pRes?.ok) payoutNull = ((await pRes.json()) as PayoutProfileGetResponse).profile === null
      } catch { /* graceful — generic content */ }
      finally { settled = true }
    })()

    const MIN = reduced ? 0 : 700
    const MAX = 6000
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      if (!alive) return
      const elapsed = now - start
      const cap = settled ? 100 : 90
      setProgress(Math.min(cap, (elapsed / Math.max(MIN, 1)) * 100))
      setStep(elapsed < MIN * 0.33 ? 1 : elapsed < MIN * 0.66 ? 2 : 3)
      if ((settled && elapsed >= MIN) || elapsed >= MAX) {
        const firstVisit = readFirstVisit()
        if (firstVisit) { markVisited(); playSuccessSound() }
        setProgress(100)
        setName(first)
        setDashboard(dash)
        setPayoutMissing(payoutNull)
        setCelebrate(firstVisit && !reduced)
        setReady(true)
      } else {
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => { alive = false; cancelAnimationFrame(raf) }
  }, [router, reduced])

  // Focus the heading once revealed (a11y).
  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => headingRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [ready])

  // Auto-redirect countdown — cancellable by any user action.
  useEffect(() => {
    if (!ready || cancelled) return
    const id = setInterval(() => {
      setCount(c => { if (c <= 1) { clearInterval(id); router.push(ROUTES.DASHBOARD); return 0 } return c - 1 })
    }, 1000)
    return () => clearInterval(id)
  }, [ready, cancelled, router])

  const cancelCountdown = useCallback(() => setCancelled(true), [])

  const primary   = useMemo(() => smartPrimary(dashboard), [dashboard])
  const nextSteps = useMemo(() => buildNextSteps(dashboard, payoutMissing), [dashboard, payoutMissing])
  const score     = dashboard?.healthScore.score ?? 0

  // ── Loading screen ──
  if (!ready) {
    return (
      <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-5 py-16">
        <BrandBackground reduced={reduced} />
        <div role="status" aria-live="polite" className="relative z-10 flex w-full max-w-[320px] flex-col items-center text-center">
          <MarketingLogo className="h-7 w-auto md:h-[30px] lg:h-[30px]" priority />
          <p className="mt-8 text-sm font-semibold text-foreground">Preparing your workspace…</p>
          <div className="mt-4 w-full"><ProgressBar value={progress} tone="primary" label="Preparing your workspace" /></div>
          <p className="mt-3 text-[12.5px] font-medium text-muted-foreground">
            <CheckCircle2 className="mr-1 inline size-3.5 align-[-2px] text-success" aria-hidden />
            {LOADING_STEPS[step]}…
          </p>
        </div>
      </main>
    )
  }

  // ── Welcome card ──
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-5 py-16 sm:px-8">
      <BrandBackground reduced={reduced} />

      <motion.div variants={container} initial={reduced ? false : 'hidden'} animate="show" className="relative z-10 w-full max-w-[480px]">

        {/* Logo — same component/size as the marketing navbar, subtle float + first-run glow */}
        <motion.div variants={item} className="relative mb-8 flex justify-center">
          {celebrate && (
            <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
              {CONFETTI.map((c, i) => (
                <motion.span key={i} className="absolute size-1.5 rounded-full"
                  style={{ background: c.color }}
                  initial={{ opacity: 1, x: 0, y: 0, scale: 0 }}
                  animate={{ opacity: 0, x: c.x, y: c.y, scale: 1 }}
                  transition={{ duration: 0.9, ease: 'easeOut' }} />
              ))}
              <motion.span className="absolute left-1/2 top-1/2 size-24 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/20 blur-2xl"
                initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: [0, 0.9, 0], scale: 1.2 }} transition={{ duration: 1.1, ease: 'easeOut' }} />
            </span>
          )}
          <motion.div animate={reduced ? undefined : { y: [0, -4, 0] }} transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}>
            <MarketingLogo className="h-7 w-auto md:h-[30px] lg:h-[30px]" priority />
          </motion.div>
        </motion.div>

        {/* Card */}
        <motion.div variants={cardIn}>
          <Card variant="modal" padded={false} className="overflow-hidden">
            <div className="h-1.5 w-full" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden />

            <div className="px-7 pb-8 pt-8 sm:px-10 sm:pb-10">
              {/* Celebration icon */}
              <motion.div variants={pop} className="mb-6 flex justify-center">
                <span className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/15">
                  <PartyPopper className="size-7 text-primary" aria-hidden />
                </span>
              </motion.div>

              {/* Title */}
              <motion.h1 ref={headingRef} tabIndex={-1} variants={item}
                className="text-center text-fs-2xl font-bold tracking-tight text-foreground outline-none">
                Welcome to RegisterDesk
              </motion.h1>

              {/* Subtitle */}
              <motion.p variants={item} className="mx-auto mt-3 max-w-[380px] text-center text-sm leading-relaxed text-muted-foreground">
                Hi <span className="font-semibold text-foreground">{name}</span>, your workspace is ready.
                Start managing registrations, check-ins, payments and analytics from one place.
              </motion.p>

              {/* Success timeline (milestones) */}
              <motion.div variants={item} className="mt-6 rounded-xl border border-border bg-muted/20 p-4">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <StatusChip tone="success"><CheckCircle2 className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />Email Verified</StatusChip>
                  <StatusChip tone="success"><CheckCircle2 className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />Workspace Activated</StatusChip>
                  <StatusChip tone="success"><CheckCircle2 className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />Ready to Publish Events</StatusChip>
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-[11.5px] text-muted-foreground">
                    <span>Workspace setup</span><span className="tabular-nums">{score}%</span>
                  </div>
                  <ProgressBar value={score} tone={score >= 100 ? 'success' : 'primary'} label={`Workspace setup ${score}% complete`} />
                </div>
              </motion.div>

              {/* Dynamic next steps */}
              <motion.div variants={item} className="mt-6">
                <div className="mb-3 flex items-center gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Next steps</span>
                  <span className="h-px flex-1 bg-border" aria-hidden />
                </div>
                <ul className="space-y-1.5">
                  {nextSteps.map(({ key, label, href, icon: Icon, priority }) => (
                    <li key={key}>
                      <Link href={href} onClick={cancelCountdown}
                        className="group flex items-center gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-2 text-[13.5px] transition-colors hover:bg-muted">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors group-hover:bg-primary/20">
                          <Icon className="size-3.5" aria-hidden />
                        </span>
                        <span className="font-medium text-foreground">{label}</span>
                        {priority && <StatusChip tone="primary" className="ml-1">Priority</StatusChip>}
                        <ArrowRight className="ml-auto size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              </motion.div>

              {/* Primary CTA (smart action) — appears last */}
              <motion.div variants={item} className="mt-8">
                <Button variant="primary" size="lg" className="w-full cursor-pointer gap-2"
                  onClick={() => { cancelCountdown(); router.push(primary.href) }}>
                  {primary.label}
                  <ArrowRight className="size-4" aria-hidden />
                </Button>

                {/* Auto-redirect countdown */}
                <div role="status" aria-live="polite" className="mt-3 text-center text-[12.5px] text-muted-foreground">
                  {cancelled ? (
                    <span>Auto-redirect cancelled — take your time.</span>
                  ) : (
                    <>
                      Taking you to your dashboard in <span className="font-semibold tabular-nums text-foreground">{count}</span>s ·{' '}
                      <button type="button" onClick={cancelCountdown} className="font-semibold text-foreground underline-offset-4 hover:underline">Stay here</button>
                    </>
                  )}
                </div>
              </motion.div>
            </div>
          </Card>
        </motion.div>

        {/* Footer */}
        <motion.p variants={item} className="mt-6 text-center text-[13px] text-muted-foreground">
          Need help?{' '}
          <a href="mailto:support@registerdesk.in" className="font-semibold text-foreground underline-offset-4 hover:underline">Contact support</a>
        </motion.p>
      </motion.div>
    </main>
  )
}
