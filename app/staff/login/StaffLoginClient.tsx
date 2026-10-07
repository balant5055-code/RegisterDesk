'use client'

// RD-CHECKIN-2.0 — the dedicated staff sign-in.
//
// ═══ WHY THIS IS NOT A SECOND AUTH SYSTEM ════════════════════════════════════
// The username is mapped, deterministically, onto the reserved Auth address for
// that credential, and the sign-in itself is `authenticateUser` — the one neutral
// Firebase entry point every login surface in this repo already uses. No new token
// format, no new session mechanism, no bespoke password check. What is new is the
// FORM: a gate operator has a username, not a mailbox.
//
// Deriving the address on the client rather than asking a server to translate a
// username is deliberate: it means no endpoint exists that will tell an
// unauthenticated caller whether a username is real.
//
// ═══ WHAT THIS SCREEN DECIDES: NOTHING ═══════════════════════════════════════
// Where the operator lands, which events they may open, whether they must change
// their password — all of it comes from GET /api/staff/me, which re-verifies the
// token server-side. This component only carries the answer.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, Loader2, LockKeyhole, ScanLine } from 'lucide-react'
import { authenticateUser } from '@/lib/firebase/auth'
import { staffEmailForUsername, isValidUsername, PASSWORD_MIN } from '@/lib/staff/types'
import type { StaffMeResponse } from '@/app/api/staff/me/route'

type Stage = 'credentials' | 'password_change'

/**
 * Firebase's own error codes, in gate language.
 *
 * Wrong-username and wrong-password map to the SAME sentence on purpose: telling a
 * caller which half they got right turns the form into a username oracle.
 */
const AUTH_COPY: Record<string, string> = {
  'auth/invalid-credential':  'Incorrect username or password.',
  'auth/wrong-password':      'Incorrect username or password.',
  'auth/user-not-found':      'Incorrect username or password.',
  'auth/invalid-email':       'Incorrect username or password.',
  'auth/user-disabled':       'This account has been disabled. Ask your organizer.',
  'auth/too-many-requests':   'Too many attempts. Wait a moment and try again.',
  'auth/network-request-failed': 'No connection. Check your network and try again.',
}

/**
 * RD-TEAM-IMPL-01 — the event this sign-in page belongs to, when it has one.
 *
 * Resolved SERVER-side from the public event document and passed in. It changes what
 * the page says and where a successful sign-in lands; it grants nothing. `eventId`
 * is compared against the assignment list returned by /api/staff/me, and the gate
 * route re-authorizes it again — the slug is never trusted on its own.
 */
export interface StaffLoginEvent {
  slug:      string
  eventId:   string
  name:      string
  /** False when the event is cancelled, archived or not yet published. */
  accepting: boolean
}

