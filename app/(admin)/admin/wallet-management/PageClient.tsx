'use client'

// RD-WALLET-W2.e · Super Admin Wallet Management — READ-ONLY console.
//
// Every figure comes from GET /api/admin/wallet-management (requireSuperAdmin). Nothing on this
// page writes, credits, debits, refunds or resolves anything. (RD-WALLET-REQ — the one exception
// is ServiceRequestsQueue, a separate component with its own Super Admin API: decisions on
// organizer refund / carry-forward requests for unused event service units.) Data the product does not record
// is shown as unavailable (the API's `unavailable` notes), and reconciliation results keep their
// confidence: "inconclusive" means the evidence is incomplete — never a loss.

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { auth } from '@/lib/firebase/auth'
import {
  Loader2, ArrowLeft, ExternalLink, WalletCards, Coins, CalendarDays, ShieldAlert, Info, RotateCw,
} from 'lucide-react'
import {
  AdminToolbar, StatusPill, TableFrame, THead, Th, TBody, Tr, Td, TableStateRow,
  FilterTabs, LoadMoreButton, ErrorBanner, SearchInput,
} from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { Card } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type {
  WalletOverview, OrganizerWalletRow, EventServiceRow, WalletTxnRow, GatewayPageReport,
} from '@/lib/admin/walletManagementService'
import {
  GATEWAY_START, gatewayRequestParams, mergeGatewayProgress, gatewayProgressText,
  type GatewayPosition, type GatewayProgress,
} from './gatewayProgress'
import ServiceRequestsQueue from './ServiceRequestsQueue'

// ─── API ──────────────────────────────────────────────────────────────────────
type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; superAdminRequired: boolean }

async function api<T>(params: Record<string, string | null | undefined>): Promise<ApiResult<T>> {
  try {
    const u = auth.currentUser
    if (!u) return { ok: false, status: 401, error: 'Not signed in.', superAdminRequired: false }
    const token = await u.getIdToken()
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v)
    const res = await fetch(`/api/admin/wallet-management?${qs.toString()}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
    const body = await res.json().catch(() => null) as (T & { error?: string; code?: string }) | null
    if (!res.ok || !body) {
      return {
        ok: false, status: res.status,
        error: typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`,
        superAdminRequired: body?.code === 'SUPER_ADMIN_REQUIRED',
      }
    }
    return { ok: true, data: body }
  } catch {
    return { ok: false, status: 0, error: 'Network error — please try again.', superAdminRequired: false }
  }
}

