'use client'

// GA-7D S3 — Global Template Library browser. Surfaces the EXISTING
// globalCertificateTemplates library (GET /api/organizer/global-templates) and the
// EXISTING import endpoint (templates/import-global). Import only — the import route
// clones the platform template into this event as a draft; it never duplicates the file.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Search, Star, Download, LayoutTemplate } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Dialog } from '@/components/ui/Dialog'
import { ErrorBox, Badge, inputCls, selectCls, btnGhost } from './ui'
import type { CertApi, GlobalTemplateItem } from './api'

export default function GlobalTemplatesModal({
  api, open, onClose, onImported,
}: {
  api: CertApi
  open: boolean
  onClose: () => void
  onImported: (name: string) => void
}) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [items, setItems] = useState<GlobalTemplateItem[]>([])
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [importingId, setImportingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try { setItems((await api.listGlobalTemplates()).templates) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load the template library') }
    finally { setLoading(false) }
  }, [api])

  useEffect(() => { if (open) void load() }, [open, load])

  const categories = useMemo(() => Array.from(new Set(items.map(i => i.category).filter(Boolean))).sort(), [items])
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter(i =>
      (!category || i.category === category) &&
      (!needle || i.name.toLowerCase().includes(needle) || i.description.toLowerCase().includes(needle) || i.tags.some(t => t.toLowerCase().includes(needle))),
    )
  }, [items, q, category])

  async function importOne(t: GlobalTemplateItem) {
    setImportingId(t.id); setErr(null)
    try {
      await api.importGlobalTemplate(t.id)
      onImported(t.name)
      onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Import failed') }
    finally { setImportingId(null) }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Start from a template" size="lg">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input className={cn(inputCls, 'pl-9')} placeholder="Search templates…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          {categories.length > 0 && (
            <select className={cn(selectCls, 'w-40')} value={category} onChange={e => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>

        {err && <ErrorBox message={err} />}

        {loading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-12 text-center">
            <LayoutTemplate className="size-8 text-muted-foreground/40" />
            <p className="text-[13px] text-muted-foreground">No templates in the library match your search.</p>
          </div>
        ) : (
          <div className="grid max-h-[55vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
            {filtered.map(t => (
              <div key={t.id} className="flex flex-col rounded-xl border border-border bg-card p-3">
                <div className="mb-2 flex aspect-[1.4/1] items-center justify-center overflow-hidden rounded-lg bg-muted/40">
                  {t.thumbnailUrl
                    ? <img src={t.thumbnailUrl} alt="" className="h-full w-full object-contain" />
                    : <LayoutTemplate className="size-8 text-muted-foreground/40" aria-hidden />}
                </div>
                <div className="flex items-center gap-1.5">
                  <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-foreground">{t.name}</p>
                  {t.featured && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Featured" />}
                </div>
                {t.description && <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{t.description}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {t.category && <Badge tone="gray">{t.category}</Badge>}
                  <Badge tone="blue">{t.tier}</Badge>
                  {t.usageCount > 0 && <span className="text-[11px] text-muted-foreground">{t.usageCount.toLocaleString('en-IN')} uses</span>}
                </div>
                <button type="button" className={cn(btnGhost, 'mt-3 justify-center')} disabled={importingId === t.id} onClick={() => void importOne(t)}>
                  {importingId === t.id ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Import
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}
