'use client'

import { useState, useEffect } from 'react'
import Link                     from 'next/link'
import { onAuthStateChanged }   from 'firebase/auth'
import { auth }                 from '@/lib/firebase/auth'
import { cn }                   from '@/lib/utils/cn'
import { ChevronLeft, AlertCircle, Loader2, ExternalLink } from 'lucide-react'
import CheckInClient            from './CheckInClient'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function CheckInPageClient({ eventId }: { eventId: string }) {
  const [token,   setToken]   = useState<string>('')
  const [event,   setEvent]   = useState<EventDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) { setError('You must be signed in.'); setLoading(false); return }
      try {
        const tok  = await user.getIdToken()
        setToken(tok)
        const res  = await fetch(`/api/organizer/events/${eventId}`, {
          headers: { Authorization: `Bearer ${tok}` },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setEvent(await res.json() as EventDetailResponse)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load event')
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [eventId])

  // ── Error ──────────────────────────────────────────────────────────────────
  if (!loading && error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <AlertCircle className="size-10 text-destructive" />
        <p className="text-[15px] font-semibold">{error}</p>
        <Link href={`/dashboard/events/${eventId}`} className="text-[13px] text-primary hover:underline">
          ← Back to Event
        </Link>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">

      {/* Top nav */}
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-3">
          <Link
            href={`/dashboard/events/${eventId}`}
            className="flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" /> Back
          </Link>
          <div className="flex-1 text-center">
            {event && (
              <p className="text-[13px] font-semibold text-foreground truncate">{event.name}</p>
            )}
          </div>
          {event?.slug && (
            <Link
              href={`/events/${event.slug}`}
              target="_blank"
              className="text-[12px] text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
            </Link>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-lg px-4 py-6">

        {/* Page heading */}
        <div className="mb-5">
          <h1 className="text-[20px] font-bold text-foreground">Check-in</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Scan QR codes or enter ticket codes to check in attendees.
          </p>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center gap-3 py-20">
            <Loader2 className="size-5 animate-spin text-primary" />
            <span className="text-[13px] text-muted-foreground">Loading event…</span>
          </div>
        )}

        {/* Check-in UI */}
        {!loading && event && token && (
          <CheckInClient
            eventId={eventId}
            eventName={event.name}
            token={token}
            totalRegistrations={event.totalRegistrations}
            checkedInCount={event.checkedInCount}
            slug={event.slug ?? ''}
          />
        )}

        {/* Lifecycle warning */}
        {!loading && event && (event.lifecycleStatus === 'cancelled' || event.lifecycleStatus === 'archived') && (
          <div className={cn(
            'mt-4 rounded-xl border px-4 py-3 text-[12.5px]',
            event.lifecycleStatus === 'cancelled'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-muted bg-muted/30 text-muted-foreground',
          )}>
            This event is {event.lifecycleStatus}. Check-in submissions will be rejected.
          </div>
        )}
      </div>
    </div>
  )
}