// ─── formatting ───────────────────────────────────────────────────────────────
const rupees = (paise: number | null | undefined) =>
  typeof paise === 'number' ? `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'
const num = (n: number | null | undefined) => (typeof n === 'number' ? n.toLocaleString('en-IN') : '—')
const when = (isoStr: string | null | undefined) =>
  isoStr ? new Date(isoStr).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

const CONFIDENCE_TONE: Record<string, PillTone> = { confirmed: 'danger', probable: 'warning', inconclusive: 'neutral' }
const SIGN_TONE: Record<string, PillTone> = { credit: 'success', debit: 'info', ambiguous: 'warning', unknown: 'neutral' }
const STATUS_TONE: Record<string, PillTone> = {
  credited: 'success', pending: 'warning', needs_review: 'danger', exhausted: 'danger', abandoned: 'neutral',
  duplicate_payment: 'danger', resolved: 'success', skipped: 'neutral', failed: 'danger',
  requested: 'warning', approved: 'info', settling: 'info', settled: 'success', rejected: 'neutral', cancelled: 'neutral',
  completed: 'success',
}
const Pill = ({ value, map = STATUS_TONE }: { value: string | null | undefined; map?: Record<string, PillTone> }) =>
  value ? <StatusPill tone={map[value] ?? 'neutral'}>{value.replace(/_/g, ' ')}</StatusPill> : <span className="text-muted-foreground">—</span>

function Stat({ label, value, hint, icon: Icon }: { label: string; value: string; hint?: string; icon?: typeof Coins }) {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-fs-2xs uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="size-3.5" aria-hidden />}
        {label}
      </p>
      {/* size first, then line-height — tailwind-merge drops a leading-* placed before a text-fs-* */}
      <p className="mt-1 text-fs-xl font-semibold tabular-nums leading-none text-foreground">{value}</p>
      {hint && <p className="mt-1 text-fs-2xs text-muted-foreground">{hint}</p>}
    </Card>
  )
}

/** A section's load failure, with the one action that helps: try again. Never shown as zero / empty data. */
function RetryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <ErrorBanner className="flex flex-wrap items-center justify-between gap-2">
      <span>{message}</span>
      <button type="button" onClick={onRetry}
        className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-card px-2.5 py-1 text-[12.5px] font-medium text-destructive hover:bg-destructive/10">
        <RotateCw className="size-3.5" aria-hidden /> Retry
      </button>
    </ErrorBanner>
  )
}

function Note({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'warning' }) {
  return (
    <div className={cn('flex items-start gap-2 rounded-xl border px-4 py-3 text-[13px]',
      tone === 'warning' ? 'border-warning/30 bg-warning/[0.04] text-foreground' : 'border-border bg-muted/40 text-muted-foreground')}>
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  )
}

// ─── tabs ─────────────────────────────────────────────────────────────────────
type Tab = 'overview' | 'organizers' | 'events' | 'transactions' | 'refunds' | 'carry_forward' | 'reconciliation'
const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: 'overview',       label: 'Overview' },
  { value: 'organizers',     label: 'Organizer wallets' },
  { value: 'events',         label: 'Event services' },
  { value: 'transactions',   label: 'Transactions' },
  { value: 'refunds',        label: 'Refund requests' },
  { value: 'carry_forward',  label: 'Carry-forward' },
  { value: 'reconciliation', label: 'Reconciliation' },
]

export default function WalletManagementPage() {
  return <Suspense fallback={null}><WalletManagementInner /></Suspense>
}

const isTab = (v: string | null): v is Tab => !!v && TABS.some(t => t.value === v)
const SAFE_ID = /^[A-Za-z0-9_.:@-]{1,128}$/

function WalletManagementInner() {
  // RD-CLOSE — the URL is the state: ?tab=, ?organizer= (drill-down), ?event= (one event,
  // draft id or slug), ?txnOrganizer=. Deep links from Event 360 / Organizer 360 and the
  // service-purchase notification land on the exact view, and refresh / back / forward keep it.
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const tab: Tab = isTab(searchParams.get('tab')) ? searchParams.get('tab') as Tab : 'overview'
  const organizerUid = SAFE_ID.test(searchParams.get('organizer') ?? '') ? searchParams.get('organizer') : null
  const eventRef = SAFE_ID.test(searchParams.get('event') ?? '') ? searchParams.get('event') : null
  const txnOrganizer = SAFE_ID.test(searchParams.get('txnOrganizer') ?? '') ? searchParams.get('txnOrganizer')! : ''
  const go = useCallback((next: Record<string, string | null>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v)
    const qs = p.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [router, pathname])
  const setTab = (t: Tab) => go({ tab: t === 'overview' ? null : t })
  const setOrganizerUid = (uid: string | null) => go({ tab: 'organizers', organizer: uid })
  const setTxnOrganizer = (uid: string) => go({ tab: 'transactions', txnOrganizer: uid || null })
  const openEvent = (ref: string) => go({ tab: 'events', event: ref })
  const [overview, setOverview] = useState<WalletOverview | null>(null)
  const [denied, setDenied] = useState<string | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [overviewAttempt, setOverviewAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    void api<WalletOverview>({ view: 'overview' }).then(r => {
      if (!alive) return
      if (r.ok) { setOverview(r.data); setOverviewError(null) }
      else if (r.status === 403) setDenied(r.superAdminRequired ? 'Wallet Management is available to Super Admins only.' : 'You do not have access to this page.')
      else setOverviewError(r.error)
    })
    return () => { alive = false }
  }, [overviewAttempt])
  const retryOverview = () => { setOverviewError(null); setOverviewAttempt(a => a + 1) }

  const openOrganizer = (uid: string) => setOrganizerUid(uid)
  const openTransactions = (uid: string) => setTxnOrganizer(uid)

  return (
    <div className="space-y-5">
      <AdminToolbar
        title="Wallet Management"
        icon={WalletCards}
        description="Communication wallets, media credits, event services, refunds and reconciliation. Only refund and carry-forward request decisions change anything."
      />

      {denied ? (
        <Card className="flex items-center gap-3 p-6 text-[14px] text-foreground">
          <ShieldAlert className="size-5 text-destructive" aria-hidden />
          {denied}
        </Card>
      ) : (
        <>
          <div className="overflow-x-auto">
            <FilterTabs options={TABS} value={tab} onChange={t => setTab(t)} aria-label="Wallet management sections" className="w-fit" />
          </div>
          {overviewError && tab === 'overview' && <RetryError message={overviewError} onRetry={retryOverview} />}
          {tab === 'overview' && !(overviewError && !overview) && <OverviewSection data={overview} />}
          {tab === 'organizers' && (organizerUid
            ? <OrganizerDetail uid={organizerUid} onBack={() => setOrganizerUid(null)} onTransactions={openTransactions} onOpenEvent={openEvent} />
            : <OrganizersSection onOpen={openOrganizer} />)}
          {tab === 'events' && (eventRef
            ? <EventDetail eventRef={eventRef} onBack={() => go({ tab: 'events' })} onOpenOrganizer={openOrganizer} onTransactions={openTransactions} />
            : <EventsSection onOpenOrganizer={openOrganizer} onOpenEvent={openEvent} unavailable={overview?.unavailable} />)}
          {tab === 'transactions' && <TransactionsSection organizer={txnOrganizer} setOrganizer={setTxnOrganizer} onOpenOrganizer={openOrganizer} />}
          {tab === 'refunds' && (
            <div className="space-y-6">
              <ServiceRequestsQueue kind="refund" />
              <RefundsSection onOpenOrganizer={openOrganizer} unavailable={overview?.unavailable} />
            </div>
          )}
          {tab === 'carry_forward' && (
            <div className="space-y-3">
              <ServiceRequestsQueue kind="carry_forward" />
              <Note>{overview?.unavailable.carryForward ?? 'Communication-wallet balances and media credits are never carried forward.'}</Note>
            </div>
          )}
          {tab === 'reconciliation' && <ReconciliationTab onOpenOrganizer={openOrganizer} />}
        </>
      )}
    </div>
  )
}

// ─── Overview ─────────────────────────────────────────────────────────────────
function OverviewSection({ data }: { data: WalletOverview | null }) {
  if (!data) return <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  const c = data.communication, m = data.media
  const openRefunds = Object.values(m.openRefunds)
  return (
    <div className="space-y-5">
      {data.failed.length > 0 && (
        <Note tone="warning">
          <p className="font-medium text-foreground">Some figures could not be loaded</p>
          <p className="mt-0.5">Shown as “—”, never as zero: {data.failed.join(', ')}. The other figures are current.</p>
        </Note>
      )}
      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Communication wallet</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat icon={WalletCards} label="Wallets" value={num(c.wallets)} />
          <Stat label="Stored balances" value={rupees(c.storedBalancePaise)} hint="Sum of stored values — verify in Reconciliation" />
          <Stat label="Top-ups credited" value={num(c.topupsByStatus.credited)} />
          <Stat label="Top-ups pending" value={num(c.topupsByStatus.pending)} hint={`${num(c.topupsByStatus.needs_review)} held · ${num(c.topupsByStatus.abandoned)} abandoned`} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          Open reconciliation:
          {Object.entries(c.openReconciliation).map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1"><Pill value={k} /> <span className="tabular-nums text-foreground">{num(v)}</span></span>
          ))}
        </div>
      </section>
      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Media credits &amp; event services</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat icon={Coins} label="Media wallets" value={num(m.wallets)} />
          <Stat label="Credits owned" value={num(m.balanceCredits)} hint={`${num(m.heldCredits)} held by upload sessions`} />
          <Stat label="Open media refunds" value={openRefunds.some(v => v === null) ? '—' : num(openRefunds.reduce<number>((a, b) => a + (b ?? 0), 0))}
            hint={Object.entries(m.openRefunds).map(([k, v]) => `${num(v)} ${k}`).join(' · ')} />
          <Stat icon={CalendarDays} label="Event service ledgers" value={num(data.allowances.eventLedgers)} />
        </div>
      </section>
      <Note>
        <p className="font-medium text-foreground">Not recorded by RegisterDesk</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {Object.values(data.unavailable).map(t => <li key={t}>{t}</li>)}
        </ul>
      </Note>
      <p className="text-fs-2xs text-muted-foreground">Generated {when(data.generatedAt)}</p>
    </div>
  )
}

// ─── Organizer wallets ────────────────────────────────────────────────────────
function OrganizersSection({ onOpen }: { onOpen: (uid: string) => void }) {
  const [rows, setRows] = useState<OrganizerWalletRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (after: string | null) => {
    if (after) setMore(true); else setLoading(true)
    setError(null)
    const r = await api<{ rows: OrganizerWalletRow[]; nextCursor: string | null }>({ view: 'organizers', cursor: after, search: applied })
    if (r.ok) { setRows(prev => (after ? [...prev, ...r.data.rows] : r.data.rows)); setCursor(r.data.nextCursor) }
    else setError(r.error)
    setLoading(false); setMore(false)
  }, [applied])
  useEffect(() => { const t = setTimeout(() => { void load(null) }, 0); return () => clearTimeout(t) }, [load])

  return (
    <div className="space-y-3">
      <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); setApplied(search.trim()) }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Exact organizer uid or email" className="w-full sm:w-80" />
        {applied && <button type="button" className="text-[13px] text-primary hover:underline" onClick={() => { setSearch(''); setApplied('') }}>Clear</button>}
      </form>
      {error && <RetryError message={error} onRetry={() => void load(null)} />}
      <TableFrame minWidth="min-w-[760px]">
        <THead><Th>Organizer</Th><Th align="right">Communication balance</Th><Th align="right">Media credits</Th><Th>Wallet updated</Th><Th>{''}</Th></THead>
        <TBody>
          {loading ? <TableStateRow colSpan={5}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
            : rows.length === 0 && error ? <TableStateRow colSpan={5}>Could not load organizer wallets — retry above.</TableStateRow>
            : rows.length === 0 ? <TableStateRow colSpan={5}>{applied ? 'No organizer matches that uid or email.' : 'No communication or media-credit wallets yet.'}</TableStateRow>
            : rows.map(r => (
              <Tr key={r.uid}>
                <Td><div className="font-medium text-foreground">{r.name ?? 'Unnamed organizer'}</div><div className="font-mono text-[11.5px] text-muted-foreground">{r.uid}</div></Td>
                <Td align="right" className="tabular-nums">
                  {!r.communication.exists ? <span className="text-muted-foreground">No wallet</span>
                    : !r.communication.balanceValid ? <StatusPill tone="warning">unreadable</StatusPill>
                    : rupees(r.communication.balancePaise)}
                </Td>
                <Td align="right" className="tabular-nums">
                  {r.media.exists ? <>{num(r.media.balance)}{(r.media.heldCredits ?? 0) + (r.media.refundHeldCredits ?? 0) > 0 && <span className="text-muted-foreground"> · {num((r.media.heldCredits ?? 0) + (r.media.refundHeldCredits ?? 0))} held</span>}</> : <span className="text-muted-foreground">—</span>}
                </Td>
                <Td className="whitespace-nowrap text-muted-foreground">{when(r.communication.updatedAt)}</Td>
                <Td align="right"><button type="button" className="text-[13px] font-medium text-primary hover:underline" onClick={() => onOpen(r.uid)}>Details</button></Td>
              </Tr>
            ))}
        </TBody>
      </TableFrame>
      {cursor && !loading && <LoadMoreButton onClick={() => load(cursor)} loading={more} />}
    </div>
  )
}

// ─── Organizer detail ─────────────────────────────────────────────────────────
interface OrganizerDetailData {
  organizer: OrganizerWalletRow
  walletCheck: { verdict: string; finding: { code: string; confidence: string; detail?: Record<string, unknown> } | null }
  topups: Array<{ orderId: string; amountPaise: number | null; status: string | null; paymentId: string | null; createdAt: string | null }>
  topupsTruncated: boolean
  reconciliationRecords: Array<{ id: string; orderId: string | null; status: string | null; reason: string | null; paymentIds: string[]; attempts: number | null; lastError: string | null; firstSeenAt: string | null }>
  reconciliationTruncated: boolean
  events: EventServiceRow[]
  eventsTruncated: boolean
  media: {
    wallet: { balance: number | null; heldCredits: number | null; refundHeldCredits: number | null; lifetimeGranted: number | null; lifetimeConsumed: number | null } | null
    ledger: Array<{ entryId: string; delta: number; reason: string; balanceAfter: number; eventSlug: string | null; createdAt: string | null }>
    refunds: RefundRow[]
  }
}

function OrganizerDetail({ uid, onBack, onTransactions, onOpenEvent }: { uid: string; onBack: () => void; onTransactions: (uid: string) => void; onOpenEvent: (ref: string) => void }) {
  const [data, setData] = useState<OrganizerDetailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    void api<OrganizerDetailData>({ view: 'organizer', uid }).then(r => { if (alive) { if (r.ok) { setData(r.data); setError(null) } else setError(r.error) } })
    return () => { alive = false }
  }, [uid, attempt])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> All wallets</button>
        <div className="flex items-center gap-3 text-[13px]">
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => onTransactions(uid)}>Wallet transactions</button>
          <Link href={`/admin/organizers/${encodeURIComponent(uid)}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">Organizer 360 <ExternalLink className="size-3.5" /></Link>
        </div>
      </div>
      {error && <RetryError message={error} onRetry={() => { setError(null); setAttempt(a => a + 1) }} />}
      {!data && !error && <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}
      {data && (
        <>
          <Card className="p-4">
            <p className="text-[16px] font-semibold text-foreground">{data.organizer.name ?? 'Unnamed organizer'}</p>
            <p className="font-mono text-[12px] text-muted-foreground">{uid}</p>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Communication balance" value={data.organizer.communication.exists ? (data.organizer.communication.balanceValid ? rupees(data.organizer.communication.balancePaise) : 'Unreadable') : 'No wallet'} />
              <Stat label="Media credits" value={data.media.wallet ? num(data.media.wallet.balance) : 'No wallet'} hint={data.media.wallet ? `${num(data.media.wallet.heldCredits)} session · ${num(data.media.wallet.refundHeldCredits)} refund held` : undefined} />
              <Stat label="Ledger check" value={data.walletCheck.verdict} hint={data.walletCheck.finding ? String(data.walletCheck.finding.detail?.reason ?? data.walletCheck.finding.code).replace(/_/g, ' ') : 'Balance matches an unbroken ledger history'} />
              <Stat label="Events with services" value={num(data.events.length)} />
            </div>
            {data.walletCheck.verdict === 'inconclusive' && (
              <p className="mt-3 text-[12.5px] text-muted-foreground">Inconclusive means the ledger cannot prove the full history (for example older balance changes made before ledger rows existed). It is not a loss.</p>
            )}
            {data.walletCheck.verdict === 'mismatch' && (
              <p className="mt-3 text-[12.5px] text-destructive">The stored balance differs from a complete, unbroken ledger history by {rupees(Number(data.walletCheck.finding?.detail?.deltaPaise ?? 0))}.</p>
            )}
          </Card>

          <DetailTable title="Top-up orders" truncated={data.topupsTruncated} empty="No top-up orders."
            head={['Created', 'Order', 'Amount', 'Status', 'Payment']}
            rows={data.topups.map(t => [when(t.createdAt), <span key="o" className="font-mono text-[12px]">{t.orderId}</span>, rupees(t.amountPaise), <Pill key="s" value={t.status} />, <span key="p" className="font-mono text-[12px]">{t.paymentId ?? '—'}</span>])} />

          <DetailTable title="Top-up reconciliation records" truncated={data.reconciliationTruncated} empty="No reconciliation records."
            head={['Record', 'Status', 'Reason / last error', 'Payments', 'Attempts']}
            rows={data.reconciliationRecords.map(r => [<span key="i" className="font-mono text-[12px]">{r.id}</span>, <Pill key="s" value={r.status} />, <span key="e" className="text-muted-foreground">{r.reason ?? r.lastError ?? '—'}</span>, <span key="p" className="font-mono text-[11.5px]">{r.paymentIds.join(', ') || '—'}</span>, num(r.attempts)])} />

          <EventsTable rows={data.events} truncated={data.eventsTruncated} onOpenEvent={onOpenEvent} />

          <DetailTable title="Media credit ledger (latest 10)" empty="No media credit activity."
            head={['When', 'Reason', 'Change', 'Balance after', 'Event']}
            rows={data.media.ledger.map(e => [when(e.createdAt), e.reason.replace(/_/g, ' '), <span key="d" className={cn('tabular-nums', e.delta < 0 ? 'text-foreground' : 'text-emerald-700')}>{e.delta > 0 ? `+${e.delta}` : e.delta}</span>, num(e.balanceAfter), e.eventSlug ?? '—'])} />

          <DetailTable title="Media credit refund requests (latest 10)" empty="No refund requests."
            head={['Requested', 'Credits', 'Purchase amount', 'Status', 'Reason']}
            rows={data.media.refunds.map(r => [when(r.createdAt), num(r.credits), rupees(r.purchaseAmountPaise), <Pill key="s" value={r.status} />, <span key="r" className="text-muted-foreground">{r.reason ?? '—'}</span>])} />
        </>
      )}
    </div>
  )
}

