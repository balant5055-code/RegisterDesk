'use client'

// RD-MC-CUSTOM-01 · Buying an exact number of credits, bounded by the event's plan.
//
// Replaces the three fixed packs (500 / 2,000 / 5,000). Those were a merchandising guess:
// an organizer on the Free plan with 13 photo slots left was offered 500 credits, 487 of
// which they could never spend.
//
// ═══ THIS FILE COMPUTES NO MONEY AND NO CAPACITY ═════════════════════════════
//   capacity → GET /media-credits/capacity, which runs the pure `purchaseCapacity`
//   price    → `pricePack`, the same function every other price on this page uses
//
// The range comes from the server and the SAME rule re-runs in `createPurchaseIntent`, so a
// quantity this card offers is one the server will accept, and one it hides is one the
// server refuses. Neither number is derived here.

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Minus, Plus, Wallet } from 'lucide-react'
import { Banner, Button, Card, Skeleton } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/components/auth/AuthProvider'
import { useMediaStudio } from '@/features/media-studio/context/MediaStudioContext'
import { pricePack } from '@/features/media-credits/utils/creditPacks'

const API = '/api/organizer/media-credits'

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (n: number) => n.toLocaleString('en-IN')

/** Exactly the server's answer. Nothing here recomputes any of it. */
interface CapacityBody {
  capacity: {
    remaining: number; canPurchase: boolean
    min: number; max: number; unlimited: boolean
  }
  basis: {
    maxPhotosPerEvent: number | null
    uploadedPhotos:    number
    walletAvailable:   number
    tier:              string | null
  }
  pricing: { creditsEnabled: boolean; unitPricePaise: number; creditsPerPhoto: number }
}

export interface CustomPurchaseCardProps {
  /** Opens the shared purchase dialog for an exact quantity. */
  onBuy: (credits: number, eventId: string) => void
}

