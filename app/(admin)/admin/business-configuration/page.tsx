'use client'

// Business Configuration Center — the single admin surface for editing platform
// business settings. Every value is read from / published through the
// BusinessConfigurationService (via /api/admin/business-config). No business value
// is hardcoded here. Edits are held as a client-side DRAFT and only become the
// stored config when Published (with a reason) — Steps 3–8.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  CONFIG_SECTION_KEYS,
  CONFIG_SECTION_REGISTRY,
  type BusinessConfigSectionKey,
} from '@/lib/config/businessConfig'
import { SECTION_LABELS } from './fields'
import { SectionEditor } from './SectionEditor'
import { LicensingEditor } from './LicensingEditor'
import { CommunicationEditor } from './CommunicationEditor'
import { FeesEditor } from './FeesEditor'
import type { BusinessConfigResponse } from '@/app/api/admin/business-config/route'

type SectionDraft = Record<string, unknown>
type DraftMap     = Record<BusinessConfigSectionKey, SectionDraft>
type Tab          = 'overview' | BusinessConfigSectionKey | 'history'

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}

const clone = (v: unknown): SectionDraft => JSON.parse(JSON.stringify(v ?? {})) as SectionDraft
function initDrafts(config: BusinessConfigResponse['config']): DraftMap {
  const out = {} as DraftMap
  for (const k of CONFIG_SECTION_KEYS) out[k] = clone(config[k])
  return out
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'draft' | 'ok' }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 truncate text-[13.5px] font-semibold',
        tone === 'draft' ? 'text-amber-600' : tone === 'ok' ? 'text-emerald-600' : 'text-foreground')}>{value}</p>
    </div>
  )
}