/** W2.e.1 — an empty section is one compact line (an empty wide table wastes space and, on a phone, clips its own message). */
function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border px-4 py-3 text-[13px] text-muted-foreground">{children}</p>
}

function DetailTable({ title, head, rows, empty, truncated }: { title: string; head: string[]; rows: React.ReactNode[][]; empty: string; truncated?: boolean }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
      {rows.length === 0 ? <EmptyLine>{empty}</EmptyLine> : (
        <TableFrame minWidth="min-w-[680px]">
          <THead>{head.map(h => <Th key={h}>{h}</Th>)}</THead>
          <TBody>
            {rows.map((cells, i) => <Tr key={i}>{cells.map((c, j) => <Td key={j}>{c}</Td>)}</Tr>)}
          </TBody>
        </TableFrame>
      )}
      {truncated && <p className="text-fs-2xs text-muted-foreground">Showing the first records only — the list was capped.</p>}
    </section>
  )
}

// ─── Event services ───────────────────────────────────────────────────────────
function serviceCell(s: EventServiceRow['services'][keyof EventServiceRow['services']], showUse = true) {
  if (s.purchased === 0 && (s.consumed ?? 0) === 0 && s.carriedIn === 0) return <span className="text-muted-foreground">—</span>
  // purchased + carried in = used + left + carried out + refunded (the ledger invariant), so every unit is accounted for.
  const moved = [s.carriedIn ? `+${num(s.carriedIn)} in` : null, s.carriedOut ? `${num(s.carriedOut)} carried out` : null, s.refunded ? `${num(s.refunded)} refunded` : null].filter(Boolean)
  return (
    <span className="tabular-nums">
      {num(s.purchased)}
      {showUse && s.remaining !== null && <span className="text-muted-foreground"> · {num(s.consumed)} used · {num(s.remaining)} left</span>}
      {moved.length > 0 && <span className="block text-[11.5px] text-muted-foreground">{moved.join(' · ')}</span>}
    </span>
  )
}

