'use client'

// RD-EVENT-TYPES-01 — Super Admin switches for which event types organizers may choose for a NEW event.
// Effective immediately (no deploy). Each change asks for a reason and is audited by the server
// (PUT /api/admin/settings/event-types). Disabling a type never touches events that already exist.

import { useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useConfirm } from '@/components/ui'

interface TypeRow { id: string; name: string }
interface Loaded { availability: Record<string, boolean>; types: TypeRow[]; unavailable: boolean }

async function headers(): Promise<Record<string, string> | null> {
  const u = auth.currentUser
  return u ? { authorization: `Bearer ${await u.getIdToken()}`, 'content-type': 'application/json' } : null
}

async function fetchSettings(): Promise<Loaded | null | 'signed_out'> {
  const h = await headers()
  if (!h) return 'signed_out'
  const res = await fetch('/api/admin/settings/event-types', { headers: h, cache: 'no-store' }).catch(() => null)
  return res?.ok ? await res.json() as Loaded : null
}

export function EventTypeAvailabilityPanel() {
  const { prompt } = useConfirm()
  const [data, setData] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void fetchSettings().then(r => {
      if (!alive || r === 'signed_out') return
      if (r) setData(r)
      else setError('Event type settings could not be loaded.')
    })
    return () => { alive = false }
  }, [])

  async function toggle(t: TypeRow, next: boolean) {
    const reason = (await prompt({
      title: `${next ? 'Enable' : 'Disable'} ${t.name}?`,
      message: next
        ? `Organizers will be able to choose “${t.name}” for new events immediately. Reason (5–500 characters):`
        : `New events of “${t.name}” will be blocked and the type shown as Coming Soon. Existing events keep working; unsubmitted drafts of this type cannot be submitted until it is enabled again. Reason (5–500 characters):`,
      required: true, confirmLabel: next ? 'Enable' : 'Disable', tone: next ? 'default' : 'danger',
    }))?.trim()
    if (!reason) return
    const h = await headers()
    if (!h) return
    setBusy(t.id); setError(null)
    try {
      const res = await fetch('/api/admin/settings/event-types', { method: 'PUT', headers: h, body: JSON.stringify({ enabled: { [t.id]: next }, reason }) })
      const json = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`)
      const r = await fetchSettings()
      if (r && r !== 'signed_out') setData(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the change.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="event-type-availability-heading" className="rounded-lg border border-border bg-card px-4 py-3">
      <p id="event-type-availability-heading" className="text-[13.5px] font-semibold text-foreground">Event types available to organizers</p>
      <p className="text-[12.5px] text-muted-foreground">
        Off = shown as “Coming Soon” and refused by the server for new events. Existing events are never affected.
      </p>
      {data?.unavailable && <p role="alert" className="mt-2 text-[12.5px] text-destructive">The stored settings could not be read; the launch defaults are shown.</p>}
      {error && <p role="alert" className="mt-2 text-[12.5px] text-destructive">{error}</p>}
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {(data?.types ?? []).map(t => {
          const on = data?.availability[t.id] === true
          return (
            <li key={t.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span className="min-w-0 text-[12.5px] font-medium text-foreground">{t.name}</span>
              <button
                type="button" role="switch" aria-checked={on} aria-label={`${t.name}: ${on ? 'available' : 'coming soon'}`}
                disabled={busy !== null}
                onClick={() => void toggle(t, !on)}
                className={cn('shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ring-1 disabled:opacity-50',
                  on ? 'bg-primary text-primary-foreground ring-primary' : 'bg-muted/40 text-muted-foreground ring-border')}
              >
                {busy === t.id ? 'Saving…' : on ? 'Available' : 'Coming Soon'}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