export default function StaffLoginClient({ event }: { event?: StaffLoginEvent } = {}) {
  const router = useRouter()

  const [stage,    setStage]    = useState<Stage>('credentials')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newPw,    setNewPw]    = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [busy,     setBusy]     = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const userRef = useRef<HTMLInputElement>(null)
  const pwRef   = useRef<HTMLInputElement>(null)

  useEffect(() => { userRef.current?.focus() }, [])
  useEffect(() => { if (stage === 'password_change') pwRef.current?.focus() }, [stage])

  /** Sends the operator to their gate — or to the chooser when they have several. */
  const land = useCallback((me: StaffMeResponse) => {
    // ── Event-scoped door ────────────────────────────────────────────────────
    // The assignment list is the SERVER's answer (GET /api/staff/me re-verifies the
    // token), so this comparison is a routing decision made on server-resolved data,
    // not a permission check. The gate route runs authorizeEvent again regardless —
    // if this were ever wrong, the result would be a 403, not access.
    if (event) {
      if (!me.eventIds.includes(event.eventId)) {
        // Named plainly rather than as a generic failure: the operator has valid
        // credentials and is at the wrong door, which is a different problem from a
        // bad password and has a different fix.
        setError(`Your account is not assigned to ${event.name}. Ask your organizer, or use the link for an event you work.`)
        return
      }
      router.replace(`/ops/checkin/${encodeURIComponent(event.eventId)}`)
      return
    }

    // One assignment is unambiguous. Anything else has no single right answer, and a
    // wrong guess at a start line reads as "check-in is broken", so the operator
    // chooses on /ops.
    router.replace(me.eventIds.length === 1
      ? `/ops/checkin/${encodeURIComponent(me.eventIds[0])}`
      : '/ops')
  }, [router, event])

  const submitCredentials = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const u = username.trim().toLowerCase()
    if (!isValidUsername(u)) { setError('Enter your username.'); return }
    if (!password)           { setError('Enter your password.'); return }

    setBusy(true)
    setError(null)
    try {
      const { user } = await authenticateUser(staffEmailForUsername(u), password, true)
      const token = await user.getIdToken()
      const auth  = { Authorization: `Bearer ${token}` }

      // Fire-and-forget bookkeeping; a failed timestamp must not block a shift.
      void fetch('/api/staff/me', { method: 'POST', headers: auth }).catch(() => {})

      const res = await fetch('/api/staff/me', { headers: auth, cache: 'no-store' })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        setError(body?.error ?? 'This account cannot open check-in. Ask your organizer.')
        return
      }
      const me = await res.json() as StaffMeResponse

      // A temporary password is a handover, not a credential. It is changed before
      // the operator reaches a gate, not "sometime later".
      if (me.mustChangePassword) { setStage('password_change'); return }
      land(me)
    } catch (err) {
      const code = (err as { code?: string }).code ?? ''
      setError(AUTH_COPY[code] ?? 'Could not sign in. Please try again.')
    } finally {
      setBusy(false)
    }
  }, [username, password, land])

  const submitNewPassword = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPw.length < PASSWORD_MIN) { setError(`Use at least ${PASSWORD_MIN} characters.`); return }
    if (newPw !== confirm)           { setError('The two passwords do not match.'); return }

    setBusy(true)
    setError(null)
    try {
      const { user } = await authenticateUser(staffEmailForUsername(username.trim().toLowerCase()), password, true)
      const token = await user.getIdToken(true)
      const auth  = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

      const res = await fetch('/api/staff/password', {
        method: 'POST', headers: auth, body: JSON.stringify({ password: newPw }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        setError(body?.error ?? 'Could not change the password.')
        return
      }

      const meRes = await fetch('/api/staff/me', {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (!meRes.ok) { setError('Password changed. Please sign in again.'); setStage('credentials'); return }
      land(await meRes.json() as StaffMeResponse)
    } catch {
      setError('Could not change the password. Please try again.')
    } finally {
      setBusy(false)
    }
  }, [newPw, confirm, username, password, land])

  const field = 'w-full rounded-xl border border-border bg-card px-4 py-3 text-fs-md text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus-visible:ring-2 focus-visible:ring-primary'
  const submit = 'w-full rounded-xl bg-primary px-4 py-3 text-fs-md font-semibold text-primary-foreground transition-opacity disabled:opacity-50'

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-7 px-6 py-12">
      <header className="space-y-2">
        <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <ScanLine className="size-5" aria-hidden />
        </span>
        <h1 className="text-fs-xl font-bold leading-tight text-foreground">
          {stage === 'credentials' ? 'Staff sign-in' : 'Set your password'}
        </h1>
        {/* Naming the event is what makes a per-event link worth handing out — the
            operator can see they opened the right one before they type anything. */}
        {stage === 'credentials' && event && (
          <p className="text-fs-sm font-semibold text-foreground">{event.name}</p>
        )}
        <p className="text-fs-sm text-muted-foreground">
          {stage === 'credentials'
            ? 'Sign in with the username your organizer gave you.'
            : 'Your organizer issued a temporary password. Choose your own before you start.'}
        </p>
      </header>

      {/* Stated before the form rather than after a failed sign-in: the credentials
          are fine, the event simply is not open, and typing them changes nothing. */}
      {stage === 'credentials' && event && !event.accepting && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-fs-sm text-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          This event is not currently accepting check-ins.
        </p>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-fs-sm text-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          {error}
        </p>
      )}

      {stage === 'credentials' ? (
        <form onSubmit={submitCredentials} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="staff-username" className="text-fs-sm font-medium text-foreground">Username</label>
            <input
              id="staff-username"
              ref={userRef}
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              placeholder="gate.arun"
              className={field}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="staff-password" className="text-fs-sm font-medium text-foreground">Password</label>
            <input
              id="staff-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              className={field}
            />
          </div>

          <button type="submit" disabled={busy} className={submit}>
            {busy ? <Loader2 className="mx-auto size-5 animate-spin" aria-hidden /> : 'Sign in'}
            {busy && <span className="sr-only">Signing in</span>}
          </button>
        </form>
      ) : (
        <form onSubmit={submitNewPassword} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="staff-new" className="text-fs-sm font-medium text-foreground">New password</label>
            <input
              id="staff-new"
              ref={pwRef}
              type="password"
              value={newPw}
              onChange={e => setNewPw(e.target.value)}
              autoComplete="new-password"
              aria-describedby="staff-new-hint"
              className={field}
            />
            <p id="staff-new-hint" className="text-fs-2xs text-muted-foreground">
              At least {PASSWORD_MIN} characters.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="staff-confirm" className="text-fs-sm font-medium text-foreground">Confirm password</label>
            <input
              id="staff-confirm"
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              autoComplete="new-password"
              className={field}
            />
          </div>

          <button type="submit" disabled={busy} className={submit}>
            {busy ? <Loader2 className="mx-auto size-5 animate-spin" aria-hidden /> : 'Save and continue'}
          </button>
        </form>
      )}

      <p className="flex items-start gap-2 text-fs-2xs text-muted-foreground">
        <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Staff accounts open check-in only. Forgot your password? Your organizer can issue a new one.
      </p>
    </main>
  )
}