/** RD-INTEG — the organizer Wallet's own figures (stateOf), so both screens agree. */
function figureCell(f: NonNullable<EventServiceRow['figures']>[keyof NonNullable<EventServiceRow['figures']>] | undefined) {
  if (!f) return null
  if (f.purchased === 0 && f.carriedIn === 0 && (f.used ?? 0) === 0) return <span className="text-muted-foreground">—</span>
  const moved = [f.carriedIn ? `+${num(f.carriedIn)} in` : null, f.carriedOut ? `${num(f.carriedOut)} carried out` : null, f.refunded ? `${num(f.refunded)} refunded` : null].filter(Boolean)
  return (
    <span className="tabular-nums">
      {num(f.purchased)}
      <span className="text-muted-foreground"> · {f.used === null ? 'use unknown' : `${num(f.used)} used`} · {f.remaining === null ? '— left' : `${num(f.remaining)} left`}</span>
      <span className="block text-[11.5px] text-muted-foreground">Refundable {num(f.refundableUnits)} · paid ₹{(f.paidPaise / 100).toFixed(2)}</span>
      {moved.length > 0 && <span className="block text-[11.5px] text-muted-foreground">{moved.join(' · ')}</span>}
      {f.problem && <span className="block text-[11.5px] text-destructive">{f.problem}</span>}
    </span>
  )
}

function EventsTable({ rows, truncated, onOpenOrganizer, onOpenEvent }: { rows: EventServiceRow[]; truncated?: boolean; onOpenOrganizer?: (uid: string) => void; onOpenEvent?: (ref: string) => void }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-semibold text-foreground">Events &amp; services</h3>
      {rows.length === 0 ? <EmptyLine>No events with licences or service allowances.</EmptyLine> : (
      <TableFrame minWidth="min-w-[980px]">
        <THead><Th>Event</Th><Th>Licence</Th><Th align="right">Registrations / capacity</Th><Th>WhatsApp</Th><Th>Certificates</Th><Th>Media (photos)</Th><Th>SMS</Th></THead>
        <TBody>
          {rows.map(e => (
              <Tr key={e.draftId}>
                <Td>
                  {e.slug
                    ? <Link href={`/admin/events/${encodeURIComponent(e.slug)}`} className="font-medium text-primary hover:underline">{e.name ?? e.slug}</Link>
                    : <span className="text-muted-foreground">Not published</span>}
                  <div className="font-mono text-[11px] text-muted-foreground">{e.draftId}</div>
                  <div className="flex flex-wrap gap-x-3">
                    {onOpenEvent && <button type="button" className="text-[11.5px] font-semibold text-primary hover:underline" onClick={() => onOpenEvent(e.slug ?? e.draftId)}>Event details</button>}
                    {onOpenOrganizer && e.organizerUid && <button type="button" className="text-[11.5px] text-primary hover:underline" onClick={() => onOpenOrganizer(e.organizerUid!)}>Organizer wallet</button>}
                  </div>
                  {e.lifecycle && <div className="mt-0.5"><Pill value={e.lifecycle} /></div>}
                  {!e.ledgerExists && <div className="text-[11px] text-muted-foreground">No prepaid service ledger — not applicable</div>}
                </Td>
                <Td>{e.license.exists ? <><span className="capitalize">{e.license.tier ?? '—'}</span> <Pill value={e.license.status} /></> : <span className="text-muted-foreground">No licence</span>}</Td>
                <Td align="right" className="tabular-nums">
                  {num(e.registrations)} /{' '}
                  {!e.license.exists ? '—' : e.license.capacityRecorded ? (e.license.capacity === null ? 'uncapped' : num(e.license.capacity)) : <span className="text-muted-foreground" title="Historical tier-priced licence: no capacity field recorded">tier limit</span>}
                  {e.figures && e.figures.registrations.purchased > 0 && (
                    <span className="block text-[11.5px] text-muted-foreground">
                      {num(e.figures.registrations.purchased)} paid · refundable {num(e.figures.registrations.refundableUnits)} · paid ₹{(e.figures.registrations.paidPaise / 100).toFixed(2)}
                    </span>
                  )}
                </Td>
                <Td>{e.figures ? figureCell(e.figures.whatsapp) : serviceCell(e.services.whatsapp)}</Td>
                <Td>{e.figures ? figureCell(e.figures.certificates) : serviceCell(e.services.certificates)}</Td>
                <Td>{e.figures ? figureCell(e.figures.media) : serviceCell(e.services.media, false)}</Td>
                <Td><span className="text-muted-foreground" title="SMS is not available: there is no SMS provider, so nothing is sent or charged">Not available</span></Td>
              </Tr>
            ))}
        </TBody>
      </TableFrame>
      )}
      {truncated && <p className="text-fs-2xs text-muted-foreground">Showing the first events only — the list was capped.</p>}
      <p className="text-fs-2xs text-muted-foreground">Purchased · used · left — the same figures the organizer&apos;s event Wallet shows. Media use is the event&apos;s stored photos above its base cap. Refundable = unused units of the event&apos;s own purchase.</p>
    </section>
  )
}

function EventsSection({ onOpenOrganizer, onOpenEvent, unavailable }: { onOpenOrganizer: (uid: string) => void; onOpenEvent: (ref: string) => void; unavailable?: WalletOverview['unavailable'] }) {
  const [source, setSource] = useState<'events' | 'ledgers'>('events')
  const [rows, setRows] = useState<EventServiceRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [org, setOrg] = useState('')
  const [applied, setApplied] = useState('')
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async (after: string | null) => {
    if (after) setMore(true); else setLoading(true)
    setError(null)
    const r = await api<{ rows: EventServiceRow[]; nextCursor: string | null }>({ view: 'events', cursor: after, organizerUid: applied, source: source === 'ledgers' ? 'ledgers' : null })
    if (r.ok) { setRows(prev => (after ? [...prev, ...r.data.rows] : r.data.rows)); setCursor(r.data.nextCursor) }
    else setError(r.error)
    setLoading(false); setMore(false)
  }, [applied, source])
  useEffect(() => { const t = setTimeout(() => { void load(null) }, 0); return () => clearTimeout(t) }, [load])
  return (
    <div className="space-y-3">
      <FilterTabs options={[{ value: 'events', label: 'Live events (incl. capacity-only)' }, { value: 'ledgers', label: 'Prepaid service ledgers' }]} value={source} onChange={v => setSource(v as 'events' | 'ledgers')} aria-label="Event list source" className="w-fit" />
      <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); setApplied(org.trim()) }}>
        <SearchInput value={org} onChange={setOrg} placeholder="Filter by exact organizer uid" className="w-full sm:w-80" />
        {applied && <button type="button" className="text-[13px] text-primary hover:underline" onClick={() => { setOrg(''); setApplied('') }}>Clear</button>}
      </form>
      {unavailable && <Note>{unavailable.smsAllowance}</Note>}
      {error && <RetryError message={error} onRetry={() => void load(null)} />}
      {loading ? <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        : error && rows.length === 0 ? null
        : <EventsTable rows={rows} onOpenOrganizer={onOpenOrganizer} onOpenEvent={onOpenEvent} />}
      {cursor && !loading && <LoadMoreButton onClick={() => load(cursor)} loading={more} />}
    </div>
  )
}

