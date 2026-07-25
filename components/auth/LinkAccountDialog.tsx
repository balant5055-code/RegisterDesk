'use client'

import { useEffect, useState } from 'react'
import { Loader2, Link2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { PasswordField } from './PasswordField'
import {
  SOCIAL_PROVIDER_LABEL,
  methodToProviderKey,
  type SocialProviderKey,
} from '@/lib/firebase/auth/social'

// ─── LinkAccountDialog ──────────────────────────────────────────────────────────
// Shown when a social sign-in collides with an email that already has a different
// sign-in method (auth/account-exists-with-different-credential). It lets the user
// link the new provider onto their EXISTING account (never creating a duplicate):
//   • existing method = password → ask for the password, then linkWithCredential.
//   • existing method = another OAuth provider → re-auth with it, then link.

export interface LinkAccountDialogProps {
  open:               boolean
  email:              string
  methods:            string[]
  pendingProviderKey: SocialProviderKey
  busy:               boolean
  error:              string | null
  onLinkWithPassword: (password: string) => void
  onLinkWithProvider: (existingKey: SocialProviderKey) => void
  onClose:            () => void
}

export function LinkAccountDialog({
  open,
  email,
  methods,
  pendingProviderKey,
  busy,
  error,
  onLinkWithPassword,
  onLinkWithProvider,
  onClose,
}: LinkAccountDialogProps) {
  // Fresh password state per attempt: the parent keys this component by email, so a
  // new collision remounts it (no reset-in-effect needed).
  const [password, setPassword] = useState('')

  // Escape closes (unless a link is in flight).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null

  const hasPassword     = methods.includes('password')
  // First existing OAuth provider (if any) to link against.
  const existingOAuth   = methods
    .map(methodToProviderKey)
    .find((k): k is SocialProviderKey => k !== null && k !== 'password')
  const pendingLabel    = SOCIAL_PROVIDER_LABEL[pendingProviderKey]

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-account-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
            <Link2 className="size-4 text-primary" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 id="link-account-title" className="text-[16px] font-bold text-foreground">Link your account</h2>
            <p className="truncate text-[13px] text-muted-foreground">{email}</p>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          {hasPassword ? (
            <>
              <p className="text-[14px] text-muted-foreground">
                This email already has a RegisterDesk account. Enter your password to link{' '}
                <span className="font-semibold text-foreground">{pendingLabel}</span> to it.
              </p>
              <PasswordField
                id="link-password"
                label="Password"
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={setPassword}
              />
              {error && (
                <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button
                type="button"
                variant="gradient"
                size="lg"
                isLoading={busy}
                onClick={() => onLinkWithPassword(password)}
                className="h-12 w-full"
              >
                Link {pendingLabel}
              </Button>
            </>
          ) : existingOAuth ? (
            <>
              <p className="text-[14px] text-muted-foreground">
                This email already signs in with{' '}
                <span className="font-semibold text-foreground">{SOCIAL_PROVIDER_LABEL[existingOAuth]}</span>.
                Continue with it to link <span className="font-semibold text-foreground">{pendingLabel}</span>.
              </p>
              {error && (
                <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button
                type="button"
                variant="gradient"
                size="lg"
                isLoading={busy}
                onClick={() => onLinkWithProvider(existingOAuth)}
                className="h-12 w-full"
              >
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : `Continue with ${SOCIAL_PROVIDER_LABEL[existingOAuth]}`}
              </Button>
            </>
          ) : (
            <p className="text-[14px] text-muted-foreground">
              This email is already registered. Please sign in with your original method.
            </p>
          )}

          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="w-full rounded-lg border border-border bg-card px-4 py-2.5 text-[14px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
