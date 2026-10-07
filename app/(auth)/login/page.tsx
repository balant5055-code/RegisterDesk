'use client'

import { use, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence, type Variants } from 'framer-motion'
import { auth, createOrganizerAccount, signInOrganizer, mapAuthError } from '@/lib/firebase/auth'
import { ArrowRight, Mail, User, Building2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { BrandLockup } from '@/components/marketing/BrandLockup'
import {
  AuthField,
  PasswordField,
  PhoneField,
  SocialLoginRow,
} from '@/components/auth'
import { AuthSplitLayout, AUTH_CANVAS_BG, AUTH_CANVAS_FROM } from '@/components/auth/AuthSplitLayout'
import { LinkAccountDialog } from '@/components/auth/LinkAccountDialog'
import { EASE } from '@/components/auth/authMotion'
import { ROUTES } from '@/config/navigation'
import { redirectFromSearch, withRedirect } from '@/lib/auth/redirectTarget'
import { formatPhoneNumber, validatePhoneNumber } from '@/lib/communication/phone'
import { DEFAULT_DIAL_CODE, callingDigitsForDialCode } from '@/lib/communication/countryCodes'
import {
  signInWithSocial,
  linkPendingCredentialWithPassword,
  linkPendingCredentialWithProvider,
  type SocialProviderKey,
  type SocialSignInResult,
} from '@/lib/firebase/auth/social'
import { PAGE_TITLE } from '@/lib/marketing/pageTitle'

// ═══ PRESENTATION NOTE ═══════════════════════════════════════════════════════
// EVERY handler, validator, redirect and piece of state below is unchanged; only
// the markup that renders them is new. Two structural facts:
//
//   • It does not render AuthScreen. AuthScreen remains THE shell for
//     forgot-password, verify-email and verify-email-success, untouched.
//
//   • It does not render LoginForm. That component is shared with /admin/login,
//     and this screen's visual language is not admin's. Composing the same
//     AuthField / PasswordField / SocialLoginRow primitives here leaves LoginForm
//     byte-identical for the admin route, which is the constraint. No
//     authentication logic is duplicated: the handlers live here, as they always
//     did, and the field components are the same ones LoginForm uses.
//
// ═══ THE COMPOSITION: ONE CENTRED COLUMN, NO IMAGERY ═════════════════════════
// This screen was twice a split — form on the left, a full-height photograph on
// the right — and both versions were rejected. It is now a single centred column
// on a white page with no photograph at all, which is the composition the product
// owner asked for by name.
//
// AuthSplitLayout is still the shell, but it is called WITHOUT a `visual`. That is
// a real shape in that component, not an omission: given no panel it drops the
// grid entirely, because a grid-cols-[55fr_45fr] with one child would pin the form
// to the left 55% of an otherwise empty page. AuthCarousel and its slides remain in
// the codebase for any surface that wants brand imagery; nothing here imports them,
// so a phone never fetches a photograph it will not see.
//
// ═══ THE RULES ═══════════════════════════════════════════════════════════════
//   Flat --background. NO wash, NO tint, NO shadow, NO glow anywhere.
//
//   Bordered fields, not hairlines, and no icons inside them. The label above each
//   field is the only thing that names it.
//
//   ONE saturated object: the CTA, painted with the product's own public ramp via
//   `rd-brand-gradient`. Everything else is type, hairlines and white.
//
// ⚠ The CTA does NOT use Button's default `primary` variant. That variant carries
//   a magenta glow shadow plus a hover lift, which is what "no shadow of pink" was
//   about. `secondary` is the variant with no shadow in its map. Do not "simplify"
//   this back to the default variant.

// ─── Animation constants ──────────────────────────────────────────────────────

// Form-switch animation — used inside AnimatePresence when toggling login ↔ signup.
// Pure opacity so no content clips.
const switchVariants: Variants = {
  enter:  { opacity: 0 },
  center: { opacity: 1, transition: { duration: 0.26, ease: EASE } },
  exit:   { opacity: 0, transition: { duration: 0.14, ease: 'easeIn' } },
}

/** The surface the form sits on.
 *
 *  A centred column of controls floating on white has no edges, and a composition
 *  with no edges reads as unfinished however well it is spaced. This gives it one:
 *  a single hairline rectangle, generous inside, holding the fields, the CTA and
 *  the providers — and nothing else. The heading sits above it and the account
 *  switch below it, so the panel contains exactly the act of signing in.
 *
 *  NO shadow and NO fill that differs from the page: --card and --background are
 *  both #FFFFFF, so only the border draws. That is the whole point — it is an edge,
 *  not a floating object.
 *
 *  The horizontal padding is generous and fixed; the VERTICAL padding is vh-aware,
 *  because /login must fit 1024×667 in signup mode and 64px of fixed py would not.
 *  Measured before adding it: 29px of slack at 1280×667. */
const PANEL = cn(
  // --radius-panel = 10px. The radii on this screen step DOWN as the objects get
  // smaller and more interactive — 10px surface, 6px controls — which is what the
  // token names in styles/tokens.css prescribe (--radius-panel for a panel,
  // --radius-control for "interactive controls"). Softer corners (this was 24px,
  // then 16px) read as friendly; these read as precise, which is the brief.
  // 2026-09-24: a soft lift (elevation-1) now that the page canvas is tinted — the panel
  // is the one raised object on the screen.
  'rounded-[var(--radius-panel)] border border-border/70 bg-card shadow-elevation-1',
  'px-[clamp(1.125rem,3vw,2rem)] py-[clamp(1rem,2.2vh,2rem)]',
  // Above 760px of viewport height the tight-fit maths stops binding (63px of slack
  // at 1024x720 in signup, measured), so the panel gets the padding it actually
  // wants. Padding sits BELOW the heading, so this cannot move the anchor e2e pins.
  '[@media(min-height:760px)]:py-8',
)

// ─── Presentation atoms ───────────────────────────────────────────────────────

/** The eyebrow → headline → supporting-copy block, centred above the form.
 *
 *  ⚠ SHAPE IS LOAD-BEARING. e2e/authViewport.spec.ts resolves the composition's
 *  vertical anchor as `h1.parentElement.querySelector('p')` and the headline as the
 *  <h1>. Remove the eyebrow <p>, or move it out of the <h1>'s parent, and that spec
 *  measures NaN rather than failing usefully. */
function AuthIntro({ eyebrow, title, blurb }: { eyebrow: string; title: string; blurb: string }) {
  // 2026-09-23 luxury pass — the site's editorial voice, nothing structural: the eyebrow is
  // bronze-ruled small caps (still the <p> e2e anchors on), the headline is the display
  // face set light in --hero-ink, the blurb is --hero-ink-soft. Sizes, the height gate and
  // every vh clamp are unchanged, so the 11-size fit is untouched.
  return (
    <div className="text-center">
      <p className="inline-flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
        <span aria-hidden className="h-px w-6 bg-hero-accent-rule" />
        {eyebrow}
        <span aria-hidden className="h-px w-6 bg-hero-accent-rule" />
      </p>
      <h1 className={`mt-[clamp(0.5rem,1.2vh,0.875rem)] ${PAGE_TITLE}`}>
        {title}
      </h1>
      <p className="mx-auto mt-[clamp(0.25rem,0.9vh,0.625rem)] max-w-[60ch] text-fs-base leading-relaxed text-hero-ink-soft">
        {blurb}
      </p>
    </div>
  )
}

/** The submit control: the brand ramp, flat, full width.
 *
 *  ═══ WHY THE RAMP AND NOT INK ════════════════════════════════════════════════
 *  It was solid --foreground for one revision. That was a misreading: what had to
 *  go was the PINK GLOW under the button (Button's `primary` variant shadow) and
 *  the violet ground wash — not the brand itself. This is the product's own public
 *  accent, applied the only sanctioned way, and it is the single saturated object
 *  on the page.
 *
 *  ⚠ `rd-brand-gradient` is THE definition of that ramp — --action → --action-end
 *  in styles/tokens.css. The two hex values are never re-typed in a component.
 *
 *  ⚠ `variant="secondary"` is deliberate and is NOT about colour: it is the entry
 *  in Button's variant map with no shadow and no hover lift. The default `primary`
 *  carries `shadow-[0_2px_12px_rgb(var(--primary-rgb)/0.28)]` — a magenta glow —
 *  which is exactly what was asked to be removed. `bg-transparent` clears that
 *  variant's fill so the gradient is the only paint.
 *
 *  ⚠ `rounded-[var(--radius-lg)]` and not a named radius class: lib/utils/cn.ts
 *  extends tailwind-merge for `text-fs-*` ONLY, so a custom radius name never
 *  conflict-resolves against Button's base `rounded-xl` — both survive and
 *  stylesheet order decides. Measured, the button rendered at 16px beside 12px
 *  fields. An arbitrary value IS recognised, so it wins the merge.
 *
 *  The inset white hairline is what stops a saturated fill reading as a flat slab.
 *  It costs no layout and it is not a shadow. */
function SubmitButton({ children, loading }: { children: React.ReactNode; loading: boolean }) {
  return (
    <Button
      type="submit"
      size="lg"
      variant="secondary"
      isLoading={loading}
      className={cn(
        'rd-brand-gradient mt-[clamp(0.625rem,1.5vh,1.5rem)] h-12 w-full cursor-pointer',
        'rounded-[var(--radius-control)] border-0 bg-transparent',
        'text-white text-fs-base font-semibold tracking-[0.005em]',
        'ring-1 ring-inset ring-white/15',
        'group transition-opacity duration-200 hover:opacity-90',
        'focus-visible:ring-action focus-visible:ring-offset-2',
      )}
    >
      <span className="inline-flex items-center gap-2.5">
        {children}
        <ArrowRight
          className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
          aria-hidden
        />
      </span>
    </Button>
  )
}

/** Inline error. Unchanged semantics: role="alert", the real message, never a
 *  generic stand-in. A left rule rather than a tinted panel — the only red on the
 *  screen is the rule and the words. */
function AuthError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="mt-4 border-l-2 border-destructive py-1 pl-3 text-left text-fs-sm text-destructive"
    >
      {message}
    </p>
  )
}

