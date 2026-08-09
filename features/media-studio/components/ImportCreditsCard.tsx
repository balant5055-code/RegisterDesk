'use client'

// MS-IMPORT-01 · The credits card on Import Media.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// Before this, the Import page never mentioned credits. An organizer could queue 800 photos,
// press Start, and discover mid-batch that they could not afford it — as a stream of failed
// uploads rather than as an answer to a question they could have asked first.
//
// This card answers, before anything is uploaded: what do I have, what will this cost, and
// what is left afterwards.
//
// PRESENTATION ONLY. Every number is passed in. It computes the arithmetic of the display
// (cost, remaining) and nothing about business state — the balance comes from
// `GET /api/organizer/media-credits/balance`, and the cost basis is the `creditsPerPhoto`
// that endpoint reports, never a number invented here.
//
// ═══ SESSION STATUS IS CLIENT-DERIVED ════════════════════════════════════════
// There is no organizer endpoint that reads an upload session — MC-06A built `getSession`
// but never routed it, and this sprint forbids adding one. So the status shown is the
// CLIENT'S view: not started, in progress, or finished, derived from the queue the page
// already holds. That is honest for the states an organizer acts on, and it is not the
// server's truth: if the reclamation sweep sealed a session mid-upload, the page would learn
// it from a failed request rather than from this line.

import { AlertTriangle, Coins, Info, Loader2, Wallet } from 'lucide-react'
import { ROUTES } from '@/config/navigation'
import Link from 'next/link'
import { Button, Card, StatusChip, buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

/** What the page knows about the upload session, from its own queue. */
export type ImportSessionStatus = 'not_started' | 'active' | 'finished'

export interface ImportCreditsCardProps {
  /** False when the platform has credits switched off — the card explains rather than alarms. */
  enabled: boolean
  loading: boolean
  /** Non-null only when the balance could not be read. */
  error: string | null

  balance:   number
  held:      number
  available: number
  /** Cost basis reported by the server. Never assumed to be 1. */
  creditsPerPhoto: number

  /** Photos currently queued. */
  photoCount: number
  sessionStatus: ImportSessionStatus

  /** Where "Buy credits" goes. Navigation only — this card starts no purchase. */
  buyHref?: string
  /**
   * MC-08.2 · Buy without leaving the page.
   *
   * Receives the SHORTFALL — how many credits short this import is — so the host can open
   * the purchase dialog pre-set to a pack that clears it. When omitted the card falls back
   * to linking at `buyHref`, which keeps every existing caller working unchanged.
   */
  onBuy?: (shortfall: number) => void
}

/**
 * Below this many credits remaining after the upload, the card warns.
 *
 * A proportion rather than a constant would read oddly at both ends — 10% of 40 is not worth
 * a warning, 10% of 40,000 is far too late. A flat figure is what an organizer can act on.
 */
export const LOW_BALANCE_THRESHOLD = 50

export function ImportCreditsCard(props: ImportCreditsCardProps) {
  const {
    enabled, loading, error, balance, held, available,
    creditsPerPhoto, photoCount, sessionStatus,
    // MC-08.1 · From the route table, not a string literal, so the two cannot drift apart.
    buyHref = ROUTES.MEDIA_STUDIO_CREDITS,
    onBuy,
  } = props

  // ── Feature off ────────────────────────────────────────────────────────────
  // Not an error and not a zero balance. Saying "0 credits" here would imply the organizer
  // had spent down to nothing, which is a different and alarming thing.
  if (!enabled) {
    return (
      <Card className="p-4">
        <Header />
        <p className="mt-2 flex items-start gap-2 text-fs-sm text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Credits are not required for uploads on this account.
        </p>
      </Card>
    )
  }

  if (loading) {
    return (
      <Card className="p-4" aria-busy="true">
        <Header />
        <p className="mt-3 flex items-center gap-2 text-fs-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Checking your balance…
        </p>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="p-4">
        <Header />
        <p className="mt-2 flex items-start gap-2 text-fs-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      </Card>
    )
  }

  const cost      = estimateCost(photoCount, creditsPerPhoto)
  const remaining = available - cost
  const verdict   = creditVerdict({ available, cost, photoCount })
  // What this import is short by. Zero when affordable — the card only offers to buy when
  // it is not, and a negative would recommend a nonsense pack.
  const shortfall = Math.max(0, cost - available)

  return (
    <Card className="p-4">
      <Header status={sessionStatus} />

      {/* The balance at real scale — one number an organizer reads at a glance, with the
          supporting figures deliberately smaller rather than a row of equal-weight metrics. */}
      <div className="mt-3">
        <p className="text-fs-2xs uppercase tracking-wide text-muted-foreground">Available</p>
        <p className="text-[1.75rem] font-semibold leading-none tabular-nums text-foreground">
          {available.toLocaleString('en-IN')}
          <span className="ml-1.5 text-fs-sm font-normal text-muted-foreground">credits</span>
        </p>
        {held > 0 && (
          <p className="mt-1 text-fs-2xs text-muted-foreground">
            {balance.toLocaleString('en-IN')} total · {held.toLocaleString('en-IN')} held by
            uploads in progress
          </p>
        )}
      </div>

      <dl className="mt-3 space-y-1.5 border-t border-border/60 pt-3">
        <Row
          label={photoCount > 0
            ? `This import · ${photoCount.toLocaleString('en-IN')} photo${photoCount === 1 ? '' : 's'}`
            : 'This import'}
          value={photoCount > 0 ? `−${cost.toLocaleString('en-IN')}` : '—'}
        />
        <Row
          label="Remaining after upload"
          value={photoCount > 0 ? Math.max(0, remaining).toLocaleString('en-IN') : '—'}
          emphasis={verdict !== 'ok'}
        />
        {creditsPerPhoto !== 1 && (
          <Row label="Cost per photo" value={`${creditsPerPhoto.toLocaleString('en-IN')} credits`} />
        )}
      </dl>

      {verdict === 'insufficient' && (
        <Notice tone="danger" title="Not enough credits">
          This import needs {cost.toLocaleString('en-IN')} credits and you have{' '}
          {available.toLocaleString('en-IN')}. Add {(cost - available).toLocaleString('en-IN')} more
          to upload these photos.
        </Notice>
      )}
      {verdict === 'low' && (
        <Notice tone="warning" title="Low balance">
          You will have {Math.max(0, remaining).toLocaleString('en-IN')} credits left after this
          import.
        </Notice>
      )}

      {/* MC-08.2 · Buying in place, when the host page can offer it.
          Navigating to the Credits page mid-import would abandon a queue the organizer has
          already built — the files are held in browser state, not on the server. The link
          remains the fallback for any host that cannot host a dialog. */}
      {verdict !== 'ok' && (
        onBuy ? (
          <Button
            variant="primary"
            size="sm"
            className="mt-3 w-full"
            onClick={() => onBuy(shortfall)}
          >
            <Wallet className="size-3.5" aria-hidden />
            Buy credits
          </Button>
        ) : (
          <Link
            href={buyHref}
            className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'mt-3 w-full')}
          >
            <Wallet className="size-3.5" aria-hidden />
            Buy credits
          </Link>
        )
      )}
    </Card>
  )
}

