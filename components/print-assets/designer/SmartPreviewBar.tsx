'use client'

// PA-9 Sprint 2 — Smart Preview controls. Chooses a sample PROFILE or a REAL
// registration and emits the resulting PrintVariableSources (never writes data).
// The parent passes these to the Live Preview, which posts them to the existing
// preview endpoint as `variables`. Reuses the existing registrations + event APIs.

import { useCallback, useEffect, useRef, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { Users, UserCheck } from 'lucide-react'
import {
  PREVIEW_PROFILES, registrationToSources, mergePreviewImageSources,
  type EventPreviewAssets,
} from '@/lib/printAssets/designer/previewData'
import type { PrintVariableSources } from '@/lib/printAssets/render/variables'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import type { RegistrationsApiResponse, SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'

export function SmartPreviewBar({ eventId, onChange, onFields }: {
  eventId: string
  onChange: (v: PrintVariableSources) => void
  onFields?: (labels: Record<string, string>) => void
}) {
  const [profileId, setProfileId] = useState(PREVIEW_PROFILES[0].id)
  const [regId, setRegId] = useState('')
  const [mode, setMode] = useState<'profile' | 'registration'>('profile')
  const [regs, setRegs] = useState<SerializedRegistration[]>([])
  const [eventName, setEventName] = useState('')
  const [assets, setAssets] = useState<EventPreviewAssets>({})
  // Keep the latest callbacks reachable from async effects (same pattern as the canvas).
  const onChangeRef = useRef(onChange)
  const onFieldsRef = useRef(onFields)
  /* eslint-disable react-hooks/refs */
  onChangeRef.current = onChange
  onFieldsRef.current = onFields
  /* eslint-enable react-hooks/refs */

  const token = useCallback(async () => (await auth.currentUser?.getIdToken()) ?? '', [])

  // Event assets (logo/banner/sponsor) so image sources preview. Best-effort.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(`/api/organizer/events/${eventId}`, { headers: { Authorization: `Bearer ${await token()}` } })
        if (!res.ok) return
        const d = await res.json() as EventDetailResponse
        if (!alive) return
        setEventName(d.name)
        setAssets({ logoUrl: d.logoUrl, bannerUrl: d.bannerUrl, sponsorLogo: d.sponsors.find(s => s.logoUrl)?.logoUrl ?? null })
      } catch { /* keep sample assets */ }
    })()
    return () => { alive = false }
  }, [eventId, token])

  // Real registrations (needs the registrations permission — silently skipped otherwise).
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(`/api/organizer/events/${eventId}/registrations?limit=50`, { headers: { Authorization: `Bearer ${await token()}` } })
        if (!res.ok) return
        const d = await res.json() as RegistrationsApiResponse
        if (alive) { setRegs(d.registrations); if (d.eventName) setEventName(d.eventName); onFieldsRef.current?.(d.fieldLabels ?? {}) }
      } catch { /* no real preview available */ }
    })()
    return () => { alive = false }
  }, [eventId, token])

  // Emit the resolved variables whenever the selection or fetched data changes.
  useEffect(() => {
    const reg = mode === 'registration' ? regs.find(r => r.id === regId) : undefined
    const base = reg
      ? registrationToSources(reg, eventName || 'Event')
      : (PREVIEW_PROFILES.find(p => p.id === profileId) ?? PREVIEW_PROFILES[0]).sources
    onChangeRef.current(mergePreviewImageSources(base, assets))
  }, [mode, profileId, regId, regs, assets, eventName])

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-2 py-1.5">
      <span className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground"><Users className="size-3.5" /> Preview</span>
      <select value={mode === 'profile' ? profileId : ''} onChange={e => { setProfileId(e.target.value); setMode('profile') }}
        className="rounded border border-border bg-background px-2 py-1 text-[12px]">
        {PREVIEW_PROFILES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {regs.length > 0 && (
        <label className="flex items-center gap-1">
          <UserCheck className="size-3.5 text-muted-foreground" />
          <select value={mode === 'registration' ? regId : ''} onChange={e => { setRegId(e.target.value); setMode(e.target.value ? 'registration' : 'profile') }}
            className="max-w-[10rem] rounded border border-border bg-background px-2 py-1 text-[12px]">
            <option value="">Preview registration…</option>
            {regs.map(r => <option key={r.id} value={r.id}>{r.attendee.name || r.ticketCode || r.id}</option>)}
          </select>
        </label>
      )}
      {mode === 'registration' && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">Real data</span>}
    </div>
  )
}