/** The login ↔ signup switch: one sentence under the form.
 *
 *  On a centred column this is the conventional place for it and the conventional
 *  shape. The two versions that put it above the fields — first a filled segmented
 *  control, then a hairline tab pair — both added a horizontal band across a
 *  composition whose quality depends on there being very few of them. Same
 *  `setMode` call either way. */
function ModeToggle({
  question, action, onClick,
}: {
  question: string
  action: string
  onClick: () => void
}) {
  return (
    <p className="mt-[clamp(0.75rem,1.6vh,1.5rem)] text-center text-fs-sm text-muted-foreground">
      {question}{' '}
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'cursor-pointer font-semibold text-action underline-offset-4 transition-colors',
          'hover:underline',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-4',
        )}
      >
        {action}
      </button>
    </p>
  )
}

/** The line that closes the page: the way back out, and the two documents that
 *  govern the account being created.
 *
 *  ═══ WHY IT IS HEIGHT-GATED ══════════════════════════════════════════════════
 *  /login is a single-screen composition: at 1024×667 — the tightest supported
 *  desktop case — the signup form uses nearly the whole column, and e2e asserts
 *  that neither the document nor the column scrolls. From lg it therefore renders
 *  only above 720px of viewport height, where the space it takes is space that was
 *  empty. Below lg the page may scroll, so it always renders — otherwise a 360×640
 *  phone would be the one size with no route to those documents. */
