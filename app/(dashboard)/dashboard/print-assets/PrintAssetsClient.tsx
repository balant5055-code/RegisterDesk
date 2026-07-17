'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { auth } from '@/lib/firebase/auth'
import { useToast } from '@/components/ui/Toast'
import { PageHeader, buttonVariants, EmptyState } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import {
  Plus, Printer, Copy, Pencil, Trash2, Eye, X, Loader2, Search, LayoutTemplate,
  Sparkles, SquarePen,
} from 'lucide-react'
import { CollectionLibrary } from '@/components/print-assets/collections/CollectionLibrary'
import {
  PRINT_ASSET_TYPES, PRINT_ASSET_TYPE_LABELS, PRINT_TEMPLATE_STATUS_LABELS,
  CANVAS_PRESETS, CANVAS_UNITS, defaultCanvas,
  type PrintTemplate, type PrintAssetType, type PrintTemplateStatus,
  type PrintCanvas, type CanvasPreset, type CanvasUnit, type CanvasOrientation,
} from '@/lib/printAssets/types'
import type { EventListItem } from '@/app/api/organizer/events/route'
import type { ListPrintTemplatesResponse, CreatePrintTemplateResponse } from '@/app/api/organizer/print-templates/route'

const STATUS_TONE: Record<PrintTemplateStatus, string> = {
  draft:     'bg-muted text-muted-foreground',
  published: 'bg-emerald-100 text-emerald-700',
  archived:  'bg-amber-100 text-amber-700',
}
const canvasLabel = (c: PrintCanvas) =>
  `${c.preset === 'CUSTOM' ? 'Custom' : c.preset} · ${c.width}×${c.height} ${c.unit} · ${c.orientation}`

interface FormState {
  id?: string
  name: string
  description: string
  eventId: string
  assetType: PrintAssetType
  status: PrintTemplateStatus
  preset: CanvasPreset
  unit: CanvasUnit
  orientation: CanvasOrientation
  width: string
  height: string
}

function emptyForm(): FormState {
  const c = defaultCanvas()
  return { name: '', description: '', eventId: '', assetType: 'BADGE', status: 'draft', preset: c.preset, unit: c.unit, orientation: c.orientation, width: String(c.width), height: String(c.height) }
}

function formFromTemplate(t: PrintTemplate): FormState {
  return {
    id: t.id, name: t.name, description: t.description, eventId: t.eventId, assetType: t.assetType, status: t.status,
    preset: t.canvas.preset, unit: t.canvas.unit, orientation: t.canvas.orientation,
    width: String(t.canvas.width), height: String(t.canvas.height),
  }
}

function buildCanvas(f: FormState): PrintCanvas {
  if (f.preset === 'CUSTOM') {
    return { preset: 'CUSTOM', width: Number(f.width) || 0, height: Number(f.height) || 0, unit: f.unit, orientation: f.orientation }
  }
  const p = CANVAS_PRESETS[f.preset]
  return { preset: f.preset, width: p.width, height: p.height, unit: p.unit, orientation: f.orientation }
}