// ─── RD-CLOSE · one event, end to end ──────────────────────────────────────────
type EventDetailData = {
  event: EventServiceRow; draftId: string; slug: string | null; organizerUid: string; closedAt: string | null
  serviceLedger: 'present' | 'not_applicable'
  orders: { orderId: string; purpose: string | null; status: string | null; amountPaise: number | null; paidAt: string | null; capacity: number | null; services: string | null }[]
  requests: { id: string; kind: string | null; service: string | null; quantity: number | null; status: string | null; approvedAmountPaise: number | null; externalReference: string | null; sourceDraftId: string | null; destinationDraftId: string | null; createdAt: string | null }[]
  charges: WalletTxnRow[]; chargesTruncated: boolean
  communication: { pending: number | null; sent: number | null; delivered: number | null; failed: number | null; unknown: number | null; whatsappMessages: number | null; whatsappCostPaise: number | null; emailMessages: number | null }
}

function EventDetail({ eventRef, onBack, onOpenOrganizer, onTransactions }: { eventRef: string; onBack: () => void; onOpenOrganizer: (uid: string) => void; onTransactions: (uid: string) => void }) {
  const [data, setData] = useState<EventDetailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    void api<EventDetailData>({ view: 'event', slug: eventRef, draftId: eventRef }).then(r => { if (alive) { if (r.ok) { setData(r.data); setError(null) } else setError(r.status === 404 ? 'Event not found.' : r.error) } })
    return () => { alive = false }
  }, [eventRef, attempt])
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"><ArrowLeft className="size-3.5" aria-hidden />All events</button>
      {error && (error === 'Event not found.' ? <ErrorBanner>{error}</ErrorBanner> : <RetryError message={error} onRetry={() => { setError(null); setAttempt(a => a + 1) }} />)}
      {!data && !error && <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <h2 className="text-[16px] font-semibold text-foreground">{data.event.name ?? data.slug ?? data.draftId}</h2>
            {data.event.lifecycle && <Pill value={data.event.lifecycle} />}
            {data.slug && <Link href={`/admin/events/${encodeURIComponent(data.slug)}`} className="text-[13px] text-primary hover:underline">Event 360</Link>}
            <button type="button" className="text-[13px] text-primary hover:underline" onClick={() => onOpenOrganizer(data.organizerUid)}>Organizer wallet</button>
            <button type="button" className="text-[13px] text-primary hover:underline" onClick={() => onTransactions(data.organizerUid)}>Organizer transactions</button>
          </div>
          <p className="font-mono text-[11.5px] text-muted-foreground">draft {data.draftId}{data.slug ? ` · event ${data.slug}` : ' · not published'}{data.closedAt ? ` · closed ${when(data.closedAt)}` : ''}</p>
          {data.serviceLedger === 'not_applicable' && <Note>This event has no prepaid service ledger (it bought no WhatsApp, certificate or photo units). Its services are pay-as-you-go; only registration capacity applies.</Note>}
          <EventsTable rows={[data.event]} />
          <DetailTable title="Orders (activation, add-on, capacity)" head={['Order', 'Purpose', 'Status', 'Amount', 'Capacity', 'Services', 'Paid']}
            rows={data.orders.map(o => [<span key="o" className="font-mono text-[11.5px]">{o.orderId}</span>, o.purpose ?? '—', <Pill key="s" value={o.status} />, rupees(o.amountPaise), num(o.capacity), o.services ?? '—', when(o.paidAt)])}
            empty="No orders recorded for this event." />
          <DetailTable title="Refund & carry-forward requests" head={['Request', 'Kind', 'Service', 'Units', 'Status', 'Approved', 'Payout reference', 'Direction']}
            rows={data.requests.map(r => [<span key="r" className="font-mono text-[11.5px]">{r.id}</span>, r.kind ?? '—', r.service ?? '—', num(r.quantity), <Pill key="s" value={r.status} />, rupees(r.approvedAmountPaise), r.externalReference ?? '—', r.sourceDraftId === data.draftId ? 'out of this event' : 'into this event'])}
            empty="No refund or carry-forward requests for this event." />
          <DetailTable title="Communication-balance entries recording this event" head={['When', 'Type', 'Amount', 'Description']}
            rows={data.charges.map(t => [when(t.createdAt), <Pill key="t" value={t.type} map={{}} />, <span key="a" className={t.sign === 'credit' ? 'text-emerald-700' : ''}>{t.sign === 'credit' ? '+' : '−'}{rupees(t.amountPaise)}</span>, t.description ?? '—'])}
            empty="No communication-balance entries record this event." truncated={data.chargesTruncated} />
          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold text-foreground">Messages for this event</h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Pending" value={num(data.communication.pending)} />
              <Stat label="Sent / submitted" value={num(data.communication.sent)} hint="Accepted by the provider" />
              <Stat label="Delivered" value={num(data.communication.delivered)} />
              <Stat label="Failed" value={num(data.communication.failed)} hint={data.communication.unknown ? `+${num(data.communication.unknown)} status unknown` : undefined} />
              <Stat label="WhatsApp messages billed" value={num(data.communication.whatsappMessages)} hint={`Charged ${rupees(data.communication.whatsappCostPaise)} to the communication balance`} />
              <Stat label="Broadcast emails" value={num(data.communication.emailMessages)} />
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ─── Transactions ─────────────────────────────────────────────────────────────
const SIGN_FILTERS = [
  { value: '', label: 'All' }, { value: 'credit', label: 'Credits' }, { value: 'debit', label: 'Debits' },
  { value: 'ambiguous', label: 'Ambiguous' }, { value: 'unknown', label: 'Unknown type' },
] as const

function TransactionsSection({ organizer, setOrganizer, onOpenOrganizer }: { organizer: string; setOrganizer: (v: string) => void; onOpenOrganizer: (uid: string) => void }) {
  const [rows, setRows] = useState<WalletTxnRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [sign, setSign] = useState<string>('')
  const [input, setInput] = useState(organizer)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [scanLimited, setScanLimited] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async (after: string | null) => {
    if (after) setMore(true); else setLoading(true)
    setError(null)
    const r = await api<{ rows: WalletTxnRow[]; nextCursor: string | null; scanLimited: boolean }>({ view: 'transactions', cursor: after, organizerUid: organizer, sign })
    if (r.ok) { setRows(prev => (after ? [...prev, ...r.data.rows] : r.data.rows)); setCursor(r.data.nextCursor); setScanLimited(r.data.scanLimited) }
    else setError(r.error)
    setLoading(false); setMore(false)
  }, [organizer, sign])
  useEffect(() => { const t = setTimeout(() => { void load(null) }, 0); return () => clearTimeout(t) }, [load])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={e => { e.preventDefault(); setOrganizer(input.trim()) }}>
          <SearchInput value={input} onChange={setInput} placeholder="Filter by exact organizer uid" className="w-full sm:w-72" />
        </form>
        <FilterTabs options={SIGN_FILTERS} value={sign} onChange={setSign} aria-label="Credit or debit" className="w-fit" />
        {organizer && <button type="button" className="text-[13px] text-primary hover:underline" onClick={() => { setInput(''); setOrganizer('') }}>Clear organizer</button>}
      </div>
      <Note>This is the communication-wallet ledger (top-ups, message and broadcast charges, their refunds). Event service purchases — activation, add-on and capacity orders — and their refund requests are shown per event under Event services → event details.</Note>
      <Note>Credit / debit follows the wallet&apos;s own rule (funds added, licence refunds and refunds are credits). &ldquo;Adjustment&rdquo; rows are shown as ambiguous — their direction is not recorded.</Note>
      {error && <RetryError message={error} onRetry={() => void load(null)} />}
      <TableFrame minWidth="min-w-[980px]">
        <THead><Th>When</Th><Th>Organizer</Th><Th>Type</Th><Th align="right">Amount</Th><Th align="right">Balance after</Th><Th>Reference</Th><Th>Status</Th></THead>
        <TBody>
          {loading ? <TableStateRow colSpan={7}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
            : rows.length === 0 && error ? <TableStateRow colSpan={7}>Could not load transactions — retry above.</TableStateRow>
            : rows.length === 0 ? <TableStateRow colSpan={7}>{cursor ? 'No matching rows in the records searched so far — load more to keep searching.' : 'No transactions.'}</TableStateRow>
            : rows.map(t => (
              <Tr key={t.id}>
                <Td className="whitespace-nowrap text-muted-foreground">{when(t.createdAt)}</Td>
                <Td>{t.organizerUid ? <button type="button" className="font-mono text-[11.5px] text-primary hover:underline" onClick={() => onOpenOrganizer(t.organizerUid!)}>{t.organizerUid}</button> : '—'}</Td>
                <Td><div>{t.type ? t.type.replace(/_/g, ' ') : '—'}</div><Pill value={t.sign} map={SIGN_TONE} /></Td>
                <Td align="right" className="tabular-nums">{t.amountPaise === null ? '—' : `${t.sign === 'credit' ? '+' : t.sign === 'debit' ? '−' : ''}${rupees(t.amountPaise)}`}</Td>
                <Td align="right" className="tabular-nums text-muted-foreground">{rupees(t.balanceAfterPaise)}</Td>
                <Td className="font-mono text-[11.5px] text-muted-foreground">
                  {[t.referenceType, t.orderId ?? t.referenceId].filter(Boolean).join(' · ') || '—'}
                  {t.paymentId && <div>{t.paymentId}</div>}
                </Td>
                <Td><Pill value={t.status} /></Td>
              </Tr>
            ))}
        </TBody>
      </TableFrame>
      {scanLimited && <p className="text-fs-2xs text-muted-foreground">This filter searched a bounded batch of rows; load more to continue.</p>}
      {cursor && !loading && <LoadMoreButton onClick={() => load(cursor)} loading={more} />}
    </div>
  )
}

