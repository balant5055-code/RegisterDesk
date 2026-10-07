'use client'

// RD-WALLET-REQ — the filter bar shared by Wallet › Transactions and Wallet › Communication usage:
// event, a second select (direction or channel), and a date range. It only builds query parameters;
// the server resolves the event (the workspace's own draft), filters and pages. The event list is the
// newest events from the Wallet read model; any event can also be opened from its Wallet detail.

import { useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'

export interface ActivityFilterValue { event: string; kind: string; from: string; to: string }
export const EMPTY_FILTERS: ActivityFilterValue = { event: '', kind: '', from: '', to: '' }

const FIELD = 'h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground'

export function ActivityFilters({ value, onChange, kindLabel, kindOptions, currentEvent }: {
  value: ActivityFilterValue
  onChange: (v: ActivityFilterValue) => void
  kindLabel: string
  kindOptions: ReadonlyArray<{ value: string; label: string }>
  /** The event the page was opened for (it may not be among the newest). */
  currentEvent?: { draftId: string; name: string } | null
}) {
  const [events, setEvents] = useState<Array<{ draftId: string; name: string }>>([])
  useEffect(() => {
    let alive = true
    void (async () => {
      const token = await auth.currentUser?.getIdToken().catch(() => null)
      if (!token) return
      const res = await fetch('/api/organizer/wallet/events?limit=15', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => null)
      const body = res?.ok ? await res.json().catch(() => null) as { events?: Array<{ draftId: string; name: string }> } | null : null
      if (alive && body?.events) setEvents(body.events.map(e => ({ draftId: e.draftId, name: e.name })))
    })()
    return () => { alive = false }
  }, [])
  const options = currentEvent && !events.some(e => e.draftId === currentEvent.draftId) ? [currentEvent, ...events] : events
  const set = (patch: Partial<ActivityFilterValue>) => onChange({ ...value, ...patch })

  return (
    <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-card p-3 sm:flex sm:flex-wrap sm:items-end">
      <label className="col-span-2 flex min-w-0 flex-col gap-1 text-[12px] text-muted-foreground sm:w-56">
        Event
        <select className={FIELD} value={value.event} onChange={e => set({ event: e.target.value })}>
          <option value="">All events</option>
          {options.map(e => <option key={e.draftId} value={e.draftId}>{e.name}</option>)}
        </select>
      </label>
      <label className="col-span-2 flex flex-col gap-1 text-[12px] text-muted-foreground sm:w-40">
        {kindLabel}
        <select className={FIELD} value={value.kind} onChange={e => set({ kind: e.target.value })}>
          {kindOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted-foreground">
        From
        <input type="date" className={FIELD} value={value.from} max={value.to || undefined} onChange={e => set({ from: e.target.value })} />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-[12px] text-muted-foreground">
        To
        <input type="date" className={FIELD} value={value.to} min={value.from || undefined} onChange={e => set({ to: e.target.value })} />
      </label>
      {(value.event || value.kind || value.from || value.to) && (
        <button type="button" onClick={() => onChange(EMPTY_FILTERS)}
          className="col-span-2 h-9 rounded-lg px-3 text-[13px] font-semibold text-primary hover:bg-muted sm:col-span-1">
          Clear filters
        </button>
      )}
    </div>
  )
}

/** Query parameters for the activity routes (empty values are left out). */
export function activityParams(v: ActivityFilterValue, kindParam: string, cursor?: string | null): URLSearchParams {
  const qs = new URLSearchParams()
  if (v.event) qs.set('event', v.event)
  if (v.kind)  qs.set(kindParam, v.kind)
  if (v.from)  qs.set('from', v.from)
  if (v.to)    qs.set('to', v.to)
  if (cursor)  qs.set('cursor', cursor)
  return qs
}