// ─── Pure helpers, exported so the gating rule has ONE definition ─────────────

/**
 * Credits this import will cost.
 *
 * Mirrors `pricingService.creditsForPhotos` — truncating multiplication — so the estimate an
 * organizer is shown and the amount the session actually holds cannot disagree.
 */
export function estimateCost(photoCount: number, creditsPerPhoto: number): number {
  return Math.max(0, Math.trunc(photoCount)) * Math.max(0, Math.trunc(creditsPerPhoto))
}

export type CreditVerdict = 'ok' | 'low' | 'insufficient'

/**
 * Whether this import can proceed, and how comfortably.
 *
 * Exported because the page gates its Start button on the same call. Two places deciding
 * "can they afford it" is how a disabled button and a green card end up on screen together.
 *
 * An EMPTY queue is `ok`, never `insufficient` — nothing has been asked for yet, and warning
 * about a zero-photo import would be noise on a page an organizer has only just opened.
 */
export function creditVerdict(input: {
  available: number
  cost: number
  photoCount: number
}): CreditVerdict {
  if (input.photoCount <= 0) return 'ok'
  if (input.cost > input.available) return 'insufficient'
  if (input.available - input.cost < LOW_BALANCE_THRESHOLD) return 'low'
  return 'ok'
}

// ─── Presentation ────────────────────────────────────────────────────────────

function Header({ status }: { status?: ImportSessionStatus }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-1.5 text-fs-sm font-semibold text-foreground">
        <Coins className="size-3.5 text-primary" aria-hidden />
        Media credits
      </h3>
      {status && status !== 'not_started' && (
        <StatusChip tone={status === 'active' ? 'info' : 'success'}>
          {status === 'active' ? 'Upload in progress' : 'Upload finished'}
        </StatusChip>
      )}
    </div>
  )
}

function Row({
  label, value, emphasis,
}: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="min-w-0 truncate text-fs-sm text-muted-foreground">{label}</dt>
      <dd className={cn(
        'shrink-0 tabular-nums text-fs-sm',
        emphasis ? 'font-semibold text-foreground' : 'text-foreground',
      )}>
        {value}
      </dd>
    </div>
  )
}

function Notice({
  tone, title, children,
}: { tone: 'warning' | 'danger'; title: string; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        'mt-3 rounded-lg border p-2.5 text-fs-2xs',
        // Brand/semantic washes stay faint on a large area — a saturated block here would
        // fight the balance figure above it for attention.
        tone === 'danger'
          ? 'border-destructive/30 bg-destructive/[0.05] text-destructive'
          : 'border-warning/30 bg-warning/[0.05] text-warning-foreground',
      )}
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-0.5 text-muted-foreground">{children}</p>
    </div>
  )
}