export function CustomPurchaseCard({ onBuy }: CustomPurchaseCardProps) {
  const { getToken } = useAuth()
  // The workspace event — the same one every other Media Studio page uses. The photo ceiling
  // is per event, so a purchase has to name one.
  const { event, events } = useMediaStudio()

  const [data,    setData]    = useState<CapacityBody | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [raw,     setRaw]     = useState('')

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!event) { if (!cancelled) { setData(null); setLoading(false) } return }
      if (!cancelled) { setLoading(true); setError(null) }
      try {
        const token = await getToken()
        const res = await fetch(
          `${API}/capacity?eventId=${encodeURIComponent(event.eventId)}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
        )
        if (!res.ok) throw new Error('Could not read your remaining capacity.')
        const body = await res.json() as CapacityBody
        if (cancelled) return
        setData(body)
        // Start at the maximum: the organizer's question is usually "how many can I get".
        setRaw(String(body.capacity.canPurchase ? body.capacity.max : ''))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read your remaining capacity.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [event, getToken])

  const cap = data?.capacity
  const parsed = Number(raw)
  const credits = Number.isFinite(parsed) ? Math.trunc(parsed) : NaN

  const invalid = !cap || !cap.canPurchase || !Number.isInteger(credits)
    || credits < cap.min || credits > cap.max

  const priced = data && Number.isInteger(credits) && credits > 0
    ? pricePack({ credits }, data.pricing.unitPricePaise, data.pricing.creditsPerPhoto)
    : null

  const step = useCallback((delta: number) => {
    if (!cap) return
    const base = Number.isInteger(credits) ? credits : cap.min
    setRaw(String(Math.max(cap.min, Math.min(cap.max, base + delta))))
  }, [cap, credits])

  // ── No event chosen ────────────────────────────────────────────────────────
  if (!event) {
    return (
      <Card className="p-5">
        <p className="text-fs-sm text-muted-foreground">
          {events.length === 0
            ? 'Publish an event before buying credits — the amount you can buy depends on that event’s plan.'
            : 'Choose an event above. Credit capacity is set by that event’s plan.'}
        </p>
      </Card>
    )
  }

  if (loading) {
    return (
      <Card className="p-5" aria-busy="true">
        <Skeleton className="h-5 w-40 rounded-md" />
        <Skeleton className="mt-3 h-24 w-full rounded-md" />
      </Card>
    )
  }

  if (error || !data || !cap) {
    return <Banner tone="error" title="Could not load capacity">{error ?? 'Please try again.'}</Banner>
  }

  // ── Plan is full ───────────────────────────────────────────────────────────
  if (!cap.canPurchase) {
    return (
      <Card className="p-5">
        <div className="flex gap-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0">
            <p className="text-fs-sm font-medium text-foreground">
              You have reached your current plan capacity.
            </p>
            <p className="mt-1 text-fs-2xs text-muted-foreground">
              Upgrade your licence to purchase additional credits.
            </p>
            <Basis basis={data.basis} remaining={cap.remaining} />
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card className="p-5">
      <p className="text-fs-2xs uppercase tracking-wide text-muted-foreground">Purchase credits</p>
      <Basis basis={data.basis} remaining={cap.remaining} />

      <label className="mt-4 block">
        <span className="text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Credits
        </span>
        <div className="mt-1 flex items-center gap-2">
          <Button
            variant="outline" size="sm" aria-label="Fewer credits"
            onClick={() => step(-10)} disabled={credits <= cap.min}
          >
            <Minus className="size-3.5" aria-hidden />
          </Button>
          <input
            value={raw}
            onChange={e => setRaw(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
            aria-label="Number of credits to purchase"
            aria-invalid={invalid}
            className={cn(
              'w-28 rounded-lg border bg-background px-3 py-2 text-center text-fs-base',
              'font-semibold tabular-nums text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              invalid ? 'border-destructive' : 'border-border',
            )}
          />
          <Button
            variant="outline" size="sm" aria-label="More credits"
            onClick={() => step(10)} disabled={credits >= cap.max}
          >
            <Plus className="size-3.5" aria-hidden />
          </Button>
          <span className="text-fs-2xs text-muted-foreground">
            {num(cap.min)}–{num(cap.max)}
          </span>
        </div>
      </label>

      {/* Live price. Server unit price × quantity — the same `pricePack` the rest of the
          page uses, never a figure computed here. */}
      <div aria-live="polite" className="mt-3">
        {priced && !invalid ? (
          <p className="text-fs-lg font-semibold text-foreground">
            {rupees(priced.amountPaise)}
            <span className="ml-2 text-fs-2xs font-normal text-muted-foreground">
              {rupees(priced.unitPricePaise)} per credit
              {priced.photosCovered !== null && ` · about ${num(priced.photosCovered)} photos`}
            </span>
          </p>
        ) : (
          <p className="text-fs-2xs text-destructive">
            Enter between {num(cap.min)} and {num(cap.max)} credits.
          </p>
        )}
      </div>

      <Button
        className="mt-4 w-full"
        size="sm"
        disabled={invalid}
        onClick={() => onBuy(credits, event.eventId)}
      >
        <Wallet className="size-3.5" aria-hidden />
        Purchase {Number.isInteger(credits) ? num(credits) : 0} Credits
      </Button>
    </Card>
  )
}

/** The three figures the capacity was derived from, shown so the number is checkable. */
function Basis({
  basis, remaining,
}: { basis: CapacityBody['basis']; remaining: number }) {
  return (
    <dl className="mt-3 space-y-1.5 border-t border-border/60 pt-3 text-fs-sm">
      {basis.tier && (
        <Row label="Current plan" value={basis.tier} />
      )}
      <Row
        label="Maximum photos"
        value={basis.maxPhotosPerEvent === null ? 'Unlimited' : num(basis.maxPhotosPerEvent)}
      />
      <Row label="Uploaded photos" value={num(basis.uploadedPhotos)} />
      <Row label="Wallet credits" value={num(basis.walletAvailable)} />
      <div className="flex items-baseline justify-between gap-3 border-t border-border/60 pt-1.5">
        <dt className="font-medium text-foreground">Remaining capacity</dt>
        <dd className="text-fs-base font-semibold tabular-nums text-foreground">{num(remaining)}</dd>
      </div>
    </dl>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums capitalize text-foreground">{value}</dd>
    </div>
  )
}
