'use client'

// Enterprise Global Search & Admin Command Palette (GA-2 S6).
//
// Reuse-first: the search FANS OUT to the EXISTING bounded admin list endpoints
// (organizers / licenses / coupons) + the one thin events endpoint — no new search
// engine, no duplicated queries, no collection scans. Navigation-only quick actions.
// Recent searches and pinned results are LOCAL (localStorage). Participants /
// payments / jobs are intentionally omitted (no global text index — see the page).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { IconButton } from '@/components/ui'
import {
  Search, X, Loader2, Building2, CalendarDays, KeyRound, Pin, PinOff,
  CornerDownLeft, Clock, LayoutGrid, ArrowRight,
} from 'lucide-react'
import { StatusPill } from '@/components/admin'
import type { PillTone } from '@/components/admin'
import type { LucideIcon } from 'lucide-react'
import type { AdminOrganizerSummary, AdminOrganizersListResponse } from '@/lib/admin/organizerTypes'
import type { LicenseRow, LicenseListResponse } from '@/lib/admin/licenseAdminTypes'
import type { CouponView, CouponListResponse } from '@/lib/admin/licenseCenterTypes'
import type { EventSearchResponse } from '@/lib/admin/globalSearchTypes'

// ─── Result model ─────────────────────────────────────────────────────────────

export type ResultGroup = 'Organizers' | 'Events' | 'Commerce' | 'Navigation'

export interface QuickAction { label: string; href: string }
export interface SearchResult {
  id:       string
  group:    ResultGroup
  type:     string
  title:    string
  subtitle: string
  status:   string | null
  tone:     PillTone
  href:     string
  actions:  QuickAction[]
}

const GROUP_ICON: Record<ResultGroup, LucideIcon> = {
  Organizers: Building2, Events: CalendarDays, Commerce: KeyRound, Navigation: LayoutGrid,
}

// ─── Static navigation (the "commands"/quick-links — navigation only) ──────────

interface NavItem { title: string; subtitle: string; href: string; keywords: string }
export const GLOBAL_NAV: { section: string; items: NavItem[] }[] = [
  { section: 'Platform', items: [
    { title: 'Admin Dashboard', subtitle: 'Platform overview', href: '/admin/dashboard', keywords: 'home overview stats' },
    { title: 'Platform Monitoring', subtitle: 'Health dashboard', href: '/admin/platform-monitor', keywords: 'health monitor infrastructure services' },
    { title: 'Analytics', subtitle: 'Platform analytics', href: '/admin/analytics', keywords: 'charts revenue growth' },
  ] },
  { section: 'Operations', items: [
    { title: 'Operations Center', subtitle: 'Background jobs / NOC', href: '/admin/operations-center', keywords: 'jobs noc queue print certificate import export' },
    { title: 'Operations Health', subtitle: 'Cron & recovery', href: '/admin/operations', keywords: 'cron recovery health alerts' },
    { title: 'Communications', subtitle: 'Email / WhatsApp', href: '/admin/communications', keywords: 'email whatsapp broadcast' },
  ] },
  { section: 'Commerce', items: [
    { title: 'License & Coupon Center', subtitle: 'Command center', href: '/admin/license-center', keywords: 'license coupon orders expiry override' },
    { title: 'Licenses', subtitle: 'License console', href: '/admin/licenses', keywords: 'license grant' },
    { title: 'Finance', subtitle: 'Finance console', href: '/admin/finance', keywords: 'settlement payout revenue' },
  ] },
  { section: 'Governance', items: [
    { title: 'Audit Log', subtitle: 'Admin audit trail', href: '/admin/audit', keywords: 'audit security actions' },
    { title: 'Moderation', subtitle: 'Events & campaigns', href: '/admin/moderation', keywords: 'moderation takedown report' },
    { title: 'Event Approvals', subtitle: 'Review queue', href: '/admin/event-approvals', keywords: 'approve review pending' },
    { title: 'Organizers', subtitle: 'Organizer accounts', href: '/admin/organizers', keywords: 'organizer users accounts' },
    { title: 'Business Configuration', subtitle: 'Runtime settings', href: '/admin/business-configuration', keywords: 'config settings fees licensing' },
    { title: 'Domains', subtitle: 'Custom domains', href: '/admin/domains', keywords: 'domain dns custom' },
  ] },
]

