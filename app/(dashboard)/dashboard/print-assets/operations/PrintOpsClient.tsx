'use client'

// PA-7 — Print Operations Center. PURE ORCHESTRATION over existing APIs:
//   templates  → /api/organizer/print-templates (+ [id] PATCH/duplicate/design/preview)
//   generation → /api/organizer/print-ops/generation-jobs (list) + /print-jobs/* (actions)
//   packages   → /api/organizer/print-ops/package-jobs (list) + /print-packages/* (actions)
//   items      → /api/organizer/print-jobs/[jobId]/items (+ per-item secure download)
// No renderer, designer, job, storage or schema changes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { PageHeader, buttonVariants, EmptyState } from '@/components/ui'
import {
  LayoutDashboard, Cpu, Package, FileText, Files, HardDrive, Search, Loader2,
  RefreshCw, Play, X, Download, Archive, CheckCircle2, Copy, Pencil, Eye,
  AlertTriangle, Printer,
} from 'lucide-react'
import {
  PRINT_ASSET_TYPE_LABELS, PRINT_TEMPLATE_STATUS_LABELS,
  type PrintTemplate, type PrintAssetType, type PrintTemplateStatus,
} from '@/lib/printAssets/types'
import type { PrintGenerationJobView, PrintJobItemView } from '@/lib/printAssets/generationJob'
import type { PrintPackageJobView } from '@/lib/printAssets/packageJob'
import type { ListPrintTemplatesResponse } from '@/app/api/organizer/print-templates/route'
import type { ListGenerationJobsResponse } from '@/app/api/organizer/print-ops/generation-jobs/route'
import type { ListPackageJobsResponse } from '@/app/api/organizer/print-ops/package-jobs/route'
import type { GetPrintJobItemsResponse } from '@/app/api/organizer/print-jobs/[jobId]/items/route'
import type { EventListItem } from '@/app/api/organizer/events/route'

type Tab = 'dashboard' | 'generation' | 'packages' | 'assets' | 'templates' | 'storage'
type JobStatus = PrintGenerationJobView['status']

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'dashboard',  label: 'Dashboard',        icon: LayoutDashboard },
  { key: 'generation', label: 'Generation Jobs',  icon: Cpu },
  { key: 'packages',   label: 'Package Jobs',     icon: Package },
  { key: 'assets',     label: 'Generated Assets', icon: Files },
  { key: 'templates',  label: 'Templates',        icon: FileText },
  { key: 'storage',    label: 'Storage',          icon: HardDrive },
]

const STATUS_TONE: Record<JobStatus, string> = {
  pending:    'bg-amber-100 text-amber-700',
  processing: 'bg-sky-100 text-sky-700',
  completed:  'bg-emerald-100 text-emerald-700',
  failed:     'bg-rose-100 text-rose-700',
  cancelled:  'bg-slate-100 text-slate-600',
}
const DAY_MS = 24 * 60 * 60 * 1000
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const isExpired = (iso: string | null | undefined, now: number) => !!iso && new Date(iso).getTime() < now

