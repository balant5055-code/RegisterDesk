// ─── The redesigned sign-in experience ───────────────────────────────────────
//
// /login is now a split composition — form left, brand panel right — through a NEW
// shell, AuthSplitLayout. The redesign is presentation-only; these tests exist
// almost entirely to prove that.
//
// ═══ WHY A SECOND SHELL, AND WHAT IT MUST NOT DISTURB ════════════════════════
// AuthScreen is THE shared shell for forgot-password, verify-email and
// verify-email-success — its own header says it exists "so the four panels never
// drift". Redesigning it would have redesigned three pages that were explicitly out
// of scope, and giving it a `variant` prop would put a route-specific branch inside
// the component whose whole job is to be identical everywhere. So /login got its own
// shell and AuthScreen kept its three routes.
//
// The two things that can silently break as a result are pinned below: AuthScreen
// must still be used by exactly those three routes, and /login must no longer use it.
//
// ═══ WHY LOGIN NO LONGER RENDERS LoginForm ═══════════════════════════════════
// LoginForm is shared with /admin/login. The redesign changes the form's visual
// language — integrated rather than a floating card, no button shadow, the action
// ramp rather than the organizer magenta — and applying that to LoginForm would have
// redesigned admin sign-in too. /login composes the SAME primitives (AuthField,
// PasswordField, SocialLoginRow) directly, so no authentication logic is duplicated
// and LoginForm is untouched for the admin route.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { AUTH_SLIDES } from '@/components/auth/authCarouselSlides'
import { APPROVED_IMAGE_HOSTS } from '@/lib/utils/imageUrl'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const exists = (p: string) => existsSync(resolvePath(ROOT, p))
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const LOGIN = 'app/(auth)/login/page.tsx'
const SPLIT = 'components/auth/AuthSplitLayout.tsx'
const CAROUSEL = 'components/auth/AuthCarousel.tsx'
const loginSrc = () => code(read(LOGIN))

// ═══ 1. THE NEW PRESENTATION ARCHITECTURE ════════════════════════════════════

