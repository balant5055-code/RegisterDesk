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
import { redirectFromSearch } from '@/lib/auth/redirectTarget'
import { auth, resyncVerifiedSession } from '@/lib/firebase/auth'

// ─── Constants ────────────────────────────────────────────────────────────────

const DIGITS = 6

// RD-AUTH-01 Phase 5 (M-B): the resend cooldown is owned entirely by the SERVER
// (getSecurityConfig().otpResendWaitSeconds + the hourly cap). The client no longer
// hardcodes a cooldown — it derives the countdown from the send-otp response
// (resendAfter on success; secondsLeft / resetInMinutes on 429), so there is one
// canonical resend policy instead of disconnected client constants.
function secondsUntil(iso: string | undefined): number {
  if (!iso) return 0
  const ms = new Date(iso).getTime() - Date.now()
  return ms > 0 ? Math.ceil(ms / 1000) : 0
}

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
  // D4 · send-otp commits the code and THEN attempts delivery, so a 502 means "the code
  // is valid but no email left the building". The sender marks that with ?delivery=failed
  // so this screen can say so instead of claiming an email the organizer will never get.
  // Cleared the moment a resend succeeds — at that point a code really was sent.
  const [deliveryFailed, setDeliveryFailed] = useState(
    () => searchParams.get('delivery') === 'failed',
  )

  const inputRefs = useRef<(HTMLInputElement | null)[]>(Array(DIGITS).fill(null))

  // D4 · No otpId means there is no code to submit — submitCode() returns early on it.
  // That state used to be invisible: the boxes accepted six digits and then nothing
  // happened, with no error and no explanation. It is now stated, and the inputs are
  // disabled, so the only working control (Resend) is the only enabled one.
  const awaitingCode = !currentOtpId

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
        // The server has just set emailVerified on the Auth record. A bare reload()
        // refreshes the local user object but NOT the cached ID token, so every organizer
        // API would still be handed email_verified:false and answer 401 — which is exactly
        // the dashboard's "Unauthorized". This resynchronises both.
        await resyncVerifiedSession()
        // RD-TEAM-INVITE-01 — return the user to where authentication interrupted
        // them (a team invitation), instead of always the onboarding page. Absent
        // or unsafe destinations fall through to WELCOME, so the ordinary
        // new-organizer journey is unchanged. Same guard as the login page.
        router.push(redirectFromSearch(searchParams) ?? ROUTES.WELCOME)
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
  }, [verifying, currentOtpId, router, searchParams])

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
      const body = await res.json().catch(() => ({})) as {
        otpId?: string; resendAfter?: string; error?: string; secondsLeft?: number; resetInMinutes?: number
      }
      if (res.ok && body.otpId) {
        setCurrentOtpId(body.otpId)
        setDeliveryFailed(false)      // a code really did go out this time
        setResendSent(true)
        setCooldown(secondsUntil(body.resendAfter))   // server-owned cooldown
        setOtpError(null)
        setDigits(Array(DIGITS).fill(''))
        requestAnimationFrame(() => inputRefs.current[0]?.focus())
      } else {
        // Cooldown comes from the server, never a hardcoded fallback: honor
        // COOLDOWN_ACTIVE.secondsLeft / RATE_LIMITED.resetInMinutes (and resendAfter on
        // a 502 where the OTP was created but delivery failed).
        const serverCooldown =
          typeof body.secondsLeft === 'number'    ? body.secondsLeft :
          typeof body.resetInMinutes === 'number' ? body.resetInMinutes * 60 :
          secondsUntil(body.resendAfter)
        if (serverCooldown > 0) setCooldown(serverCooldown)
        // D4 · a 502 resend still committed a NEW code. Adopt it so the form submits the
        // live one rather than a superseded id, and keep the screen honest about the fact
        // that nothing was delivered. (Neither code reached the organizer, so nothing is
        // lost by moving on from the older one.)
        if (body.otpId) {
          setCurrentOtpId(body.otpId)
          setDeliveryFailed(true)
        }
        setResendError(body.error ?? 'Failed to resend code. Please try again.')
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
          className="flex size-14 items-center justify-center rounded-[var(--radius-control)] border border-hero-accent-rule/40 bg-card"
        >
          <KeyRound className="size-8 text-primary" aria-hidden />
        </motion.div>
      </div>

      {/* Title + email */}
      <div className="mb-2 text-center">
        <h2 className="font-display text-fs-2xl font-light tracking-[-0.01em] text-hero-ink">
          Enter Verification Code
        </h2>
      </div>
      <p className="mb-6 text-center text-sm leading-relaxed text-muted-foreground">
        {/* Three states, three different truths. Saying "we sent a code" in any of the
            first two would be a lie the organizer can only discover by waiting for an
            email that is never coming. */}
        {awaitingCode
          // No otpId at all. Deliberately does NOT claim a send failed: there are three
          // ways to land here — a failed send on signup, a failed send on sign-in, and
          // the dashboard guard redirecting an unverified organizer, which never
          // attempted a send — so a failure claim would be untrue in the third.
          ? <>Request a verification code for{' '}
              {userEmail
                ? <span className="font-medium text-foreground">{userEmail}</span>
                : 'your email address'
              }{' '}using the button below.</>
          : deliveryFailed
          // A code EXISTS and is valid, but the email did not go out (send-otp 502).
          ? <>Your code was created, but we couldn&apos;t email it to{' '}
              {userEmail
                ? <span className="font-medium text-foreground">{userEmail}</span>
                : 'your email address'
              }. Use Resend below to try again.</>
          : <>We sent a 6-digit code to{' '}
              {userEmail
                ? <span className="font-medium text-foreground">{userEmail}</span>
                : 'your email address'
              }.</>
        }
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
            disabled={verifying || awaitingCode}
            aria-label={`Digit ${idx + 1} of ${DIGITS}`}
            onChange={(e) => handleChange(idx, e.target.value)}
            onKeyDown={(e) => handleKeyDown(idx, e)}
            onPaste={(e) => handlePaste(e, idx)}
            onFocus={(e) => e.target.select()}
            className={cn(
              'size-11 sm:size-12 rounded-[var(--radius-control)] border-2 text-center text-xl font-bold',
              'bg-background text-foreground',
              'outline-none transition-[border-color,box-shadow] duration-150',
              'focus:border-primary focus:ring-2 focus:ring-primary/20',
              d && !otpError ? 'border-primary/60 bg-primary/5' : '',
              !d ? 'border-border' : '',
              otpError && !verifying ? 'border-destructive/60 bg-destructive/5' : '',
              verifying || awaitingCode ? 'cursor-not-allowed opacity-60' : '',
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
          className="mb-4 rounded-[var(--radius-control)] border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-center text-sm text-destructive"
        >
          {errorMessage(otpError)}
        </motion.p>
      )}

      {/* Resend success */}
      {resendSent && (
        <motion.p
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 rounded-[var(--radius-control)] border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-center text-sm text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-400"
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
          className="mb-4 rounded-[var(--radius-control)] border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-center text-sm text-destructive"
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
          className="w-full cursor-pointer rounded-[var(--radius-control)]"
          onClick={() => void submitCode(digits.join(''))}
          disabled={!codeComplete || isBlocked || verifying || awaitingCode}
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