// ─── Refund requests ──────────────────────────────────────────────────────────
interface RefundRow { refundId: string | null; organizerUid: string | null; purchaseId: string | null; credits: number | null; purchaseAmountPaise: number | null; status: string | null; reason: string | null; decidedBy: string | null; createdAt: string | null }
const REFUND_FILTERS = ['requested', 'approved', 'settling', 'settled', 'rejected', 'cancelled'].map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))

function RefundsSection({ onOpenOrganizer, unavailable }: { onOpenOrganizer: (uid: string) => void; unavailable?: WalletOverview['unavailable'] }) {
  const [status, setStatus] = useState('requested')
  const [rows, setRows] = useState<RefundRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async (after: string | null) => {
    if (after) setMore(true); else setLoading(true)
    setError(null)
    const r = await api<{ rows: RefundRow[]; nextCursor: string | null }>({ view: 'refunds', status, cursor: after })
    if (r.ok) { setRows(prev => (after ? [...prev, ...r.data.rows] : r.data.rows)); setCursor(r.data.nextCursor) }
    else setError(r.error)
    setLoading(false); setMore(false)
  }, [status])
  useEffect(() => { const t = setTimeout(() => { void load(null) }, 0); return () => clearTimeout(t) }, [load])
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <FilterTabs options={REFUND_FILTERS} value={status} onChange={setStatus} aria-label="Refund status" className="w-fit" />
      </div>
      <h2 className="text-[14px] font-semibold text-foreground">Media-credit refund requests (historical)</h2>
      <Note>Historical media-credit refund requests (Media Credits are retired; decided in Media Credits). {unavailable?.communicationRefunds}</Note>
      {error && <RetryError message={error} onRetry={() => void load(null)} />}
      <TableFrame minWidth="min-w-[820px]">
        <THead><Th>Requested</Th><Th>Organizer</Th><Th align="right">Credits</Th><Th align="right">Purchase amount</Th><Th>Status</Th><Th>Reason</Th></THead>
        <TBody>
          {loading ? <TableStateRow colSpan={6}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
            : rows.length === 0 && error ? <TableStateRow colSpan={6}>Could not load media-credit refunds — retry above.</TableStateRow>
            : rows.length === 0 ? <TableStateRow colSpan={6}>No {status} refund requests.</TableStateRow>
            : rows.map(r => (
              <Tr key={r.refundId ?? `${r.organizerUid}-${r.createdAt}`}>
                <Td className="whitespace-nowrap text-muted-foreground">{when(r.createdAt)}</Td>
                <Td>{r.organizerUid ? <button type="button" className="font-mono text-[11.5px] text-primary hover:underline" onClick={() => onOpenOrganizer(r.organizerUid!)}>{r.organizerUid}</button> : '—'}</Td>
                <Td align="right" className="tabular-nums">{num(r.credits)}</Td>
                <Td align="right" className="tabular-nums">{rupees(r.purchaseAmountPaise)}</Td>
                <Td><Pill value={r.status} /></Td>
                <Td className="max-w-[260px] truncate text-muted-foreground" title={r.reason ?? ''}>{r.reason ?? '—'}</Td>
              </Tr>
            ))}
        </TBody>
      </TableFrame>
      {cursor && !loading && <LoadMoreButton onClick={() => load(cursor)} loading={more} />}
    </div>
  )
}

// ─── Reconciliation · two scopes: the communication wallet (W2.d) and event-service refunds (S3) ─────
function ReconciliationTab({ onOpenOrganizer }: { onOpenOrganizer: (uid: string) => void }) {
  const [scope, setScope] = useState<'wallet' | 'service_refunds'>('wallet')
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <FilterTabs options={[{ value: 'wallet', label: 'Communication wallet' }, { value: 'service_refunds', label: 'Service refunds' }]}
          value={scope} onChange={v => setScope(v as 'wallet' | 'service_refunds')} aria-label="Reconciliation area" className="w-fit" />
      </div>
      {scope === 'wallet' ? <ReconciliationSection onOpenOrganizer={onOpenOrganizer} /> : <ServiceRefundRecon onOpenOrganizer={onOpenOrganizer} />}
    </div>
  )
}

interface RefundReconRowUI {
  requestId: string; organizerUid: string; sourceDraftId: string; eventName: string; service: string
  status: 'approved' | 'processed'; approvedQuantity: number; approvedAmountPaise: number | null
  refundedQuantity: number | null; refundedAmountPaise: number | null; outstandingPaise: number | null
  submittedAt: string | null; approvedAt: string | null; processedAt: string | null
  capacity: { before: number; refunded: number; after: number } | null
}
interface RefundReconFindingUI { code: string; confidence: string; organizerUid: string; sourceDraftId: string; service: string; requestId: string | null; detail: Record<string, string | number | boolean | null> }
interface RefundReconPage { rows: RefundReconRowUI[]; findings: RefundReconFindingUI[]; scanned: number; groupsChecked: number; nextCursor: string | null; complete: boolean }

