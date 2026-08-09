'use client'

// RD-MEDIA-01 · Media Studio settings — the workspace-level upload defaults.

import { useCallback, useEffect, useState } from 'react'
import { Check, Star } from 'lucide-react'
import { Banner, Button, ErrorState, Skeleton, useToast } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import { Panel } from './MediaStudioShell'
import { COMPRESSION_PROFILES } from '@/features/media-studio/utils/compressionProfiles'
import type { SettingsResponse } from '@/app/api/organizer/media-studio/settings/route'

type Settings = SettingsResponse['settings']


export function SettingsClient() {
  const { getToken }  = useAuth()
  const { showToast } = useToast()

  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const call = useCallback(async (init?: RequestInit): Promise<Settings> => {
    const token = await getToken()
    if (!token) throw new Error('Your session has expired. Please sign in again.')
    const res = await fetch('/api/organizer/media-studio/settings', {
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
    return (await res.json() as SettingsResponse).settings
  }, [getToken])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const s = await call()
        if (!cancelled) setSettings(s)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load settings.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [call])

  async function patch(body: Record<string, unknown>) {
    setSaving(true)
    try {
      const next = await call({ method: 'PATCH', body: JSON.stringify(body) })
      setSettings(next)
      showToast('Settings saved.', 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save settings.', 'error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
      </div>
    )
  }
  if (error || !settings) return <ErrorState message={error ?? 'Settings unavailable.'} />

  return (
    <div className="space-y-6">
      <Panel label="Default compression"
        title="Applied to every new import. You can still change it per upload."
      >
        <ul className="grid gap-2.5 sm:grid-cols-2">
          {COMPRESSION_PROFILES.map(p => {
            const selected = settings.defaultProfileId === p.id
            return (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void patch({ defaultProfileId: p.id })}
                  aria-pressed={selected}
                  className={cn(
                    'w-full rounded-xl border bg-card p-4 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    'disabled:opacity-60',
                    selected ? 'border-primary/50 bg-primary/[0.04]' : 'border-border hover:border-border-strong',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-fs-md font-semibold text-foreground">{p.name}</span>
                    {selected && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
                  </div>
                  <div className="mt-1 flex items-center gap-0.5" aria-label={`${p.stars} out of 5`}>
                    {[1, 2, 3, 4, 5].map(n => (
                      <Star
                        key={n}
                        className={cn('size-3', n <= p.stars ? 'fill-warning text-warning' : 'text-muted-foreground/30')}
                        aria-hidden
                      />
                    ))}
                    {p.recommended && (
                      <span className="ml-1.5 rounded-md bg-primary/10 px-1.5 py-0.5 text-fs-2xs font-semibold text-primary">
                        Recommended
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-fs-2xs leading-relaxed text-muted-foreground">
                    {p.description}
                  </p>
                </button>
              </li>
            )
          })}
        </ul>
      </Panel>


      <Panel label="Default visibility"
        title="How new photos are served."
      >
        <div className="flex flex-wrap gap-2">
          {(['PUBLIC', 'SIGNED_URL'] as const).map(v => (
            <Button
              key={v}
              variant={settings.defaultVisibility === v ? 'primary' : 'outline'}
              size="sm"
              disabled={saving}
              onClick={() => void patch({ defaultVisibility: v })}
              aria-pressed={settings.defaultVisibility === v}
            >
              {v === 'PUBLIC' ? 'Public link' : 'Signed link'}
            </Button>
          ))}
        </div>
        <Banner tone="info" title="What these mean">
          <strong>Public link</strong> serves photos from a cacheable CDN URL — right for race
          photography participants will share. <strong>Signed link</strong> keeps them private
          at rest and issues a short-lived URL on request.
        </Banner>
      </Panel>
    </div>
  )
}