const ALL_NAV: (NavItem & { section: string })[] = GLOBAL_NAV.flatMap(g => g.items.map(i => ({ ...i, section: g.section })))

function navResults(q: string): SearchResult[] {
  const ql = q.trim().toLowerCase()
  const items = ql
    ? ALL_NAV.filter(i => i.title.toLowerCase().includes(ql) || i.subtitle.toLowerCase().includes(ql) || i.keywords.includes(ql))
    : ALL_NAV
  return items.map(i => ({
    id: `nav:${i.href}`, group: 'Navigation', type: i.section, title: i.title, subtitle: i.subtitle,
    status: null, tone: 'neutral', href: i.href, actions: [],
  }))
}

// ─── Data fetch (reuses existing endpoints; coupons cached per session) ────────

async function token(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}
async function getJson<T>(url: string, bearer: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` }, cache: 'no-store' })
    if (!res.ok) return null
    return await res.json() as T
  } catch { return null }
}

let couponCache: CouponView[] | null = null
async function loadCoupons(bearer: string): Promise<CouponView[]> {
  if (couponCache) return couponCache
  const d = await getJson<CouponListResponse>('/api/admin/license-coupons?includeArchived=1', bearer)
  couponCache = d?.coupons ?? []
  return couponCache
}

const orgTone = (s: string): PillTone => (s === 'active' ? 'success' : s === 'suspended' ? 'warning' : 'danger')
const licTone = (s: string): PillTone => (s === 'active' ? 'success' : s === 'pending' ? 'warning' : 'danger')

async function runSearch(q: string): Promise<SearchResult[]> {
  const bearer = await token()
  const [orgs, lics, evs, coupons] = await Promise.all([
    getJson<AdminOrganizersListResponse>(`/api/admin/organizers?pageSize=6&search=${encodeURIComponent(q)}`, bearer),
    getJson<LicenseListResponse>(`/api/admin/licenses?pageSize=6&search=${encodeURIComponent(q)}`, bearer),
    getJson<EventSearchResponse>(`/api/admin/search/events?q=${encodeURIComponent(q)}`, bearer),
    loadCoupons(bearer),
  ])

  const out: SearchResult[] = []
  const ql = q.toLowerCase()

  for (const o of (orgs?.items ?? []) as AdminOrganizerSummary[]) {
    out.push({
      id: `org:${o.uid}`, group: 'Organizers', type: 'Organizer',
      title: o.name || o.organizationName || o.uid, subtitle: o.email || o.organizationName || o.uid,
      status: o.accountStatus, tone: orgTone(o.accountStatus),
      href: `/admin/organizers/${o.uid}`, actions: [{ label: 'Licenses', href: '/admin/licenses' }],
    })
  }
  for (const e of evs?.events ?? []) {
    out.push({
      id: `ev:${e.slug}`, group: 'Events', type: 'Event', title: e.name, subtitle: e.slug,
      status: e.lifecycleStatus, tone: e.lifecycleStatus === 'published' ? 'success' : 'neutral',
      href: `/admin/events/${e.slug}`,
      actions: e.organizerUid ? [{ label: 'Organizer 360', href: `/admin/organizers/${e.organizerUid}` }] : [],
    })
  }
  for (const l of (lics?.items ?? []) as LicenseRow[]) {
    out.push({
      id: `lic:${l.eventId}`, group: 'Commerce', type: 'License',
      title: l.eventName, subtitle: `${l.tier} · ${l.organizerName || l.organizerEmail}`,
      status: l.displayStatus, tone: licTone(l.displayStatus),
      href: `/admin/events/${l.eventId}`,
      actions: [{ label: 'License Center', href: '/admin/license-center' }, ...(l.organizerUid ? [{ label: 'Organizer 360', href: `/admin/organizers/${l.organizerUid}` }] : [])],
    })
  }
  for (const c of coupons.filter(c => c.code.toLowerCase().includes(ql) || c.campaign.toLowerCase().includes(ql) || c.description.toLowerCase().includes(ql)).slice(0, 6)) {
    out.push({
      id: `coupon:${c.code}`, group: 'Commerce', type: 'Coupon', title: c.code,
      subtitle: c.campaign || c.description || `${c.type} coupon`, status: c.lifecycle,
      tone: c.lifecycle === 'active' ? 'success' : c.lifecycle === 'paused' ? 'warning' : 'neutral',
      href: '/admin/license-center', actions: [],
    })
  }
  return out
}

// ─── Search hook (debounced) ────────────────────────────────────────────────

export function useGlobalSearch(query: string): { results: SearchResult[]; loading: boolean } {
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const q = query.trim()
    let alive = true
    const t = setTimeout(() => {
      if (!alive) return
      if (q.length < 2) { setResults([]); setLoading(false); return }
      setLoading(true)
      void (async () => {
        const r = await runSearch(q).catch(() => [])
        if (alive) { setResults(r); setLoading(false) }
      })()
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [query])

  return { results, loading }
}

// ─── Local history + pins (localStorage) ────────────────────────────────────

const RECENT_KEY = 'rd_admin_search_recent'
const PIN_KEY    = 'rd_admin_search_pinned'

function readLS<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback } catch { return fallback }
}
function writeLS(key: string, v: unknown): void { try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* quota */ } }

export function useSearchHistory() {
  const [recent, setRecent] = useState<string[]>([])
  const [pinned, setPinned] = useState<SearchResult[]>([])
  // Hydrate from localStorage after mount, deferred off the synchronous effect path.
  useEffect(() => {
    const t = setTimeout(() => { setRecent(readLS<string[]>(RECENT_KEY, [])); setPinned(readLS<SearchResult[]>(PIN_KEY, [])) }, 0)
    return () => clearTimeout(t)
  }, [])

  const pushRecent = useCallback((q: string) => {
    const t = q.trim(); if (t.length < 2) return
    setRecent(prev => { const next = [t, ...prev.filter(x => x !== t)].slice(0, 8); writeLS(RECENT_KEY, next); return next })
  }, [])
  const clearRecent = useCallback(() => { setRecent([]); writeLS(RECENT_KEY, []) }, [])
  const togglePin = useCallback((r: SearchResult) => {
    setPinned(prev => { const has = prev.some(p => p.id === r.id); const next = has ? prev.filter(p => p.id !== r.id) : [r, ...prev].slice(0, 12); writeLS(PIN_KEY, next); return next })
  }, [])
  const isPinned = useCallback((id: string) => pinned.some(p => p.id === id), [pinned])

  return { recent, pinned, pushRecent, clearRecent, togglePin, isPinned }
}

// ─── Shared result row ──────────────────────────────────────────────────────

export function ResultRow({ r, active, onNavigate, onPin, pinned }: {
  r: SearchResult; active?: boolean; onNavigate: (href: string) => void; onPin?: (r: SearchResult) => void; pinned?: boolean
}) {
  const Icon = GROUP_ICON[r.group]
  return (
    <div className={cn('group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors', active ? 'bg-primary/[0.08]' : 'hover:bg-muted')}>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <button onClick={() => onNavigate(r.href)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className="truncate text-[13.5px] font-medium text-foreground">{r.title}</span>{r.status && <StatusPill tone={r.tone}>{r.status}</StatusPill>}</div>
          <div className="truncate text-[12px] text-muted-foreground">{r.type} · {r.subtitle}</div>
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {r.actions.map(a => (
          <Link key={a.href + a.label} href={a.href} onClick={() => onNavigate(a.href)} className="hidden rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex">{a.label}</Link>
        ))}
        {onPin && <button onClick={() => onPin(r)} title={pinned ? 'Unpin' : 'Pin'} className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100">{pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}</button>}
        <button onClick={() => onNavigate(r.href)} className="rounded-md p-1 text-muted-foreground hover:bg-muted"><ArrowRight className="size-3.5" /></button>
      </div>
    </div>
  )
}

// ─── Command Palette (Ctrl/Cmd+K) ───────────────────────────────────────────

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { results, loading } = useGlobalSearch(query)
  const { recent, pinned, pushRecent, clearRecent, togglePin, isPinned } = useSearchHistory()

  const nav = useMemo(() => navResults(query), [query])
  const flat = useMemo(() => [...results, ...nav], [results, nav])

  useEffect(() => {
    if (!open) return
    // Restore focus to the invoking control when the palette closes (a11y).
    const prev = document.activeElement as HTMLElement | null
    const t = setTimeout(() => { setQuery(''); setSel(0); inputRef.current?.focus() }, 20)
    return () => { clearTimeout(t); prev?.focus?.() }
  }, [open])
  useEffect(() => { const t = setTimeout(() => setSel(0), 0); return () => clearTimeout(t) }, [query])

  const navigate = useCallback((href: string) => { pushRecent(query); onClose(); router.push(href) }, [pushRecent, query, onClose, router])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, flat.length - 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
      else if (e.key === 'Enter') { const r = flat[sel]; if (r) navigate(r.href) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, flat, sel, navigate, onClose])

  if (!open) return null
  const showHistory = query.trim().length < 2
  const grouped: [ResultGroup, SearchResult[]][] = (['Organizers', 'Events', 'Commerce', 'Navigation'] as ResultGroup[])
    .map(g => [g, flat.filter(r => r.group === g)] as [ResultGroup, SearchResult[]]).filter(([, rs]) => rs.length > 0)
  let idx = -1

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[10vh]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Global search" className="w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search organizers, events, licenses, coupons, pages…"
            aria-label="Search organizers, events, licenses, coupons and admin pages"
            className="w-full bg-transparent py-3.5 text-[14px] text-foreground outline-none placeholder:text-muted-foreground" />
          {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
          <IconButton onClick={onClose} aria-label="Close search"><X className="size-4" /></IconButton>
        </div>

        {/* Screen-reader status: loading + result count announced politely. */}
        <div aria-live="polite" className="sr-only">{loading ? 'Searching…' : query.trim().length >= 2 ? `${flat.length} result${flat.length === 1 ? '' : 's'}` : ''}</div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {showHistory ? (
            <div className="space-y-3">
              {pinned.length > 0 && (
                <Section title="Pinned">
                  {pinned.map(r => <ResultRow key={r.id} r={r} onNavigate={navigate} onPin={togglePin} pinned />)}
                </Section>
              )}
              {recent.length > 0 && (
                <Section title="Recent searches" action={<button onClick={clearRecent} className="text-[11px] text-muted-foreground hover:text-foreground">Clear</button>}>
                  {recent.map(q => (
                    <button key={q} onClick={() => setQuery(q)} className="flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-muted"><Clock className="size-3.5 text-muted-foreground" />{q}</button>
                  ))}
                </Section>
              )}
              {GLOBAL_NAV.map(g => (
                <Section key={g.section} title={g.section}>
                  {g.items.map(i => {
                    idx++
                    return <ResultRow key={i.href} r={{ id: `nav:${i.href}`, group: 'Navigation', type: g.section, title: i.title, subtitle: i.subtitle, status: null, tone: 'neutral', href: i.href, actions: [] }} onNavigate={navigate} />
                  })}
                </Section>
              ))}
            </div>
          ) : flat.length === 0 && !loading ? (
            <div className="px-3 py-10 text-center text-[13px] text-muted-foreground">No results. Participants, payments and job records aren&apos;t globally searchable — open the workspace that scopes them.</div>
          ) : (
            <div className="space-y-3">
              {grouped.map(([g, rs]) => (
                <Section key={g} title={g}>
                  {rs.map(r => { idx++; const active = idx === sel; return <ResultRow key={r.id} r={r} active={active} onNavigate={navigate} onPin={togglePin} pinned={isPinned(r.id)} /> })}
                </Section>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><CornerDownLeft className="size-3" /> open · ↑↓ navigate · esc close</span>
          <Link href="/admin/search" onClick={onClose} className="hover:text-foreground">Full search →</Link>
        </div>
      </div>
    </div>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between px-3 py-1"><p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{title}</p>{action}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

// ─── Header trigger + global Ctrl/Cmd+K wiring (single mount point) ─────────

export function CommandPaletteRoot() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setOpen(o => !o) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="Open global search"
        className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
        <Search className="size-3.5" aria-hidden />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded border border-border bg-card px-1.5 py-0.5 text-[10px] font-semibold sm:inline">⌘K</kbd>
      </button>
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </>
  )
}
