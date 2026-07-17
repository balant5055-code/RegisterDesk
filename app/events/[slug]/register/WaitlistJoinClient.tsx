'use client'

import { useState } from 'react'
import { Clock }    from 'lucide-react'

interface WaitlistJoinClientProps {
  eventSlug:  string
  eventName:  string
  passId:     string
  passName:   string
}

export function WaitlistJoinClient({
  eventSlug,
  eventName,
  passId,
  passName,
}: WaitlistJoinClientProps) {
  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [phone,    setPhone]    = useState('')
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [success,  setSuccess]  = useState(false)

  const inputCls = 'w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!name.trim())  { setError('Please enter your name.'); return }
    if (!email.trim()) { setError('Please enter your email address.'); return }
    if (!phone.trim()) { setError('Please enter your phone number.'); return }

    setLoading(true)
    try {
      const res  = await fetch('/api/waitlist/join', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ slug: eventSlug, passId, name, email, phone }),
      })
      const json = await res.json() as { success: boolean; error?: string }
      if (json.success) {
        setSuccess(true)
      } else {
        setError(json.error ?? 'Failed to join waitlist. Please try again.')
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-amber-100 mx-auto">
          <Clock className="size-7 text-amber-600" />
        </div>
        <h1 className="text-[20px] font-bold text-foreground">You&rsquo;re on the waitlist!</h1>
        <p className="mt-2 text-[14px] text-muted-foreground max-w-sm mx-auto">
          We&rsquo;ll email you at <strong>{email}</strong> if a spot opens up for{' '}
          <strong>{passName}</strong> at <strong>{eventName}</strong>.
        </p>
        <p className="mt-4 text-[13px] text-muted-foreground">
          No further action needed — we&rsquo;ll reach out when a spot becomes available.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      {/* Header */}
      <div className="mb-6">
        <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-amber-100">
          <Clock className="size-5 text-amber-600" />
        </div>
        <p className="text-[12px] font-semibold uppercase tracking-wider text-amber-600">
          Event Full
        </p>
        <h1 className="mt-0.5 text-[22px] font-bold text-foreground">{eventName}</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">
          This event is currently full, but you can join the waitlist for the{' '}
          <strong>{passName}</strong> pass. We&rsquo;ll notify you if a spot opens up.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-foreground">
            Full Name <span className="text-destructive">*</span>
          </label>
          <input
            type="text"
            className={inputCls}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Enter your full name"
            required
            autoComplete="name"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-foreground">
            Email Address <span className="text-destructive">*</span>
          </label>
          <input
            type="email"
            className={inputCls}
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Enter your email"
            required
            autoComplete="email"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-foreground">
            Phone Number <span className="text-destructive">*</span>
          </label>
          <input
            type="tel"
            className={inputCls}
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="Enter your phone number"
            required
            autoComplete="tel"
          />
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/[0.04] px-4 py-3 text-[13px] text-destructive">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="mt-2 w-full rounded-xl bg-amber-500 py-3 text-[14px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? 'Joining waitlist…' : 'Join Waitlist'}
        </button>

        <p className="text-center text-[11.5px] text-muted-foreground">
          Joining the waitlist does not guarantee a spot. We&rsquo;ll notify you by email if one becomes available.
        </p>
      </form>
    </div>
  )
}
