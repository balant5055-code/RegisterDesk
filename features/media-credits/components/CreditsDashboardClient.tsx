'use client'

// MC-07 · The organizer Credits dashboard.
//
// The destination for every "Buy credits" button in Media Studio.
//
// ═══ DISPLAY ONLY ════════════════════════════════════════════════════════════
// Every figure comes from an existing endpoint. Nothing here computes a balance, a price or
// a charge: `amountPaise` is `quantity × unitPricePaise` from the server, `lifetimeConsumed`
// is read off the wallet, and the photo count is a server-side aggregation. The one thing
// this file decides is which quantities to OFFER — see utils/creditPacks.ts for why that is
// a presentation choice rather than a pricing one.
//
// ═══ FOUR ENDPOINTS, LOADED IN PARALLEL ══════════════════════════════════════
//   /media-credits/balance    → balance, held, available, lifetime totals, photo count, rate
//   /media-credits/ledger     → transaction history
//   /media-credits/purchases  → purchase history
//   /media-credits/refunds    → refund status, joined to purchases by purchaseId
//   /media-credits/sessions   → the active session (MC-07 routed MC-06A's existing service)
//
// A failure in any one degrades that section alone. A dashboard that blanks entirely because
// its history call failed is worse than one that shows a balance and an error where the
// history would be.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Coins, Images, Loader2, Undo2, Wallet,
} from 'lucide-react'
import {
  Button, Card, EmptyState, ErrorState, SectionHeading, Skeleton, StatusChip,
} from '@/components/ui'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import {
  averageCostPerUpload, pricePack, recommendPack, remainingCapacity,
} from '@/features/media-credits/utils/creditPacks'
import { BuyCreditsDialog } from './BuyCreditsDialog'
import { RefundRequestDialog } from './RefundRequestDialog'
import { CustomPurchaseCard } from './CustomPurchaseCard'

const API = '/api/organizer/media-credits'

/** Below this many credits, the dashboard leads with a warning. */
const LOW_BALANCE_CREDITS = 50

// ─── Wire shapes, mirroring what each route returns ──────────────────────────

interface BalanceBody {
  balance: number; held: number; available: number
  /** RD-MC-REFUND-V2-P3 · locked by pending refund requests. */
  refundHeld: number
  lifetimeGranted: number; lifetimeConsumed: number
  creditsEnabled: boolean; creditsPerPhoto: number; unitPricePaise: number
  photosUploaded: number | null
}
interface LedgerEntry {
  entryId: string; delta: number; reason: string
  balanceAfter: number; eventSlug: string | null; createdAtMs: number
}
interface Purchase {
  purchaseId: string; credits: number; amountPaise: number
  status: string; createdAtMs: number
}
interface Refund { refundId: string; purchaseId: string; status: string; refundAmountPaise: number }
/**
 * MC-11 · Per-purchase refund eligibility, computed SERVER-SIDE.
 *
 * Every money field here arrives already calculated by `refundMath`. This component renders
 * them and derives nothing — see the note in RefundRequestDialog for why that matters.
 */
interface RefundView {
  purchaseId: string
  eligible: boolean
  reason: string | null
  explanation: string | null
  purchaseAmountPaise: number
  /** RD-MC-REFUND-V2-P2 · unused credits × this purchase's unit price. The refund basis. */
  refundBasePaise: number
  serviceChargePaise: number
  refundAmountPaise: number
  credits: number
  /** RD-MC-REFUND-V2-P2 · how much of this purchase is left, and how much is gone. */
  creditsRemaining: number
  creditsUsed: number
  availableCredits: number
  refundStatus: string | null
  /** RD-MC-REFUND-V2-P3 · credits this purchase's pending refund is holding. 0 when none. */
  heldCredits: number
}
interface RefundPolicyView { refundsEnabled: boolean; reasonRequired: boolean }
interface SessionRow {
  sessionId: string; status: string; allocatedCredits: number
  slotCount: number; consumedSlots: number | null
}

type Loadable<T> = { data: T | null; loading: boolean; error: string | null }
const initial = <T,>(): Loadable<T> => ({ data: null, loading: true, error: null })

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (n: number) => n.toLocaleString('en-IN')

