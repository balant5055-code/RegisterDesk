'use client'

// /admin/login — Platform Admin login.
//
// This page lives in the (admin-auth) route group, NOT (admin), so the
// protected admin layout's auth gate does NOT wrap it — an unauthenticated
// visitor can reach the form instead of being bounced away in a redirect loop.
//
// It reuses the SINGLE shared authentication service (authenticateUser) and the
// SHARED presentation components. Only branding, the extra server-side admin
// authorization check, and the success redirect differ from organizer login.
//
// Flow:
//   authenticateUser()  → GET /api/admin/auth-check
//     200 → /admin/dashboard
//     403 → sign out immediately, show "no Platform Admin access"
//
// ═══ 2026-09-23 · ONE COLUMN, NO PINK ════════════════════════════════════════
// The owner retired this screen's magenta split (a --primary-gradient brand panel beside
// the form) and asked for the luxury treatment the rest of the site now has. It is the
// SAME composition as the public /login: a centred white column, the brand lockup, a
// bronze-ruled small-caps eyebrow, a light serif headline, and the form in a hairline
// panel (no shadow). LoginForm renders in its opt-in `editorial` tone: the --action
// accent, icon-free 6px fields, and the flat brand-ramp button. The auth flow above is
// unchanged line for line.

import { useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { signOut } from 'firebase/auth'
import { ShieldAlert, Lock, ArrowRight } from 'lucide-react'
import { auth, authenticateUser, mapAuthError } from '@/lib/firebase/auth'
import { LoginForm } from '@/components/auth'
import { fadeUp } from '@/components/auth/authMotion'
import { BrandLockup } from '@/components/marketing/BrandLockup'
import { AUTH_CANVAS_BG } from '@/components/auth/AuthSplitLayout'
import { Button } from '@/components/ui'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'

/** The hairline panel the form sits in — the same object /login uses. */
const PANEL = 'rounded-[var(--radius-panel)] border border-border/70 bg-card shadow-elevation-1 px-6 py-6 sm:px-8 [@media(min-height:760px)]:py-8'

const LINK =
  'font-semibold text-action underline-offset-4 hover:underline ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2'

// ─── Unauthorized state ───────────────────────────────────────────────────────

function UnauthorizedPanel({ onTryAnother }: { onTryAnother: () => void }) {
  return (
    <div className={cn(PANEL, 'text-center')}>
      <span aria-hidden className="mx-auto inline-flex size-12 items-center justify-center rounded-[var(--radius-control)] border border-destructive/30 text-destructive">
        <ShieldAlert className="size-5" strokeWidth={1.75} />
      </span>
      <h2 className="mt-5 font-display text-fs-2xl font-light text-hero-ink">Access restricted</h2>
      <p className="mt-2 text-fs-sm leading-relaxed text-hero-ink-soft">
        This account doesn&apos;t have Platform Admin access.
      </p>

      <div className="mt-7 space-y-3">
        <Link
          href={ROUTES.LOGIN}
          className={cn(
            'rd-brand-gradient inline-flex h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-control)]',
            'text-fs-base font-semibold text-white ring-1 ring-inset ring-white/15 transition-opacity hover:opacity-90',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2',
          )}
        >
          Return to Organizer Login
          <ArrowRight className="size-4" aria-hidden />
        </Link>
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={onTryAnother}
          className="h-12 w-full cursor-pointer rounded-[var(--radius-control)] border-border text-hero-ink shadow-none"
        >
          Try Another Account
        </Button>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminLoginPage() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [unauthorized, setUnauthorized] = useState(false)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const { user } = await authenticateUser(email, password)
      const token = await user.getIdToken()
      const res   = await fetch('/api/admin/auth-check', {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })

      if (res.ok) {
        // Full navigation so the protected admin layout mounts fresh and
        // re-verifies. Keep `loading` true through the redirect.
        window.location.replace(ROUTES.ADMIN_DASHBOARD)
        return
      }

      // Authenticated but NOT an admin → never leave them signed in.
      await signOut(auth).catch(() => null)
      setUnauthorized(true)
      setLoading(false)
    } catch (err) {
      setError(mapAuthError(err))
      setLoading(false)
    }
  }

  const tryAnother = () => {
    setUnauthorized(false)
    setError(null)
    setEmail('')
    setPassword('')
  }

  return (
    <main className={cn('flex min-h-dvh flex-col', AUTH_CANVAS_BG)}>
      {/* The 2px brand rule across the top edge — the same signature /login carries. */}
      <span aria-hidden className="rd-brand-gradient fixed inset-x-0 top-0 z-10 h-0.5" />

      <div className="flex flex-1 flex-col px-5 pb-[clamp(0.75rem,2.5vh,2rem)] pt-[clamp(0.875rem,2.5vh,3rem)] sm:px-8">
        <div className="flex justify-center">
          <BrandLockup size="sm" />
        </div>

        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="mx-auto mt-[clamp(1rem,3.5vh,4.5rem)] w-full max-w-[440px]"
        >
          {/* ── Intro ── */}
          <div className="text-center">
            <p className="inline-flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
              <span aria-hidden className="h-px w-6 bg-hero-accent-rule" />
              Platform Administration
              <span aria-hidden className="h-px w-6 bg-hero-accent-rule" />
            </p>
            <h1 className="mt-3 text-balance font-display text-fs-3xl font-light leading-[1.08] tracking-[-0.02em] text-hero-ink [@media(min-height:760px)]:sm:text-fs-4xl">
              Platform control, secured.
            </h1>
            <p className="mx-auto mt-3 max-w-[38ch] text-fs-base leading-relaxed text-hero-ink-soft">
              Sign in with your Platform Admin account to manage operations, finance, moderation and configuration.
            </p>
          </div>

          {/* ── The form ── */}
          <div className="mt-[clamp(1rem,3vh,2.25rem)]">
            {unauthorized ? (
              <UnauthorizedPanel onTryAnother={tryAnother} />
            ) : (
              <div className={PANEL}>
                <LoginForm
                  email={email}
                  password={password}
                  onEmailChange={setEmail}
                  onPasswordChange={setPassword}
                  onSubmit={handleSubmit}
                  loading={loading}
                  error={error}
                  submitLabel="Sign In to Admin Console"
                  emailPlaceholder="admin@registerdesk.in"
                  forgotPasswordHref={ROUTES.FORGOT_PASSWORD}
                  tone="editorial"
                />
              </div>
            )}
          </div>

          <p className="mt-5 text-center text-fs-sm text-hero-ink-soft">
            Not an admin?{' '}
            <Link href={ROUTES.LOGIN} className={LINK}>Organizer login</Link>
          </p>
        </motion.div>

        {/* Closing line — the restricted-access notice, pinned to the bottom of the column. */}
        <div className="mt-auto pt-[clamp(1rem,3vh,2.5rem)]">
          <p className="mx-auto flex max-w-[440px] flex-col items-center gap-1.5 border-t border-border pt-3.5 text-center text-fs-2xs uppercase tracking-[0.14em] text-hero-eyebrow sm:flex-row sm:justify-center sm:gap-2">
            <Lock className="size-3.5 shrink-0 text-hero-accent-rule" aria-hidden />
            <span>Authorized personnel only</span>
            <span className="text-hero-ink-soft/80 normal-case tracking-normal">All actions are audit-logged.</span>
          </p>
        </div>
      </div>
    </main>
  )
}
