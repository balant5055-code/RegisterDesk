'use client'

import { startTransition, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  KeyRound,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { AuthScreen } from '@/components/auth'
import { ROUTES } from '@/config/navigation'
import { auth } from '@/lib/firebase/auth'

// ─── Constants ────────────────────────────────────────────────────────────────

const DIGITS = 6
const RESEND_COOLDOWN = 60

// ─── Error helpers ────────────────────────────────────────────────────────────

type OtpErrorCode =
  | 'INVALID_CODE'
  | 'EXPIRED'
  | 'MAX_ATTEMPTS_REACHED'
  | 'ALREADY_VERIFIED'
  | 'UNKNOWN'

interface OtpError {
  code:          OtpErrorCode
  attemptsLeft?: number
  message?:      string
}

function errorMessage(err: OtpError): string {
  switch (err.code) {
    case 'INVALID_CODE':
      return `Incorrect code. ${err.attemptsLeft ?? 0} attempt${err.attemptsLeft === 1 ? '' : 's'} remaining.`
    case 'EXPIRED':
      return 'This code has expired. Request a new one below.'
    case 'MAX_ATTEMPTS_REACHED':
      return 'Too many incorrect attempts. Request a new code below.'
    case 'ALREADY_VERIFIED':
      return 'Your email is already verified. Redirecting…'
    default:
      return err.message ?? 'Something went wrong. Please try again.'
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  )
}

function VerifyEmailContent() {
  const router      = useRouter()
  const searchParams = useSearchParams()

  const [currentOtpId, setCurrentOtpId] = useState<string | null>(
    () => searchParams.get('otpId'),
  )
  const [userEmail, setUserEmail]           = useState<string | null>(null)
  const [digits, setDigits]                 = useState<string[]>(Array(DIGITS).fill(''))
  const [verifying, setVerifying]           = useState(false)
  const [otpError, setOtpError]             = useState<OtpError | null>(null)
  const [resendLoading, setResendLoading]   = useState(false)
  const [resendSent, setResendSent]         = useState(false)
  const [resendError, setResendError]       = useState<string | null>(null)
  const [cooldown, setCooldown]             = useState(0)

  const inputRefs = useRef<(HTMLInputElement | null)[]>(Array(DIGITS).fill(null))

  useEffect(() => {
    const user = auth.currentUser
    if (user?.email) startTransition(() => setUserEmail(user.email!))
  }, [])

  // Cooldown tick
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1_000)
    return () => clearTimeout(t)
  }, [cooldown])

  // Submit code to verify-otp API
  const submitCode = useCallback(async (code: string) => {
    if (code.length !== DIGITS || verifying || !currentOtpId) return
    setVerifying(true)
    setOtpError(null)
    try {
      const token = await auth.currentUser!.getIdToken()
      const res   = await fetch('/api/auth/verify-otp', {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ otpId: currentOtpId, code }),
      })
      if (res.ok) {
        await auth.currentUser!.reload()
        router.push(ROUTES.WELCOME)
        return
      }
      const body = await res.json() as { error: string; attemptsLeft?: number }
      setOtpError({ code: body.error as OtpErrorCode, attemptsLeft: body.attemptsLeft })
      setDigits(Array(DIGITS).fill(''))
      requestAnimationFrame(() => inputRefs.current[0]?.focus())
    } catch {
      setOtpError({ code: 'UNKNOWN', message: 'Network error. Please try again.' })
    } finally {
      setVerifying(false)
    }
  }, [verifying, currentOtpId, router])

  // Digit change — auto-advance and auto-submit
  const handleChange = (idx: number, raw: string) => {
    const digit = raw.replace(/\D/g, '').slice(-1)
    const next  = [...digits]
    next[idx]   = digit
    setDigits(next)
    if (digit) {
      if (idx < DIGITS - 1) inputRefs.current[idx + 1]?.focus()
      if (next.every(Boolean)) void submitCode(next.join(''))
    }
  }

  // Keyboard navigation and backspace
  const handleKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault()
      if (digits[idx]) {
        const next = [...digits]; next[idx] = ''; setDigits(next)
      } else if (idx > 0) {
        const next = [...digits]; next[idx - 1] = ''; setDigits(next)
        inputRefs.current[idx - 1]?.focus()
      }
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      e.preventDefault(); inputRefs.current[idx - 1]?.focus()
    } else if (e.key === 'ArrowRight' && idx < DIGITS - 1) {
      e.preventDefault(); inputRefs.current[idx + 1]?.focus()
    }
  }

  // Paste — fills from the pasted position
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>, startIdx: number) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, DIGITS)
    if (!pasted) return
    const next = [...digits]
    for (let i = 0; i < pasted.length; i++) {
      if (startIdx + i < DIGITS) next[startIdx + i] = pasted[i]!
    }
    setDigits(next)
    inputRefs.current[Math.min(startIdx + pasted.length, DIGITS - 1)]?.focus()
    if (next.every(Boolean)) void submitCode(next.join(''))
  }

  // Resend — calls send-otp API and updates otpId state
  const handleResend = async () => {
    setResendLoading(true)
    setResendError(null)
    setResendSent(false)
    try {
      const token = await auth.currentUser!.getIdToken()
      const res   = await fetch('/api/auth/send-otp', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const { otpId } = await res.json() as { otpId: string }
        setCurrentOtpId(otpId)
        setResendSent(true)
        setCooldown(RESEND_COOLDOWN)
        setOtpError(null)
        setDigits(Array(DIGITS).fill(''))
        requestAnimationFrame(() => inputRefs.current[0]?.focus())
      } else {
        const body = await res.json() as { error?: string }
        setResendError(body.error ?? 'Failed to resend code. Please try again.')
        setCooldown(30)
      }
    } catch {
      setResendError('Network error. Please try again.')
    } finally {
      setResendLoading(false)
    }
  }

  const isBlocked   = otpError?.code === 'MAX_ATTEMPTS_REACHED' || otpError?.code === 'EXPIRED'
  const codeComplete = digits.every(Boolean)

  return (
    <AuthScreen>
      {/* Icon */}
      <div className="mb-6 flex justify-center">
        <motion.div
          animate={{ scale: [1, 1.06, 1] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20"
        >
          <KeyRound className="size-8 text-primary" aria-hidden />
        </motion.div>
      </div>

      {/* Title + email */}
      <div className="mb-2 text-center">
        <h2 className="text-[1.45rem] font-bold tracking-tight text-foreground">
          Enter Verification Code
        </h2>
      </div>
      <p className="mb-6 text-center text-sm leading-relaxed text-muted-foreground">
        We sent a 6-digit code to{' '}
        {userEmail
          ? <span className="font-medium text-foreground">{userEmail}</span>
          : 'your email address'
        }.
      </p>

      {/* ── OTP digit boxes ── */}
      <div
        role="group"
        aria-label="6-digit verification code"
        className="mb-6 flex items-center justify-center gap-2 sm:gap-3"
      >
        {digits.map((d, idx) => (
          <input
            key={idx}
            ref={(el) => { inputRefs.current[idx] = el }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            value={d}
            autoFocus={idx === 0}
            disabled={verifying}
            aria-label={`Digit ${idx + 1} of ${DIGITS}`}
            onChange={(e) => handleChange(idx, e.target.value)}
            onKeyDown={(e) => handleKeyDown(idx, e)}
            onPaste={(e) => handlePaste(e, idx)}
            onFocus={(e) => e.target.select()}
            className={cn(
              'size-11 sm:size-12 rounded-xl border-2 text-center text-xl font-bold',
              'bg-background text-foreground',
              'outline-none transition-[border-color,box-shadow] duration-150',
              'focus:border-primary focus:ring-2 focus:ring-primary/20',
              d && !otpError ? 'border-primary/60 bg-primary/5' : '',
              !d ? 'border-border' : '',
              otpError && !verifying ? 'border-destructive/60 bg-destructive/5' : '',
              verifying ? 'cursor-not-allowed opacity-60' : '',
            )}
          />
        ))}
      </div>

      {/* OTP error */}
      {otpError && (
        <motion.p
          key={otpError.code}
          role="alert"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-center text-sm text-destructive"
        >
          {errorMessage(otpError)}
        </motion.p>
      )}

      {/* Resend success */}
      {resendSent && (
        <motion.p
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-center text-sm text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-400"
        >
          New code sent! Check your inbox.
        </motion.p>
      )}

      {/* Resend error */}
      {resendError && (
        <motion.p
          role="alert"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-center text-sm text-destructive"
        >
          {resendError}
        </motion.p>
      )}

      {/* Verify button */}
      <div className="mb-4">
        <Button
          type="button"
          variant="primary"
          size="lg"
          className="w-full cursor-pointer"
          onClick={() => void submitCode(digits.join(''))}
          disabled={!codeComplete || isBlocked || verifying}
          isLoading={verifying}
        >
          Verify Email
        </Button>
      </div>

      {/* Resend */}
      <div className="text-center">
        <p className="mb-2 text-xs text-muted-foreground">
          Didn&apos;t receive the code?
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="cursor-pointer gap-1.5 text-sm font-medium text-primary"
          onClick={handleResend}
          disabled={cooldown > 0 || resendLoading}
          isLoading={resendLoading}
        >
          {!resendLoading && <RefreshCw className="size-3.5" aria-hidden />}
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend Code'}
        </Button>
      </div>

      {/* Back link */}
      <div className="mt-5 border-t border-border pt-5 text-center">
        <Link
          href={ROUTES.LOGIN}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to Sign In
        </Link>
      </div>
    </AuthScreen>
  )
}
