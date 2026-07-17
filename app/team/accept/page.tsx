'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import { Loader2, ShieldCheck, CheckCircle2, XCircle } from 'lucide-react'

type Phase = 'loading' | 'need-auth' | 'accepting' | 'done' | 'error'

function AcceptInner() {
  const params = useSearchParams()
  const router = useRouter()
  const token  = params.get('token') ?? ''
  const next   = `/team/accept?token=${encodeURIComponent(token)}`

  const [phase,   setPhase]   = useState<Phase>(() => (token ? 'loading' : 'error'))
  const [message, setMessage] = useState(() => (token ? '' : 'This invitation link is invalid.'))
  const userRef = useRef<User | null>(null)

  const accept = useCallback(async (user: User) => {
    setPhase('accepting')
    try {
      const tok = await user.getIdToken()
      const res = await fetch('/api/team/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ token }),
      })
      const data = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) { setPhase('error'); setMessage(data?.error ?? 'Could not accept the invitation.'); return }
      setPhase('done'); setMessage('You have joined the team.')
      setTimeout(() => router.replace('/dashboard'), 1500)
    } catch {
      setPhase('error'); setMessage('Something went wrong. Please try again.')
    }
  }, [token, router])

  useEffect(() => {
    if (!token) return   // phase already 'error' from initializer — no setState here
    const unsub = onAuthStateChanged(auth, user => {
      userRef.current = user
      if (!user) { setPhase('need-auth'); return }
      void accept(user)
    })
    return unsub
  }, [token, accept])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-7 text-center shadow-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl text-primary-foreground shadow-sm" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden>
          <ShieldCheck className="size-6" aria-hidden />
        </div>
        <h1 className="text-[19px] font-bold tracking-tight text-foreground">Team invitation</h1>

        {(phase === 'loading' || phase === 'accepting') && (
          <p className="mt-3 flex items-center justify-center gap-2 text-[13.5px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> {phase === 'accepting' ? 'Accepting invitation…' : 'Loading…'}
          </p>
        )}

        {phase === 'need-auth' && (
          <>
            <p className="mt-2 text-[13.5px] text-muted-foreground">Sign in or create an account with the invited email to accept this invitation.</p>
            <div className="mt-5 flex flex-col gap-2">
              <Link href={`/login?next=${encodeURIComponent(next)}`}
                className="inline-flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-[14px] font-semibold text-primary-foreground shadow-sm hover:opacity-90"
                style={{ backgroundImage: 'var(--primary-gradient)' }}>Sign in</Link>
              <Link href={`/register?next=${encodeURIComponent(next)}`}
                className="inline-flex w-full items-center justify-center rounded-lg border border-border px-4 py-2.5 text-[14px] font-medium text-foreground hover:bg-muted">Create an account</Link>
            </div>
          </>
        )}

        {phase === 'done' && (
          <p className="mt-3 flex items-center justify-center gap-2 text-[13.5px] font-medium text-emerald-700">
            <CheckCircle2 className="size-4" aria-hidden /> {message} Redirecting…
          </p>
        )}

        {phase === 'error' && (
          <>
            <p className="mt-3 flex items-center justify-center gap-2 text-[13.5px] text-destructive">
              <XCircle className="size-4" aria-hidden /> {message}
            </p>
            <Link href="/dashboard" className="mt-5 inline-flex w-full items-center justify-center rounded-lg border border-border px-4 py-2.5 text-[14px] font-medium text-foreground hover:bg-muted">Go to dashboard</Link>
          </>
        )}
      </div>
    </div>
  )
}

export default function TeamAcceptPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>}>
      <AcceptInner />
    </Suspense>
  )
}