/** Refund-history S3 — read-only: approved / recorded refunds against the ledger; nothing here changes anything. */
function ServiceRefundRecon({ onOpenOrganizer }: { onOpenOrganizer: (uid: string) => void }) {
  const [rows, setRows] = useState<RefundReconRowUI[]>([])
  const [findings, setFindings] = useState<RefundReconFindingUI[]>([])
  const [meta, setMeta] = useState<{ scanned: number; groups: number; complete: boolean } | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [onlyOutstanding, setOnlyOutstanding] = useState(true)
  const load = useCallback(async (after: string | null) => {
    if (after) setMore(true); else setLoading(true)
    setError(null)
    const r = await api<RefundReconPage>({ view: 'reconciliation', kind: 'service_refunds', cursor: after })
    if (r.ok) {
      setRows(prev => (after ? [...prev, ...r.data.rows] : r.data.rows))
      setFindings(prev => (after ? [...prev, ...r.data.findings] : r.data.findings))
      setCursor(r.data.nextCursor)
      setMeta(prev => ({ scanned: (after ? prev?.scanned ?? 0 : 0) + r.data.scanned, groups: (after ? prev?.groups ?? 0 : 0) + r.data.groupsChecked, complete: r.data.complete }))
    } else setError(r.error)
    setLoading(false); setMore(false)
  }, [])
  useEffect(() => { const t = setTimeout(() => { void load(null) }, 0); return () => clearTimeout(t) }, [load])
  const shown = onlyOutstanding ? rows.filter(r => r.outstandingPaise === null || r.outstandingPaise > 0) : rows
  return (
    <div className="space-y-3">
      <Note tone="warning">
        Report-only. Approved refunds are compared with the money recorded as refunded and with each event&apos;s service ledger.
        Approval is <strong>not</strong> a refund: “outstanding” is approved money not yet recorded as paid. Nothing here moves money or changes a ledger.
      </Note>
      {error && <RetryError message={error} onRetry={() => void load(null)} />}
      {meta && <p className="text-[12.5px] text-muted-foreground">{num(meta.scanned)} approved / refunded requests checked · {num(meta.groups)} event services compared with their ledger · {meta.complete ? 'scan complete' : 'more to scan — load more'}</p>}

      <h3 className="text-[13px] font-semibold text-foreground">Findings</h3>
      <TableFrame minWidth="min-w-[760px]">
        <THead><Th>Event · service</Th><Th>Finding</Th><Th>Confidence</Th><Th>Detail</Th></THead>
        <TBody>
          {loading ? <TableStateRow colSpan={4}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
            : error && findings.length === 0 ? <TableStateRow colSpan={4}>Could not run the refund reconciliation — retry above.</TableStateRow>
            : findings.length === 0 ? <TableStateRow colSpan={4}>No findings for the requests checked: refunded units match every ledger checked.</TableStateRow>
            : findings.map((f, i) => (
              <Tr key={`${f.sourceDraftId}-${f.service}-${f.code}-${i}`}>
                <Td className="font-mono text-[11.5px]">{f.sourceDraftId} · {f.service}{f.requestId && <div className="text-muted-foreground">{f.requestId}</div>}</Td>
                <Td>{f.code.replace(/_/g, ' ').toLowerCase()}</Td>
                <Td><Pill value={f.confidence} map={CONFIDENCE_TONE} /></Td>
                <Td className="text-[12px] text-muted-foreground">{detailText(f.detail)}</Td>
              </Tr>
            ))}
        </TBody>
      </TableFrame>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">{onlyOutstanding ? 'Outstanding — approved, not (fully) recorded as refunded' : 'All approved and refunded requests'}</h3>
        <button type="button" className="text-[12.5px] font-medium text-primary hover:underline" onClick={() => setOnlyOutstanding(v => !v)}>{onlyOutstanding ? 'Show all' : 'Show outstanding only'}</button>
      </div>
      <TableFrame minWidth="min-w-[1040px]">
        <THead><Th>Organizer</Th><Th>Event · service</Th><Th>Request</Th><Th align="right">Approved</Th><Th align="right">Refunded</Th><Th align="right">Outstanding</Th><Th>Status</Th><Th>Dates</Th></THead>
        <TBody>
          {loading ? <TableStateRow colSpan={8}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
            : error && rows.length === 0 ? <TableStateRow colSpan={8}>Could not load refunds — retry above.</TableStateRow>
            : shown.length === 0 ? <TableStateRow colSpan={8}>{onlyOutstanding ? 'Nothing outstanding in the requests checked.' : 'No approved or refunded requests.'}</TableStateRow>
            : shown.map(r => (
              <Tr key={r.requestId}>
                <Td><button type="button" className="font-mono text-[11.5px] text-primary hover:underline" onClick={() => onOpenOrganizer(r.organizerUid)}>{r.organizerUid}</button></Td>
                <Td>{r.eventName}<div className="text-[12px] text-muted-foreground">{r.service}{r.capacity ? ` · capacity ${num(r.capacity.before)} → ${num(r.capacity.after)}` : ''}</div></Td>
                <Td className="font-mono text-[11px] text-muted-foreground">{r.requestId}</Td>
                <Td align="right" className="tabular-nums">{num(r.approvedQuantity)} · {rupees(r.approvedAmountPaise)}</Td>
                <Td align="right" className="tabular-nums">{r.status === 'processed' ? (r.refundedAmountPaise === null ? 'Not recorded' : `${num(r.refundedQuantity)} · ${rupees(r.refundedAmountPaise)}`) : '—'}</Td>
                <Td align="right" className="tabular-nums font-medium">{r.outstandingPaise === null ? 'Unknown' : rupees(r.outstandingPaise)}</Td>
                <Td><Pill value={r.status === 'processed' ? 'refunded' : 'approved — not refunded'} /></Td>
                <Td className="whitespace-nowrap text-[12px] text-muted-foreground">req {when(r.submittedAt)}<div>appr {when(r.approvedAt)}</div>{r.processedAt && <div>paid {when(r.processedAt)}</div>}</Td>
              </Tr>
            ))}
        </TBody>
      </TableFrame>
      {cursor && !loading && <LoadMoreButton onClick={() => load(cursor)} loading={more} />}
    </div>
  )
}

// ─── Reconciliation (W2.d report-only) ────────────────────────────────────────
type ReconKind = 'topups' | 'records' | 'wallets'
const RECON_KINDS: ReadonlyArray<{ value: ReconKind; label: string }> = [
  { value: 'topups', label: 'Top-ups' }, { value: 'records', label: 'Reconciliation records' }, { value: 'wallets', label: 'Wallet balances' },
]
interface ReconFinding { scope: string; code: string; confidence: string; orderId?: string | null; recordId?: string; uid?: string | null; detail?: Record<string, string | number | boolean | null> }
interface ReconPage { findings: ReconFinding[]; scanned: number; deferred: number; nextCursor: string | null; complete: boolean; truncated: boolean; verified?: number; mismatched?: number; inconclusive?: number }

