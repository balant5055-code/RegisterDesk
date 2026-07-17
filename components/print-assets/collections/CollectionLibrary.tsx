'use client'

// PA-8 — Professional Collection library + import flow. Bundled starters only —
// no marketplace / download / purchase / sharing / rating. Import calls the
// existing /print-templates/import endpoint, which reuses createPrintTemplate +
// savePrintDesign; imported templates are ordinary templates.

import { useMemo, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { buttonVariants } from '@/components/ui'
import { X, ArrowLeft, Loader2, Sparkles, Check, Layers } from 'lucide-react'
import { PRINT_COLLECTIONS, getCollection, recommendCollection } from '@/lib/printAssets/collections'
import { PRINT_ASSET_TYPE_LABELS } from '@/lib/printAssets/types'
import type { PrintTemplate } from '@/lib/printAssets/types'
import type { EventListItem } from '@/app/api/organizer/events/route'
import type { ImportCollectionResponse } from '@/app/api/organizer/print-templates/import/route'
import { DesignThumb } from './DesignThumb'

export function CollectionLibrary({ events, onClose, onImported }: {
  events: EventListItem[]
  onClose: () => void
  onImported: (created: PrintTemplate[]) => void
}) {
  const { showToast } = useToast()
  const [openId, setOpenId] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [eventId, setEventId] = useState('')
  const [busy, setBusy] = useState(false)

  const collection = openId ? getCollection(openId) : undefined

  // Collections recommended by any of the organizer's events (Smart Recommendations).
  const recommendedIds = useMemo(() => {
    const s = new Set<string>()
    for (const e of events) { const r = recommendCollection(e.eventType, e.campaignType, e.name); if (r) s.add(r) }
    return s
  }, [events])

  const chosenEvent = events.find(e => e.draftId === eventId)
  const eventRec = chosenEvent ? recommendCollection(chosenEvent.eventType, chosenEvent.campaignType, chosenEvent.name) : null

  function openCollection(id: string) {
    const c = getCollection(id)
    setOpenId(id)
    setSelected(new Set(c ? c.templates.map((_, i) => i) : []))
  }

  async function doImport() {
    if (!collection) return
    if (!eventId) { showToast('Select an event', 'error'); return }
    if (selected.size === 0) { showToast('Select at least one template', 'error'); return }
    setBusy(true)
    try {
      const token = await auth.currentUser?.getIdToken()
      const res = await fetch('/api/organizer/print-templates/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionId: openId, eventId, templateIndices: [...selected] }),
      })
      const data = await res.json() as ImportCollectionResponse
      if (!res.ok || !data.success) { showToast((!data.success && data.error) || 'Import failed', 'error'); return }
      showToast(`Imported ${data.templates.length} template${data.templates.length === 1 ? '' : 's'}`, 'success')
      onImported(data.templates)
    } catch { showToast('Network error', 'error') }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-2xl border border-border bg-card shadow-xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border p-4">
          {collection && <button onClick={() => setOpenId('')} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ArrowLeft className="size-4" /></button>}
          <div className="flex-1">
            <h3 className="flex items-center gap-1.5 text-[16px] font-bold text-foreground"><Sparkles className="size-4 text-primary" /> {collection ? collection.name : 'Professional Collections'}</h3>
            <p className="text-[12px] text-muted-foreground">{collection ? collection.description : 'Start from a professionally designed collection instead of a blank canvas.'}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button>
        </div>

        {/* ── Library grid ── */}
        {!collection && (
          <div className="grid grid-cols-1 gap-3 overflow-y-auto p-4 sm:grid-cols-2 lg:grid-cols-3">
            {PRINT_COLLECTIONS.map(c => (
              <button key={c.id} onClick={() => openCollection(c.id)}
                className="group flex flex-col overflow-hidden rounded-xl border border-border text-left transition-shadow hover:shadow-md">
                <div className="relative flex h-24 items-center justify-center" style={{ background: `linear-gradient(135deg, ${c.accent}, ${c.accent}cc)` }}>
                  <Layers className="size-8 text-white/80" />
                  {recommendedIds.has(c.id) && <span className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-bold text-foreground">Recommended</span>}
                </div>
                <div className="flex flex-1 flex-col p-3">
                  <p className="text-[14px] font-bold text-foreground">{c.name}</p>
                  <p className="mt-0.5 line-clamp-2 flex-1 text-[12px] text-muted-foreground">{c.description}</p>
                  <p className="mt-2 text-[11px] font-semibold text-primary">{c.templates.length} templates →</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* ── Select templates + event ── */}
        {collection && (
          <>
            <div className="grid grid-cols-2 gap-3 overflow-y-auto p-4 sm:grid-cols-3 lg:grid-cols-4">
              {collection.templates.map((t, i) => {
                const on = selected.has(i)
                return (
                  <button key={i} onClick={() => setSelected(s => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })}
                    className={cn('flex flex-col items-center gap-2 rounded-xl border p-2 transition-colors', on ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40')}>
                    <div className="relative">
                      <DesignThumb canvas={t.canvas} design={t.design} height={132} />
                      <span className={cn('absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full border', on ? 'border-primary bg-primary text-white' : 'border-border bg-card text-transparent')}><Check className="size-3" /></span>
                    </div>
                    <div className="text-center">
                      <p className="text-[12px] font-semibold text-foreground">{t.name}</p>
                      <p className="text-[10.5px] text-muted-foreground">{PRINT_ASSET_TYPE_LABELS[t.assetType]}</p>
                    </div>
                  </button>
                )
              })}
            </div>

            {/* Footer: event + import */}
            <div className="flex flex-wrap items-center gap-3 border-t border-border p-4">
              <div className="flex-1">
                <label className="block text-[12px] font-semibold text-foreground">Import into event</label>
                <select value={eventId} onChange={e => setEventId(e.target.value)} className="mt-1 w-full max-w-xs rounded-lg border border-border bg-background px-3 py-2 text-[13px]">
                  <option value="">Select an event…</option>
                  {events.map(e => <option key={e.draftId} value={e.draftId}>{e.name}</option>)}
                </select>
                {eventRec === openId && chosenEvent && <p className="mt-1 flex items-center gap-1 text-[11.5px] font-semibold text-emerald-600"><Sparkles className="size-3" /> Recommended for {chosenEvent.name}</p>}
                {eventRec && eventRec !== openId && chosenEvent && (
                  <p className="mt-1 text-[11.5px] text-amber-600">Tip: the <button className="font-semibold underline" onClick={() => openCollection(eventRec)}>{getCollection(eventRec)?.name}</button> collection is a better fit for this event.</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-muted-foreground">{selected.size} selected</span>
                <button onClick={() => void doImport()} disabled={busy || selected.size === 0} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Import {selected.size > 0 ? selected.size : ''}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
