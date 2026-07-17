'use client'

import type { FormEvent, ReactNode } from 'react'
import Link from 'next/link'
import { Mail } from 'lucide-react'
import { Button } from '@/components/ui'
import { AuthField } from './AuthField'
import { PasswordField } from './PasswordField'
import { SocialLoginRow } from './SocialLoginRow'

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
  /** Render the (disabled) social sign-in row. Opt-in so it stays on the
   *  organizer panel and off the admin login. */
  showSocial?:         boolean
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
}: LoginFormProps) {
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
        />

        <PasswordField
          id="login-password"
          label="Password"
          autoComplete="current-password"
          placeholder="Enter your password"
          value={password}
          onChange={onPasswordChange}
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
                className="size-4 cursor-pointer rounded border-border accent-primary"
              />
              <span className="text-sm text-muted-foreground">Remember me</span>
            </label>
          ) : (
            <span />
          )}
          {forgotPasswordHref && (
            <Link
              href={forgotPasswordHref}
              className="text-sm font-medium text-primary transition-opacity duration-150 hover:opacity-75"
            >
              Forgot password?
            </Link>
          )}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <Button
        type="submit"
        variant="gradient"
        size="lg"
        isLoading={loading}
        className="mt-5 h-12 w-full cursor-pointer shadow-md transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
      >
        {submitLabel}
      </Button>

      {showSocial && (
        <div className="mt-4">
          <SocialLoginRow />
        </div>
      )}

      {footer}
    </form>
  )
}
