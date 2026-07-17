'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence, type Variants } from 'framer-motion'
import { auth, createOrganizerAccount, signInOrganizer, mapAuthError } from '@/lib/firebase/auth'
import {
  Mail,
  User,
  Building2,
} from 'lucide-react'
import { Button } from '@/components/ui'
import {
  AuthScreen,
  AuthHeader,
  AuthField,
  PasswordField,
  LoginForm,
  SocialLoginRow,
} from '@/components/auth'
import { EASE } from '@/components/auth/authMotion'
import { ROUTES } from '@/config/navigation'

// ─── Animation constants ──────────────────────────────────────────────────────
// The shared chrome (marketing panel, card, links) lives in <AuthScreen>; only
// the login ↔ signup form-switch animation is specific to this page.

// Form-switch animation — used inside AnimatePresence when toggling login ↔ signup.
// Pure opacity so no content clips behind overflow-hidden on the card.
const switchVariants: Variants = {
  enter:  { opacity: 0 },
  center: { opacity: 1, transition: { duration: 0.26, ease: EASE } },
  exit:   { opacity: 0, transition: { duration: 0.14, ease: 'easeIn' } },
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
    <div className="mt-5 border-t border-border pt-4 text-center">
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
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [remember, setRemember]   = useState(false)
  const [loading, setLoading]     = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  // ── signup state (new) ─────────────────────────────────────────────────────
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
    <AuthScreen>
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
                  <AuthHeader
                    title="Organizer Login"
                    subtitle="Welcome back — sign in to your dashboard."
                  />

                  <LoginForm
                    email={email}
                    password={password}
                    onEmailChange={setEmail}
                    onPasswordChange={setPassword}
                    onSubmit={handleLogin}
                    loading={loading}
                    error={loginError}
                    submitLabel="Sign In to Dashboard"
                    emailPlaceholder="organizer@example.com"
                    forgotPasswordHref={ROUTES.FORGOT_PASSWORD}
                    showRemember
                    remember={remember}
                    onRememberChange={setRemember}
                    showSocial
                    footer={
                      <ModeToggle
                        question="New organizer?"
                        action="Create account"
                        onClick={() => setMode('signup')}
                      />
                    }
                  />
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
                  <AuthHeader
                    title="Create Account"
                    subtitle="Join RegisterDesk and start organizing events."
                  />

                  <form onSubmit={handleSignup} noValidate>
                    {/*
                     * Two-column on desktop (lg+), single column below.
                     * Row 1: Full Name | Organization Name
                     * Row 2: Email Address (full width)
                     * Row 3: Password | Confirm Password
                     */}
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <AuthField
                        id="signup-name"
                        label="Full Name"
                        type="text"
                        autoComplete="name"
                        placeholder="Jane Smith"
                        value={name}
                        onChange={setName}
                        Icon={User}
                      />

                      <AuthField
                        id="signup-org"
                        label="Organization Name"
                        type="text"
                        autoComplete="organization"
                        placeholder="Your company or club"
                        value={orgName}
                        onChange={setOrgName}
                        Icon={Building2}
                      />

                      <div className="lg:col-span-2">
                        <AuthField
                          id="signup-email"
                          label="Email Address"
                          type="email"
                          autoComplete="email"
                          placeholder="organizer@example.com"
                          value={signupEmail}
                          onChange={setSignupEmail}
                          Icon={Mail}
                        />
                      </div>

                      <PasswordField
                        id="signup-password"
                        label="Password"
                        autoComplete="new-password"
                        placeholder="Create a password"
                        value={signupPassword}
                        onChange={setSignupPassword}
                      />

                      <PasswordField
                        id="signup-confirm"
                        label="Confirm Password"
                        autoComplete="new-password"
                        placeholder="Re-enter your password"
                        value={confirmPassword}
                        onChange={setConfirmPassword}
                      />
                    </div>

                    {/* Inline error — validation or Firebase error */}
                    {signupError && (
                      <p
                        role="alert"
                        className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
                      >
                        {signupError}
                      </p>
                    )}

                    <Button
                      type="submit"
                      variant="gradient"
                      size="lg"
                      isLoading={signupLoading}
                      className="mt-5 h-12 w-full cursor-pointer shadow-md transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
                    >
                      Create My Account
                    </Button>

                    <div className="mt-4">
                      <SocialLoginRow />
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
    </AuthScreen>
  )
}
