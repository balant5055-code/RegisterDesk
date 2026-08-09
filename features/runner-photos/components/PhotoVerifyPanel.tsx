'use client'

// RD-RUNNER-01 · Verify to see your photos.
//
// REUSES the existing attendee verification end to end: `/api/attendee/auth/request-otp` and
// `/api/attendee/auth/verify-otp`, the same email OTP that already guards the attendee
// portal. No new auth, no new session, no new cookie, no new rate limit.
//
// It runs INLINE rather than redirecting to `/attendee/login`, for one reason: that page has
// no return path, so a participant who followed a link to their photos would verify and land
// somewhere else entirely. Verifying here leaves them exactly where they meant to be.

import { useCallback, useState } from 'react'
import { Loader2, Mail, ShieldCheck } from 'lucide-react'
import { Button, Card } from '@/components/ui'

type Stage = 'email' | 'code'

export function PhotoVerifyPanel({ eventName }: { eventName: string }) {
  const [stage, setStage] = useState<Stage>('email')
  const [email, setEmail] = useState('')
  const [code,  setCode]  = useState('')
  const [busy,  setBusy]  = useState(false)
  const [error, setError] = useState<string | null>(null)

  const requestCode = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/attendee/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(detail?.error ?? 'Could not send the code. Please try again.')
      }
      // The endpoint always reports success — it never reveals whether an email is in the
      // system. So the copy below says "if you registered", which is the honest phrasing.
      setStage('code')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the code.')
    } finally {
      setBusy(false)
    }
  }, [email])

  const verify = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/attendee/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp: code }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(detail?.error ?? 'That code was not accepted.')
      }
      // The session cookie is now set. A full reload lets the server component re-run and
      // render the gallery — no client-side duplicate of the access rules.
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code was not accepted.')
      setBusy(false)
    }
  }, [email, code])

  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted" aria-hidden>
          <ShieldCheck className="size-[18px] text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-fs-md font-semibold text-foreground">
            Verify your email to see your photos
          </h2>
          <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
            Photos are matched to your bib number, so we confirm it is you before showing
            them. Use the email you registered for {eventName} with.
          </p>

          {stage === 'email' ? (
            <form
              className="mt-4 flex flex-wrap gap-2"
              onSubmit={e => { e.preventDefault(); void requestCode() }}
            >
              <label htmlFor="photo-verify-email" className="sr-only">Email address</label>
              <input
                id="photo-verify-email"
                type="email"
                required
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-[14px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
              <Button type="submit" size="sm" disabled={busy || email.trim() === ''}>
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Mail className="size-4" aria-hidden />}
                Send code
              </Button>
            </form>
          ) : (
            <form
              className="mt-4 flex flex-wrap gap-2"
              onSubmit={e => { e.preventDefault(); void verify() }}
            >
              <label htmlFor="photo-verify-code" className="sr-only">Verification code</label>
              <input
                id="photo-verify-code"
                type="text"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="6-digit code"
                className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-[14px] tabular-nums text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
              <Button type="submit" size="sm" disabled={busy || code.length < 4}>
                {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Verify
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setStage('email')}>
                Change email
              </Button>
            </form>
          )}

          {stage === 'code' && !error && (
            <p className="mt-2 text-fs-2xs text-muted-foreground">
              If you registered with that address, a code is on its way. It expires shortly.
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-[13.5px] text-destructive">{error}</p>
          )}
        </div>
      </div>
    </Card>
  )
}