function AuthPageFooter() {
  const LINKS = [
    { href: '/privacy', label: 'Privacy' },
    { href: '/terms',   label: 'Terms'   },
  ]

  const linkClass = cn(
    'text-fs-2xs text-muted-foreground underline-offset-4 transition-colors',
    'hover:text-foreground hover:underline',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2',
  )

  return (
    <div
      className={cn(
        'relative mt-[clamp(1rem,2.4vh,2.5rem)] hidden items-center justify-between gap-4',
        'border-t border-border pt-[clamp(0.625rem,1.3vh,1.25rem)]',
        // Below lg the WRAPPER supplies the rule and the ground, because it is the
        // element pinned to the viewport edge. Drawing them here too would put a
        // second hairline inside the bar and a margin above a fixed element.
        'max-lg:mt-0 max-lg:border-t-0',
        // Both variants resolve to `flex`, so their order in the stylesheet cannot
        // matter; only the base `hidden` is being overridden.
        'max-lg:flex [@media(min-height:720px)]:flex',
      )}
    >
      {/* A short fade above the bar, drawn only where the bar is pinned. Scrolling
          content otherwise met the strip's hairline as a hard cut halfway through a
          field label. Token-only (--background → transparent), and a fade is not a
          shadow: nothing is lifted off the page. */}
      <span
        aria-hidden
        className={cn('pointer-events-none absolute inset-x-0 bottom-full h-8 bg-gradient-to-t to-transparent lg:hidden', AUTH_CANVAS_FROM)}
      />
      <Link href={ROUTES.HOME} className={linkClass}>Back to home</Link>
      <nav className="flex items-center gap-5">
        {LINKS.map(({ href, label }) => (
          <Link key={href} href={href} className={linkClass}>{label}</Link>
        ))}
      </nav>
    </div>
  )
}