export function PrintOpsClient() {
  const { showToast } = useToast()
  const tokenRef = useRef('')

  const [tab, setTab] = useState<Tab>('dashboard')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')

  const [templates, setTemplates] = useState<PrintTemplate[]>([])
  const [genJobs, setGenJobs]     = useState<PrintGenerationJobView[]>([])
  const [pkgJobs, setPkgJobs]     = useState<PrintPackageJobView[]>([])
  const [events, setEvents]       = useState<EventListItem[]>([])

  const [search, setSearch]   = useState('')
  const [fEvent, setFEvent]   = useState('')
  const [fType, setFType]     = useState<'' | PrintAssetType>('')
  const [fStatus, setFStatus] = useState<'' | JobStatus>('')

  // Assets tab
  const [assetJobId, setAssetJobId] = useState('')
  const [items, setItems] = useState<PrintJobItemView[]>([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Captured at load/refresh (never Date.now() during render — keeps render pure).
  const [nowTs, setNowTs] = useState(0)

  const token = useCallback(async () => {
    const t = await auth.currentUser?.getIdToken() ?? tokenRef.current
    if (t) tokenRef.current = t
    return t
  }, [])
  const headers = useCallback(async (): Promise<Record<string, string>> =>
    ({ Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }), [token])

  const load = useCallback(async () => {
    setLoading(true)
    setNowTs(Date.now())
    try {
      const h = await headers()
      const [tRes, gRes, pRes, eRes] = await Promise.all([
        fetch('/api/organizer/print-templates', { headers: h }),
        fetch('/api/organizer/print-ops/generation-jobs', { headers: h }),
        fetch('/api/organizer/print-ops/package-jobs', { headers: h }),
        fetch('/api/organizer/events', { headers: h }),
      ])
      const t = await tRes.json() as ListPrintTemplatesResponse
      if (t.success) setTemplates(t.templates)
      const g = await gRes.json() as ListGenerationJobsResponse
      if (g.success) setGenJobs(g.jobs)
      const p = await pRes.json() as ListPackageJobsResponse
      if (p.success) setPkgJobs(p.jobs)
      const e = await eRes.json().catch(() => ({})) as { events?: EventListItem[] }
      setEvents(e.events ?? [])
    } catch { showToast('Could not load the operations center', 'error') }
    finally { setLoading(false) }
  }, [headers, showToast])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const eventName = useCallback((id: string) => events.find(e => e.draftId === id)?.name ?? id, [events])

  // ── Actions (all reuse existing endpoints) ──────────────────────────────────
  const act = useCallback(async (key: string, url: string, body?: unknown, okMsg?: string) => {
    setBusy(key)
    try {
      const res = await fetch(url, { method: 'POST', headers: await headers(), ...(body ? { body: JSON.stringify(body) } : {}) })
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string }
      if (!res.ok || data.success === false) { showToast(data.error ?? 'Action failed', 'error'); return false }
      if (okMsg) showToast(okMsg, 'success')
      await load()
      return true
    } catch { showToast('Network error', 'error'); return false }
    finally { setBusy('') }
  }, [headers, load, showToast])

  const patchTemplate = useCallback(async (id: string, status: PrintTemplateStatus) => {
    setBusy(`tpl-${id}`)
    try {
      const res = await fetch(`/api/organizer/print-templates/${id}`, { method: 'PATCH', headers: await headers(), body: JSON.stringify({ status }) })
      const data = await res.json() as { success: boolean; error?: string; template?: PrintTemplate }
      if (!res.ok || !data.success) { showToast(data.error ?? 'Update failed', 'error'); return }
      if (data.template) setTemplates(prev => prev.map(t => t.id === data.template!.id ? data.template! : t))
      showToast(`Template ${PRINT_TEMPLATE_STATUS_LABELS[status].toLowerCase()}`, 'success')
    } catch { showToast('Network error', 'error') }
    finally { setBusy('') }
  }, [headers, showToast])

  const duplicateTemplate = useCallback(async (id: string) => {
    setBusy(`dup-${id}`)
    try {
      const res = await fetch(`/api/organizer/print-templates/${id}/duplicate`, { method: 'POST', headers: await headers() })
      const data = await res.json() as { success: boolean; template?: PrintTemplate; error?: string }
      if (!res.ok || !data.success || !data.template) { showToast(data.error ?? 'Duplicate failed', 'error'); return }
      setTemplates(prev => [data.template!, ...prev])
      showToast('Template duplicated', 'success')
    } catch { showToast('Network error', 'error') }
    finally { setBusy('') }
  }, [headers, showToast])

  const loadItems = useCallback(async (jobId: string) => {
    setAssetJobId(jobId); setItems([]); setSelected(new Set())
    if (!jobId) return
    setItemsLoading(true)
    try {
      const res = await fetch(`/api/organizer/print-jobs/${jobId}/items`, { headers: await headers() })
      const data = await res.json() as GetPrintJobItemsResponse
      if (data.success) setItems(data.items)
    } catch { showToast('Could not load assets', 'error') }
    finally { setItemsLoading(false) }
  }, [headers, showToast])

  const downloadItem = useCallback(async (jobId: string, regId: string) => {
    const t = await token()
    window.open(`/api/organizer/print-jobs/${jobId}/items/${regId}/download?token=${encodeURIComponent(t)}`, '_blank')
  }, [token])
  const downloadZip = useCallback(async (jobId: string) => {
    const t = await token()
    window.open(`/api/organizer/print-packages/${jobId}/download?token=${encodeURIComponent(t)}`, '_blank')
  }, [token])

  // ── Derived metrics ─────────────────────────────────────────────────────────
  const metrics = useMemo(() => {
    const generatedAssets = genJobs.reduce((s, j) => s + j.counts.succeeded, 0)
    const packagesReady   = pkgJobs.filter(p => p.ready).length
    const expiredAssets   = genJobs.reduce((s, j) => s + (j.createdAt && nowTs - new Date(j.createdAt).getTime() > DAY_MS ? j.counts.succeeded : 0), 0)
    const expiredPackages = pkgJobs.filter(p => isExpired(p.output?.expiresAt, nowTs)).length
    return {
      templates: templates.length,
      generatedAssets,
      packageJobs: pkgJobs.length,
      packagesReady,
      storedFiles: generatedAssets + packagesReady,
      expiredAssets,
      expiredPackages,
      running: genJobs.filter(j => j.status === 'processing' || j.status === 'pending').length
             + pkgJobs.filter(j => j.status === 'processing' || j.status === 'pending').length,
    }
  }, [templates, genJobs, pkgJobs, nowTs])

  const recent = useMemo(() => [
    ...genJobs.map(j => ({ kind: 'Generation', label: `${PRINT_ASSET_TYPE_LABELS[j.assetType]} · ${eventName(j.eventId)}`, status: j.status, at: j.createdAt })),
    ...pkgJobs.map(j => ({ kind: 'Package', label: `${PRINT_ASSET_TYPE_LABELS[j.assetType]} · ${j.output?.fileCount ?? 0} files`, status: j.status, at: j.createdAt })),
  ].sort((a, b) => (new Date(b.at ?? 0).getTime()) - (new Date(a.at ?? 0).getTime())).slice(0, 8), [genJobs, pkgJobs, eventName])

  const templateUsage = useCallback((id: string) => genJobs.filter(j => j.templateId === id).length, [genJobs])

  const q = search.trim().toLowerCase()
  const genFiltered = genJobs.filter(j =>
    (!fEvent || j.eventId === fEvent) && (!fType || j.assetType === fType) && (!fStatus || j.status === fStatus)
    && (!q || j.jobId.toLowerCase().includes(q) || eventName(j.eventId).toLowerCase().includes(q) || PRINT_ASSET_TYPE_LABELS[j.assetType].toLowerCase().includes(q)))
  const pkgFiltered = pkgJobs.filter(j =>
    (!fType || j.assetType === fType) && (!fStatus || j.status === fStatus)
    && (!q || j.jobId.toLowerCase().includes(q) || j.sourceJobId.toLowerCase().includes(q)))
  const tplFiltered = templates.filter(t =>
    (!fEvent || t.eventId === fEvent) && (!fType || t.assetType === fType)
    && (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)))
  const itemFiltered = items.filter(it =>
    !q || it.name.toLowerCase().includes(q) || it.ticketCode.toLowerCase().includes(q) || it.registrationId.toLowerCase().includes(q))

  if (loading) return <div className="flex h-[60vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Print Operations Center"
        subtitle="Manage templates, generation & packaging jobs, generated assets and downloads."
        breadcrumb={[{ label: 'Operations' }, { label: 'Print Assets', href: '/dashboard/print-assets' }, { label: 'Operations Center' }]}
        action={
          <div className="flex gap-2">
            <button onClick={() => void load()} className={buttonVariants({ variant: 'outline', size: 'sm' })}><RefreshCw className="size-4" /> Refresh</button>
            <Link href="/dashboard/print-assets" className={buttonVariants({ variant: 'primary', size: 'sm' })}><FileText className="size-4" /> Manage templates</Link>
          </div>
        }
      />

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={cn('flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium -mb-px transition-colors',
              tab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>

      {/* Search + filters (shared) */}
      {tab !== 'dashboard' && tab !== 'storage' && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search registration, ticket, pass, package, template…"
              className="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-[13px]" />
          </div>
          {(tab === 'generation' || tab === 'templates') && (
            <select value={fEvent} onChange={e => setFEvent(e.target.value)} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]">
              <option value="">All events</option>
              {events.map(e => <option key={e.draftId} value={e.draftId}>{e.name}</option>)}
            </select>
          )}
          <select value={fType} onChange={e => setFType(e.target.value as typeof fType)} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]">
            <option value="">All asset types</option>
            {(Object.keys(PRINT_ASSET_TYPE_LABELS) as PrintAssetType[]).map(t => <option key={t} value={t}>{PRINT_ASSET_TYPE_LABELS[t]}</option>)}
          </select>
          {(tab === 'generation' || tab === 'packages') && (
            <select value={fStatus} onChange={e => setFStatus(e.target.value as typeof fStatus)} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]">
              <option value="">All statuses</option>
              {(['pending', 'processing', 'completed', 'failed', 'cancelled'] as JobStatus[]).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>
      )}

      {/* ── DASHBOARD ── */}
      {tab === 'dashboard' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <Metric label="Templates" value={metrics.templates} icon={FileText} />
            <Metric label="Generated assets" value={metrics.generatedAssets} icon={Files} />
            <Metric label="Package jobs" value={metrics.packageJobs} icon={Package} />
            <Metric label="Stored files" value={metrics.storedFiles} icon={HardDrive} />
            <Metric label="Active jobs" value={metrics.running} icon={Cpu} tone={metrics.running ? 'text-sky-600' : undefined} />
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="mb-3 text-[13px] font-bold text-foreground">Recent activity</p>
            {recent.length === 0 ? <p className="text-[13px] text-muted-foreground">No generation or package jobs yet.</p> : (
              <ul className="divide-y divide-border">
                {recent.map((r, i) => (
                  <li key={i} className="flex items-center justify-between py-2 text-[13px]">
                    <span className="flex items-center gap-2"><span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{r.kind}</span><span className="text-foreground">{r.label}</span></span>
                    <span className="flex items-center gap-3"><Pill status={r.status} /><span className="text-muted-foreground">{fmt(r.at)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ── GENERATION JOBS ── */}
      {tab === 'generation' && (
        <Table head={['Asset · Event', 'Progress', 'Status', 'Created', '']} empty={genFiltered.length === 0} emptyText="No generation jobs.">
          {genFiltered.map(j => {
            const active = j.status === 'processing' || j.status === 'pending'
            return (
              <tr key={j.jobId} className="border-t border-border hover:bg-muted/20">
                <td className="px-4 py-3"><p className="font-semibold text-foreground">{PRINT_ASSET_TYPE_LABELS[j.assetType]}</p><p className="text-[12px] text-muted-foreground">{eventName(j.eventId)}</p></td>
                <td className="px-4 py-3 text-[12px] text-muted-foreground">{j.counts.processed}/{j.counts.total} · <span className="text-emerald-600">{j.counts.succeeded} ok</span>{j.counts.failed > 0 && <> · <span className="text-rose-600">{j.counts.failed} failed</span></>}</td>
                <td className="px-4 py-3"><Pill status={j.status} /></td>
                <td className="px-4 py-3 text-[12px] text-muted-foreground">{fmt(j.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <IconBtn title="View assets" onClick={() => { setTab('assets'); void loadItems(j.jobId) }}><Eye className="size-3.5" /></IconBtn>
                    {active && <IconBtn title="Resume" busy={busy === `res-${j.jobId}`} onClick={() => void act(`res-${j.jobId}`, `/api/organizer/print-jobs/${j.jobId}/process`, undefined, 'Resumed')}><Play className="size-3.5" /></IconBtn>}
                    {j.status === 'failed' && <IconBtn title="Retry" busy={busy === `res-${j.jobId}`} onClick={() => void act(`res-${j.jobId}`, `/api/organizer/print-jobs/${j.jobId}/process`, undefined, 'Retried')}><RefreshCw className="size-3.5" /></IconBtn>}
                    <IconBtn title="Package this job" busy={busy === `pkg-${j.jobId}`} onClick={() => void act(`pkg-${j.jobId}`, '/api/organizer/print-packages', { sourceJobId: j.jobId }, 'Packaging started')}><Package className="size-3.5" /></IconBtn>
                    {active && <IconBtn title="Cancel" danger busy={busy === `can-${j.jobId}`} onClick={() => void act(`can-${j.jobId}`, `/api/organizer/print-jobs/${j.jobId}/cancel`, undefined, 'Cancelled')}><X className="size-3.5" /></IconBtn>}
                  </div>
                </td>
              </tr>
            )
          })}
        </Table>
      )}

      {/* ── PACKAGE JOBS ── */}
      {tab === 'packages' && (
        <Table head={['Package', 'Files', 'Status', 'Expires', '']} empty={pkgFiltered.length === 0} emptyText="No package jobs.">
          {pkgFiltered.map(j => {
            const expired = isExpired(j.output?.expiresAt, nowTs)
            const active = j.status === 'processing' || j.status === 'pending'
            return (
              <tr key={j.jobId} className="border-t border-border hover:bg-muted/20">
                <td className="px-4 py-3"><p className="font-semibold text-foreground">{PRINT_ASSET_TYPE_LABELS[j.assetType]}</p><p className="font-mono text-[11px] text-muted-foreground">{j.jobId.slice(0, 16)}…</p></td>
                <td className="px-4 py-3 text-[12px] text-muted-foreground">{j.stats ? `${j.stats.packaged}/${j.stats.filesTotal}` : (j.output?.fileCount ?? '—')}{j.stats && j.stats.failed + j.stats.missing > 0 && <span className="text-rose-600"> · {j.stats.failed + j.stats.missing} skipped</span>}</td>
                <td className="px-4 py-3"><Pill status={j.status} />{expired && <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">expired</span>}</td>
                <td className="px-4 py-3 text-[12px] text-muted-foreground">{fmt(j.output?.expiresAt ?? null)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {j.ready && !expired && <IconBtn title="Download ZIP" onClick={() => void downloadZip(j.jobId)}><Download className="size-3.5" /></IconBtn>}
                    <IconBtn title="Regenerate package" busy={busy === `rpk-${j.jobId}`} onClick={() => void act(`rpk-${j.jobId}`, '/api/organizer/print-packages', { sourceJobId: j.sourceJobId }, 'Re-packaging started')}><RefreshCw className="size-3.5" /></IconBtn>
                    {active && <IconBtn title="Cancel" danger busy={busy === `canp-${j.jobId}`} onClick={() => void act(`canp-${j.jobId}`, `/api/organizer/print-packages/${j.jobId}/cancel`, undefined, 'Cancelled')}><X className="size-3.5" /></IconBtn>}
                  </div>
                </td>
              </tr>
            )
          })}
        </Table>
      )}

      {/* ── GENERATED ASSETS ── */}
      {tab === 'assets' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card p-3">
            <span className="text-[12px] font-semibold text-muted-foreground">Generation job</span>
            <select value={assetJobId} onChange={e => void loadItems(e.target.value)} className="min-w-[260px] rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]">
              <option value="">Select a generation job…</option>
              {genJobs.map(j => <option key={j.jobId} value={j.jobId}>{PRINT_ASSET_TYPE_LABELS[j.assetType]} · {eventName(j.eventId)} · {j.counts.succeeded} assets · {fmt(j.createdAt)}</option>)}
            </select>
            {selected.size > 0 && assetJobId && (
              <button onClick={() => { const job = genJobs.find(g => g.jobId === assetJobId); if (job) void act(`regen`, '/api/organizer/print-jobs', { templateId: job.templateId, filters: { registrationIds: [...selected] } }, 'Regeneration started') }}
                className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'ml-auto')} disabled={busy === 'regen'}>
                {busy === 'regen' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Regenerate {selected.size} selected
              </button>
            )}
          </div>
          {!assetJobId ? <div className="rounded-2xl border border-border bg-card py-4"><EmptyState icon={Files} title="Select a generation job" description="Pick a job to browse its generated assets." /></div>
           : itemsLoading ? <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
           : (
            <Table head={[<input key="h" type="checkbox" onChange={e => setSelected(e.target.checked ? new Set(itemFiltered.map(i => i.registrationId)) : new Set())} checked={itemFiltered.length > 0 && selected.size === itemFiltered.length} />, 'Attendee', 'Ticket', 'Status', '']} empty={itemFiltered.length === 0} emptyText="No assets match.">
              {itemFiltered.map(it => (
                <tr key={it.registrationId} className="border-t border-border hover:bg-muted/20">
                  <td className="px-4 py-3"><input type="checkbox" checked={selected.has(it.registrationId)} onChange={e => setSelected(s => { const n = new Set(s); if (e.target.checked) n.add(it.registrationId); else n.delete(it.registrationId); return n })} /></td>
                  <td className="px-4 py-3"><p className="font-medium text-foreground">{it.name || '—'}</p><p className="font-mono text-[11px] text-muted-foreground">{it.registrationId}</p></td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground">{it.ticketCode || '—'}</td>
                  <td className="px-4 py-3">{it.ready ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[12px] font-semibold text-emerald-700">Ready</span> : <span title={it.error ?? ''} className="rounded-full bg-rose-100 px-2 py-0.5 text-[12px] font-semibold text-rose-700">Failed</span>}</td>
                  <td className="px-4 py-3"><div className="flex items-center justify-end gap-1">{it.ready && <><IconBtn title="Preview / open PDF" onClick={() => void downloadItem(assetJobId, it.registrationId)}><Eye className="size-3.5" /></IconBtn><IconBtn title="Download PDF" onClick={() => void downloadItem(assetJobId, it.registrationId)}><Download className="size-3.5" /></IconBtn></>}</div></td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      )}

      {/* ── TEMPLATES ── */}
      {tab === 'templates' && (
        <Table head={['Name', 'Asset type', 'Version', 'Usage', 'Status', '']} empty={tplFiltered.length === 0} emptyText="No templates.">
          {tplFiltered.map(t => (
            <tr key={t.id} className="border-t border-border hover:bg-muted/20">
              <td className="px-4 py-3"><p className="font-semibold text-foreground">{t.name}</p><p className="text-[12px] text-muted-foreground">{eventName(t.eventId)}</p></td>
              <td className="px-4 py-3 text-[12px] text-muted-foreground">{PRINT_ASSET_TYPE_LABELS[t.assetType]}</td>
              <td className="px-4 py-3 text-[12px] text-muted-foreground">v{t.design?.version ?? 1}</td>
              <td className="px-4 py-3 text-[12px] text-muted-foreground">{templateUsage(t.id)} job{templateUsage(t.id) === 1 ? '' : 's'}</td>
              <td className="px-4 py-3"><span className={cn('rounded-full px-2 py-0.5 text-[12px] font-semibold', t.status === 'published' ? 'bg-emerald-100 text-emerald-700' : t.status === 'archived' ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground')}>{PRINT_TEMPLATE_STATUS_LABELS[t.status]}</span></td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <Link href={`/dashboard/print-assets/${t.id}/design`} title="Open designer" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="size-3.5" /></Link>
                  <IconBtn title="Duplicate" busy={busy === `dup-${t.id}`} onClick={() => void duplicateTemplate(t.id)}><Copy className="size-3.5" /></IconBtn>
                  {t.status !== 'published' && <IconBtn title="Publish" busy={busy === `tpl-${t.id}`} onClick={() => void patchTemplate(t.id, 'published')}><CheckCircle2 className="size-3.5" /></IconBtn>}
                  {t.status !== 'archived' && <IconBtn title="Archive" busy={busy === `tpl-${t.id}`} onClick={() => void patchTemplate(t.id, 'archived')}><Archive className="size-3.5" /></IconBtn>}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}

      {/* ── STORAGE (visual only) ── */}
      {tab === 'storage' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Generated assets" value={metrics.generatedAssets} icon={Files} />
            <Metric label="Packages" value={metrics.packagesReady} icon={Package} />
            <Metric label="Expired assets" value={metrics.expiredAssets} icon={AlertTriangle} tone={metrics.expiredAssets ? 'text-amber-600' : undefined} />
            <Metric label="Expired packages" value={metrics.expiredPackages} icon={AlertTriangle} tone={metrics.expiredPackages ? 'text-amber-600' : undefined} />
          </div>
          <div className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4">
            <HardDrive className="mt-0.5 size-5 text-muted-foreground" />
            <div className="text-[13px]">
              <p className="font-semibold text-foreground">Cleanup status</p>
              <p className="mt-0.5 text-muted-foreground">Download links expire 24h after generation/packaging. Automated cleanup is <span className="font-semibold text-foreground">not enabled</span> — expired objects remain in storage until a future cleanup phase. This view is informational only.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Small local UI helpers ────────────────────────────────────────────────────
function Metric({ label, value, icon: Icon, tone }: { label: string; value: number; icon: React.ElementType; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground"><Icon className="size-4" /><span className="text-[12px] font-medium">{label}</span></div>
      <p className={cn('mt-1 text-2xl font-bold tabular-nums', tone ?? 'text-foreground')}>{value.toLocaleString('en-IN')}</p>
    </div>
  )
}
function Pill({ status }: { status: JobStatus }) {
  return <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11.5px] font-semibold capitalize', STATUS_TONE[status])}>{status}</span>
}
function IconBtn({ children, title, onClick, danger, busy }: { children: React.ReactNode; title: string; onClick: () => void; danger?: boolean; busy?: boolean }) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={busy}
      className={cn('rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50', danger ? 'hover:text-rose-600' : 'hover:text-foreground')}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : children}
    </button>
  )
}
function Table({ head, children, empty, emptyText }: { head: React.ReactNode[]; children: React.ReactNode; empty: boolean; emptyText: string }) {
  if (empty) return <div className="rounded-2xl border border-border bg-card py-4"><EmptyState icon={Printer} title={emptyText} description="Nothing to show here yet." /></div>
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-card">
      <table className="w-full min-w-[720px] text-left text-[13px]">
        <thead className="bg-muted/40 text-[12px] uppercase tracking-wide text-muted-foreground">
          <tr>{head.map((h, i) => <th key={i} className="px-4 py-2.5 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
