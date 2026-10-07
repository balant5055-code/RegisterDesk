'use client'

// RD-PHOTO-01 · The event's PAID photo capacity on Import Media.
//
// Photos are a paid event service: every upload takes one unit of the capacity bought for THIS
// event on its License & Services step. This card answers, before anything is uploaded, how much
// the event has paid for, how much is used, and whether the queued batch fits. It starts no
// purchase — its only action is navigation to License & Services for the same event. The server
// (/uploads/prepare) enforces the same numbers; this card only mirrors them.

import Link from 'next/link'
import { AlertTriangle, Images, Loader2 } from 'lucide-react'
import { Card, StatusChip, buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

export interface PhotoCapacityView {
  capacity:      number
  used:          number
  remaining:     number
  max:           number
  purchaseHref:  string
}

export type PhotoCapacityVerdict = 'loading' | 'unknown' | 'required' | 'full' | 'over' | 'ok'

/** ONE rule for the card and the Start buttons: may a batch of `photoCount` start? */
export function photoCapacityVerdict(c: PhotoCapacityView | null, loading: boolean, photoCount: number): PhotoCapacityVerdict {
  if (loading) return 'loading'
  if (!c) return 'unknown'
  if (c.capacity <= 0) return 'required'
  if (c.remaining <= 0) return 'full'
  if (photoCount > c.remaining) return 'over'
  return 'ok'
}

export function PhotoCapacityCard({ capacity, loading, error, photoCount }: {
  capacity: PhotoCapacityView | null
  loading: boolean
  error: string | null
  photoCount: number
}) {
  const verdict = photoCapacityVerdict(capacity, loading, photoCount)
  const fmt = (n: number) => n.toLocaleString('en-IN')

  return (
    <Card className="p-4" aria-busy={loading || undefined}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-fs-sm font-semibold text-foreground">
          <Images className="size-4 text-muted-foreground" aria-hidden />
          Photo capacity
        </h2>
        {capacity && verdict !== 'loading' && (
          <StatusChip tone={verdict === 'ok' ? 'success' : verdict === 'over' ? 'warning' : 'danger'}>
            {fmt(capacity.remaining)} remaining
          </StatusChip>
        )}
      </div>

      {loading ? (
        <p className="mt-3 flex items-center gap-2 text-fs-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking this event’s photo capacity…
        </p>
      ) : error || !capacity ? (
        <p className="mt-2 flex items-start gap-2 text-fs-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error ?? 'Could not read this event’s photo capacity.'}
        </p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            {[['Purchased', capacity.capacity], ['Used', capacity.used], ['Remaining', capacity.remaining]].map(([l, v]) => (
              <div key={l as string} className="rounded-md border border-border px-2 py-1.5">
                <dt className="text-fs-2xs text-muted-foreground">{l}</dt>
                <dd className="text-fs-base font-semibold tabular-nums text-foreground">{fmt(v as number)}</dd>
              </div>
            ))}
          </dl>

          {verdict === 'required' && (
            <p className="mt-3 text-fs-sm text-foreground">
              <span className="font-semibold">Photo capacity required.</span>{' '}
              Purchase photo capacity for this event from License &amp; Services before uploading photos.
            </p>
          )}
          {verdict === 'full' && (
            <p className="mt-3 text-fs-sm text-foreground">
              This event’s paid photo capacity is fully used. Purchase more from License &amp; Services to upload more photos.
            </p>
          )}
          {verdict === 'over' && (
            <p className="mt-3 text-fs-sm text-foreground">
              {fmt(photoCount)} photos are queued but only {fmt(capacity.remaining)} remain. Remove{' '}
              {fmt(photoCount - capacity.remaining)} photos, or purchase more capacity from License &amp; Services.
            </p>
          )}
          {verdict === 'ok' && photoCount > 0 && (
            <p className="mt-3 text-fs-2xs text-muted-foreground">
              This upload uses {fmt(photoCount)} · {fmt(capacity.remaining - photoCount)} will remain.
            </p>
          )}
          <p className="mt-2 text-fs-2xs text-muted-foreground">
            Maximum {fmt(capacity.max)} photos per event.
          </p>

          {(verdict === 'required' || verdict === 'full' || verdict === 'over') && (
            <Link href={capacity.purchaseHref} className={cn(buttonVariants({ size: 'sm' }), 'mt-3 w-full justify-center')}>
              Go to License &amp; Services
            </Link>
          )}
        </>
      )}
    </Card>
  )
}
