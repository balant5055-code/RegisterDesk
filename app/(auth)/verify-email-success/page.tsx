'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { applyActionCode } from 'firebase/auth'
import { motion } from 'framer-motion'
import {
  BadgeCheck,
  XCircle,
  Loader2,
  ArrowLeft,
  LogIn,
  RefreshCw,
} from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { AuthScreen } from '@/components/auth'
import { EASE } from '@/components/auth/authMotion'
import { ROUTES } from '@/config/navigation'
import { auth, mapAuthError } from '@/lib/firebase/auth'

// ─── Types ────────────────────────────────────────────────────────────────────

type VerifyState = 'loading' | 'success' | 'error'

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VerifyEmailSuccessPage() {
  return (
    <Suspense>
      <VerifyEmailSuccessContent />
    </Suspense>
  )
}

function VerifyEmailSuccessContent() {
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
    <AuthScreen>
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
    </AuthScreen>
  )
}
