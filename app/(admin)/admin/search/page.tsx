'use client'

// Full-page Global Search (GA-2 S6). Reuses the SAME search hook, result rows and
// local history as the command palette — no duplicated search logic. Reuse-first:
// it queries the existing bounded admin endpoints; participants/payments/job records
// are omitted (no global text index) and that is stated honestly in the UI.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils/cn'
import { Search, Info } from 'lucide-react'
import { AdminToolbar, SearchInput, FilterTabs, ErrorBanner } from '@/components/admin'
import {
  useGlobalSearch, useSearchHistory, ResultRow, GLOBAL_NAV,
  type ResultGroup, type SearchResult,
} from '@/components/admin/commandPalette'

const GROUP_FILTERS = [
  { value: '', label: 'All' }, { value: 'Organizers', label: 'Organizers' }, { value: 'Events', label: 'Events' },
  { value: 'Commerce', label: 'Commerce' }, { value: 'Navigation', label: 'Navigation' },
]
const ORDER: ResultGroup[] = ['Organizers', 'Events', 'Commerce', 'Navigation']

export default function AdminSearchPage() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('')
  const { results, loading } = useGlobalSearch(query)
  const { recent, pinned, pushRecent, togglePin, isPinned } = useSearchHistory()

  const navResults: SearchResult[] = useMemo(() => {
    const ql = query.trim().toLowerCase()
    return GLOBAL_NAV.flatMap(g => g.items.map(i => ({ ...i, section: g.section })))
      .filter(i => !ql || i.title.toLowerCase().includes(ql) || i.subtitle.toLowerCase().includes(ql) || i.keywords.includes(ql))
      .map(i => ({ id: `nav:${i.href}`, group: 'Navigation' as ResultGroup, type: i.section, title: i.title, subtitle: i.subtitle, status: null, tone: 'neutral' as const, href: i.href, actions: [] }))
  }, [query])

  const all = useMemo(() => [...results, ...navResults], [results, navResults])
  const filtered = group ? all.filter(r => r.group === group) : all
  const grouped = ORDER.map(g => [g, filtered.filter(r => r.group === g)] as [ResultGroup, SearchResult[]]).filter(([, rs]) => rs.length > 0)

  const navigate = (href: string) => { pushRecent(query); router.push(href) }

  return (
    <div className="space-y-5">
      <AdminToolbar title="Global Search" description="Locate any organizer, event, license, coupon or admin page. Press ⌘K anywhere." icon={Search} />

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search organizers, events, licenses, coupons, pages…" className="max-w-md flex-1" />
        <FilterTabs options={GROUP_FILTERS} value={group} onChange={setGroup} aria-label="Filter by group" />
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[12.5px] text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        Reuses existing bounded indexes only. <strong className="mx-1 text-foreground">Participants, payments and job records are not globally searchable</strong> (no global text index) — open Event 360, the License Center or the Operations Center to search within their scope.
      </div>

      {query.trim().length < 2 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {pinned.length > 0 && (
            <Card title="Pinned">{pinned.map(r => <ResultRow key={r.id} r={r} onNavigate={navigate} onPin={togglePin} pinned />)}</Card>
          )}
          {recent.length > 0 && (
            <Card title="Recent searches">{recent.map(q => <button key={q} onClick={() => setQuery(q)} className="block w-full rounded-md px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-muted">{q}</button>)}</Card>
          )}
          {GLOBAL_NAV.map(g => (
            <Card key={g.section} title={g.section}>
              {g.items.map(i => <ResultRow key={i.href} r={{ id: `nav:${i.href}`, group: 'Navigation', type: g.section, title: i.title, subtitle: i.subtitle, status: null, tone: 'neutral', href: i.href, actions: [] }} onNavigate={navigate} />)}
            </Card>
          ))}
        </div>
      ) : loading && filtered.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-muted-foreground">Searching…</p>
      ) : filtered.length === 0 ? (
        <ErrorBanner>No results for “{query}”.</ErrorBanner>
      ) : (
        <div className="space-y-4">
          {grouped.map(([g, rs]) => (
            <Card key={g} title={`${g} (${rs.length})`}>
              {rs.map(r => <ResultRow key={r.id} r={r} onNavigate={navigate} onPin={togglePin} pinned={isPinned(r.id)} />)}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={cn('overflow-hidden rounded-xl border border-border bg-card')}>
      <header className="border-b border-border px-4 py-2.5"><h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2></header>
      <div className="space-y-0.5 p-2">{children}</div>
    </section>
  )
}