export function PrintAssetsClient() {
  const { showToast } = useToast()
  const router = useRouter()
  const tokenRef = useRef('')

  const [chooser,  setChooser]  = useState(false)   // Blank vs Collection chooser
  const [showLib,  setShowLib]  = useState(false)   // Professional Collection library

  const [templates, setTemplates] = useState<PrintTemplate[]>([])
  const [events,    setEvents]    = useState<EventListItem[]>([])
  const [loading,   setLoading]   = useState(true)

  const [search,     setSearch]     = useState('')
  const [statusF,    setStatusF]    = useState<'all' | PrintTemplateStatus>('all')
  const [typeF,      setTypeF]      = useState<'all' | PrintAssetType>('all')

  const [form,     setForm]     = useState<FormState | null>(null)   // create/edit dialog
  const [details,  setDetails]  = useState<PrintTemplate | null>(null)
  const [confirm,  setConfirm]  = useState<PrintTemplate | null>(null)
  const [busy,     setBusy]     = useState(false)

  const authed = useCallback(async (): Promise<Record<string, string>> => {
    const token = await auth.currentUser?.getIdToken() ?? tokenRef.current
    if (token) tokenRef.current = token
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const headers = await authed()
      const [tRes, eRes] = await Promise.all([
        fetch('/api/organizer/print-templates', { headers }),
        fetch('/api/organizer/events', { headers }),
      ])
      const tData = await tRes.json() as ListPrintTemplatesResponse
      if (tData.success) setTemplates(tData.templates)
      const eData = await eRes.json().catch(() => ({})) as { events?: EventListItem[] }
      setEvents((eData.events ?? []).filter(e => e.slug))
    } catch { showToast('Could not load print templates', 'error') }
    finally { setLoading(false) }
  }, [authed, showToast])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const q = search.trim().toLowerCase()
  const filtered = templates.filter(t =>
    (statusF === 'all' || t.status === statusF) &&
    (typeF === 'all' || t.assetType === typeF) &&
    (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)),
  )

  async function saveForm() {
    if (!form) return
    if (!form.name.trim()) { showToast('Name is required', 'error'); return }
    if (!form.id && !form.eventId) { showToast('Select an event', 'error'); return }
    setBusy(true)
    try {
      const headers = await authed()
      const canvas = buildCanvas(form)
      if (form.id) {
        const res = await fetch(`/api/organizer/print-templates/${form.id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ name: form.name.trim(), description: form.description.trim(), assetType: form.assetType, status: form.status, canvas }),
        })
        const data = await res.json() as { success: boolean; error?: string; template?: PrintTemplate }
        if (!res.ok || !data.success) { showToast(data.error ?? 'Save failed', 'error'); return }
        if (data.template) setTemplates(prev => prev.map(t => t.id === data.template!.id ? data.template! : t))
        showToast('Template saved', 'success')
      } else {
        const res = await fetch('/api/organizer/print-templates', {
          method: 'POST', headers,
          body: JSON.stringify({ eventId: form.eventId, name: form.name.trim(), description: form.description.trim(), assetType: form.assetType, canvas }),
        })
        const data = await res.json() as CreatePrintTemplateResponse
        if (!res.ok || !data.success) { showToast((!data.success && data.error) || 'Create failed', 'error'); return }
        setTemplates(prev => [data.template, ...prev])
        showToast('Template created', 'success')
      }
      setForm(null)
    } catch { showToast('Network error', 'error') }
    finally { setBusy(false) }
  }

  async function doDelete(t: PrintTemplate) {
    setBusy(true)
    try {
      const res = await fetch(`/api/organizer/print-templates/${t.id}`, { method: 'DELETE', headers: await authed() })
      if (!res.ok) { showToast('Delete failed', 'error'); return }
      setTemplates(prev => prev.filter(x => x.id !== t.id))
      setConfirm(null)
      showToast('Template deleted', 'success')
    } catch { showToast('Network error', 'error') }
    finally { setBusy(false) }
  }

  async function doDuplicate(t: PrintTemplate) {
    try {
      const res  = await fetch(`/api/organizer/print-templates/${t.id}/duplicate`, { method: 'POST', headers: await authed() })
      const data = await res.json() as { success: boolean; template?: PrintTemplate; error?: string }
      if (!res.ok || !data.success || !data.template) { showToast(data.error ?? 'Duplicate failed', 'error'); return }
      setTemplates(prev => [data.template!, ...prev])
      showToast('Template duplicated', 'success')
    } catch { showToast('Network error', 'error') }
  }

  const eventName = (id: string) => events.find(e => e.draftId === id)?.name ?? '—'

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Print Assets"
        subtitle="Design templates for badges, bibs, passes and more. Open the designer to lay out text, images, QR and shapes."
        breadcrumb={[{ label: 'Operations' }, { label: 'Print Assets' }]}
        action={
          <div className="flex gap-2">
            <Link href="/dashboard/print-assets/operations" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <LayoutTemplate className="size-4" /> Operations Center
            </Link>
            <button type="button" onClick={() => setChooser(true)} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
              <Plus className="size-4" /> New Template
            </button>
          </div>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search templates…"
            className="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground" />
        </div>
        <select value={statusF} onChange={e => setStatusF(e.target.value as typeof statusF)}
          className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]">
          <option value="all">All statuses</option>
          {(['draft', 'published', 'archived'] as PrintTemplateStatus[]).map(s => <option key={s} value={s}>{PRINT_TEMPLATE_STATUS_LABELS[s]}</option>)}
        </select>
        <select value={typeF} onChange={e => setTypeF(e.target.value as typeof typeF)}
          className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]">
          <option value="all">All asset types</option>
          {PRINT_ASSET_TYPES.map(t => <option key={t} value={t}>{PRINT_ASSET_TYPE_LABELS[t]}</option>)}
        </select>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card py-4">
          <EmptyState icon={Printer} title={templates.length === 0 ? 'No print templates yet' : 'No templates match your filters'}
            description={templates.length === 0 ? 'Create your first badge, bib or pass template.' : 'Try clearing the search or filters.'} />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="bg-muted/40 text-[12px] uppercase tracking-wide text-muted-foreground">
              <tr>
                {['Name', 'Asset Type', 'Canvas', 'Event', 'Status', ''].map((h, i) => (
                  <th key={i} className="px-4 py-2.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} className="border-t border-border hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <button type="button" onClick={() => setDetails(t)} className="font-semibold text-foreground hover:text-primary hover:underline">{t.name}</button>
                    {t.description && <p className="mt-0.5 line-clamp-1 max-w-[240px] text-[12px] text-muted-foreground">{t.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{PRINT_ASSET_TYPE_LABELS[t.assetType]}</td>
                  <td className="px-4 py-3 text-muted-foreground">{canvasLabel(t.canvas)}</td>
                  <td className="max-w-[140px] truncate px-4 py-3 text-muted-foreground">{eventName(t.eventId)}</td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[12px] font-semibold', STATUS_TONE[t.status])}>{PRINT_TEMPLATE_STATUS_LABELS[t.status]}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Link href={`/dashboard/print-assets/${t.id}/design`} title="Open designer"
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                        <LayoutTemplate className="size-3.5" />
                      </Link>
                      <IconBtn title="View" onClick={() => setDetails(t)}><Eye className="size-3.5" /></IconBtn>
                      <IconBtn title="Edit" onClick={() => setForm(formFromTemplate(t))}><Pencil className="size-3.5" /></IconBtn>
                      <IconBtn title="Duplicate" onClick={() => void doDuplicate(t)}><Copy className="size-3.5" /></IconBtn>
                      <IconBtn title="Delete" onClick={() => setConfirm(t)} danger><Trash2 className="size-3.5" /></IconBtn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* New-template chooser: Blank vs Professional Collection */}
      {chooser && (
        <Modal title="Create Print Template" onClose={() => setChooser(false)}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button type="button" onClick={() => { setChooser(false); setForm(emptyForm()) }}
              className="flex flex-col items-start gap-2 rounded-xl border border-border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5">
              <SquarePen className="size-6 text-muted-foreground" />
              <span className="text-[14px] font-bold text-foreground">Blank Template</span>
              <span className="text-[12px] text-muted-foreground">Start from an empty canvas and design it yourself.</span>
            </button>
            <button type="button" onClick={() => { setChooser(false); setShowLib(true) }}
              className="flex flex-col items-start gap-2 rounded-xl border border-border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5">
              <Sparkles className="size-6 text-primary" />
              <span className="text-[14px] font-bold text-foreground">Professional Collection</span>
              <span className="text-[12px] text-muted-foreground">Import ready-made, professionally designed templates.</span>
            </button>
          </div>
        </Modal>
      )}

      {/* Professional Collection library + import */}
      {showLib && (
        <CollectionLibrary
          events={events}
          onClose={() => setShowLib(false)}
          onImported={created => {
            setTemplates(prev => [...created, ...prev])
            setShowLib(false)
            if (created.length === 1) router.push(`/dashboard/print-assets/${created[0].id}/design`)
          }}
        />
      )}

      {/* Create / Edit dialog */}
      {form && (
        <Modal title={form.id ? 'Edit Template' : 'New Print Template'} onClose={() => setForm(null)}>
          <div className="space-y-3">
            <Field label="Name">
              <input value={form.name} onChange={e => setForm(f => f && { ...f, name: e.target.value })} placeholder="e.g. Conference Badge — Speakers"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px]" />
            </Field>
            <Field label="Description">
              <textarea value={form.description} onChange={e => setForm(f => f && { ...f, description: e.target.value })} rows={2}
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[13px]" />
            </Field>
            {!form.id && (
              <Field label="Event">
                <select value={form.eventId} onChange={e => setForm(f => f && { ...f, eventId: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px]">
                  <option value="">Select an event…</option>
                  {events.map(e => <option key={e.draftId} value={e.draftId}>{e.name}</option>)}
                </select>
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Asset Type">
                <select value={form.assetType} onChange={e => setForm(f => f && { ...f, assetType: e.target.value as PrintAssetType })}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px]">
                  {PRINT_ASSET_TYPES.map(t => <option key={t} value={t}>{PRINT_ASSET_TYPE_LABELS[t]}</option>)}
                </select>
              </Field>
              {form.id && (
                <Field label="Status">
                  <select value={form.status} onChange={e => setForm(f => f && { ...f, status: e.target.value as PrintTemplateStatus })}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px]">
                    {(['draft', 'published', 'archived'] as PrintTemplateStatus[]).map(s => <option key={s} value={s}>{PRINT_TEMPLATE_STATUS_LABELS[s]}</option>)}
                  </select>
                </Field>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Canvas size">
                <select value={form.preset} onChange={e => {
                  const preset = e.target.value as CanvasPreset
                  setForm(f => {
                    if (!f) return f
                    if (preset === 'CUSTOM') return { ...f, preset }
                    const p = CANVAS_PRESETS[preset]
                    return { ...f, preset, width: String(p.width), height: String(p.height), unit: p.unit }
                  })
                }} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px]">
                  {(Object.keys(CANVAS_PRESETS) as (keyof typeof CANVAS_PRESETS)[]).map(k => <option key={k} value={k}>{CANVAS_PRESETS[k].label}</option>)}
                  <option value="CUSTOM">Custom</option>
                </select>
              </Field>
              <Field label="Orientation">
                <select value={form.orientation} onChange={e => setForm(f => f && { ...f, orientation: e.target.value as CanvasOrientation })}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px]">
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </Field>
            </div>
            {form.preset === 'CUSTOM' && (
              <div className="grid grid-cols-3 gap-3">
                <Field label="Width"><input type="number" value={form.width} onChange={e => setForm(f => f && { ...f, width: e.target.value })} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px]" /></Field>
                <Field label="Height"><input type="number" value={form.height} onChange={e => setForm(f => f && { ...f, height: e.target.value })} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px]" /></Field>
                <Field label="Unit">
                  <select value={form.unit} onChange={e => setForm(f => f && { ...f, unit: e.target.value as CanvasUnit })} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px]">
                    {CANVAS_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </Field>
              </div>
            )}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setForm(null)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Cancel</button>
            <button type="button" onClick={() => void saveForm()} disabled={busy} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null} {form.id ? 'Save' : 'Create'}
            </button>
          </div>
        </Modal>
      )}

      {/* Details dialog */}
      {details && (
        <Modal title={details.name} onClose={() => setDetails(null)}>
          <div className="space-y-3 text-[13px]">
            {details.description && <p className="text-muted-foreground">{details.description}</p>}
            <div className="grid grid-cols-2 gap-3">
              <Detail label="Asset Type" value={PRINT_ASSET_TYPE_LABELS[details.assetType]} />
              <Detail label="Status" value={PRINT_TEMPLATE_STATUS_LABELS[details.status]} />
              <Detail label="Canvas" value={canvasLabel(details.canvas)} />
              <Detail label="Event" value={eventName(details.eventId)} />
            </div>
            <div>
              <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Preview</p>
              <div className="flex items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 py-10 text-center">
                <div>
                  <Printer className="mx-auto size-6 text-muted-foreground/60" aria-hidden />
                  <p className="mt-2 text-[12px] text-muted-foreground">Preview placeholder</p>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setDetails(null)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Close</button>
            <button type="button" onClick={() => { const t = details; setDetails(null); setForm(formFromTemplate(t)) }} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <Pencil className="size-3.5" /> Edit
            </button>
            <Link href={`/dashboard/print-assets/${details.id}/design`} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
              <LayoutTemplate className="size-3.5" /> Open designer
            </Link>
          </div>
        </Modal>
      )}

      {/* Delete confirm */}
      {confirm && (
        <Modal title="Delete template?" onClose={() => setConfirm(null)}>
          <p className="text-[14px] text-muted-foreground">This permanently deletes <span className="font-semibold text-foreground">{confirm.name}</span>. This cannot be undone.</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirm(null)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Cancel</button>
            <button type="button" onClick={() => void doDelete(confirm)} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-rose-700 disabled:opacity-60">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-3.5" />} Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─── Small local UI helpers ────────────────────────────────────────────────────

function IconBtn({ children, title, onClick, danger }: { children: React.ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className={cn('rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted', danger ? 'hover:text-rose-600' : 'hover:text-foreground')}>
      {children}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[12px] font-semibold text-foreground">{label}</span>
      {children}
    </label>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-foreground">{value}</p>
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[16px] font-bold text-foreground">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