export function CreditsDashboardClient() {
  const { getToken } = useAuth()

  const [balance,   setBalance]   = useState<Loadable<BalanceBody>>(initial)
  const [ledger,    setLedger]    = useState<Loadable<LedgerEntry[]>>(initial)
  const [purchases, setPurchases] = useState<Loadable<Purchase[]>>(initial)
  const [refunds,   setRefunds]   = useState<Loadable<Refund[]>>(initial)
  const [sessions,  setSessions]  = useState<Loadable<SessionRow[]>>(initial)
  // MC-11 · eligibility + pricing for each purchase row, and the policy in force.
  const [refundViews, setRefundViews] = useState<Loadable<{
    views: RefundView[]; policy: RefundPolicyView
  }>>(initial)
  /** The purchase a refund is being requested for, or null. */
  const [refunding, setRefunding] = useState<RefundView | null>(null)

  // MC-08.2 · Which quantity the Buy dialog should open on, or false when it is closed.
  // Not a boolean: the low-balance card opens the dialog pre-set to a suggested top-up,
  // while the section header opens it with no suggestion at all.
  const [buying, setBuying] = useState<number | null | false>(false)
  // RD-MC-CUSTOM-01 · the exact quantity and event chosen on the purchase card.
  const [custom, setCustom] = useState<{ credits: number; eventId: string } | null>(null)

  const load = useCallback(async <T,>(
    path: string,
    pick: (body: Record<string, unknown>) => T,
    set: (v: Loadable<T>) => void,
  ) => {
    try {
      const token = await getToken()
      const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.status === 401 || res.status === 403) {
        throw new Error('You do not have permission to view credits.')
      }
      if (!res.ok) throw new Error('Could not load this section.')
      set({ data: pick(await res.json() as Record<string, unknown>), loading: false, error: null })
    } catch (e) {
      set({
        data: null, loading: false,
        error: e instanceof Error ? e.message : 'Could not load this section.',
      })
    }
  }, [getToken])

  /**
   * Re-reads every section a purchase can move.
   *
   * MC-08.2 · Balance, ledger and purchase history all change on a grant, and a dashboard
   * that refreshed only the headline number would show a new balance above a history that
   * does not explain it. Sessions and refunds come along because they are cheap and because
   * one refresh path is easier to keep correct than two subtly different ones.
   *
   * A re-fetch, deliberately, not a local increment: the wallet is the single source of truth
   * for a balance, and adding the purchased amount on the client would make this a second one.
   */
  const refreshAll = useCallback(() => {
    // Parallel, and each independently fallible — see the header note on partial failure.
    void load('/balance',           b => b as unknown as BalanceBody,        setBalance)
    void load('/ledger?limit=25',   b => (b.entries   ?? []) as LedgerEntry[], setLedger)
    void load('/purchases?limit=25', b => (b.purchases ?? []) as Purchase[],   setPurchases)
    void load('/refunds?limit=50',  b => (b.refunds   ?? []) as Refund[],      setRefunds)
    void load('/sessions?limit=5',  b => (b.sessions  ?? []) as SessionRow[],  setSessions)
    void load('/refunds/eligibility?limit=25',
      b => ({
        views:  (b.views  ?? []) as RefundView[],
        policy: (b.policy ?? { refundsEnabled: false, reasonRequired: true }) as RefundPolicyView,
      }), setRefundViews)
  }, [load])

  useEffect(() => { refreshAll() }, [refreshAll])

  /**
   * RD-MC-REFUND-V2-P3 · withdraw a pending request and get the held credits back.
   *
   * Re-reads everything rather than patching state locally: the cancellation changes the
   * refund's status, the wallet's `available`, and every row's eligibility at once, and
   * guessing at those on the client is how a screen starts disagreeing with the server.
   */
  const [cancelling, setCancelling] = useState<string | null>(null)
  const cancelRefund = useCallback(async (refundId: string) => {
    setCancelling(refundId)
    try {
      const token = await getToken()
      const res = await fetch(`${API}/refunds/${encodeURIComponent(refundId)}/cancel`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? 'The refund could not be cancelled.')
      }
      refreshAll()
    } catch {
      // Deliberately silent beyond clearing the busy state: the refresh below re-reads the
      // truth either way, and the row will still show `Requested` if nothing changed.
      refreshAll()
    } finally {
      setCancelling(null)
    }
  }, [getToken, refreshAll])

  const b = balance.data

  /** Refund state per purchase, so the history can show one row per purchase. */
  const refundByPurchase = useMemo(() => {
    const map = new Map<string, Refund>()
    for (const r of refunds.data ?? []) map.set(r.purchaseId, r)
    return map
  }, [refunds.data])

  /** Refund view per purchase, so each history row can answer for itself. */
  const refundByPurchaseId = useMemo(() => {
    const map = new Map<string, RefundView>()
    for (const v of refundViews.data?.views ?? []) map.set(v.purchaseId, v)
    return map
  }, [refundViews.data])

  const activeSession = (sessions.data ?? []).find(s => s.status === 'ACTIVE') ?? null
  const capacity = b ? remainingCapacity(b.available, b.creditsPerPhoto) : null
  const isLow    = b ? b.available < LOW_BALANCE_CREDITS : false

  // ── Whole-page states ──────────────────────────────────────────────────────

  if (balance.loading) return <DashboardSkeleton />

  if (balance.error) {
    return <ErrorState message={balance.error} />
  }

  if (b && !b.creditsEnabled) {
    // Not an error and not a zero balance — the feature is simply off for this account.
    return (
      <EmptyState
        icon={Coins}
        title="Credits are not in use on this account"
        description="Uploads do not consume credits here. Nothing to buy and nothing to track."
      />
    )
  }

  return (
    <div className="space-y-6">
      {/* ═══ 1 · Balance + 6 · Low balance ═══ */}
      <section aria-labelledby="credits-balance">
        <SectionHeading id="credits-balance" title="Current balance" />

        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Card className="p-5">
            {/* One number at real scale. The supporting figures are deliberately smaller —
                a row of five equal-weight metrics answers nothing at a glance. */}
            <p className="text-fs-2xs uppercase tracking-wide text-muted-foreground">Available</p>
            <p className="mt-1 text-[2.5rem] font-semibold leading-none tabular-nums text-foreground">
              {num(b!.available)}
              <span className="ml-2 text-fs-base font-normal text-muted-foreground">credits</span>
            </p>
            {capacity !== null && (
              <p className="mt-2 flex items-center gap-1.5 text-fs-sm text-muted-foreground">
                <Images className="size-3.5" aria-hidden />
                Covers about {num(capacity)} more photo{capacity === 1 ? '' : 's'}
              </p>
            )}

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/60 pt-4 sm:grid-cols-3">
              <Figure label="Total" value={num(b!.balance)} />
              <Figure label="Held" value={num(b!.held)} hint={b!.held > 0 ? 'Uploads in progress' : undefined} />
              {/* RD-MC-REFUND-V2-P3 · shown ONLY when non-zero. An organizer whose available
                  figure has dropped below their balance must be able to see where the
                  difference went; a permanent "0" line would be noise for everyone else. */}
              {b!.refundHeld > 0 && (
                <Figure
                  label="Reserved for refund"
                  value={num(b!.refundHeld)}
                  hint="Awaiting review — cancel the request to release them"
                />
              )}
              <Figure label="Lifetime used" value={num(b!.lifetimeConsumed)} />
            </dl>
          </Card>

          {isLow ? (
            <LowBalanceCard
              available={b!.available}
              capacity={capacity}
              creditsPerPhoto={b!.creditsPerPhoto}
              unitPricePaise={b!.unitPricePaise}
              onBuy={setBuying}
            />
          ) : (
            <UsageCard
              lifetimeGranted={b!.lifetimeGranted}
              lifetimeConsumed={b!.lifetimeConsumed}
              photosUploaded={b!.photosUploaded}
              activeSession={activeSession}
              sessionsLoading={sessions.loading}
            />
          )}
        </div>
      </section>

      {/* ═══ 2 · Purchase ═══ */}
      <section aria-labelledby="credits-buy">
        <SectionHeading id="credits-buy" title="Buy credits" />
        <p className="mt-1 text-fs-sm text-muted-foreground">
          {rupees(b!.unitPricePaise)} per credit · {b!.creditsPerPhoto} credit
          {b!.creditsPerPhoto === 1 ? '' : 's'} per photo
        </p>

        {/* RD-MC-CUSTOM-01 · one card, a custom quantity, bounded by the event plan.
            The three fixed packs (500 / 2,000 / 5,000) were a merchandising guess that
            regularly offered an organizer more credits than their plan could ever use. */}
        <div className="mt-3 max-w-md">
          <CustomPurchaseCard onBuy={(credits, eventId) => setCustom({ credits, eventId })} />
        </div>
        <p className="mt-2 text-fs-2xs text-muted-foreground">
          Prices are live from your account&rsquo;s current rate. Paid securely via Razorpay;
          credits are added to your wallet as soon as the payment is verified.
        </p>
      </section>

      {/* ═══ 4 · Transactions ═══ */}
      <section aria-labelledby="credits-ledger">
        <SectionHeading id="credits-ledger" title="Transaction history" />
        <Card className="mt-3 overflow-hidden">
          <SectionBody
            state={ledger}
            empty={{
              icon: Coins,
              title: 'No transactions yet',
              description: 'Purchases and photo uploads will appear here.',
            }}
          >
            {rows => (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-fs-sm">
                  <caption className="sr-only">Credit transactions, most recent first</caption>
                  <thead>
                    <tr className="border-b border-border text-left text-fs-2xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="px-4 py-2 font-medium">Date</th>
                      <th scope="col" className="px-4 py-2 font-medium">Reason</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Credits</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Balance after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(e => (
                      <tr key={e.entryId} className="border-b border-border/50 last:border-0">
                        <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                          {formatDate(e.createdAtMs)}
                        </td>
                        <td className="px-4 py-2.5">
                          <ReasonChip reason={e.reason} />
                          {e.eventSlug && (
                            <span className="ml-2 text-fs-2xs text-muted-foreground">{e.eventSlug}</span>
                          )}
                        </td>
                        <td className={cn(
                          'whitespace-nowrap px-4 py-2.5 text-right tabular-nums',
                          e.delta > 0 ? 'text-success' : e.delta < 0 ? 'text-foreground' : 'text-muted-foreground',
                        )}>
                          <span className="inline-flex items-center gap-1">
                            {e.delta > 0 && <ArrowUpRight className="size-3" aria-hidden />}
                            {e.delta < 0 && <ArrowDownRight className="size-3" aria-hidden />}
                            {e.delta > 0 ? `+${num(e.delta)}` : num(e.delta)}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                          {num(e.balanceAfter)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionBody>
        </Card>
      </section>

      {/* ═══ 5 · Purchases ═══ */}
      <section aria-labelledby="credits-purchases">
        <SectionHeading id="credits-purchases" title="Purchase history" />
        <Card className="mt-3 overflow-hidden">
          <SectionBody
            state={purchases}
            empty={{
              icon: Wallet,
              title: 'No purchases yet',
              description: 'Credits you buy will be listed here with their payment status.',
            }}
          >
            {rows => (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-fs-sm">
                  <caption className="sr-only">Credit purchases, most recent first</caption>
                  <thead>
                    <tr className="border-b border-border text-left text-fs-2xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="px-4 py-2 font-medium">Date</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Credits</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
                      <th scope="col" className="px-4 py-2 font-medium">Payment</th>
                      {/* MC-11 · Both figures come from the server. Nothing in this table is
                          multiplied, and no percentage is applied here. */}
                      <th scope="col" className="px-4 py-2 text-right font-medium">Est. refund</th>
                      <th scope="col" className="px-4 py-2 font-medium">Refund</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(p => {
                      const refund = refundByPurchase.get(p.purchaseId)
                      const view   = refundByPurchaseId.get(p.purchaseId)
                      return (
                        <tr key={p.purchaseId} className="border-b border-border/50 last:border-0">
                          <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                            {formatDate(p.createdAtMs)}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{num(p.credits)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{rupees(p.amountPaise)}</td>
                          <td className="px-4 py-2.5"><PurchaseChip status={p.status} /></td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            {view
                              ? (
                                /* RD-MC-REFUND-V2-P2 · the basis is the UNUSED credits, so the
                                   explanation names them. Titling this with the purchase
                                   amount would claim a figure the refund is not taken from. */
                                <span title={`${num(view.creditsRemaining)} unused credits — ${rupees(view.refundBasePaise)} less ${rupees(view.serviceChargePaise)} service charge`}>
                                  {rupees(view.refundAmountPaise)}
                                </span>
                              )
                              : <span className="text-fs-2xs text-muted-foreground">—</span>}
                          </td>
                          <td className="px-4 py-2.5">
                            {refund ? (
                              /* RD-MC-REFUND-V2-P3 · a pending request is the one refund state
                                 the organizer can still act on, and it is holding their
                                 credits — so the row offers the way out rather than only
                                 reporting the state. */
                              <div className="flex items-center gap-2">
                                <RefundChip status={refund.status} />
                                {refund.status === 'requested' && (
                                  <Button
                                    size="xs" variant="ghost"
                                    disabled={cancelling === refund.refundId}
                                    onClick={() => void cancelRefund(refund.refundId)}
                                  >
                                    {cancelling === refund.refundId ? 'Cancelling…' : 'Cancel'}
                                  </Button>
                                )}
                              </div>
                            ) : view?.eligible ? (
                              <Button size="xs" variant="outline" onClick={() => setRefunding(view)}>
                                <Undo2 className="size-3.5" aria-hidden />
                                Request refund
                              </Button>
                            ) : view?.explanation ? (
                              /* Says WHY, rather than showing a disabled control the organizer
                                 has to hover to understand. */
                              <span className="text-fs-2xs text-muted-foreground">{view.explanation}</span>
                            ) : (
                              <span className="text-fs-2xs text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionBody>
        </Card>
      </section>

      {/* MC-08.2 · ONE dialog for every entry point on this page — the pack cards and the
          low-balance card both open this. Two dialogs would be two sets of payment error
          handling to keep in step. */}
      {/* MC-11 · Mounted only while open, so each opening starts from a clean form.
          Every figure it shows is passed straight through from the server. */}
      {refunding && (
        <RefundRequestDialog
          target={{
            purchaseId:          refunding.purchaseId,
            credits:             refunding.credits,
            creditsUsed:         refunding.creditsUsed,
            creditsRemaining:    refunding.creditsRemaining,
            availableCredits:    refunding.availableCredits,
            purchaseAmountPaise: refunding.purchaseAmountPaise,
            refundBasePaise:     refunding.refundBasePaise,
            serviceChargePaise:  refunding.serviceChargePaise,
            refundAmountPaise:   refunding.refundAmountPaise,
          }}
          reasonRequired={refundViews.data?.policy.reasonRequired ?? true}
          onClose={() => setRefunding(null)}
          onRequested={refreshAll}
        />
      )}

      {/* RD-MC-CUSTOM-01 · the SAME purchase dialog, opened on an exact quantity. The pack
          grid is suppressed by `fixedCredits`, and `eventId` lets the server re-check the
          capacity that produced the number. */}
      {custom && (
        <BuyCreditsDialog
          open
          onClose={() => setCustom(null)}
          unitPricePaise={b!.unitPricePaise}
          creditsPerPhoto={b!.creditsPerPhoto}
          fixedCredits={custom.credits}
          eventId={custom.eventId}
          onPurchased={refreshAll}
        />
      )}

      {/* Mounted only while open, so each opening starts from a clean phase. */}
      {buying !== false && (
        <BuyCreditsDialog
          open
          onClose={() => setBuying(false)}
          unitPricePaise={b!.unitPricePaise}
          creditsPerPhoto={b!.creditsPerPhoto}
          suggestedCredits={buying}
          onPurchased={refreshAll}
        />
      )}
    </div>
  )
}

// ─── Sections ────────────────────────────────────────────────────────────────

function UsageCard(props: {
  lifetimeGranted: number
  lifetimeConsumed: number
  photosUploaded: number | null
  activeSession: SessionRow | null
  sessionsLoading: boolean
}) {
  const avg = averageCostPerUpload(props.lifetimeConsumed, props.photosUploaded)
  return (
    <Card className="p-5">
      <h3 className="text-fs-sm font-semibold text-foreground">Usage</h3>
      <dl className="mt-3 space-y-2">
        <Line label="Credits purchased" value={num(props.lifetimeGranted)} />
        <Line label="Credits used" value={num(props.lifetimeConsumed)} />
        <Line
          label="Photos uploaded"
          // Null means the count could not be read. Showing "0" to someone with thousands of
          // photos would be a confident lie; a dash is honest.
          value={props.photosUploaded === null ? '—' : num(props.photosUploaded)}
        />
        <Line
          label="Average per photo"
          value={avg === null ? '—' : `${avg} credit${avg === 1 ? '' : 's'}`}
        />
        <div className="flex items-baseline justify-between gap-3 border-t border-border/60 pt-2">
          <dt className="text-fs-sm text-muted-foreground">Active session</dt>
          <dd className="text-fs-sm">
            {props.sessionsLoading ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
            ) : props.activeSession ? (
              <StatusChip tone="info">
                {num(props.activeSession.slotCount)} slots · {num(props.activeSession.allocatedCredits)} held
              </StatusChip>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  )
}

function LowBalanceCard(props: {
  available: number
  capacity: number | null
  creditsPerPhoto: number
  unitPricePaise: number
  onBuy: (credits: number | null) => void
}) {
  // Recommend against a round working batch rather than against zero — "top up to exactly
  // what you lack" leaves an organizer back here tomorrow.
  const suggestion = recommendPack(Math.max(LOW_BALANCE_CREDITS, props.creditsPerPhoto * 500))
  return (
    <Card className="border-warning/30 bg-warning/[0.04] p-5">
      <h3 className="flex items-center gap-1.5 text-fs-sm font-semibold text-warning-foreground">
        <AlertTriangle className="size-3.5" aria-hidden />
        Low balance
      </h3>
      <p className="mt-2 text-fs-sm text-muted-foreground">
        {props.capacity === null
          ? `You have ${num(props.available)} credits left.`
          : `You have ${num(props.available)} credits — enough for about ${num(props.capacity)} more photo${props.capacity === 1 ? '' : 's'}.`}
      </p>
      {suggestion && (
        <p className="mt-3 text-fs-sm text-foreground">
          We suggest topping up with{' '}
          <strong className="font-semibold">{num(suggestion.credits)} credits</strong> (
          {rupees(pricePack(suggestion, props.unitPricePaise, props.creditsPerPhoto).amountPaise)}
          ).
        </p>
      )}
      {/* MC-08.2 · Was an in-page anchor down to the pack grid. The shortfall is already
          known here, so the card opens the purchase dialog pre-set to the pack that clears
          it — scrolling someone to a grid to re-pick is a step with no purpose. */}
      <Button className="mt-3" size="sm" onClick={() => props.onBuy(suggestion?.credits ?? null)}>
        <Wallet className="size-3.5" aria-hidden />
        Top up now
      </Button>
    </Card>
  )
}

/** Loading / error / empty / content, so every section handles all four identically. */
function SectionBody<T>({
  state, empty, children,
}: {
  state: Loadable<T[]>
  empty: { icon: LucideIcon; title: string; description: string }
  children: (rows: T[]) => React.ReactNode
}) {
  if (state.loading) {
    return (
      <div className="space-y-2 p-4" aria-busy="true">
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-9 w-full rounded-md" />)}
      </div>
    )
  }
  if (state.error) return <div className="p-4"><ErrorState message={state.error} /></div>
  if (!state.data || state.data.length === 0) {
    return (
      <div className="p-4">
        <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />
      </div>
    )
  }
  return <>{children(state.data)}</>
}

// ─── Small presentation pieces ───────────────────────────────────────────────

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-fs-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-fs-base font-medium text-foreground">{value}</dd>
      {hint && <p className="text-fs-2xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-fs-sm text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-fs-sm text-foreground">{value}</dd>
    </div>
  )
}

const REASON_LABEL: Record<string, string> = {
  purchase: 'Purchase', grant: 'Grant', consume: 'Photo uploads',
  refund: 'Refund', release: 'Hold released', adjustment: 'Adjustment',
}

function ReasonChip({ reason }: { reason: string }) {
  const tone = reason === 'purchase' || reason === 'grant' ? 'success'
    : reason === 'refund' ? 'warning'
    : reason === 'adjustment' ? 'info' : 'neutral'
  return <StatusChip tone={tone}>{REASON_LABEL[reason] ?? reason}</StatusChip>
}

function PurchaseChip({ status }: { status: string }) {
  const tone = status === 'granted' ? 'success'
    : status === 'failed' ? 'danger'
    : status === 'paid' ? 'warning' : 'neutral'
  const label = status === 'granted' ? 'Paid'
    : status === 'paid' ? 'Processing'
    : status === 'pending' ? 'Awaiting payment'
    : status === 'failed' ? 'Failed' : status
  return <StatusChip tone={tone}>{label}</StatusChip>
}

/**
 * RD-MC-REFUND-V2-P3 · `Pending` says the credits are HELD, which is the fact the organizer
 * needs — their spendable balance has dropped and they are entitled to know why. `Cancelled`
 * is shown as its own state rather than folded into `Declined`: the organizer did it, and
 * telling them the platform declined a request they withdrew would be false.
 */
function RefundChip({ status }: { status: string }) {
  const tone = status === 'settled' ? 'success'
    : status === 'rejected' ? 'danger'
    : status === 'cancelled' ? 'neutral'
    : status === 'requested' ? 'warning' : 'warning'
  const label = status === 'settled' ? 'Refunded'
    : status === 'requested' ? 'Pending · credits held'
    : status === 'approved' || status === 'settling' ? 'Processing'
    : status === 'rejected' ? 'Declined'
    : status === 'cancelled' ? 'Cancelled' : status
  return <StatusChip tone={tone}>{label}</StatusChip>
}

function formatDate(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

/** Matches the loaded layout's shape so nothing jumps when the data lands. */
function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-56 w-full rounded-xl" />)}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  )
}
