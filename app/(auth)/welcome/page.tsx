'use client'

// Intelligent first-run onboarding /welcome (GA-3 S2). Refinement, not redesign.
// Reuse-first: BrandLockup, Card / Button / StatusChip / ProgressBar, framer-motion,
// brand tokens. Content adapts to REAL organizer state fetched from EXISTING APIs
// (/api/organizer/dashboard + /api/organizer/payout-profile) — the loading is genuine.
// Motion respects prefers-reduced-motion. Routing/redirects/CTA targets preserved.

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import {
  ArrowRight, CheckCircle2, CalendarPlus, Settings, Wallet, BarChart3, PartyPopper,
} from 'lucide-react'
import { Button, ProgressBar } from '@/components/ui'
import { BrandLockup } from '@/components/marketing/BrandLockup'
import { AUTH_CANVAS_BG } from '@/components/auth/AuthSplitLayout'
import { PublicAccentScope } from '@/components/auth/PublicAccentScope'
import { PopperSpray, CornerCannons } from '@/components/auth/ConfettiBurst'
import { cn } from '@/lib/utils/cn'
import { ROUTES } from '@/config/navigation'
import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'
import { useAuth } from '@/components/auth/AuthProvider'
import { resolveAuthGuard } from '@/lib/auth/authGuard'
import type { DashboardData } from '@/app/api/organizer/dashboard/route'
import type { PayoutProfileGetResponse } from '@/lib/payout/types'

// ─── Motion vocabulary (reuses the existing easing) ────────────────────────────

const EASE = [0.22, 1, 0.36, 1] as const
const container: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } } }
const item: Variants     = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE } } }
const cardIn: Variants   = { hidden: { opacity: 0, y: 24, scale: 0.96 }, show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 260, damping: 24, mass: 0.9 } } }
const pop: Variants      = { hidden: { opacity: 0, scale: 0.5 }, show: { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 380, damping: 15 } } }

const LOADING_STEPS = ['Authentication', 'Loading Workspace', 'Loading Profile', 'Loading Permissions'] as const
const WELCOME_FLAG = 'rd_welcome_celebrated'

// RD-ORGANIZER-WELCOME-ONBOARDING-10 · this page no longer navigates on its own.
//
// It used to hold AUTO_REDIRECT_SECONDS = 5 and a setInterval that pushed to /dashboard when
// the counter ran out, with a "Stay here" button to cancel it. That made the one screen a
// first-time organizer needs to READ into a screen they had to react to: five seconds is not
// long enough to take in how the product works, and a refresh restarted the clock. The page
// is now a destination — every navigation away from it is an explicit choice below.

/** The platform's own onboarding model, in the product's existing vocabulary. */
const HOW_IT_WORKS = [
  { n: '01', title: 'Create your event',   body: 'Add your event details, date, venue, branding and registration settings.' },
  { n: '02', title: 'Set up registration', body: 'Create passes, pricing, registration fields and payment options.' },
  { n: '03', title: 'Publish & share',     body: 'Publish your event and share the registration page with attendees.' },
  { n: '04', title: 'Manage everything',   body: 'Registrations, attendees, payments, communications, check-in, certificates and reports — from your dashboard.' },
] as const

/** The PLATFORM support inbox — the same source app/(dashboard)/dashboard/settings reads.
 *  Deliberately NOT the organizer's own `organizationProfile.supportEmail`, which is
 *  attendee-facing and would send a "help me get started" note straight back to themselves. */
