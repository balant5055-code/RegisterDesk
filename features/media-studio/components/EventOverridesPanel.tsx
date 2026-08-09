'use client'

// RD-MEDIA-09 · Event Settings → Media.  ·  MS-SETTINGS-01: limits removed.
//
// Per-event PREFERENCES, made editable. Every field is a two-state control:
//
//     ○ Use inherited value      — no override; the licence tier or the platform decides
//     ● Override value           — this event's own number
//
// ═══ NOT A SECOND CONFIGURATION SYSTEM ════════════════════════════════════════
// This panel stores DELTAS and resolves nothing. The inherited value shown beside each
// control is whatever `GET /limits` reported — the same `resolveMediaConfig` the upload API
// enforces with. There is exactly one resolver, and this is not it.
// ══════════════════════════════════════════════════════════════════════════════
//
// ═══ WHAT IS NO LONGER HERE, AND WHY (MS-SETTINGS-01) ═════════════════════════
// The six PLATFORM LIMITS — maxPhotosPerEvent, maxUploadBatchSize, maxUploadFileSizeBytes,
// maxGalleriesPerEvent, maxAlbumsPerGallery, signedUrlExpirySeconds — used to be editable
// here, with `maxPhotosPerEvent` blankable to mean UNLIMITED. Since the resolver ranks the
// event layer above plan and global, an organizer could hand themselves a limit the
// business never sold them.
//
// They are now admin-only and `PATCH /overrides` REFUSES them with 403. Removing the
// controls is the cosmetic half of that change; the server-side refusal is the half that
// actually closes it. What remains below is the organizer's own product — compression,
// renditions, visibility — which is theirs to choose.
// ══════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, SlidersHorizontal } from 'lucide-react'
import { Banner, Button, Card, StatusChip, useToast } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import { useMediaStudio } from '@/features/media-studio/context/MediaStudioContext'
import type { MediaOverridableConfig } from '@/lib/config/businessConfig'
import type { OverridesResponse } from '@/app/api/organizer/media-studio/overrides/route'
import type { MediaLimitsResponse } from '@/app/api/organizer/media-studio/limits/route'

const API = '/api/organizer/media-studio'

type BooleanKey =
  | 'publicGalleryEnabled'

const BOOLEAN_FIELDS: { key: BooleanKey; label: string }[] = [

  { key: 'publicGalleryEnabled', label: 'Public gallery enabled' },
]

const inputCls = 'h-8 w-full rounded-lg border border-border bg-background px-2.5 text-fs-sm text-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15 disabled:opacity-50'

export function EventOverridesPanel() {
  const { getToken } = useAuth()
  const { showToast } = useToast()
  const { event } = useMediaStudio()

  const [overrides, setOverrides] = useState<Partial<MediaOverridableConfig>>({})
  const [saved,     setSaved]     = useState<Partial<MediaOverridableConfig>>({})
  const [effective, setEffective] = useState<MediaLimitsResponse | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const call = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const token = await getToken()
    if (!token) throw new Error('Your session has expired. Please sign in again.')
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(detail?.error ?? 'That request could not be completed.')
    }
    return await res.json() as T
  }, [getToken])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!event) { if (!cancelled) setLoading(false); return }
      if (!cancelled) { setLoading(true); setError(null) }
      try {
        const id = encodeURIComponent(event.eventId)
        const [ov, eff] = await Promise.all([
          call<OverridesResponse>(`/overrides?eventId=${id}`),
          call<MediaLimitsResponse>(`/limits?eventId=${id}`),
        ])
        if (cancelled) return
        setOverrides(ov.overrides)
        setSaved(ov.overrides)
        setEffective(eff)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load overrides.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [event, call])

  const dirty = useMemo(
    () => JSON.stringify(overrides) !== JSON.stringify(saved),
    [overrides, saved],
  )

  /** Removing the KEY is how "inherit" is expressed — never storing a blank or a zero. */
  const clear = (key: keyof MediaOverridableConfig) => {
    setOverrides(prev => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const setValue = (key: keyof MediaOverridableConfig, value: unknown) => {
    setOverrides(prev => ({ ...prev, [key]: value }))
  }

  const save = useCallback(async () => {
    if (!event) return
    setSaving(true)
    try {
      const res = await call<OverridesResponse>('/overrides', {
        method: 'PATCH',
        body: JSON.stringify({ eventId: event.eventId, overrides }),
      })
      setSaved(res.overrides)
      setOverrides(res.overrides)
      // Re-read the effective limits so the inherited values shown beside each control
      // reflect what the backend now resolves — never a locally recomputed guess.
      const eff = await call<MediaLimitsResponse>(`/limits?eventId=${encodeURIComponent(event.eventId)}`)
      setEffective(eff)
      showToast('Media limits saved for this event.', 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save the overrides.', 'error')
    } finally {
      setSaving(false)
    }
  }, [event, overrides, call, showToast])

  if (!event) return null

  /** What this field would be WITHOUT this event's override — the plan or the platform. */
  const inheritedOf = (key: keyof MediaOverridableConfig): string => {
    if (!effective) return '—'
    const fromLimits = (effective.limits as Record<string, unknown>)[key]
    const fromDefaults = (effective.defaults as Record<string, unknown>)[key]
    const value = fromLimits !== undefined ? fromLimits : fromDefaults
    if (value === null) return 'Unlimited'
    if (typeof value === 'boolean') return value ? 'On' : 'Off'
    return value === undefined ? '—' : String(value)
  }

  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted" aria-hidden>
          <SlidersHorizontal className="size-[18px] text-muted-foreground" />
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-fs-md font-semibold text-foreground">
              Media limits for {event.name}
            </h2>
            {effective?.tier && <StatusChip tone="neutral">{effective.tier} plan</StatusChip>}
          </div>
          <p className="text-fs-sm leading-relaxed text-muted-foreground">
            Each setting either inherits from your licence plan or is overridden for this
            event. An override always wins; everything else keeps following the plan.
          </p>

          {error && <Banner tone="error" title="Something went wrong">{error}</Banner>}

          {loading ? (
            <p className="text-fs-base text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="space-y-2">
                {BOOLEAN_FIELDS.map(f => {
                  const overridden = f.key in overrides
                  return (
                    <div key={f.key} className="grid items-center gap-2 border-b border-border/50 py-2 sm:grid-cols-[1fr_auto_10rem]">
                      <div className="min-w-0">
                        <p className="text-fs-base text-foreground">{f.label}</p>
                        <p className="text-fs-2xs text-muted-foreground">
                          Inherited: {inheritedOf(f.key)}
                        </p>
                      </div>
                      <label className="flex items-center gap-1.5 text-fs-sm text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={overridden}
                          onChange={e => e.target.checked ? setValue(f.key, true) : clear(f.key)}
                          className="size-3.5"
                        />
                        Override
                      </label>
                      <select
                        aria-label={f.label}
                        disabled={!overridden}
                        className={cn(inputCls, overridden && 'border-primary/60')}
                        value={overrides[f.key] === undefined ? '' : String(overrides[f.key])}
                        onChange={e => setValue(f.key, e.target.value === 'true')}
                      >
                        <option value="true">On</option>
                        <option value="false">Off</option>
                      </select>
                    </div>
                  )
                })}
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
                  {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  {saving ? 'Saving…' : 'Save overrides'}
                </Button>
                {Object.keys(overrides).length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setOverrides({})} disabled={saving}>
                    Inherit everything
                  </Button>
                )}
                {!dirty && !saving && (
                  <span className="text-fs-sm text-muted-foreground">No unsaved changes.</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