describe('the split shell', () => {
  it('exists and is presentation-only', () => {
    expect(exists(SPLIT)).toBe(true)
    const src = code(read(SPLIT))
    // Named for auth, but it must not KNOW any: no imports, no calls, no routing.
    // Matching the bare word would fail on its own filename, so this looks for the
    // things that would actually make it load-bearing.
    for (const forbidden of [
      'firebase', 'signIn', 'signOut', 'useRouter', 'router.push', 'redirect',
      'emailVerified', 'ROUTES', 'currentUser', 'getIdToken', 'fetch(',
    ]) {
      expect(src, 'AuthSplitLayout references ' + forbidden).not.toContain(forbidden)
    }
    // And it imports nothing from the auth or firebase layers.
    expect(src).not.toContain("from '@/lib/firebase")
    expect(src).not.toContain("from '@/lib/auth")
  })

  it('takes slots rather than owning content', () => {
    const src = code(read(SPLIT))
    expect(src).toMatch(/form:\s*ReactNode/)
    expect(src).toMatch(/visual\?:\s*ReactNode/)
  })

  it('puts the form first in DOM order, so it is first on a phone', () => {
    const src = code(read(SPLIT))
    expect(src.indexOf('{form}')).toBeLessThan(src.indexOf('{visual}'))
  })

  it('renders the visual only from lg — the form never waits on it', () => {
    const src = code(read(SPLIT))
    // Conditional render, not merely `hidden`: a phone must not fetch the image.
    expect(src).toMatch(/\{visual && \(/)
    expect(src).toContain('lg:block')
    expect(src).toContain('aria-hidden')
  })

  it('is used by /login', () => {
    expect(loginSrc()).toContain('AuthSplitLayout')
  })
})

describe('AuthScreen keeps its three routes and loses login', () => {
  it('/login no longer renders it', () => {
    expect(loginSrc()).not.toContain('AuthScreen')
  })

  it('the other three auth routes still do', () => {
    for (const p of [
      'app/(auth)/forgot-password/page.tsx',
      'app/(auth)/verify-email/page.tsx',
      'app/(auth)/verify-email-success/page.tsx',
    ]) {
      expect(code(read(p)), p + ' lost AuthScreen').toContain('AuthScreen')
    }
  })

  it('AuthScreen has no route-specific branch', () => {
    // The failure this guards: teaching the shared shell to know about /login.
    const src = code(read('components/auth/AuthScreen.tsx'))
    // Precisely: no route awareness and no login-specific prop. A bare /variant/
    // would fail on framer-motion's `variants={fadeUp}`, which is unrelated.
    expect(src).not.toMatch(/usePathname|pathname/)
    expect(src).not.toContain('isLogin')
    expect(src).not.toMatch(/mode\s*===/)
  })

  it('no /register route was introduced — signup is still a mode of /login', () => {
    expect(exists('app/(auth)/register/page.tsx')).toBe(false)
    const entries = readdirSync(resolvePath(ROOT, 'app/(auth)'), { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name)
    expect(entries).toContain('login')
    expect(loginSrc()).toMatch(/useState<'login' \| 'signup'>/)
  })
})

describe('/admin/login — one column, public theme (owner decision 2026-09-23)', () => {
  // It was pinned "untouched" so the PUBLIC /login redesign could not leak into it. The owner
  // then asked for this screen too: the magenta two-column split is gone and it now shares
  // /login's composition. The auth logic is still LoginForm's, in its opt-in editorial tone.
  it('renders the shared LoginForm in the editorial tone, with no split shell', () => {
    const src = code(read('app/(admin-auth)/admin/login/page.tsx'))
    expect(src).toContain('LoginForm')
    expect(src).toContain('tone="editorial"')
    expect(src).not.toContain('AuthShell')
  })

  it('carries no magenta — no --primary gradient, no primary utilities', () => {
    const src = code(read('app/(admin-auth)/admin/login/page.tsx'))
    expect(src).not.toContain('primary-gradient')
    expect(src).not.toMatch(/(?:text|bg|border|ring|accent)-primary/)
    expect(src).toContain('rd-brand-gradient')
  })

  it('keeps the admin authorization flow line for line', () => {
    const src = code(read('app/(admin-auth)/admin/login/page.tsx'))
    expect(src).toContain("fetch('/api/admin/auth-check'")
    expect(src).toContain('await signOut(auth)')
    expect(src).toContain('window.location.replace(ROUTES.ADMIN_DASHBOARD)')
  })

  it('and LoginForm still exists with its contract intact', () => {
    const src = code(read('components/auth/LoginForm.tsx'))
    for (const prop of ['showRemember', 'forgotPasswordHref', 'showSocial', 'onSocialSelect', 'submitLabel']) {
      expect(src, 'LoginForm lost ' + prop).toContain(prop)
    }
  })
})

// ═══ 2. AUTHENTICATION BEHAVIOUR IS UNCHANGED ════════════════════════════════

describe('every authentication behaviour survives the redesign', () => {
  const src = loginSrc()

  it('keeps the lazy ?mode=signup initialiser — no login flash for an invitee', () => {
    // A lazy useState initialiser, NOT an effect: an effect would paint login first.
    expect(src).toMatch(/function initialMode\(\)/)
    expect(src).toMatch(/get\('mode'\) === 'signup'/)
    expect(src).toMatch(/useState<'login' \| 'signup'>\(initialMode\)/)
  })

  it('keeps the sign-in call with its remember argument', () => {
    expect(src).toMatch(/signInOrganizer\(email, password, remember\)/)
  })

  it('keeps the single post-auth routing decision, redirect included', () => {
    expect(src).toMatch(/routeAfterAuth/)
    expect(src).toMatch(/safeRedirectTarget\(\) \?\? ROUTES\.DASHBOARD/)
    expect(src).toContain('redirectFromSearch')
    // RD-TEAM-INVITE-01: the destination must survive the verification hop.
    expect(src).toContain('withRedirect')
  })

  it('keeps the OTP send and the verify-email hop', () => {
    expect(src).toContain("'/api/auth/send-otp'")
    expect(src).toContain('ROUTES.VERIFY_EMAIL')
  })

  it('keeps account creation with every required field', () => {
    expect(src).toMatch(/createOrganizerAccount\(\{/)
    for (const field of ['name:', 'email:', 'password:', 'orgName:', 'mobileE164', 'mobileCountryCode']) {
      expect(src, 'createOrganizerAccount lost ' + field).toContain(field)
    }
  })

  it('keeps every signup validation rule, in order', () => {
    for (const rule of [
      'Full name is required.',
      'Organization name is required.',
      'Email address is required.',
      'Enter a valid email address.',
      'Mobile number is required.',
      'Enter a valid mobile number.',
      'Password must be at least 8 characters.',
      'Passwords do not match.',
    ]) {
      expect(src, 'lost validation: ' + rule).toContain(rule)
    }
  })

  it('keeps organization name and mobile as real, rendered, required fields', () => {
    // The two the redesign brief was most at risk of dropping.
    expect(src).toContain('signup-org')
    expect(src).toContain('Organization Name')
    expect(src).toContain('signup-mobile')
    expect(src).toContain('PhoneField')
    expect(src).toContain('onCountryCodeChange')
  })

  it('keeps all THREE social providers, not just Google', () => {
    expect(src).toContain('SocialLoginRow')
    const row = code(read('components/auth/SocialLoginRow.tsx'))
    for (const p of ['google', 'microsoft', 'facebook']) {
      expect(row, 'provider missing: ' + p).toContain(`'${p}'`)
    }
  })

  it('keeps the account-linking flow', () => {
    expect(src).toContain('LinkAccountDialog')
    expect(src).toContain("result.status === 'needs-link'")
    expect(src).toContain('linkPendingCredentialWithPassword')
    expect(src).toContain('linkPendingCredentialWithProvider')
  })

  // RD-SIGNUP-PERMDENIED-01 · signup does Auth work AND a Firestore write
  // (createOrganizerProfile), so mapAuthError is handed Firestore codes too. When
  // `permission-denied` fell through to the generic default, a signup that was being
  // REFUSED by security rules looked exactly like any other unknown failure — which is
  // precisely how a real outage stayed unattributable through several debugging rounds.
  //
  // Asserted against the source rather than by calling the function: this module
  // initialises the Firebase client SDK at import time, which a unit test must not do.
  it('maps Firestore codes, so a refused profile write is never "something went wrong"', () => {
    const mapper = read('lib/firebase/auth/index.ts')
    expect(mapper).toContain("case 'permission-denied':")
    expect(mapper).toContain("case 'unavailable':")
    expect(mapper).toContain("case 'deadline-exceeded':")
    // The copy must stay non-technical — no rules/Firestore/collection wording on screen.
    const permBranch = mapper.slice(mapper.indexOf("case 'permission-denied':"))
      .slice(0, 300)
    expect(permBranch).not.toMatch(/firestore|security rule|permission-denied'\s*$/i)
    // An unmapped code must still be visible to whoever is debugging.
    expect(mapper).toContain("console.warn('[auth] unmapped Firebase error code:', err.code)")
  })

  it('surfaces real errors, never a generic stand-in', () => {
    expect(src).toContain('mapAuthError')
    expect(src).toMatch(/role="alert"/)
    // Both forms keep their own error channel and their own loading flag.
    for (const s of ['loginError', 'signupError', 'loading', 'signupLoading', 'socialLoadingKey']) {
      expect(src, 'lost state: ' + s).toContain(s)
    }
  })
})

// ═══ 3. THE CAROUSEL ═════════════════════════════════════════════════════════

describe('the brand carousel', () => {
  it('has exactly three slides with copy and an image', () => {
    expect(AUTH_SLIDES).toHaveLength(3)
    for (const s of AUTH_SLIDES) {
      expect(s.headline.trim()).toBeTruthy()
      expect(s.body.trim()).toBeTruthy()
      expect(s.src).toMatch(/^https:\/\//)
    }
  })

  it('serves every image from an already-approved host', () => {
    for (const s of AUTH_SLIDES) {
      const host = new URL(s.src).hostname
      expect(APPROVED_IMAGE_HOSTS, host + ' is not approved').toContain(host)
    }
  })

  it('names no sport and reuses no race imagery', () => {
    // RegisterDesk runs races among many other things; leading sign-in with one
    // vertical tells a conference organizer the product is not for them.
    const blob = JSON.stringify(AUTH_SLIDES).toLowerCase()
    for (const w of ['marathon', 'runner', 'running', 'race', 'bib', 'track', 'sport']) {
      expect(blob, 'slide copy mentions ' + w).not.toContain(w)
    }
    // The road-race photo used by HeroBackdrop must not be reused here.
    const collage = read('components/discovery/home/HeroBackdrop.tsx')
    const raceId = collage.match(/photo-1517649763962-[a-z0-9]+/)?.[0]
    if (raceId) expect(blob).not.toContain(raceId)
  })

  it('makes no claim, cites no number and names no customer', () => {
    // Copy only — an image URL legitimately contains the photo's numeric id.
    const copy = AUTH_SLIDES.map(s => `${s.headline} ${s.body}`).join(' ').toLowerCase()
    for (const w of ['thousand', 'trusted by', 'award', 'testimonial', 'customers', '%', 'rated']) {
      expect(copy, 'slide copy claims: ' + w).not.toContain(w)
    }
    expect(copy, 'slide copy cites a number').not.toMatch(/\d/)
  })

  it('loads one image eagerly and lazies the rest', () => {
    const src = code(read(CAROUSEL))
    expect(src).toMatch(/priority=\{i === 0\}/)
    expect(src).toMatch(/loading=\{i === 0 \? undefined : 'lazy'\}/)
  })

  it('falls back to a token wash when an image fails, without breaking layout', () => {
    const src = code(read(CAROUSEL))
    expect(src).toContain('onError')
    expect(src).toContain('FALLBACK_WASH')
    // Silent: no console noise on the sign-in screen.
    expect(src).not.toContain('console.')
  })

  it('does not autoplay', () => {
    // Movement beside a password field is a distraction, and an un-pausable
    // auto-advancing region is a WCAG 2.2.2 problem.
    const src = code(read(CAROUSEL))
    expect(src).not.toMatch(/setInterval|setTimeout|autoplay|autoPlay/)
  })

  it('keeps its controls out of the tab order, because the panel is decorative', () => {
    const src = code(read(CAROUSEL))
    expect(src).toContain('tabIndex={-1}')
    expect(src).toMatch(/aria-label=\{label\}/)
  })
})

// ═══ 4. DESIGN SYSTEM ════════════════════════════════════════════════════════

const AUTH_UI = [LOGIN, SPLIT, CAROUSEL, 'components/auth/authCarouselSlides.ts'] as const

describe('the redesigned surface obeys the design system', () => {
  it('uses the public action ramp, not the retired organizer magenta', () => {
    const src = loginSrc()
    expect(src).toContain('text-action')
    expect(src).not.toContain('primary-gradient')
    expect(src).not.toMatch(/text-primary\b|bg-primary\b|accent-primary/)
  })

  it('reaches the gradient through the canonical class, never re-typed hex', () => {
    expect(loginSrc()).toContain('rd-brand-gradient')
  })

  it('hardcodes no colour anywhere in the new UI', () => {
    for (const f of AUTH_UI) {
      const src = code(read(f))
      expect(src, f + ' hardcodes a colour').not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, f + ' hardcodes a colour').not.toMatch(/\b(rgba?|hsla?|oklch)\((?!var)/)
    }
  })

  it('introduces no pill and no floating card', () => {
    for (const f of [LOGIN, SPLIT, CAROUSEL]) {
      const src = code(read(f))
      expect(src, f + ' uses rounded-full').not.toContain('rounded-full')
      expect(src, f + ' uses rounded-3xl').not.toContain('rounded-3xl')
      expect(src, f + ' adds a shadow').not.toMatch(/\bshadow-(sm|md|lg|xl|2xl)\b/)
    }
  })

  it('does not depend on the old brand panel', () => {
    expect(loginSrc()).not.toContain('OrganizerAuthHero')
    expect(loginSrc()).not.toContain('AuthCard')
  })

  it('uses the canonical lockup rather than redrawing the brand', () => {
    const src = loginSrc()
    expect(src).toContain('BrandLockup')
    // The old mobile strip drew an "RD" text tile instead of the real mark.
    expect(src).not.toMatch(/>RD</)
  })

  it('uses type tokens, not arbitrary pixel sizes', () => {
    for (const f of [LOGIN, SPLIT, CAROUSEL]) {
      expect(code(read(f)), f + ' uses an arbitrary font size').not.toMatch(/text-\[\d+px\]/)
    }
  })
})

// ═══ 5. NO FABRICATED PROOF ══════════════════════════════════════════════════

describe('no fabricated trust claim survives on any auth screen', () => {
  it('the "thousands of organizers" line is gone', () => {
    // It sat under the form on every AuthScreen route — a countable claim
    // RegisterDesk has never measured, on the screen where someone decides whether
    // to trust the product with a password.
    for (const f of [
      'components/auth/AuthScreen.tsx',
      'components/auth/AuthFooter.tsx',
      LOGIN,
    ]) {
      // code(), not raw source: the comment recording WHY the claim was removed
      // names it, and a comment is not a claim shown to a reader.
      const src = code(read(f))
      expect(src, f).not.toMatch(/thousands of organizers/i)
      expect(src, f).not.toMatch(/trusted by [\d,]+/i)
    }
  })

  it('and nothing numeric replaced it', () => {
    const footerLine = read('components/auth/AuthScreen.tsx')
      .match(/<AuthFooter>([\s\S]*?)<\/AuthFooter>/)?.[1] ?? ''
    expect(footerLine.trim()).toBeTruthy()
    expect(footerLine).not.toMatch(/\d/)
  })

  it('the sign-in page states no metric of its own', () => {
    const visible = loginSrc()
    for (const w of ['thousands', 'trusted by', 'award', 'testimonial', 'rated', '4.9', '99%']) {
      expect(visible.toLowerCase(), 'login page claims: ' + w).not.toContain(w.toLowerCase())
    }
  })
})

// ═══ 6. ACCESSIBILITY ════════════════════════════════════════════════════════

describe('the form stays accessible', () => {
  const src = loginSrc()

  it('every field has a real label, not a placeholder standing in for one', () => {
    // AuthField / PasswordField / PhoneField all render a <label for>; the page must
    // pass a label to each one it mounts.
    const fields = [...src.matchAll(/<(AuthField|PasswordField|PhoneField)\b[\s\S]*?\/>/g)].map(m => m[0])
    expect(fields.length).toBeGreaterThanOrEqual(8)   // 2 login + 6 signup
    for (const f of fields) expect(f, 'field without a label: ' + f.slice(0, 60)).toMatch(/label=/)
  })

  it('carries the right autocomplete on every field', () => {
    for (const a of ['email', 'current-password', 'new-password', 'name', 'organization']) {
      expect(src, 'missing autocomplete: ' + a).toContain(`autoComplete="${a}"`)
    }
  })

  it('gives the icon-only back link a visible focus ring', () => {
    expect(src).toMatch(/focus-visible:ring-2 focus-visible:ring-action/)
  })

  it('keeps the password visibility control, which lives in PasswordField', () => {
    const pf = code(read('components/auth/PasswordField.tsx'))
    expect(pf).toMatch(/aria-label|sr-only/)
    expect(pf).toMatch(/type=\{|showPassword|visible/i)
  })
})

// ═══ 7. THE VIEWPORT COMPOSITION ═════════════════════════════════════════════
//
// /login is a single-screen composition: nothing scrolls at desktop widths, in either
// mode. Whether it ACTUALLY fits is a measurement of rendered boxes, and vitest here
// runs on `environment: 'node'` with no DOM — so that assertion lives in
// e2e/authViewport.spec.ts, which checks 22 width×height×mode combinations against a
// real production server.
//
// What belongs HERE is the mechanism: the specific things that, when they regress,
// produce the overflow. Each one below was an actual cause, measured:
//
//   • 176px of fixed padding (lg:py-10 on the column + py-10 lg:py-12 on the wrapper)
//   • `items-center`, which overflows at BOTH ends and puts the heading out of reach
//   • single-column signup at 1024 — 1159px tall, fitting no viewport height at all
//   • the phone disclosure inside a 174px grid cell, wrapping to 90px

describe('the viewport composition cannot regress', () => {
  const login = () => loginSrc()

  it('the shell owns the height and lets its children shrink', () => {
    const src = code(read(SPLIT))
    expect(src).toContain('lg:h-dvh')          // the viewport, not the content, sets height
    expect(src).toContain('lg:overflow-hidden')
    expect(src).toContain('lg:min-h-0')        // without this a grid child cannot shrink
  })

  it('the form column carries no large fixed vertical padding', () => {
    // `lg:py-10` here plus `py-10 lg:py-12` on the wrapper was 176px spent before any
    // content — more than a quarter of a 667px viewport.
    const src = login()
    expect(src).not.toMatch(/lg:py-(?:8|10|12|14|16|20)\b/)
    expect(src).not.toMatch(/className="flex flex-1 items-center py-10/)
  })

  it('anchors the form to the top — it does not centre it', () => {
    // `my-auto` centred the block, and centring positions by INTRINSIC height: measured
    // across the 18 desktop sizes the eyebrow ranged over 191px on login and 194px on
    // signup, and at any one size the two modes started 38–59px apart, while the panel
    // beside them never moved. Neither auto margins nor justify-center may come back.
    const src = login()
    expect(src, 'the form is centred again').not.toContain('my-auto')
    expect(src, 'the form column centres its content').not.toMatch(/flex-1[^"]*justify-center/)
    expect(src, 'the form column centres its content').not.toMatch(/flex flex-1 items-center/)
  })

  it('positions the content with ONE bounded offset below the masthead', () => {
    // anchor = column padding-top + masthead + this offset. Three bounded terms, none of
    // them a function of how tall the form is, so login and signup share a baseline and
    // spare height falls BELOW the form instead of pushing it down.
    const src = login()
    expect(src).toMatch(/flex flex-1 flex-col pt-\[clamp\([^\]]+vh[^\]]*\)\]/)
    // The column's own top padding is likewise bounded, so the masthead cannot drift.
    expect(src).toMatch(/lg:pt-\[clamp\([^\]]+vh[^\]]*\)\]/)
  })

  it('spaces every section with viewport-aware clamps, not fixed margins', () => {
    const src = login()
    const clamps = src.match(/clamp\([^)]*vh[^)]*\)/g) ?? []
    // intro, headline, blurb, CTA, social, toggle margin, toggle padding, grid rows, column
    expect(clamps.length, 'the vertical rhythm is not viewport-aware').toBeGreaterThanOrEqual(8)
  })

  it('lays signup out two-up from lg, because single column does not fit', () => {
    // 1159px tall at 1024 — taller than every viewport height tested, 1080 included.
    expect(login()).toContain('lg:grid-cols-2')
    expect(login()).not.toMatch(/grid-cols-1 gap[^"]*xl:grid-cols-2/)
  })

  it('gives the phone disclosure the full column width', () => {
    // Inside the 174px Mobile cell it wrapped to 90px and inflated that whole grid row
    // from 76px to 172px. It is rendered here rather than through PhoneField's `hint`,
    // which is shared with dashboard settings and carries no aria-describedby.
    const src = login()
    expect(src).toMatch(/col-span-2[^>]*>\s*Private — used only for RegisterDesk/)
    // …and PhoneField is no longer asked to render it.
    const phoneCall = src.slice(src.indexOf('<PhoneField'), src.indexOf('/>', src.indexOf('<PhoneField')))
    expect(phoneCall, 'the hint is back inside the narrow grid cell').not.toContain('hint=')
  })

  it('keeps the disclosure itself, word for word', () => {
    // Moving it must never become dropping it.
    expect(login()).toContain('Never shown to attendees.')
    expect(login()).toContain('approvals')
  })

  it('does not buy the fit by shrinking controls', () => {
    // 48px inputs and CTA. The fit came from whitespace, not from usability.
    expect(login()).toMatch(/h-12 w-full/)          // CTA
    const field = code(read('components/auth/AuthField.tsx'))
    expect(field).toMatch(/h-12|h-\[48px\]/)
  })
})