const PLATFORM_SUPPORT_EMAIL = BUSINESS_CONFIG_DEFAULTS.branding.supportEmail

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
  // RD-DASH-08 — keyed on the check's stable `id`, not its LABEL. The labels are display
  // copy: this lookup silently reported every step as incomplete the moment one was reworded,
  // and `?? false` meant the breakage looked exactly like a genuinely unfinished workspace.
  const done = new Map((d?.workspaceHealth.checks ?? []).map(c => [c.id, c.done] as const))
  const eventPublished = done.get('published_event') ?? false
  const profileDone    = (done.get('org_name') ?? false) && (done.get('logo') ?? false) && (done.get('support_email') ?? false)

  const steps: NextStep[] = []
  if (!eventPublished) steps.push({ key: 'event',   label: 'Create your first event',       href: ROUTES.NEW_EVENT,                     icon: CalendarPlus, priority: true })
  if (!profileDone)    steps.push({ key: 'profile', label: 'Complete Organization Profile',  href: ROUTES.DASHBOARD_SETTINGS,            icon: Settings })
  if (payoutMissing)   steps.push({ key: 'payout',  label: 'Configure Payout Details',       href: ROUTES.DASHBOARD_FINANCE_PAYOUT_PROFILE, icon: Wallet })
  if (steps.length === 0) steps.push({ key: 'analytics', label: 'Explore Analytics', href: ROUTES.DASHBOARD, icon: BarChart3 })
  return steps.slice(0, 4)
}

// ─── Subtle brand background (gentle gradient movement; reduced-motion aware) ───


// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WelcomePage() {
  const router  = useRouter()
  const reduced = !!useReducedMotion()

  // RD-AUTH-01 Phase 4 (H-C): auth from the shared AuthProvider + the ONE canonical
  // guard resolver (same as the dashboard layout) — no synchronous auth.currentUser read.
  const { user } = useAuth()
  const guard    = resolveAuthGuard(user)

  const [name, setName]           = useState('')
  const [ready, setReady]         = useState(false)
  const [progress, setProgress]   = useState(0)
  const [step, setStep]           = useState(0)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [payoutMissing, setPayoutMissing] = useState(false)
  const [celebrate, setCelebrate] = useState(false)
  // Each increment fires a fresh burst (the popper tile replays it on click).
  const [burst, setBurst] = useState(1)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Canonical guard (RD-AUTH-01 Phase 4 / H-C): redirect only once auth has resolved,
  // from the shared AuthProvider state — never auth.currentUser synchronously on mount.
  useEffect(() => {
    if (guard.redirect) router.replace(guard.redirect)
  }, [guard.redirect, router])

  // Genuine loading — waits on two real API calls, with a short premium floor. Runs only
  // after the canonical guard authorizes (auth resolved + email verified); the loading
  // screen below covers the resolving / redirecting window.
  useEffect(() => {
    if (guard.status !== 'authorized' || !user) return
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
        setCelebrate(!reduced)
        setReady(true)
      } else {
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => { alive = false; cancelAnimationFrame(raf) }
  }, [guard.status, user, reduced])

  // Focus the heading once revealed (a11y).
  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => headingRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [ready])

  const primary   = useMemo(() => smartPrimary(dashboard), [dashboard])
  // The primary button already IS one of these steps for a brand-new organizer, and the two
  // rendered adjacently — "Create your first event" as a list row, then the same words as the
  // full-width button directly beneath it. Dropping the row the button duplicates leaves the
  // list saying only what the button does not.
  const nextSteps = useMemo(
    () => buildNextSteps(dashboard, payoutMissing).filter(s => s.href !== primary.href),
    [dashboard, payoutMissing, primary.href],
  )
  // A literal completion ratio over the setup checklist — which is what this onboarding
  // screen is actually showing. The dashboard's fabricated "health score" is gone; a
  // "3 of 6 steps done" progress bar on a setup screen is a tally, not a health model.
  const setup     = dashboard?.workspaceHealth.setup
  const score     = setup && setup.total > 0 ? Math.round((setup.done / setup.total) * 100) : 0

  // ── Loading screen ──
  // ═══ 2026-09-24 · LUXURY PASS (owner) ═══════════════════════════════════════
  // Same logic, same data, same hand-off — only the setting changed. The pink drifting
  // blobs and the gradient cap are gone; the page sits on the tinted auth canvas with the
  // 2px brand rule on the top edge (the same place /login and verify-email live), and the
  // card is one hairline panel. The heading is the display face set light; the three
  // milestones are a ruled checklist rather than three green pills; next steps are squared
  // rows with a bronze-outlined icon, and "Priority" is a small-caps note, not a badge.
  // PublicAccentScope turns every --primary utility the card still uses into the public
  // indigo, so nothing here is magenta.

  if (!ready) {
    return (
      <PublicAccentScope>
        <main className={cn('relative flex min-h-dvh items-center justify-center px-5 py-16', AUTH_CANVAS_BG)}>
          <span aria-hidden className="rd-brand-gradient fixed inset-x-0 top-0 z-10 h-0.5" />
          <div role="status" aria-live="polite" className="flex w-full max-w-[320px] flex-col items-center text-center">
            <BrandLockup size="sm" priority />
            <p className="mt-10 font-display text-fs-xl font-light text-hero-ink">Preparing your workspace…</p>
            <div className="mt-5 w-full"><ProgressBar value={progress} tone="primary" label="Preparing your workspace" /></div>
            <p className="mt-3 text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-eyebrow">
              {LOADING_STEPS[step]}…
            </p>
          </div>
        </main>
      </PublicAccentScope>
    )
  }

  const MILESTONES = ['Email verified', 'Workspace active', 'Ready to publish'] as const

  return (
    <PublicAccentScope>
      {/* overflow-x-clip · the celebration spray is decorative and pointer-events-none, but
          PopperSpray is positioned absolutely from the popper's centre with no clip of its
          own (CornerCannons already clips itself), so at narrow widths stray pieces pushed
          document.scrollWidth ~100px past the viewport and gave the page a horizontal
          scrollbar on mobile. `clip` rather than `hidden`: hidden on one axis forces the
          other to `auto`, which would turn this main into a scroll container. */}
      <main className={cn('relative flex min-h-dvh flex-col items-center overflow-x-clip px-5 py-10 sm:px-8', AUTH_CANVAS_BG)}>
        <span aria-hidden className="rd-brand-gradient fixed inset-x-0 top-0 z-10 h-0.5" />

        <motion.div variants={container} initial={reduced ? false : 'hidden'} animate="show" className="my-auto w-full max-w-[520px] lg:max-w-[1000px]">

          {/* The corner cannons — fixed to the viewport, click-through. */}
          {celebrate && <CornerCannons key={`c${burst}`} seed={burst * 97 + 13} />}

          <motion.div variants={item} className="mb-8 flex justify-center">
            <BrandLockup size="sm" priority />
          </motion.div>

          <motion.div variants={cardIn}>
            <div className="rounded-[var(--radius-panel)] border border-border/70 bg-card px-6 pb-8 pt-9 shadow-elevation-1 sm:px-10 sm:pb-10 lg:px-12">

              {/* ═══ WIDTH ═══════════════════════════════════════════════════════
                  The card runs to 1000px from `lg`, but the hero is not allowed to run
                  with it: a centred greeting reads as a headline at ~600px and as a
                  banner at 1000px. So the announcement keeps its own measure and the
                  card's extra width is spent below, where two stacked sections become
                  two columns. A `motion.div` rather than a plain one because framer
                  variants propagate only through motion components — a plain wrapper
                  here would strand every child at opacity 0. */}
              <motion.div className="mx-auto w-full max-w-[600px]">

              {/* The popper — the moment's one object. A soft indigo halo, a wiggle as it
                  lands, and the confetti spray from its centre. Click to fire it again. */}
              <motion.div variants={pop} className="flex justify-center">
                <span className="relative">
                  <span aria-hidden className="absolute -inset-6 rounded-full bg-[radial-gradient(circle,rgb(var(--action-rgb)/0.16),transparent_68%)]" />
                  <motion.button
                    type="button"
                    onClick={() => setBurst(b => b + 1)}
                    aria-label="Celebrate again"
                    title="Celebrate again"
                    animate={reduced ? undefined : { rotate: [0, -16, 12, -8, 4, 0] }}
                    transition={{ duration: 0.9, delay: 0.25, ease: 'easeInOut' }}
                    key={`p${burst}`}
                    className="relative flex size-[72px] cursor-pointer items-center justify-center rounded-[var(--radius-panel)] border border-hero-accent-rule/50 bg-card shadow-elevation-1 transition-colors hover:border-action/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
                  >
                    <PartyPopper className="size-8 text-hero-accent-rule" strokeWidth={1.4} aria-hidden />
                  </motion.button>
                  {celebrate && <PopperSpray key={`s${burst}`} seed={burst * 31 + 7} />}
                </span>
              </motion.div>

              <motion.p variants={item} className="mt-6 flex items-center justify-center gap-3 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
                <span aria-hidden className="h-px w-8 bg-hero-accent-rule" />
                Your workspace is ready
                <span aria-hidden className="h-px w-8 bg-hero-accent-rule" />
              </motion.p>

              <motion.h1 ref={headingRef} tabIndex={-1} variants={item}
                className="mt-3 text-balance text-center font-display text-fs-3xl font-light tracking-[-0.015em] text-hero-ink outline-none">
                Welcome to RegisterDesk, <em className="italic text-hero-accent-rule">{name}</em>
              </motion.h1>

              <motion.p variants={item} className="mt-3 text-center text-fs-sm font-medium text-hero-ink">
                Your organizer account is ready.
              </motion.p>

              <motion.p variants={item} className="mx-auto mt-1.5 max-w-[400px] text-center text-fs-sm leading-relaxed text-hero-ink-soft">
                Everything is set up. You can now create and manage your events, registrations
                and event operations from one place.
              </motion.p>

              {/* Milestones — a ruled checklist, then the setup meter. */}
              <motion.div variants={item} className="mt-7 border-y border-border/60 py-4">
                <ul className="flex flex-col items-center gap-2 sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-6">
                  {MILESTONES.map(m => (
                    <li key={m} className="flex items-center justify-center gap-1.5 whitespace-nowrap text-fs-2xs font-semibold uppercase tracking-[0.1em] text-hero-ink">
                      <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
                      {m}
                    </li>
                  ))}
                </ul>
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between text-fs-2xs font-semibold uppercase tracking-[0.14em] text-hero-eyebrow">
                    <span>Workspace setup</span><span className="tabular-nums text-hero-ink">{score}%</span>
                  </div>
                  <ProgressBar value={score} tone={score >= 100 ? 'success' : 'primary'} label={`Workspace setup ${score}% complete`} />
                </div>
              </motion.div>

              </motion.div>{/* end of the hero measure */}

              {/* ═══ THE TWO COLUMNS ═════════════════════════════════════════════
                  Below the announcement the page splits, because the two things left to
                  say are different in kind: what the product IS (static, four steps) and
                  what to DO now (this workspace's state, then the button). Stacked, they
                  were the reason the page ran well past a laptop viewport at any width —
                  the column was 520px whether the screen was 520px or 1920px. One column
                  until `lg`, so the phone layout is untouched. */}
              <motion.div className="mt-7 grid gap-7 lg:mt-8 lg:grid-cols-2 lg:gap-x-10">

              {/* How RegisterDesk works — the product model, stated once. Static by design:
                  this is what the platform IS, not what this workspace still needs (that is
                  the data-driven "Next steps" block below). Numbered because the four are a
                  genuine sequence, and event-type agnostic — nothing here assumes a sport, a
                  conference or a fundraiser. */}
              <motion.div variants={item}>
                <p className="mb-3 flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.2em] text-hero-eyebrow">
                  <span aria-hidden className="h-px w-5 bg-hero-accent-rule" />
                  How RegisterDesk works
                </p>
                {/* Two across while this is the full width of the card; back to one once it
                    is a half-width column, where two would leave ~200px per step. */}
                <ol className="grid gap-x-5 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-1 lg:gap-y-4">
                  {HOW_IT_WORKS.map(({ n, title, body }) => (
                    <li key={n} className="flex gap-2.5">
                      <span aria-hidden
                        className="shrink-0 pt-px font-display text-fs-xs font-normal tabular-nums tracking-[0.08em] text-hero-accent-rule">
                        {n}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-fs-sm font-medium text-hero-ink">{title}</span>
                        <span className="mt-0.5 block text-fs-xs leading-relaxed text-hero-ink-soft">{body}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </motion.div>

              {/* The action column: what this workspace still needs, then the button that
                  starts it. `justify-end` keeps the CTA on the bottom edge so it lines up
                  with the end of the four steps opposite instead of floating mid-column. */}
              <motion.div className="flex flex-col lg:justify-end">

              {/* Next steps — only when there is something left to say after the primary
                  button has claimed its own step. An empty heading is worse than no section. */}
              {nextSteps.length > 0 && (
              <motion.div variants={item} className="lg:mb-auto lg:pb-7">
                <p className="mb-3 flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.2em] text-hero-eyebrow">
                  <span aria-hidden className="h-px w-5 bg-hero-accent-rule" />
                  Next steps
                </p>
                <ul className="space-y-2">
                  {nextSteps.map(({ key, label, href, icon: Icon, priority }) => (
                    <li key={key}>
                      <Link href={href}
                        className="group flex items-center gap-3 rounded-[var(--radius-control)] border border-border/70 bg-card px-3 py-2.5 transition-colors hover:border-action/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-hero-accent-rule/40 text-hero-accent-rule transition-colors group-hover:border-action/40 group-hover:text-action">
                          <Icon className="size-4" strokeWidth={1.5} aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-fs-sm font-medium text-hero-ink">{label}</span>
                          {priority && (
                            <span className="block text-fs-2xs font-semibold uppercase tracking-[0.14em] text-hero-accent-rule">Start here</span>
                          )}
                        </span>
                        <ArrowRight className="ml-auto size-4 shrink-0 text-hero-ink-soft/50 transition-[color,translate] duration-200 group-hover:translate-x-0.5 group-hover:text-action motion-reduce:transition-none" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              </motion.div>
              )}

              {/* Primary CTA (smart action) */}
              <motion.div variants={item} className="mt-8 lg:mt-0">
                <Button variant="primary" size="lg" className="h-12 w-full cursor-pointer gap-2 rounded-[var(--radius-control)]"
                  onClick={() => router.push(primary.href)}>
                  {primary.label}
                  <ArrowRight className="size-4" aria-hidden />
                </Button>

                {/* Secondary action. Hidden when the smart primary already targets the
                    dashboard, so the two buttons can never say the same thing twice. */}
                {primary.href !== ROUTES.DASHBOARD && (
                  <Button variant="outline" size="lg"
                    className="mt-3 h-12 w-full cursor-pointer rounded-[var(--radius-control)]"
                    onClick={() => router.push(ROUTES.DASHBOARD)}>
                    Go to Dashboard
                  </Button>
                )}

                {/* Reassurance. True of the current wizard: it persists an eventDraft under
                    users/{uid}/eventDrafts, and /dashboard/events lists drafts so setup can be
                    resumed later — which is exactly why this promise is safe to make. */}
                <p className="mt-3.5 text-center text-fs-xs leading-relaxed text-hero-ink-soft">
                  You can start with a draft and complete your event setup whenever you&rsquo;re ready.
                </p>
              </motion.div>

              </motion.div>{/* end of the action column */}
              </motion.div>{/* end of the two columns */}
            </div>
          </motion.div>

          {/* Support — a dedicated area rather than a footnote, because "I don't know where
              to start" is the most likely reason a first-time organizer leaves. The address
              comes from BUSINESS_CONFIG_DEFAULTS.branding.supportEmail, the same platform
              inbox the settings page uses; it is never hard-coded here. */}
          {/* A row rather than a centred stack from `sm`: the copy and its one link sat in
              three stacked, centred lines that cost ~130px of height to say one sentence. */}
          <motion.div variants={item}
            className="mt-6 flex flex-col items-center gap-3 rounded-[var(--radius-panel)] border border-border/70 bg-card/60 px-5 py-4 text-center sm:flex-row sm:justify-between sm:gap-6 sm:px-6 sm:text-left">
            <div className="min-w-0">
              <p className="text-fs-sm font-medium text-hero-ink">Need help getting started?</p>
              <p className="mx-auto mt-1 max-w-[380px] text-fs-xs leading-relaxed text-hero-ink-soft sm:mx-0 sm:max-w-[520px]">
                Our team can help you set up your first event and answer questions about RegisterDesk.
              </p>
            </div>
            <a
              href={`mailto:${PLATFORM_SUPPORT_EMAIL}?subject=${encodeURIComponent('Help getting started with RegisterDesk')}`}
              className="inline-flex shrink-0 items-center gap-1.5 text-fs-sm font-semibold text-action underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
            >
              Contact Support
              <ArrowRight className="size-3.5" aria-hidden />
            </a>
          </motion.div>
        </motion.div>
      </main>
    </PublicAccentScope>
  )
}
