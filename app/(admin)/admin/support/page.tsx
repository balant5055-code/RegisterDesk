'use client'

// Enterprise Support Workspace (GA-2 S7). The operational support dashboard.
// REUSE-only consolidation — no duplicated data, no new business logic:
//   • Search        → the SAME global-search hook + result rows as the ⌘K palette
//   • Overview/Health → GET /api/admin/support/overview (bounded reads + counts)
//   • Recent activity → merges the Operations Center + Platform Monitor timelines
//   • Toolbox        → deep-links into Organizer 360 / Event 360 / the centers
// Out of scope (chat, tickets, CRM, helpdesk) — navigation & consolidation only.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import {
  LifeBuoy, Search, Building2, CalendarDays, ClipboardCheck, ShieldAlert,
  AlertTriangle, KeyRound, Ban, CreditCard, ScrollText, Boxes, Gauge, Wallet,
  ExternalLink, Loader2,
} from 'lucide-react'
import { AdminToolbar, StatusPill, SearchInput, ErrorBanner } from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { useGlobalSearch, ResultRow, type ResultGroup, type SearchResult } from '@/components/admin/commandPalette'
import type { SupportOverview, SupportOverviewResponse, SupportHealth } from '@/lib/admin/supportTypes'
import type { OpsTimelineResponse, OpsTimelineEntry } from '@/lib/admin/operationsCenterTypes'
import type { PlatformSecurityResponse } from '@/lib/admin/platformMonitorTypes'

// ─── Utilities ──────────────────────────────────────────────────────────────

async function authedGet<T>(url: string): Promise<T> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  const res = await fetch(url, { headers: { authorization: `Bearer ${await u.getIdToken()}` }, cache: 'no-store' })
  if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? `Request failed (${res.status})`) }
  return await res.json() as T
}
const num = (n: number): string => n.toLocaleString('en-IN')
const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtDay = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

const ORDER: ResultGroup[] = ['Organizers', 'Events', 'Commerce', 'Navigation']

// ─── Toolbox ──────────────────────────────────────────────────────────────────

const TOOLBOX: { label: string; href: string; icon: typeof KeyRound; hint: string }[] = [
  { label: 'Organizers (Organizer 360)', href: '/admin/organizers', icon: Building2, hint: 'Open any organizer console' },
  { label: 'Global Search (Event 360)', href: '/admin/search', icon: Search, hint: 'Locate an event / participant' },
  { label: 'License & Coupon Center', href: '/admin/license-center', icon: KeyRound, hint: 'Licenses, coupons, expiry' },
  { label: 'Operations Center', href: '/admin/operations-center', icon: Boxes, hint: 'Background jobs / NOC' },
  { label: 'Platform Monitoring', href: '/admin/platform-monitor', icon: Gauge, hint: 'Platform health' },
  { label: 'Finance', href: '/admin/finance', icon: Wallet, hint: 'Settlements & payouts' },
  { label: 'Audit Log', href: '/admin/audit', icon: ScrollText, hint: 'Admin actions' },
]

// ─── Page ───────────────────────────────────────────────────────────────────

