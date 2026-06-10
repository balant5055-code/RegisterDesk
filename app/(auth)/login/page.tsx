'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence, type Variants } from 'framer-motion'
import { auth, createOrganizerAccount, signInOrganizer, mapAuthError } from '@/lib/firebase/auth'
import type { LucideIcon } from 'lucide-react'
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  ArrowLeft,
  CalendarDays,
  Shield,
  Users,
  User,
  Building2,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { ROUTES } from '@/config/navigation'

// ─── Animation constants ──────────────────────────────────────────────────────

const EASE = [0.22, 1, 0.36, 1] as const

// Page-level entrance animations — unchanged from login-only version
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

// Form-switch animation — used inside AnimatePresence when toggling login ↔ signup.
// Pure opacity so no content clips behind overflow-hidden on the card.
const switchVariants: Variants = {
  enter:  { opacity: 0 },
  center: { opacity: 1, transition: { duration: 0.26, ease: EASE } },
  exit:   { opacity: 0, transition: { duration: 0.14, ease: 'easeIn' } },
}

// ─── Static data ──────────────────────────────────────────────────────────────

const FEATURES: { icon: LucideIcon; text: string }[] = [
  { icon: CalendarDays, text: 'Online registration & ticketing'    },
  { icon: Shield,       text: 'QR-code check-in & verification'    },
  { icon: Users,        text: 'Attendee management & analytics'    },
]

const STATS = [
  { value: '500+',  label: 'Events'    },
  { value: '1.2M+', label: 'Check-ins' },
  { value: '99.9%', label: 'Uptime'    },
]

// ─── Shared input field ───────────────────────────────────────────────────────

function Field({
  id,
  label,
  type = 'text',
  placeholder,
  value,
  onChange,
  autoComplete,
  Icon,
  suffix,
}: {
  id: string
  label: string
  type?: string
  placeholder?: string
  value: string
  onChange: (v: string) => void
  autoComplete?: string
  Icon: LucideIcon
  suffix?: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        <Icon
          aria-hidden
          className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          id={id}
          type={type}
          autoComplete={autoComplete}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          className={cn(
            'w-full rounded-sm border border-border bg-background text-sm',
            'text-foreground placeholder:text-muted-foreground',
            'py-2.5 pl-10',
            suffix ? 'pr-11' : 'pr-4',
            'outline-none transition-[border-color,box-shadow] duration-150',
            'focus:border-primary focus:ring-2 focus:ring-primary/20 focus:ring-offset-0',
          )}
        />
        {suffix && (
          <div className="absolute right-3.5 top-1/2 -translate-y-1/2">{suffix}</div>
        )}
      </div>
    </div>
  )
}

// Small helper so the toggle link looks consistent in both forms
function ModeToggle({
  question,
  action,
  onClick,
}: {
  question: string
  action: string
  onClick: () => void
}) {
  return (
    <div className="mt-5 border-t border-border pt-5 text-center">
      <p className="text-sm text-muted-foreground">
        {question}{' '}
        <button
          type="button"
          onClick={onClick}
          className="cursor-pointer font-semibold text-primary transition-opacity duration-150 hover:opacity-75"
        >
          {action}
        </button>
      </p>
    </div>
  )
}

// ─── Eye-toggle helper ────────────────────────────────────────────────────────