/** W2.e.1 — finding detail for people: *Paise values as rupees, camelCase keys as words, codes without underscores. */
function detailText(detail: Record<string, string | number | boolean | null> | undefined): string {
  const parts = Object.entries(detail ?? {}).map(([k, v]) => {
    const label = k.replace(/Paise$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    // S4 — identifiers (…Id / …Ids) stay exactly as stored so they can be copied and searched; only
    // code-like values (reasons, statuses) are made readable.
    const value = v === null ? '—' : /Paise$/.test(k) && typeof v === 'number' ? rupees(v) : /Ids?$/.test(k) ? String(v) : String(v).replace(/_/g, ' ')
    return `${label}: ${value}`
  })
  return parts.join(' · ') || '—'
}

function ReconciliationSection({ onOpenOrganizer }: { onOpenOrganizer: (uid: string) => void }) {
  const [kind, setKind] = useState<ReconKind>('topups')
  const [findings, setFindings] = useState<ReconFinding[]>([])
  const [meta, setMeta] = useState<{ scanned: number; complete: boolean; truncated: boolean; deferred: number; verified: number; mismatched: number; inconclusive: number } | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async (after: string | null) => {
    if (after) setMore(true); else setLoading(true)
    setError(null)
    const r = await api<ReconPage>({ view: 'reconciliation', kind, cursor: after })
    if (r.ok) {
      setFindings(prev => (after ? [...prev, ...r.data.findings] : r.data.findings))
      setCursor(r.data.nextCursor)
      setMeta(prev => ({
        scanned: (after ? prev?.scanned ?? 0 : 0) + r.data.scanned,
        complete: r.data.complete, truncated: (after ? !!prev?.truncated : false) || r.data.truncated, deferred: r.data.deferred,
        verified: (after ? prev?.verified ?? 0 : 0) + (r.data.verified ?? 0),
        mismatched: (after ? prev?.mismatched ?? 0 : 0) + (r.data.mismatched ?? 0),
        inconclusive: (after ? prev?.inconclusive ?? 0 : 0) + (r.data.inconclusive ?? 0),
      }))
    } else setError(r.error)
    setLoading(false); setMore(false)
  }, [kind])
  useEffect(() => { const t = setTimeout(() => { void load(null) }, 0); return () => clearTimeout(t) }, [load])

  // W2.d S3 — on-demand gateway evidence (top-ups only). Production gateway verification is NOT
  // enabled: the API answers "not enabled" without calling anything, and that is what is shown.
  // G2 — "Check next" continues manually, one bounded batch per click (./gatewayProgress).
  const [gateway, setGateway] = useState<GatewayProgress | null>(null)
  const [gatewayLoading, setGatewayLoading] = useState(false)
  const [gatewayError, setGatewayError] = useState<string | null>(null)
  const gatewayRun = useRef(0)                                              // a reset outdates in-flight answers
  const runGateway = async (pos: GatewayPosition, prev: GatewayProgress | null) => {
    const run = ++gatewayRun.current
    setGatewayLoading(true); setGatewayError(null)
    const r = await api<ReconPage & { gateway?: GatewayPageReport }>(gatewayRequestParams(pos))
    if (run !== gatewayRun.current) return
    if (r.ok) setGateway(r.data.gateway ? mergeGatewayProgress(prev, pos, r.data.gateway, r.data.nextCursor) : null)
    else setGatewayError(r.error)
    setGatewayLoading(false)
  }
  const changeKind = (k: ReconKind) => {
    gatewayRun.current++
    setGateway(null); setGatewayError(null); setGatewayLoading(false)
    setKind(k)
  }

  return (
    <div className="space-y-3">
      <FilterTabs options={RECON_KINDS} value={kind} onChange={changeKind} aria-label="Reconciliation scope" className="w-fit" />
      <Note tone="warning">
        Report-only. <strong>Confirmed</strong>: the stored records contradict each other. <strong>Probable</strong>: likely inconsistent, a benign explanation exists.
        {' '}<strong>Inconclusive</strong>: the evidence is incomplete (for example legacy history without ledger rows) — not a loss. Nothing here changes any record.
      </Note>
      {error && <RetryError message={error} onRetry={() => void load(null)} />}
      {meta && (
        <p className="text-[12.5px] text-muted-foreground">
          {num(meta.scanned)} checked{kind === 'wallets' ? ` · ${num(meta.verified)} verified · ${num(meta.mismatched)} mismatched · ${num(meta.inconclusive)} inconclusive` : ''}
          {' · '}{meta.complete ? 'scan complete' : 'more to scan — load more to continue'}{meta.truncated ? ' · some evidence was capped' : ''}
        </p>
      )}
      <TableFrame minWidth="min-w-[860px]">
        <THead><Th>Subject</Th><Th>Finding</Th><Th>Confidence</Th><Th>Detail</Th></THead>
        <TBody>
          {loading ? <TableStateRow colSpan={4}><Loader2 className="mx-auto size-5 animate-spin" /></TableStateRow>
            : findings.length === 0 ? <TableStateRow colSpan={4}>{
                error ? 'The reconciliation could not be run — see the error above.'
                : meta?.complete ? 'No findings in RegisterDesk\'s own records for everything checked. This is not verified against the payment gateway.'
                : 'No findings so far — load more to keep scanning.'
              }</TableStateRow>
            : findings.map((f, i) => {
              const subject = f.orderId ?? f.recordId ?? f.uid ?? '—'
              return (
                <Tr key={`${subject}-${f.code}-${i}`}>
                  <Td className="font-mono text-[11.5px]">
                    {f.scope === 'wallet' && f.uid
                      ? <button type="button" className="text-primary hover:underline" onClick={() => onOpenOrganizer(f.uid!)}>{f.uid}</button>
                      : subject}
                  </Td>
                  <Td>{f.code.replace(/_/g, ' ')}{/* S4 — on small screens the Confidence column scrolls out of view; keep the label with the finding */}<span className="mt-1 block sm:hidden"><Pill value={f.confidence} map={CONFIDENCE_TONE} /></span></Td>
                  <Td><Pill value={f.confidence} map={CONFIDENCE_TONE} /></Td>
                  <Td className="text-[12px] text-muted-foreground">
                    <span title={JSON.stringify(f.detail ?? {})}>{detailText(f.detail)}</span>
                  </Td>
                </Tr>
              )
            })}
        </TBody>
      </TableFrame>
      {cursor && !loading && <LoadMoreButton onClick={() => load(cursor)} loading={more} />}
      {kind === 'topups' && (
        <GatewayEvidencePanel progress={gateway} loading={gatewayLoading} error={gatewayError}
          onCheck={() => runGateway(GATEWAY_START, null)}
          onNext={gateway?.next ? () => runGateway(gateway.next!, gateway) : null} />
      )}
    </div>
  )
}

/** W2.d S3 — gateway evidence, on demand. Never presented as production payment evidence. */
const GATEWAY_BUTTON = 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-60'

function GatewayEvidencePanel({ progress, loading, error, onCheck, onNext }: {
  progress: GatewayProgress | null; loading: boolean; error: string | null; onCheck: () => void; onNext: (() => void) | null
}) {
  const report = progress?.last ?? null
  // G2 — continuation exists only for real (here: mock) evidence; the disabled path has nothing to continue.
  const canContinue = !!(report?.enabled && onNext)
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold text-foreground">Gateway evidence</h3>
          <p className="text-[12.5px] text-muted-foreground">Production Razorpay verification is not enabled — this phase is mock-only.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onCheck} disabled={loading} className={GATEWAY_BUTTON}>
            {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Check gateway evidence
          </button>
          {canContinue && (
            <button type="button" onClick={onNext!} disabled={loading} className={GATEWAY_BUTTON}>Check next</button>
          )}
        </div>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {report && !report.enabled && (
        <Note tone="warning">
          <p className="font-medium text-foreground">Gateway verification unavailable</p>
          <p className="mt-0.5">
            No payment provider was contacted. Production Razorpay reads are not approved, so gateway evidence exists only as
            mock fixtures in automated tests. The findings above are based on RegisterDesk&apos;s own records only — they are
            not confirmed against the gateway, and an empty gateway result would not mean a clean one.
          </p>
        </Note>
      )}
      {progress && report && report.enabled && (
        <div className="space-y-2">
          <Note tone="warning"><strong>MOCK EVIDENCE — not production payment data.</strong> {gatewayProgressText(progress)}.</Note>
          <TableFrame minWidth="min-w-[760px]">
            <THead><Th>Order</Th><Th>Finding</Th><Th>Confidence</Th><Th>Detail</Th></THead>
            <TBody>
              {progress.findings.length === 0
                ? <TableStateRow colSpan={4}>{progress.checked === 0 ? 'No top-ups were checked against the mock gateway.' : 'No gateway findings in the mock evidence for the top-ups checked.'}</TableStateRow>
                : progress.findings.map((f, i) => (
                  <Tr key={`${f.orderId}-${f.code}-${i}`}>
                    <Td className="font-mono text-[11.5px]">{f.orderId} <StatusPill tone="warning">mock</StatusPill></Td>
                    <Td>{f.code.replace(/_/g, ' ')}{/* S4 — on small screens the Confidence column scrolls out of view; keep the label with the finding */}<span className="mt-1 block sm:hidden"><Pill value={f.confidence} map={CONFIDENCE_TONE} /></span></Td>
                    <Td><Pill value={f.confidence} map={CONFIDENCE_TONE} /></Td>
                    <Td className="text-[12px] text-muted-foreground">{detailText(f.detail)}</Td>
                  </Tr>
                ))}
            </TBody>
          </TableFrame>
        </div>
      )}
    </section>
  )
}
