'use client'

import type { FormEvent, ReactNode } from 'react'
import Link from 'next/link'
import { Mail } from 'lucide-react'
import { Button } from '@/components/ui'
import { AuthField } from './AuthField'
import { PasswordField } from './PasswordField'
import { SocialLoginRow } from './SocialLoginRow'
import { cn } from '@/lib/utils/cn'
import type { SocialProviderKey } from '@/lib/firebase/auth/social'

// ─── LoginForm ──────────────────────────────────────────────────────────────
// PURE PRESENTATION. Email + password + loading + error + submit + optional
// "remember me" and "forgot password" link. Contains NO Firebase, NO redirects,
// NO role logic, NO navigation — the wrapper owns all of that via `onSubmit`.
// A `footer` slot lets a wrapper append its own controls (e.g. a mode toggle)
// inside the form without this component knowing about them.

export interface LoginFormProps {
  email:               string
  password:            string
  onEmailChange:       (v: string) => void
  onPasswordChange:    (v: string) => void
  onSubmit:            (e: FormEvent<HTMLFormElement>) => void
  loading?:            boolean
  error?:              string | null
  submitLabel?:        string
  emailPlaceholder?:   string
  forgotPasswordHref?: string
  showRemember?:       boolean
  remember?:           boolean
  onRememberChange?:   (v: boolean) => void
  footer?:             ReactNode
  /** Render the social sign-in row. Opt-in so it stays on the organizer panel and
   *  off the admin login. */
  showSocial?:         boolean
  /** Social handlers — forwarded to SocialLoginRow when showSocial is true. */
  onSocialSelect?:     (key: SocialProviderKey) => void
  socialLoadingKey?:   SocialProviderKey | null
  /**
   * 'default' — the original product dress (organizer magenta), byte-identical to what
   * shipped. 'editorial' — the public theme the sign-in screens now share: the --action
   * accent, icon-free 6px fields, a small-caps link, and the flat brand-ramp button with NO
   * shadow and NO hover lift (Button's gradient variant carries a magenta glow). Opt-in, so
   * nothing else changes.
   */
  tone?:               'default' | 'editorial'
}

export function LoginForm({
  email,
  password,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  loading = false,
  error = null,
  submitLabel = 'Sign In',
  emailPlaceholder = 'you@example.com',
  forgotPasswordHref,
  showRemember = false,
  remember = false,
  onRememberChange,
  footer,
  showSocial = false,
  onSocialSelect,
  socialLoadingKey = null,
  tone = 'default',
}: LoginFormProps) {
  const editorial = tone === 'editorial'
  const fieldProps = editorial
    ? { accent: 'action' as const, hideIcon: true, radius: 'control' as const }
    : {}
  return (
    <form onSubmit={onSubmit} noValidate>
      {/* Field group — 16px field-to-field */}
      <div className="space-y-4">
        <AuthField
          id="login-email"
          label="Email Address"
          type="email"
          autoComplete="email"
          placeholder={emailPlaceholder}
          value={email}
          onChange={onEmailChange}
          Icon={Mail}
          {...fieldProps}
        />

        <PasswordField
          id="login-password"
          label="Password"
          autoComplete="current-password"
          placeholder="Enter your password"
          value={password}
          onChange={onPasswordChange}
          {...fieldProps}
        />
      </div>

      {(showRemember || forgotPasswordHref) && (
        <div className="mt-4 flex items-center justify-between">
          {showRemember ? (
            <label className="flex cursor-pointer select-none items-center gap-2">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => onRememberChange?.(e.target.checked)}
                className={cn('size-4 cursor-pointer rounded border-border', editorial ? 'accent-action' : 'accent-primary')}
              />
              <span className="text-sm text-muted-foreground">Remember me</span>
            </label>
          ) : (
            <span />
          )}
          {forgotPasswordHref && (
            <Link
              href={forgotPasswordHref}
              className={editorial
                ? 'text-fs-xs font-semibold uppercase tracking-[0.12em] text-action underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2'
                : 'text-sm font-medium text-primary transition-opacity duration-150 hover:opacity-75'}
            >
              Forgot password?
            </Link>
          )}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className={editorial
            ? 'mt-4 border-l-2 border-destructive py-1 pl-3 text-left text-fs-sm text-destructive'
            : 'mt-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive'}
        >
          {error}
        </p>
      )}

      <Button
        type="submit"
        variant={editorial ? 'secondary' : 'gradient'}
        size="lg"
        isLoading={loading}
        className={editorial
          ? cn(
              'rd-brand-gradient mt-6 h-12 w-full cursor-pointer rounded-[var(--radius-control)] border-0 bg-transparent',
              'text-white text-fs-base font-semibold ring-1 ring-inset ring-white/15',
              'transition-opacity duration-200 hover:opacity-90 focus-visible:ring-action focus-visible:ring-offset-2',
            )
          : 'mt-5 h-12 w-full cursor-pointer shadow-md transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg'}
      >
        {submitLabel}
      </Button>

      {showSocial && (
        <div className="mt-4">
          <SocialLoginRow onSelect={onSocialSelect} loadingKey={socialLoadingKey} />
        </div>
      )}

      {footer}
    </form>
  )
}