export default function BusinessConfigurationPage() {
  const [data,    setData]    = useState<BusinessConfigResponse | null>(null)
  const [drafts,  setDrafts]  = useState<DraftMap | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [active,  setActive]  = useState<Tab>('overview')

  const [reasonFor,  setReasonFor]  = useState<BusinessConfigSectionKey | null>(null)
  const [reasonText, setReasonText] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [banner,     setBanner]     = useState<{ kind: 'success' | 'error'; msg: string } | null>(null)

  const fetchData = useCallback(async (): Promise<BusinessConfigResponse> => {
    const token = await getToken()
    const res = await fetch('/api/admin/business-config', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
    if (!res.ok) {
      const b = await res.json().catch(() => null) as { error?: string } | null
      throw new Error(b?.error ?? `Request failed (${res.status})`)
    }
    return res.json() as Promise<BusinessConfigResponse>
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await fetchData()
        if (!alive) return
        setData(d); setDrafts(initDrafts(d.config))
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load configuration')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [fetchData])

  const dirtyBySection = useMemo(() => {
    const out = {} as Record<BusinessConfigSectionKey, boolean>
    if (data && drafts) for (const k of CONFIG_SECTION_KEYS) out[k] = JSON.stringify(drafts[k]) !== JSON.stringify(data.config[k])
    return out
  }, [data, drafts])
  const anyDirty = Object.values(dirtyBySection).some(Boolean)

  const doPublish = useCallback(async () => {
    if (!reasonFor || !drafts) return
    const section = reasonFor
    const reason  = reasonText.trim()
    if (!reason) return
    setPublishing(true); setBanner(null)
    try {
      const token = await getToken()
      const res = await fetch('/api/admin/business-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ section, patch: drafts[section], reason }),
      })
      const body = await res.json().catch(() => null) as { error?: string; version?: number } | null
      if (!res.ok) throw new Error(body?.error ?? `Publish failed (${res.status})`)
      const fresh = await fetchData()
      setData(fresh)
      setDrafts(prev => ({ ...(prev as DraftMap), [section]: clone(fresh.config[section]) }))
      setReasonFor(null); setReasonText('')
      setBanner({ kind: 'success', msg: `${SECTION_LABELS[section]} published — version ${body?.version ?? fresh.version}.` })
    } catch (e) {
      setBanner({ kind: 'error', msg: e instanceof Error ? e.message : 'Publish failed' })
    } finally {
      setPublishing(false)
    }
  }, [reasonFor, reasonText, drafts, fetchData])

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error || !data || !drafts) {
    return <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13.5px] text-destructive">{error ?? 'Configuration unavailable.'}</div>
  }

  const tabs: Tab[] = ['overview', ...CONFIG_SECTION_KEYS, 'history']
  const tabLabel = (t: Tab) => t === 'overview' ? 'Overview' : t === 'history' ? 'History' : SECTION_LABELS[t]

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">Business Configuration</h1>
          <p className="text-[13.5px] text-muted-foreground">The single place to manage platform business settings. Edits become active only when published.</p>
        </div>
        <Badge variant={anyDirty ? 'warning' : 'outline'}>{anyDirty ? 'Unsaved draft changes' : 'All published'}</Badge>
      </div>

      {banner && (
        <div className={cn('rounded-lg px-3 py-2 text-[13px]',
          banner.kind === 'success' ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'border border-destructive/30 bg-destructive/5 text-destructive')}>
          {banner.msg}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1">
        {tabs.map(t => (
          <button
            key={t} type="button" onClick={() => setActive(t)}
            className={cn('rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              active === t ? 'bg-primary/[0.08] text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
          >
            {tabLabel(t)}
            {t !== 'overview' && t !== 'history' && dirtyBySection[t] && <span className="ml-1 inline-block size-1.5 rounded-full bg-amber-500 align-middle" />}
          </button>
        ))}
      </div>

      {/* Overview */}
      {active === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Tile label="Version" value={String(data.version)} />
            <Tile label="Updated by" value={data.meta.updatedBy ?? '—'} />
            <Tile label="Updated at" value={fmtDate(data.meta.updatedAt)} />
            <Tile label="Status" value={anyDirty ? 'Draft' : 'Published'} tone={anyDirty ? 'draft' : 'ok'} />
            <Tile label="Cache" value="Server · clears on publish" />
          </div>
          <div className="rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4 py-2.5 text-[13px] font-semibold text-foreground">Sections</div>
            <ul className="divide-y divide-border">
              {CONFIG_SECTION_KEYS.map(k => {
                const v = CONFIG_SECTION_REGISTRY[k].validate(drafts[k])
                return (
                  <li key={k} className="flex items-center gap-2 px-4 py-2.5">
                    <button type="button" onClick={() => setActive(k)} className="text-[13px] font-medium text-foreground hover:text-primary">{SECTION_LABELS[k]}</button>
                    <div className="ml-auto flex items-center gap-2">
                      {dirtyBySection[k]
                        ? <Badge variant="warning" className="text-[11px]">Draft</Badge>
                        : <Badge variant="outline" className="text-[11px]">Published</Badge>}
                      {v.valid
                        ? <Badge variant="success" className="text-[11px]">Valid</Badge>
                        : <Badge variant="destructive" className="text-[11px]">Invalid</Badge>}
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}

      {/* Section editors */}
      {active === 'licensing' && (
        <LicensingEditor
          published={clone(data.config.licensing)}
          draft={drafts.licensing}
          onDraftChange={d => setDrafts(prev => ({ ...(prev as DraftMap), licensing: d }))}
          onPublish={() => { setReasonText(''); setBanner(null); setReasonFor('licensing') }}
          publishing={publishing && reasonFor === 'licensing'}
        />
      )}
      {active === 'communication' && (
        <CommunicationEditor
          published={clone(data.config.communication)}
          draft={drafts.communication}
          onDraftChange={d => setDrafts(prev => ({ ...(prev as DraftMap), communication: d }))}
          onPublish={() => { setReasonText(''); setBanner(null); setReasonFor('communication') }}
          publishing={publishing && reasonFor === 'communication'}
        />
      )}
      {active === 'fees' && (
        <FeesEditor
          published={clone(data.config.fees)}
          draft={drafts.fees}
          onDraftChange={d => setDrafts(prev => ({ ...(prev as DraftMap), fees: d }))}
          onPublish={() => { setReasonText(''); setBanner(null); setReasonFor('fees') }}
          publishing={publishing && reasonFor === 'fees'}
        />
      )}
      {active !== 'overview' && active !== 'history' && active !== 'licensing' && active !== 'communication' && active !== 'fees' && (
        <SectionEditor
          sectionKey={active}
          published={clone(data.config[active])}
          draft={drafts[active]}
          onDraftChange={d => setDrafts(prev => ({ ...(prev as DraftMap), [active]: d }))}
          onPublish={() => { setReasonText(''); setBanner(null); setReasonFor(active) }}
          publishing={publishing && reasonFor === active}
        />
      )}

      {/* Version history */}
      {active === 'history' && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
                <th className="px-3 py-2.5">Version</th>
                <th className="px-3 py-2.5">Section</th>
                <th className="px-3 py-2.5">Updated by</th>
                <th className="px-3 py-2.5">Updated at</th>
                <th className="px-3 py-2.5">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.history.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No changes yet — configuration is at its code defaults.</td></tr>
              )}
              {data.history.map((h, i) => (
                <tr key={i} className="hover:bg-muted/20">
                  <td className="px-3 py-2.5 font-semibold text-foreground">v{h.version}</td>
                  <td className="px-3 py-2.5 text-foreground">{SECTION_LABELS[h.section as BusinessConfigSectionKey] ?? h.section}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{h.updatedBy || '—'}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(h.updatedAt)}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{h.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Reason-to-publish modal (Step 7) */}
      {reasonFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4" onClick={() => !publishing && setReasonFor(null)}>
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-[15px] font-bold text-foreground">Publish {SECTION_LABELS[reasonFor]}</h2>
            <p className="mt-1 text-[12.5px] text-muted-foreground">This creates a new version and takes effect immediately. A reason is required for the audit trail.</p>
            <textarea
              value={reasonText} onChange={e => setReasonText(e.target.value)} rows={3} autoFocus
              placeholder="Why are you making this change?"
              className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-primary/15"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled={publishing} onClick={() => setReasonFor(null)}>Cancel</Button>
              <Button type="button" variant="primary" size="sm" isLoading={publishing} disabled={publishing || !reasonText.trim()} onClick={doPublish}>Publish</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
