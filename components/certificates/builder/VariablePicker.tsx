'use client'

// Visual variable picker (GA-6 S3) for the certificate builder. Reuses the single
// PLACEHOLDERS registry (no new token list) so the picker, renderer, and validation
// stay in sync. Inserting a variable appends its token; MANUAL typing in the textarea
// keeps working unchanged — this is purely additive assistance.

import { useMemo, useState } from 'react'
import { Plus, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { PLACEHOLDERS, type PlaceholderCategory, type PlaceholderDef } from '@/lib/certificates/placeholders'

const CATEGORY_LABEL: Record<PlaceholderCategory, string> = {
  identity:    'Participant & Registration',
  event:       'Event & Organization',
  certificate: 'Certificate',
  sports:      'Race · Timing · Result · Bib',
}
const CATEGORY_ORDER: PlaceholderCategory[] = ['identity', 'event', 'certificate', 'sports']

export function VariablePicker({ onInsert }: { onInsert: (token: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const grouped = useMemo(() => {
    const term = q.trim().toLowerCase()
    const match = (p: PlaceholderDef) =>
      !term || p.label.toLowerCase().includes(term) || p.token.toLowerCase().includes(term) || p.key.toLowerCase().includes(term)
    return CATEGORY_ORDER
      .map(cat => ({ cat, items: PLACEHOLDERS.filter(p => p.category === cat && match(p)) }))
      .filter(g => g.items.length > 0)
  }, [q])

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="mt-1.5 flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[12px] font-medium text-muted-foreground hover:bg-muted/40">
        <Plus className="size-3.5" /> Insert variable
      </button>
    )
  }

  return (
    <div className="mt-1.5 rounded-md border border-border bg-card">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Search className="size-3.5 text-muted-foreground" />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search variables…"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground focus:outline-none" />
        <button type="button" onClick={() => { setOpen(false); setQ('') }} className="text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
      </div>
      <div className="max-h-56 overflow-y-auto p-1.5">
        {grouped.length === 0 && <p className="px-1 py-2 text-[12px] text-muted-foreground">No variables match “{q}”.</p>}
        {grouped.map(({ cat, items }) => (
          <div key={cat} className="mb-1.5 last:mb-0">
            <p className="px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">{CATEGORY_LABEL[cat]}</p>
            {items.map(p => (
              <button key={p.key} type="button" title={`${p.description} · e.g. ${p.example}`}
                onClick={() => onInsert(p.token)}
                className={cn('flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-muted/50')}>
                <span className="text-[12px] text-foreground">{p.label}</span>
                <span className="truncate text-[10.5px] tabular-nums text-muted-foreground/70">{p.example}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
