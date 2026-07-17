'use client'

// PA-9 Sprint 2 — Variable Picker. Inserts ENGINE tokens ({{name}} etc.) so
// organizers never type them. It only produces tokens from the existing catalog
// (TEXT_VARIABLES, built from PRINT_VARIABLES) + the event's custom fields.

import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils/cn'
import {
  Braces, Search, User, Calendar, Ticket, Building2, Handshake, Hash, ListChecks, Clock,
} from 'lucide-react'
import {
  TEXT_VARIABLES, CATEGORY_LABELS, CATEGORY_ORDER,
  type AuthoringVar, type VarCategory,
} from '@/lib/printAssets/designer/previewData'

const CAT_ICON: Record<VarCategory, React.ElementType> = {
  participant: User, event: Calendar, pass: Ticket, organization: Building2,
  sponsor: Handshake, system: Hash, custom: ListChecks,
}
const RECENT_KEY = 'pa-recent-vars'

function loadRecents(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[] } catch { return [] }
}
function bumpRecent(token: string) {
  try {
    const cur = loadRecents().filter(t => t !== token)
    localStorage.setItem(RECENT_KEY, JSON.stringify([token, ...cur].slice(0, 8)))
  } catch { /* ignore */ }
}

export function VariablePicker({ onInsert, customVars }: { onInsert: (token: string) => void; customVars?: AuthoringVar[] }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [recents, setRecents] = useState<string[]>([])
  const ref = useRef<HTMLDivElement>(null)

  const all = useMemo(() => [...TEXT_VARIABLES, ...(customVars ?? [])], [customVars])

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecents(loadRecents()); setQuery(''); setActive(0)
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() =>
    q ? all.filter(v => v.token.toLowerCase().includes(q) || v.label.toLowerCase().includes(q)) : all,
    [all, q])

  // Recent chips (only when not searching) — resolved from the catalog.
  const recentVars = useMemo(() =>
    q ? [] : recents.map(t => all.find(v => v.token === t)).filter((v): v is AuthoringVar => !!v).slice(0, 5),
    [q, recents, all])

  const flat = useMemo(() => [...recentVars, ...filtered], [recentVars, filtered])

  function insert(v: AuthoringVar) {
    onInsert(`{{${v.token}}}`); bumpRecent(v.token); setOpen(false)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(flat.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (flat[active]) insert(flat[active]) }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  const grouped = CATEGORY_ORDER
    .map(cat => ({ cat, vars: filtered.filter(v => v.category === cat) }))
    .filter(g => g.vars.length > 0)

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11.5px] font-semibold text-foreground hover:bg-muted">
        <Braces className="size-3.5 text-muted-foreground" /> Insert Variable
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-border bg-card shadow-lg">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input autoFocus value={query} onChange={e => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKey}
                placeholder="Search variables…" className="w-full rounded border border-border bg-background py-1 pl-7 pr-2 text-[12px]" />
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {flat.length === 0 && <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">No variables match.</p>}

            {recentVars.length > 0 && (
              <Group label="Recent" icon={Clock}>
                {recentVars.map((v, i) => <VarRow key={`r-${v.token}`} v={v} activeIdx={active} idx={i} onPick={insert} />)}
              </Group>
            )}
            {grouped.map(g => (
              <Group key={g.cat} label={CATEGORY_LABELS[g.cat]} icon={CAT_ICON[g.cat]}>
                {g.vars.map(v => (
                  <VarRow key={v.token} v={v} activeIdx={active} idx={recentVars.length + filtered.indexOf(v)} onPick={insert} />
                ))}
              </Group>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Group({ label, icon: Icon, children }: { label: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <p className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground"><Icon className="size-3" /> {label}</p>
      {children}
    </div>
  )
}
function VarRow({ v, idx, activeIdx, onPick }: { v: AuthoringVar; idx: number; activeIdx: number; onPick: (v: AuthoringVar) => void }) {
  return (
    <button type="button" onClick={() => onPick(v)}
      className={cn('flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left', idx === activeIdx ? 'bg-primary/10' : 'hover:bg-muted')}>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-medium text-foreground">{v.label}</span>
        {v.example && <span className="block truncate text-[10.5px] text-muted-foreground">{v.example}</span>}
      </span>
      <code className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{`{{${v.token}}}`}</code>
    </button>
  )
}
