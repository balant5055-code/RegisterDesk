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

import { useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { signOut } from 'firebase/auth'
import { ShieldCheck, ShieldAlert } from 'lucide-react'
import { auth, authenticateUser, mapAuthError } from '@/lib/firebase/auth'
import {
  AuthShell,
  AuthCard,
  AuthHeader,
  AuthFooter,
  LoginForm,
} from '@/components/auth'
import { EASE, fadeUp } from '@/components/auth/authMotion'
import { Button, buttonVariants } from '@/components/ui'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'

// ─── Admin brand panel (left slot) ────────────────────────────────────────────

function AdminBrandPanel() {
  return (
    <motion.aside
      initial={{ opacity: 0, x: -32 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.75, ease: EASE }}
      aria-hidden="true"
      className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between"
      style={{ backgroundImage: 'var(--primary-gradient)' }}
    >
      <div className="pointer-events-none absolute inset-0 select-none">
        <div
          className="absolute inset-0 opacity-[0.045]"
          style={{
            backgroundImage: `radial-gradient(circle, var(--primary-foreground) 1px, transparent 1px)`,
            backgroundSize: '30px 30px',
          }}
        />
        <div className="absolute -right-32 -top-32 h-[480px] w-[480px] rounded-full border border-primary-foreground/15" />
        <div className="absolute -bottom-28 -left-28 h-[320px] w-[320px] rounded-full bg-primary-foreground/5 blur-3xl" />
      </div>

      <div className="relative flex flex-col gap-8 px-12 pt-12 xl:px-16 xl:pt-16">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-[12px] bg-primary-foreground/15 ring-1 ring-primary-foreground/25 backdrop-blur-sm">
            <span className="text-sm font-bold tracking-widest text-primary-foreground">RD</span>
          </div>
          <span className="text-lg font-semibold text-primary-foreground">
            Register<span className="text-primary-foreground/60">Desk</span>
          </span>
        </div>

        <div className="space-y-4">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-foreground/15 px-3 py-1 text-xs font-semibold text-primary-foreground ring-1 ring-primary-foreground/20">
            <ShieldCheck className="size-3.5" aria-hidden />
            Platform Administration
          </span>
          <h1 className="text-[var(--fs-3xl)] font-bold leading-[1.15] tracking-tight text-primary-foreground xl:text-[var(--fs-4xl)]">
            Platform control,
            <br />
            secured.
          </h1>
          <p className="max-w-[340px] text-base leading-relaxed text-primary-foreground/65">
            Restricted access. Sign in with a Platform Admin account to manage
            operations, finance, moderation, and configuration.
          </p>
        </div>
      </div>

      <div className="relative px-12 pb-12 xl:px-16 xl:pb-16">
        <p className="text-xs font-medium text-primary-foreground/55">
          Authorized personnel only. All actions are audit-logged.
        </p>
      </div>
    </motion.aside>
  )
}

// ─── Unauthorized state ───────────────────────────────────────────────────────

function UnauthorizedCard({ onTryAnother }: { onTryAnother: () => void }) {
  return (
    <AuthCard>
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-destructive/10">
          <ShieldAlert className="size-7 text-destructive" aria-hidden />
        </div>
        <AuthHeader title="Access restricted" />
        <p className="-mt-4 text-sm leading-relaxed text-muted-foreground">
          This account doesn&apos;t have Platform Admin access.
        </p>
      </div>

      <div className="space-y-3">
        <Link
          href={ROUTES.LOGIN}
          className={cn(buttonVariants({ variant: 'gradient', size: 'lg' }), 'w-full')}
          style={{ backgroundImage: 'var(--primary-gradient)' }}
        >
          Return to Organizer Login
        </Link>
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={onTryAnother}
          className="w-full cursor-pointer"
        >
          Try Another Account
        </Button>
      </div>
    </AuthCard>
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

  const formColumn = (
    <div className="flex flex-col lg:h-full lg:overflow-y-auto">

      {/* Mobile brand strip */}
      <div
        className="px-6 pb-8 pt-8 lg:hidden"
        style={{ backgroundImage: 'var(--primary-gradient)' }}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-[12px] bg-primary-foreground/15 ring-1 ring-primary-foreground/25">
            <ShieldCheck className="size-5 text-primary-foreground" aria-hidden />
          </div>
          <div>
            <p className="text-base font-semibold text-primary-foreground">RegisterDesk Admin</p>
            <p className="mt-0.5 text-sm text-primary-foreground/65">Platform Administration</p>
          </div>
        </div>
      </div>

      {/* Form area */}
      <motion.div
        variants={fadeUp}
        initial="hidden"
        animate="show"
        className="flex flex-1 items-center justify-center px-5 py-12 sm:px-8 lg:min-h-full"
      >
        <div className="w-full max-w-[420px]">
          {unauthorized ? (
            <UnauthorizedCard onTryAnother={tryAnother} />
          ) : (
            <AuthCard>
              <AuthHeader
                title="Platform Admin"
                subtitle="Sign in with your Platform Admin account."
              />
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
              />
            </AuthCard>
          )}

          <div className="mt-6">
            <AuthFooter>
              Not an admin?{' '}
              <Link
                href={ROUTES.LOGIN}
                className="font-semibold text-foreground underline-offset-4 hover:underline"
              >
                Organizer login
              </Link>
            </AuthFooter>
          </div>
        </div>
      </motion.div>
    </div>
  )

  return <AuthShell left={<AdminBrandPanel />} right={formColumn} />
}
