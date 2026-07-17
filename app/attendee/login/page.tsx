'use client'

import { useState }     from 'react'
import { useRouter }    from 'next/navigation'
import { Mail, KeyRound, Loader2, ShieldCheck, ArrowLeft } from 'lucide-react'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function AttendeeLoginPage() {
  const router = useRouter()
  const [step,   setStep]   = useState<'email' | 'otp'>('email')
  const [email,  setEmail]  = useState('')
  const [otp,    setOtp]    = useState('')
  const [busy,   setBusy]   = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function requestOtp() {
    if (!EMAIL_RE.test(email.trim())) { setError('Enter a valid email address.'); return }
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/attendee/auth/request-otp', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(b?.error ?? 'Could not send the code. Please try again.')
      }
      setStep('otp')
      setNotice('If that email is registered, a 6-digit code is on its way.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally { setBusy(false) }
  }

  async function verifyOtp() {
    if (!/^\d{6}$/.test(otp.trim())) { setError('Enter the 6-digit code.'); return }
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/attendee/auth/verify-otp', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), otp: otp.trim() }),
      })
      const b = await res.json().catch(() => null) as { authenticated?: boolean; error?: string } | null
      if (!res.ok || !b?.authenticated) throw new Error(b?.error ?? 'Invalid or expired code.')
      router.replace('/attendee')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-7 shadow-sm">
        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl text-primary-foreground shadow-sm" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden>
            <ShieldCheck className="size-6" aria-hidden />
          </div>
          <h1 className="text-[19px] font-bold tracking-tight text-foreground">Attendee sign in</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {step === 'email' ? 'Use the email you registered or donated with.' : `Enter the code sent to ${email}.`}
          </p>
        </div>

        {step === 'email' ? (
          <form onSubmit={e => { e.preventDefault(); void requestOtp() }} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-medium text-muted-foreground">Email</span>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  type="email" inputMode="email" autoComplete="email" autoFocus
                  value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-lg border border-border bg-background py-2.5 pl-9 pr-3 text-[14px] text-foreground outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </label>
            {error && <p className="text-[13px] text-destructive">{error}</p>}
            <button type="submit" disabled={busy}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[14px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
              style={{ backgroundImage: 'var(--primary-gradient)' }}>
              {busy && <Loader2 className="size-4 animate-spin" />} Send code
            </button>
          </form>
        ) : (
          <form onSubmit={e => { e.preventDefault(); void verifyOtp() }} className="space-y-3">
            {notice && <p className="rounded-lg bg-muted/50 px-3 py-2 text-[12.5px] text-muted-foreground">{notice}</p>}
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-medium text-muted-foreground">6-digit code</span>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                  value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  className="w-full rounded-lg border border-border bg-background py-2.5 pl-9 pr-3 text-[15px] tracking-[0.3em] text-foreground outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </label>
            {error && <p className="text-[13px] text-destructive">{error}</p>}
            <button type="submit" disabled={busy}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[14px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
              style={{ backgroundImage: 'var(--primary-gradient)' }}>
              {busy && <Loader2 className="size-4 animate-spin" />} Verify &amp; continue
            </button>
            <button type="button" onClick={() => { setStep('email'); setOtp(''); setError(null) }}
              className="inline-flex w-full items-center justify-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-3.5" aria-hidden /> Use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