export default function SupportPage() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const { results, loading } = useGlobalSearch(query)

  const [overview, setOverview] = useState<SupportOverview | null>(null)
  const [ovErr, setOvErr] = useState<string | null>(null)
  const [feed, setFeed] = useState<FeedEntry[] | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<SupportOverviewResponse>('/api/admin/support/overview'); if (alive) { setOvErr(null); setOverview(d.overview) } }
      catch (e) { if (alive) setOvErr(e instanceof Error ? e.message : 'Failed to load overview') }
    })()
    void (async () => {
      try {
        const [jobs, sec] = await Promise.all([
          authedGet<OpsTimelineResponse>('/api/admin/operations-center/timeline'),
          authedGet<PlatformSecurityResponse>('/api/admin/platform-monitor/security'),
        ])
        if (!alive) return
        const merged: FeedEntry[] = [
          ...jobs.entries.map((t: OpsTimelineEntry) => ({ id: t.id, source: 'ops' as const, kind: t.kind, detail: t.detail, entity: t.entity, at: t.at })),
          ...sec.security.recentActivity.map(e => ({ id: `admin:${e.id}`, source: 'admin' as const, kind: 'admin', detail: e.action.replace(/[._]/g, ' '), entity: e.entityId ?? e.entityType, at: e.at })),
        ].sort((a, b) => (b.at ? Date.parse(b.at) : -Infinity) - (a.at ? Date.parse(a.at) : -Infinity))
        setFeed(merged.slice(0, 60))
      } catch { if (alive) setFeed([]) }
    })()
    return () => { alive = false }
  }, [])

  const grouped = useMemo(() => {
    return ORDER.map(g => [g, results.filter(r => r.group === g)] as [ResultGroup, SearchResult[]]).filter(([, rs]) => rs.length > 0)
  }, [results])

  const navigate = (href: string) => router.push(href)

  return (
    <div className="space-y-5">
      <AdminToolbar title="Support Workspace" description="Investigate and support any organizer, event or transaction — reuses every command center." icon={LifeBuoy} />

      {/* Support Health */}
      {ovErr && <ErrorBanner>{ovErr}</ErrorBanner>}
      <SupportHealthStrip health={overview?.health ?? null} />

      {/* Scoped search (reuses the global search) */}
      <Card title="Search" icon={Search}>
        <div className="space-y-3 p-4">
          <SearchInput value={query} onChange={setQuery} placeholder="Search organizer, event, email, license, coupon…" className="max-w-lg" />
          {query.trim().length < 2 ? (
            <p className="text-[12.5px] text-muted-foreground">Type at least 2 characters. Participants, payments and job records aren&apos;t globally searchable — open Event 360 / License Center / Operations Center to scope them.</p>
          ) : loading && grouped.length === 0 ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Searching…</div>
          ) : grouped.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No results for “{query}”.</p>
          ) : (
            <div className="space-y-3">
              {grouped.map(([g, rs]) => (
                <div key={g}>
                  <p className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{g}</p>
                  <div className="space-y-0.5">{rs.map(r => <ResultRow key={r.id} r={r} onNavigate={navigate} />)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* GA-7E S1 — cross-entity lookup + resend (find & fix without Firestore console) */}
      <SupportLookup />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Recent organizers */}
        <Card title="Recent organizers" icon={Building2}>
          <div className="p-2">
            {overview === null ? <Spin /> : overview.recentOrganizers.length === 0 ? <Empty>None.</Empty> : overview.recentOrganizers.map(o => (
              <Link key={o.uid} href={`/admin/organizers/${o.uid}`} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 hover:bg-muted">
                <div className="min-w-0"><div className="truncate text-[13.5px] font-medium text-foreground">{o.name || o.email || o.uid}</div><div className="truncate text-[12px] text-muted-foreground">{o.email}</div></div>
                <StatusPill tone={o.status === 'active' ? 'success' : o.status === 'suspended' ? 'warning' : 'danger'}>{o.status}</StatusPill>
              </Link>
            ))}
          </div>
        </Card>

        {/* Recent events */}
        <Card title="Recent events" icon={CalendarDays}>
          <div className="p-2">
            {overview === null ? <Spin /> : overview.recentEvents.length === 0 ? <Empty>None.</Empty> : overview.recentEvents.map(e => (
              <Link key={e.slug} href={`/admin/events/${e.slug}`} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 hover:bg-muted">
                <div className="min-w-0"><div className="truncate text-[13.5px] font-medium text-foreground">{e.name}</div><div className="truncate text-[12px] text-muted-foreground">{e.slug}</div></div>
                <StatusPill tone={e.status === 'published' ? 'success' : 'neutral'}>{e.status ?? '—'}</StatusPill>
              </Link>
            ))}
          </div>
        </Card>

        {/* Toolbox */}
        <Card title="Support toolbox" icon={LifeBuoy}>
          <div className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-2">
            {TOOLBOX.map(t => (
              <Link key={t.href + t.label} href={t.href} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 hover:bg-muted">
                <t.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0"><span className="block truncate text-[13px] font-medium text-foreground">{t.label}</span><span className="block truncate text-[11.5px] text-muted-foreground">{t.hint}</span></span>
                <ExternalLink className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </Card>

        {/* Recent activity (merged timelines) */}
        <Card title="Recent activity" icon={ScrollText}>
          <div className="p-2">
            {feed === null ? <Spin /> : feed.length === 0 ? <Empty>No recent activity.</Empty> : (
              <ol className="max-h-[420px] space-y-1.5 overflow-y-auto px-1">
                {feed.map(f => (
                  <li key={f.id} className="rounded-lg bg-muted/30 px-3 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2"><StatusPill tone={FEED_TONE[f.kind] ?? 'neutral'}>{f.source === 'admin' ? 'admin' : f.kind}</StatusPill><span className="truncate text-[12.5px] font-medium text-foreground">{f.detail}</span></span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{fmtDate(f.at)}</span>
                    </div>
                    {f.entity && <p className="truncate text-[11px] text-muted-foreground/70">{f.entity}</p>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Card>
      </div>

      <p className="text-[11.5px] text-muted-foreground">Recent-activity merges the Operations Center and Platform Monitor timelines. Health figures reuse existing bounded aggregations · organizers joined {overview ? fmtDay(overview.recentOrganizers[0]?.createdAt ?? null) : ''}</p>
    </div>
  )
}

// ─── Support Health strip ───────────────────────────────────────────────────

function SupportHealthStrip({ health }: { health: SupportHealth | null }) {
  const items: { label: string; value: number | null; icon: typeof KeyRound; bad: boolean }[] = [
    { label: 'Approvals pending', value: health?.approvalsPending ?? null, icon: ClipboardCheck, bad: (health?.approvalsPending ?? 0) > 0 },
    { label: 'Moderation pending', value: health?.moderationPending ?? null, icon: ShieldAlert, bad: (health?.moderationPending ?? 0) > 0 },
    { label: 'Failed jobs', value: health?.failedJobs ?? null, icon: AlertTriangle, bad: (health?.failedJobs ?? 0) > 0 },
    { label: 'Expired licenses', value: health?.expiredLicenses ?? null, icon: KeyRound, bad: (health?.expiredLicenses ?? 0) > 0 },
    { label: 'Suspended organizers', value: health?.suspendedOrganizers ?? null, icon: Ban, bad: (health?.suspendedOrganizers ?? 0) > 0 },
    { label: 'Payment issues', value: health?.paymentIssues ?? null, icon: CreditCard, bad: (health?.paymentIssues ?? 0) > 0 },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map(it => (
        <div key={it.label} className={cn('rounded-xl border bg-card p-3.5', it.value != null && it.bad ? 'border-amber-300/60' : 'border-border')}>
          <div className="flex items-center gap-1.5 text-muted-foreground"><it.icon className="size-3.5" aria-hidden /><span className="truncate text-[11px] font-medium uppercase tracking-wide">{it.label}</span></div>
          <p className={cn('mt-1.5 text-[19px] font-bold tabular-nums', it.value != null && it.bad ? 'text-amber-600' : 'text-foreground')}>{it.value == null ? '—' : num(it.value)}</p>
        </div>
      ))}
    </div>
  )
}

// ─── Recent activity feed ────────────────────────────────────────────────────

interface FeedEntry { id: string; source: 'ops' | 'admin'; kind: string; detail: string; entity: string | null; at: string | null }
const FEED_TONE: Record<string, PillTone> = { created: 'info', completed: 'success', failed: 'danger', cancelled: 'neutral', admin: 'accent' }

// ─── Shared primitives ──────────────────────────────────────────────────────

function Spin() { return <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div> }
function Empty({ children }: { children: React.ReactNode }) { return <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">{children}</p> }
function Card({ title, icon: Icon, children }: { title: string; icon?: typeof KeyRound; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">{Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}<h2 className="text-[13.5px] font-semibold text-foreground">{title}</h2></header>
      {children}
    </section>
  )
}

// ─── Cross-entity lookup + resend (GA-7E S1) ────────────────────────────────────
// Reuses the new /api/admin/lookup (read-only) + the audited admin resend routes.

interface LookupReg { id: string; eventSlug: string; eventName: string; attendeeName: string; attendeeEmail: string; attendeePhone: string; status: string; paymentStatus: string; amount: number; ticketCode: string; paymentId: string | null; organizerUid: string; registeredAt: string | null }
interface LookupCert { certificateId: string; eventId: string; attendeeName: string; certificateType: string; status: string; organizerUid: string }
interface LookupOrg { uid: string; name: string; email: string; organizationName: string; accountStatus: string }
interface LookupResponse { query: string; registrations: LookupReg[]; certificates: LookupCert[]; organizers: LookupOrg[] }

async function authedPost(url: string): Promise<{ ok: boolean; error?: string }> {
  const u = auth.currentUser
  if (!u) return { ok: false, error: 'Not authenticated' }
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${await u.getIdToken()}` } })
  if (res.ok) return { ok: true }
  const b = await res.json().catch(() => null) as { error?: string } | null
  return { ok: false, error: b?.error ?? `Failed (${res.status})` }
}

function SupportLookup() {
  const [q, setQ]           = useState('')
  const [loading, setLoad]  = useState(false)
  const [err, setErr]       = useState<string | null>(null)
  const [res, setRes]       = useState<LookupResponse | null>(null)
  const [busy, setBusy]     = useState<string | null>(null)
  const [note, setNote]     = useState<string | null>(null)

  async function run() {
    const query = q.trim()
    if (!query) return
    setLoad(true); setErr(null); setRes(null); setNote(null)
    try { setRes(await authedGet<LookupResponse>(`/api/admin/lookup?q=${encodeURIComponent(query)}`)) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Lookup failed') }
    finally { setLoad(false) }
  }
  async function resend(url: string, id: string, label: string) {
    setBusy(id); setNote(null)
    const r = await authedPost(url)
    setNote(r.ok ? `${label} resent.` : `Resend failed: ${r.error}`)
    setBusy(null)
  }

  const empty = res != null && res.registrations.length === 0 && res.certificates.length === 0 && res.organizers.length === 0

  return (
    <Card title="Cross-entity lookup" icon={Search}>
      <div className="space-y-3 p-4">
        <form onSubmit={e => { e.preventDefault(); void run() }} className="flex items-center gap-2">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Registration id · ticket code · attendee email · payment id · certificate id · organizer uid/email"
            className="h-9 flex-1 rounded-lg border border-border bg-card px-3 text-[13.5px] text-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25" />
          <button type="submit" disabled={loading || !q.trim()} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-60">
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />} Look up
          </button>
        </form>
        {err && <ErrorBanner>{err}</ErrorBanner>}
        {note && <p className="text-[12.5px] text-muted-foreground">{note}</p>}
        {loading ? <Spin /> : empty ? <Empty>No matching registration, certificate, or organizer.</Empty> : res && (
          <div className="space-y-3">
            {res.registrations.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Registrations</p>
                <div className="space-y-1.5">
                  {res.registrations.map(r => (
                    <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-foreground">{r.attendeeName || r.attendeeEmail || r.id}</div>
                        <div className="truncate text-[11.5px] text-muted-foreground">{r.eventName} · {r.ticketCode || r.id} · {r.attendeeEmail}</div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <StatusPill tone={r.status === 'confirmed' ? 'success' : r.status === 'cancelled' || r.status === 'rejected' ? 'danger' : 'warning'}>{r.status}</StatusPill>
                        <StatusPill tone={r.paymentStatus === 'paid' ? 'success' : r.paymentStatus === 'refunded' ? 'danger' : 'neutral'}>{r.paymentStatus}</StatusPill>
                        <button type="button" disabled={busy === r.id} onClick={() => void resend(`/api/admin/registrations/${r.id}/resend-email`, r.id, 'Ticket email')}
                          className="rounded-md border border-border px-2 py-1 text-[12px] font-medium text-foreground hover:bg-muted disabled:opacity-50">{busy === r.id ? '…' : 'Resend ticket'}</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {res.certificates.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Certificates</p>
                {res.certificates.map(c => (
                  <div key={c.certificateId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                    <div className="min-w-0"><div className="truncate text-[13px] font-medium text-foreground">{c.attendeeName} · {c.certificateType}</div><div className="truncate text-[11.5px] text-muted-foreground">{c.certificateId}</div></div>
                    <div className="flex items-center gap-1.5">
                      <StatusPill tone={c.status === 'revoked' ? 'danger' : 'success'}>{c.status}</StatusPill>
                      <button type="button" disabled={busy === c.certificateId || c.status === 'revoked'} onClick={() => void resend(`/api/admin/certificates/${c.certificateId}/resend-email`, c.certificateId, 'Certificate email')}
                        className="rounded-md border border-border px-2 py-1 text-[12px] font-medium text-foreground hover:bg-muted disabled:opacity-50">{busy === c.certificateId ? '…' : 'Resend certificate'}</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {res.organizers.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Organizers</p>
                {res.organizers.map(o => (
                  <Link key={o.uid} href={`/admin/organizers/${o.uid}`} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 hover:bg-muted">
                    <div className="min-w-0"><div className="truncate text-[13px] font-medium text-foreground">{o.name || o.organizationName || o.email}</div><div className="truncate text-[11.5px] text-muted-foreground">{o.email} · {o.uid}</div></div>
                    <StatusPill tone={o.accountStatus === 'active' ? 'success' : o.accountStatus === 'suspended' ? 'warning' : 'danger'}>{o.accountStatus}</StatusPill>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
