'use client'

import { useState }   from 'react'
import Link           from 'next/link'
import { motion }     from 'framer-motion'
import { ArrowLeft, BadgeCheck, Mail } from 'lucide-react'
import { Button } from '@/components/ui'
import { AuthScreen } from '@/components/auth'
import { EASE } from '@/components/auth/authMotion'
import { ROUTES } from '@/config/navigation'
import { sendOrganizerPasswordReset, mapAuthError } from '@/lib/firebase/auth'

// ─── Page ─────────────────────────────────────────────────────────────────────
// Uses the shared <AuthScreen> chrome; only the center-card content lives here.

export default function ForgotPasswordPage() {
  const [email,   setEmail]   = useState('')
  const [loading, setLoading] = useState(false)
  const [sent,    setSent]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed || loading) return
    setLoading(true)
    setError(null)
    try {
      await sendOrganizerPasswordReset(trimmed)
      setSent(true)
    } catch (err) {
      setError(mapAuthError(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthScreen>
      {sent ? (
        /* ── Success state ──────────────────────────────────── */
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
              Check your inbox
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              If an account exists for{' '}
              <span className="font-medium text-foreground">{email.trim()}</span>,
              you&apos;ll receive a password reset link shortly.
            </p>
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
      ) : (
        /* ── Form state ─────────────────────────────────────── */
        <>
          <div className="mb-6 flex justify-center">
            <motion.div
              animate={{ scale: [1, 1.06, 1] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20"
            >
              <Mail className="size-8 text-primary" aria-hidden />
            </motion.div>
          </div>

          <div className="mb-2 text-center">
            <h2 className="text-[1.45rem] font-bold tracking-tight text-foreground">
              Forgot your password?
            </h2>
          </div>
          <p className="mb-6 text-center text-sm leading-relaxed text-muted-foreground">
            Enter your account email and we&apos;ll send you a link to reset your password.
          </p>

          <form onSubmit={handleSubmit} noValidate>
            {/* Email input */}
            <div className="mb-4">
              <label
                htmlFor="reset-email"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                Email address
              </label>
              <input
                id="reset-email"
                type="email"
                autoComplete="email"
                placeholder="organizer@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none transition-[border-color,box-shadow] duration-150 focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>

            {/* Error */}
            {error && (
              <motion.p
                role="alert"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-center text-sm text-destructive"
              >
                {error}
              </motion.p>
            )}

            {/* Submit */}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full cursor-pointer"
              disabled={!email.trim() || loading}
              isLoading={loading}
            >
              Send Reset Link
            </Button>
          </form>

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
        </>
      )}
    </AuthScreen>
  )
}
