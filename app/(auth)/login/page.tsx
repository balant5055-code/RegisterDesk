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
  PhoneField,
  LoginForm,
  SocialLoginRow,
} from '@/components/auth'
import { LinkAccountDialog } from '@/components/auth/LinkAccountDialog'
import { EASE } from '@/components/auth/authMotion'
import { ROUTES } from '@/config/navigation'
import { formatPhoneNumber, validatePhoneNumber } from '@/lib/communication/phone'
import { DEFAULT_DIAL_CODE, callingDigitsForDialCode } from '@/lib/communication/countryCodes'
import {
  signInWithSocial,
  linkPendingCredentialWithPassword,
  linkPendingCredentialWithProvider,
  type SocialProviderKey,
  type SocialSignInResult,
} from '@/lib/firebase/auth/social'

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
  mobile: string
  countryCode: string
  password: string
  confirmPassword: string
  orgName: string
}): string | null {
  if (!fields.name.trim())
    return 'Full name is required.'
  if (!fields.orgName.trim())
    return 'Organization name is required.'
  if (!fields.email.trim())
    return 'Email address is required.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email))
    return 'Enter a valid email address.'
  // RD-AUTH-02: mobile is required; validate against the country-agnostic normalizer
  // using the selected dial code so a bare national number is accepted and expanded.
  if (!fields.mobile.trim())
    return 'Mobile number is required.'
  if (!validatePhoneNumber(fields.mobile, { defaultCallingCode: callingDigitsForDialCode(fields.countryCode) }).valid)
    return 'Enter a valid mobile number.'
  if (fields.password.length < 8)
    return 'Password must be at least 8 characters.'
  if (fields.password !== fields.confirmPassword)
    return 'Passwords do not match.'
  return null
}

// C-1: after login, return to a same-origin `?redirect=` target (e.g. a login-required
// registration form) instead of always the dashboard — so attendees are never dead-ended
// on the organizer dashboard. Read from window (no useSearchParams → no Suspense boundary
// needed) and guarded to internal paths only (never protocol-relative // or absolute URLs).
function safeRedirectTarget(): string | null {
  if (typeof window === 'undefined') return null
  const r = new URLSearchParams(window.location.search).get('redirect')
  return r && r.startsWith('/') && !r.startsWith('//') ? r : null
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
  const [mobileCountryCode, setMobileCountryCode] = useState(DEFAULT_DIAL_CODE)
  const [mobile, setMobile]                   = useState('')
  const [signupLoading, setSignupLoading]     = useState(false)
  const [signupError, setSignupError]         = useState<string | null>(null)

  // ── social sign-in state (RD-AUTH-02 Phases 7–9) ─────────────────────────────
  const [socialLoadingKey, setSocialLoadingKey] = useState<SocialProviderKey | null>(null)
  const [linkState, setLinkState] = useState<Extract<SocialSignInResult, { status: 'needs-link' }> | null>(null)
  const [linkBusy, setLinkBusy]   = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  // ── shared post-authentication routing ───────────────────────────────────────
  // The ONE place that decides where an authenticated user goes: a verified user
  // lands on the dashboard (or a same-origin redirect); an unverified user is sent
  // through the existing email-OTP flow. Shared by password + social sign-in.
  const routeAfterAuth = async (emailVerified: boolean) => {
    if (emailVerified) {
      // C-1: honor a same-origin redirect (e.g. back to a login-required register form).
      router.push(safeRedirectTarget() ?? ROUTES.DASHBOARD)
      return
    }
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

  // ── handlers ───────────────────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoginError(null)
    setLoading(true)
    try {
      const { emailVerified } = await signInOrganizer(email, password, remember)
      await routeAfterAuth(emailVerified)
    } catch (err) {
      setLoginError(mapAuthError(err))
    } finally {
      setLoading(false)
    }
  }

  // Social sign-in — Google / Microsoft / Facebook. On an email collision with a
  // different sign-in method, opens the link dialog instead of creating a duplicate.
  const handleSocial = async (key: SocialProviderKey) => {
    setLoginError(null)
    setSignupError(null)
    setSocialLoadingKey(key)
    try {
      const result = await signInWithSocial(key)
      if (result.status === 'needs-link') {
        setLinkError(null)
        setLinkState(result)
        return
      }
      await routeAfterAuth(result.user.emailVerified)
    } catch (err) {
      const msg = mapAuthError(err)
      if (mode === 'signup') setSignupError(msg)
      else setLoginError(msg)
    } finally {
      setSocialLoadingKey(null)
    }
  }

  const handleLinkWithPassword = async (linkPassword: string) => {
    if (!linkState) return
    setLinkBusy(true)
    setLinkError(null)
    try {
      const user = await linkPendingCredentialWithPassword(linkState.email, linkPassword, linkState.pendingCredential)
      setLinkState(null)
      await routeAfterAuth(user.emailVerified)
    } catch (err) {
      setLinkError(mapAuthError(err))
    } finally {
      setLinkBusy(false)
    }
  }

  const handleLinkWithProvider = async (existingKey: SocialProviderKey) => {
    if (!linkState) return
    setLinkBusy(true)
    setLinkError(null)
    try {
      const user = await linkPendingCredentialWithProvider(existingKey, linkState.pendingCredential)
      setLinkState(null)
      await routeAfterAuth(user.emailVerified)
    } catch (err) {
      setLinkError(mapAuthError(err))
    } finally {
      setLinkBusy(false)
    }
  }

  const handleSignup = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSignupError(null)

    const validationError = validateSignup({
      name,
      email:           signupEmail,
      mobile,
      countryCode:     mobileCountryCode,
      password:        signupPassword,
      confirmPassword,
      orgName,
    })
    if (validationError) {
      setSignupError(validationError)
      return
    }

    // Compose the canonical E.164 mobile from the selected dial code + national number.
    const mobileE164 = formatPhoneNumber(mobile, {
      defaultCallingCode: callingDigitsForDialCode(mobileCountryCode),
    })

    setSignupLoading(true)
    try {
      await createOrganizerAccount({
        name:              name.trim(),
        email:             signupEmail.trim(),
        password:          signupPassword,
        orgName:           orgName.trim(),
        mobileE164,
        mobileCountryCode,
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
                    onSocialSelect={handleSocial}
                    socialLoadingKey={socialLoadingKey}
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

                      <div className="lg:col-span-2">
                        <PhoneField
                          id="signup-mobile"
                          label="Mobile Number"
                          countryCode={mobileCountryCode}
                          onCountryCodeChange={setMobileCountryCode}
                          value={mobile}
                          onChange={setMobile}
                          placeholder="98765 43210"
                          hint="Private — used only for RegisterDesk account notifications (approvals, settlements, security). Never shown to attendees."
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
                      <SocialLoginRow onSelect={handleSocial} loadingKey={socialLoadingKey} />
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

            {linkState && (
              <LinkAccountDialog
                key={linkState.email}
                open
                email={linkState.email}
                methods={linkState.methods}
                pendingProviderKey={linkState.providerKey}
                busy={linkBusy}
                error={linkError}
                onLinkWithPassword={handleLinkWithPassword}
                onLinkWithProvider={handleLinkWithProvider}
                onClose={() => { if (!linkBusy) { setLinkState(null); setLinkError(null) } }}
              />
            )}
    </AuthScreen>
  )
}