// ─── Signup validation ────────────────────────────────────────────────────────
// Returns the first error message found, or null if everything is valid.
// UNCHANGED — same fields, same order, same messages.

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
// RD-TEAM-INVITE-01: the guard itself now lives in lib/auth/redirectTarget so the
// verify-email hop applies the IDENTICAL rule instead of a second copy. Behaviour
// is unchanged for existing callers; the shared version additionally rejects a
// `/\` backslash form and control characters.
function safeRedirectTarget(): string | null {
  if (typeof window === 'undefined') return null
  return redirectFromSearch(window.location.search)
}

/**
 * RD-ORGANIZER-SIGNUP-FIX-02 (D4) · the ONE place the verification URL is built.
 *
 * Both hops to /verify-email — the sign-in path (routeAfterAuth) and the signup path
 * (handleSignup) — go through here, because the previous shape of this logic was
 * duplicated at both call sites and only one of them was ever reasoned about.
 *
 * `send-otp` commits the OTP document BEFORE it attempts delivery, so a non-OK status
 * still carries a usable `otpId`. Two facts therefore have to survive the redirect:
 *   • the otpId, at ANY status, or the organizer lands on a screen that cannot submit
 *   • whether the email actually went out, or the screen claims a delivery that failed
 */
function verifyEmailHref(opts: { otpId?: string; delivered: boolean; reason?: string }): string {
  const q = new URLSearchParams()
  if (opts.otpId) {
    q.set('otpId', opts.otpId)
    if (!opts.delivered) q.set('delivery', 'failed')
  } else if (opts.reason) {
    q.set('reason', opts.reason)
  }
  const query = q.toString()
  return query ? `${ROUTES.VERIFY_EMAIL}?${query}` : ROUTES.VERIFY_EMAIL
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const router = useRouter()

  // ── mode ───────────────────────────────────────────────────────────────────
  // Signup preselected via `?mode=signup` — used by the team-invitation page, whose
  // "Create an account" action previously pointed at a non-existent /register.
  //
  // Lazy initialiser (not an effect) so the correct form is on the FIRST paint —
  // an invitee who asked to create an account never sees the login form flash.
  //
  // HYDRATION (2026-09-24): it reads the query Next.js hands the page, NOT
  // window.location. The server has no window, so it always rendered the login form
  // while the browser's first render chose signup — a hydration mismatch on every
  // ?mode=signup visit, which made React throw the server HTML away and re-render.
  // Reading the same query on both sides makes the two first renders identical.
  const query = use(searchParams)
  function initialMode(): 'login' | 'signup' {
    const raw = typeof query.mode === 'string' ? query.mode : ''
    return new URLSearchParams({ mode: raw }).get('mode') === 'signup' ? 'signup' : 'login'
  }
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode)

  // ── login state ────────────────────────────────────────────────────────────
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [remember, setRemember]   = useState(false)
  const [loading, setLoading]     = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  // ── signup state ───────────────────────────────────────────────────────────
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
    // RD-TEAM-INVITE-01 — carry the destination THROUGH verification.
    //
    // Previously these two pushes dropped it, so an invitee who had to verify their
    // email (every newly created account) lost the invitation even though the
    // redirect had survived login. Both invitees in the reported incident took
    // exactly this branch. `withRedirect` is a no-op when there is no destination,
    // so the ordinary sign-in journey is byte-identical.
    const destination = safeRedirectTarget()

    const token = await auth.currentUser!.getIdToken()
    const res   = await fetch('/api/auth/send-otp', {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    // RD-ORGANIZER-SIGNUP-FIX-02 (D4) · same defect as handleSignup below, and this is the
    // likelier path: an organizer who abandoned verification reaches it on every return
    // visit. send-otp returns `otpId` WITH its 502, so branching on res.ok threw away a
    // usable code and landed them on a screen whose digit boxes did nothing.
    const { otpId } = await res.json().catch(() => ({})) as { otpId?: string }
    router.push(withRedirect(
      verifyEmailHref({ otpId, delivered: res.ok, reason: 'unverified' }),
      destination,
    ))
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
      // RD-TEAM-INVITE-01 — a NEW account is exactly the invitee case, so the
      // destination has to survive here as well as on the sign-in path above.
      const destination = safeRedirectTarget()
      // RD-ORGANIZER-SIGNUP-FIX-02 (D4) · this used to branch on res.ok and discard the
      // body on failure. But send-otp commits the OTP BEFORE it attempts delivery, and it
      // returns `otpId` alongside a 502 EMAIL_DELIVERY_FAILED precisely so the code stays
      // usable when the provider is down. Dropping it stranded the organizer on a
      // verification screen with no otpId, where typing all six digits did nothing at all.
      // The otpId is now carried through whenever the server sent one, at any status.
      const { otpId } = await res.json().catch(() => ({})) as { otpId?: string }
      router.push(withRedirect(
        verifyEmailHref({ otpId, delivered: res.ok }),
        destination,
      ))
    } catch (err) {
      setSignupError(mapAuthError(err))
    } finally {
      setSignupLoading(false)
    }
  }

  // ── The authentication column ──────────────────────────────────────────────
  const formColumn = (
    <div className={cn(
      'flex min-h-dvh flex-col px-5 py-8 sm:px-8',
      // Room for the footer strip that is fixed to the bottom edge below lg.
      'max-lg:pb-24',
      // From lg the column is exactly one viewport tall, so its padding is part of
      // the height budget rather than free space. 80px of fixed py alone once put
      // the login form 88px over a 667-tall viewport.
      'lg:min-h-0 lg:flex-1 lg:px-8',
      'lg:pt-[clamp(0.875rem,2.2vh,2.5rem)] lg:pb-[clamp(0.625rem,1.6vh,2rem)]',
    )}>

      {/* The 2px brand rule across the top edge of the page — the ONE place the
          action ramp appears, and the only block of colour on the screen. `fixed`
          so it bleeds past the column's padding without negative margins. */}
      <span aria-hidden className="rd-brand-gradient fixed inset-x-0 top-0 z-10 h-0.5" />

      {/* Masthead — the canonical lockup, centred, and the only navigation at the
          top of the page. There is no separate "back" control here: the lockup IS
          the way home, which is the convention on every sign-in screen worth
          copying, and the footer repeats it in words for anyone who wants it named.

          It MUST stay the first a[href="/"] in <main>: e2e resolves the brand by
          that selector to prove it is on screen at every supported size. */}
      <div className="flex justify-center">
        <BrandLockup size="sm" />
      </div>

      {/* ═══ THE FORM IS TOP-ANCHORED, NOT CENTRED ═══════════════════════════
             This once carried `my-auto`. Centring positions content by its own
             INTRINSIC height, so the anchor moved with both the viewport and the
             mode: measured across 18 desktop sizes the eyebrow ranged over 191px on
             login and 194px on signup, and at any one size login and signup started
             38–59px apart.

             Now there is ONE offset between the masthead and the content. The
             position is `column padding-top + masthead + this offset` — three
             bounded terms, none depending on how tall the form is, so login and
             signup share a baseline to the pixel and spare height falls BELOW the
             form. This offset is the largest of the three and scales with the
             viewport, which keeps the block optically placed rather than jammed
             under the logo on a tall screen. */}
      <div className="flex flex-1 flex-col pt-[clamp(1.25rem,4.8vh,5rem)] lg:min-h-0">
        <AuthIntro
          eyebrow={mode === 'login' ? 'Welcome back' : 'Get started'}
          title={mode === 'login' ? 'Sign in to continue' : 'Create your account'}
          blurb={
            mode === 'login'
              ? 'Manage your events, registrations and participants from one place.'
              : 'Set up your organizer account and start managing events.'
          }
        />

        <AnimatePresence mode="wait">

          {/* ── LOGIN ──────────────────────────────────────────────────────
                 One narrow measure. 400px is the width at which a single-column
                 form reads as a considered object rather than a stretched row. */}
          {mode === 'login' && (
            <motion.div
              key="login"
              variants={switchVariants}
              initial="enter"
              animate="center"
              exit="exit"
              className="mx-auto w-full max-w-[440px]"
            >
              <form onSubmit={handleLogin} noValidate className="mt-[clamp(0.875rem,2.2vh,2.5rem)]">
                <div className={PANEL}>
                <div className="space-y-[clamp(0.625rem,1.6vh,1.125rem)]">
                  <AuthField
                    id="login-email"
                    label="Email address"
                    type="email"
                    autoComplete="email"
                    placeholder="organizer@example.com"
                    value={email}
                    onChange={setEmail}
                    Icon={Mail}
                    accent="action"
                    hideIcon
                    radius="control"
                  />
                  <PasswordField
                    id="login-password"
                    label="Password"
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={setPassword}
                    accent="action"
                    hideIcon
                    radius="control"
                  />
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <label className="flex cursor-pointer select-none items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={e => setRemember(e.target.checked)}
                      className="size-4 cursor-pointer border-border accent-action"
                    />
                    <span className="text-fs-sm text-muted-foreground">Keep me signed in</span>
                  </label>
                  <Link
                    href={ROUTES.FORGOT_PASSWORD}
                    className={cn(
                      'text-fs-sm font-medium text-action underline-offset-4',
                      'transition-colors hover:underline',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-4',
                    )}
                  >
                    Forgot password?
                  </Link>
                </div>

                {loginError && <AuthError message={loginError} />}

                <SubmitButton loading={loading}>Sign in</SubmitButton>

                <div className="mt-[clamp(0.625rem,1.5vh,1.5rem)]">
                  <SocialLoginRow
                    onSelect={handleSocial}
                    loadingKey={socialLoadingKey}
                    accent="action"
                    label="or continue with"
                    variant="group"
                  />
                </div>
                </div>

                <ModeToggle
                  question="New to RegisterDesk?"
                  action="Create an account"
                  onClick={() => setMode('signup')}
                />
              </form>
            </motion.div>
          )}

          {/* ── CREATE ACCOUNT ─────────────────────────────────────────────
                 A wider measure than login, because six stacked fields at 400px is
                 1159px tall — measured — and fits NO supported viewport height,
                 1080 included. Two-up from lg it is 889px, which the vh-aware
                 rhythm takes under 768. Both blocks are centred on the same axis,
                 so the two modes do not appear to move sideways. */}
          {mode === 'signup' && (
            <motion.div
              key="signup"
              variants={switchVariants}
              initial="enter"
              animate="center"
              exit="exit"
              className="mx-auto w-full max-w-[440px] lg:max-w-[720px]"
            >
              <form onSubmit={handleSignup} noValidate className="mt-[clamp(0.875rem,2.2vh,2.5rem)]">
                <div className={PANEL}>
                {/*
                 * Row 1: Full Name | Organization Name
                 * Row 2: Email     | Mobile
                 * Row 3: Password  | Confirm Password
                 */}
                <div className="grid grid-cols-1 gap-x-5 gap-y-[clamp(0.5rem,1vh,1rem)] lg:grid-cols-2">
                  <AuthField
                    id="signup-name"
                    label="Full Name"
                    type="text"
                    autoComplete="name"
                    placeholder="Jane Smith"
                    value={name}
                    onChange={setName}
                    Icon={User}
                    accent="action"
                    hideIcon
                    radius="control"
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
                    accent="action"
                    hideIcon
                    radius="control"
                  />

                  <AuthField
                    id="signup-email"
                    label="Email Address"
                    type="email"
                    autoComplete="email"
                    placeholder="organizer@example.com"
                    value={signupEmail}
                    onChange={setSignupEmail}
                    Icon={Mail}
                    accent="action"
                    hideIcon
                    radius="control"
                  />

                  <PhoneField
                    id="signup-mobile"
                    label="Mobile Number"
                    countryCode={mobileCountryCode}
                    onCountryCodeChange={setMobileCountryCode}
                    value={mobile}
                    onChange={setMobile}
                    placeholder="98765 43210"
                    accent="action"
                    hideIcon
                    radius="control"
                  />

                  {/* The privacy disclosure, rendered here rather than through
                      PhoneField's `hint` prop — same words, full width.

                      Measured: inside the Mobile grid cell it wraps to 90px of text
                      and inflates that whole grid row from 76px to 172px. Spanning
                      both columns it costs a fraction of that. It stays directly
                      beneath the field it describes, and PhoneField — shared with
                      dashboard settings — is untouched. Its `hint` carries no
                      aria-describedby, so nothing programmatic is lost either.

                      ⚠ lg: ONLY — a col-span-2 on a single-column grid does not
                      collapse to one column, it creates an IMPLICIT second one.
                      With an `sm:col-span-2` here the signup grid silently went
                      two-up from 640px with mismatched column widths (measured at
                      820: a 192px first column beside a 352px second) even though
                      the field rows only go two-up at lg. */}
                  <p className="text-fs-2xs leading-snug text-muted-foreground lg:col-span-2">
                    Private — used only for RegisterDesk account notifications (approvals,
                    settlements, security). Never shown to attendees.
                  </p>

                  <PasswordField
                    id="signup-password"
                    label="Password"
                    autoComplete="new-password"
                    placeholder="Create a password"
                    value={signupPassword}
                    onChange={setSignupPassword}
                    accent="action"
                    hideIcon
                    radius="control"
                  />

                  <PasswordField
                    id="signup-confirm"
                    label="Confirm Password"
                    autoComplete="new-password"
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    accent="action"
                    hideIcon
                    radius="control"
                  />
                </div>

                {signupError && <AuthError message={signupError} />}

                <SubmitButton loading={signupLoading}>Create account</SubmitButton>

                <div className="mt-[clamp(0.625rem,1.5vh,1.5rem)]">
                  <SocialLoginRow
                    onSelect={handleSocial}
                    loadingKey={socialLoadingKey}
                    accent="action"
                    label="or continue with"
                    variant="group"
                  />
                </div>
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
      </div>

      {/* The footer's rule is aligned to the FORM's measure, not to the column's.
          At 680px under a 400px login form the hairline overhung the form by 140px
          on each side and read as an unrelated horizontal band. */}
      {/* ═══ THE FOOTER IS PINNED TO THE VIEWPORT ON A PHONE ══════════════════
             From lg it is the last block in a column that cannot scroll, so it
             already sits at the bottom of the screen. Below lg the page DOES scroll
             — signup is ~185px taller than a 390×844 viewport — and the footer
             scrolled away with it, so the two documents governing the account
             someone is about to create were reachable only by scrolling past the
             form. Fixed to the bottom edge, it is always there.

             `env(safe-area-inset-bottom)` keeps it clear of the iOS home indicator,
             and the column reserves the height it occupies (max-lg:pb-24 below) so
             the fixed strip never covers the last control. */}
      <div className={cn(
        'mx-auto w-full max-w-[440px]',
        mode === 'signup' && 'lg:max-w-[720px]',
        'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-20 max-lg:max-w-none',
        'max-lg:border-t max-lg:border-border max-lg:px-5', AUTH_CANVAS_BG,
        'max-lg:pb-[calc(0.6875rem+env(safe-area-inset-bottom))] sm:max-lg:px-8',
      )}>
        <AuthPageFooter />
      </div>
    </div>
  )

  return (
    <>
      <AuthSplitLayout form={formColumn} />

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
    </>
  )
}