function EyeToggle({
  visible,
  onToggle,
}: {
  visible: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-label={visible ? 'Hide password' : 'Show password'}
      onClick={onToggle}
      className="cursor-pointer text-muted-foreground transition-colors duration-150 hover:text-foreground"
    >
      {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
    </button>
  )
}

// ─── Signup validation ────────────────────────────────────────────────────────
// Returns the first error message found, or null if everything is valid.

function validateSignup(fields: {
  name: string
  email: string
  password: string
  confirmPassword: string
  orgName: string
}): string | null {
  if (!fields.name.trim())
    return 'Full name is required.'
  if (!fields.email.trim())
    return 'Email address is required.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email))
    return 'Enter a valid email address.'
  if (fields.password.length < 8)
    return 'Password must be at least 8 characters.'
  if (fields.password !== fields.confirmPassword)
    return 'Passwords do not match.'
  if (!fields.orgName.trim())
    return 'Organization name is required.'
  return null
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const router = useRouter()

  // ── mode ───────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'login' | 'signup'>('login')

  // ── login state ────────────────────────────────────────────────────────────
  const [showPw, setShowPw]       = useState(false)
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [remember, setRemember]   = useState(false)
  const [loading, setLoading]     = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  // ── signup state (new) ─────────────────────────────────────────────────────
  const [showSignupPw, setShowSignupPw]       = useState(false)
  const [showConfirmPw, setShowConfirmPw]     = useState(false)
  const [name, setName]                       = useState('')
  const [signupEmail, setSignupEmail]         = useState('')
  const [signupPassword, setSignupPassword]   = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [orgName, setOrgName]                 = useState('')
  const [signupLoading, setSignupLoading]     = useState(false)
  const [signupError, setSignupError]         = useState<string | null>(null)

  // ── handlers ───────────────────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoginError(null)
    setLoading(true)
    try {
      const { emailVerified } = await signInOrganizer(email, password)
      if (emailVerified) {
        router.push(ROUTES.DASHBOARD)
      } else {
        const token = await auth.currentUser!.getIdToken()
        const res   = await fetch('/api/auth/send-otp', {
          method:  'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const { otpId } = await res.json() as { otpId: string }
          router.push(`${ROUTES.VERIFY_EMAIL}?otpId=${encodeURIComponent(otpId)}`)
        } else {
          router.push(`${ROUTES.VERIFY_EMAIL}?reason=unverified`)
        }
      }
    } catch (err) {
      setLoginError(mapAuthError(err))
    } finally {
      setLoading(false)
    }
  }

  const handleSignup = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSignupError(null)

    const validationError = validateSignup({
      name,
      email:           signupEmail,
      password:        signupPassword,
      confirmPassword,
      orgName,
    })
    if (validationError) {
      setSignupError(validationError)
      return
    }

    setSignupLoading(true)
    try {
      await createOrganizerAccount({
        name:     name.trim(),
        email:    signupEmail.trim(),
        password: signupPassword,
        orgName:  orgName.trim(),
      })
      const token = await auth.currentUser!.getIdToken()
      const res   = await fetch('/api/auth/send-otp', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const { otpId } = await res.json() as { otpId: string }
        router.push(`${ROUTES.VERIFY_EMAIL}?otpId=${encodeURIComponent(otpId)}`)
      } else {
        router.push(ROUTES.VERIFY_EMAIL)
      }
    } catch (err) {
      setSignupError(mapAuthError(err))
    } finally {
      setSignupLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="lg:grid lg:h-screen lg:grid-cols-[55%_45%]">

        {/* ── Left: brand panel — fully unchanged ──────────────────── */}
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

        {/* ── Right: form column ───────────────────────────────────── */}
        <div className="flex flex-col">

          {/* Mobile brand strip — unchanged */}
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

          {/* Form area */}
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
              {/* Desktop back link — unchanged */}
              <motion.div variants={fadeUp} className="mb-8 hidden lg:block">
                <Link
                  href={ROUTES.HOME}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
                >
                  <ArrowLeft className="size-3.5" aria-hidden />
                  Back to home
                </Link>
              </motion.div>

              {/*
               * Card — `layout` so its height animates when the inner form
               * changes (login is shorter, signup is taller).
               * `overflow-hidden` clips the opacity-only transitions safely.
               */}
              <motion.div
                variants={fadeUp}
                layout
                transition={{ layout: { duration: 0.22, ease: EASE } }}
                className={cn(
                  'overflow-hidden rounded-2xl bg-card',
                  'p-8 sm:p-10',
                  'shadow-[0_2px_28px_rgb(0_0_0/0.08),0_1px_4px_rgb(0_0_0/0.04)]',
                  'ring-1 ring-border',
                )}
              >
                <AnimatePresence mode="wait">

                  {/* ── LOGIN FORM ─────────────────────────────────── */}
                  {mode === 'login' && (
                    <motion.div
                      key="login"
                      variants={switchVariants}
                      initial="enter"
                      animate="center"
                      exit="exit"
                    >
                      <div className="mb-7">
                        <h2 className="text-[1.45rem] font-bold tracking-tight text-foreground">
                          Organizer Login
                        </h2>
                        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                          Welcome back — sign in to your dashboard.
                        </p>
                      </div>

                      <form onSubmit={handleLogin} noValidate className="space-y-5">
                        <Field
                          id="login-email"
                          label="Email Address"
                          type="email"
                          autoComplete="email"
                          placeholder="organizer@example.com"
                          value={email}
                          onChange={setEmail}
                          Icon={Mail}
                        />

                        <Field
                          id="login-password"
                          label="Password"
                          type={showPw ? 'text' : 'password'}
                          autoComplete="current-password"
                          placeholder="Enter your password"
                          value={password}
                          onChange={setPassword}
                          Icon={Lock}
                          suffix={<EyeToggle visible={showPw} onToggle={() => setShowPw((v) => !v)} />}
                        />

                        <div className="flex items-center justify-between">
                          <label className="flex cursor-pointer select-none items-center gap-2">
                            <input
                              type="checkbox"
                              checked={remember}
                              onChange={(e) => setRemember(e.target.checked)}
                              className="size-4 cursor-pointer rounded border-border accent-primary"
                            />
                            <span className="text-sm text-muted-foreground">Remember me</span>
                          </label>
                          <Link
                            href="#"
                            className="text-sm font-medium text-primary transition-opacity duration-150 hover:opacity-75"
                          >
                            Forgot password?
                          </Link>
                        </div>

                        {loginError && (
                          <p
                            role="alert"
                            className="rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
                          >
                            {loginError}
                          </p>
                        )}

                        <div className="pt-1">
                          <Button
                            type="submit"
                            variant="primary"
                            size="lg"
                            isLoading={loading}
                            className="w-full cursor-pointer"
                          >
                            Sign In to Dashboard
                          </Button>
                        </div>

                        <ModeToggle
                          question="New organizer?"
                          action="Create account"
                          onClick={() => setMode('signup')}
                        />
                      </form>
                    </motion.div>
                  )}

                  {/* ── SIGN-UP FORM ───────────────────────────────── */}
                  {mode === 'signup' && (
                    <motion.div
                      key="signup"
                      variants={switchVariants}
                      initial="enter"
                      animate="center"
                      exit="exit"
                    >
                      <div className="mb-7">
                        <h2 className="text-[1.45rem] font-bold tracking-tight text-foreground">
                          Create Account
                        </h2>
                        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                          Join RegisterDesk and start organizing events.
                        </p>
                      </div>

                      <form onSubmit={handleSignup} noValidate className="space-y-4">
                        <Field
                          id="signup-name"
                          label="Full Name"
                          type="text"
                          autoComplete="name"
                          placeholder="Jane Smith"
                          value={name}
                          onChange={setName}
                          Icon={User}
                        />

                        <Field
                          id="signup-email"
                          label="Email Address"
                          type="email"
                          autoComplete="email"
                          placeholder="organizer@example.com"
                          value={signupEmail}
                          onChange={setSignupEmail}
                          Icon={Mail}
                        />

                        <Field
                          id="signup-password"
                          label="Password"
                          type={showSignupPw ? 'text' : 'password'}
                          autoComplete="new-password"
                          placeholder="Create a password"
                          value={signupPassword}
                          onChange={setSignupPassword}
                          Icon={Lock}
                          suffix={
                            <EyeToggle
                              visible={showSignupPw}
                              onToggle={() => setShowSignupPw((v) => !v)}
                            />
                          }
                        />

                        <Field
                          id="signup-confirm"
                          label="Confirm Password"
                          type={showConfirmPw ? 'text' : 'password'}
                          autoComplete="new-password"
                          placeholder="Re-enter your password"
                          value={confirmPassword}
                          onChange={setConfirmPassword}
                          Icon={Lock}
                          suffix={
                            <EyeToggle
                              visible={showConfirmPw}
                              onToggle={() => setShowConfirmPw((v) => !v)}
                            />
                          }
                        />

                        <Field
                          id="signup-org"
                          label="Organization Name"
                          type="text"
                          autoComplete="organization"
                          placeholder="Your company or club"
                          value={orgName}
                          onChange={setOrgName}
                          Icon={Building2}
                        />

                        {/* Inline error — validation or Firebase error */}
                        {signupError && (
                          <p
                            role="alert"
                            className="rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
                          >
                            {signupError}
                          </p>
                        )}

                        <div className="pt-1">
                          <Button
                            type="submit"
                            variant="primary"
                            size="lg"
                            isLoading={signupLoading}
                            className="w-full cursor-pointer"
                          >
                            Create My Account
                          </Button>
                        </div>

                        <ModeToggle
                          question="Already have an account?"
                          action="Sign in"
                          onClick={() => setMode('login')}
                        />
                      </form>
                    </motion.div>
                  )}

                </AnimatePresence>
              </motion.div>

              {/* Footer note — unchanged */}
              <motion.p
                variants={fadeUp}
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
            </motion.div>
          </motion.div>
        </div>

      </div>
    </main>
  )
}
