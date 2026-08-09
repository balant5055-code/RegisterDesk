// PassPrice — the ONE way a pass price is rendered.
//
// RD-RT3.2.2 BUG 1. The early-bird strikethrough and badge existed in the sticky summary
// only. The pass selector, the pass picker, the review's pass card and the mobile
// checkout bar each printed a bare `₹{price}`, so the same pass showed a discount in one
// place and full price in another on the same screen.
//
// `price` is the EFFECTIVE price (early-bird resolved server-side by
// resolveEffectivePriceRupees in page.tsx); `regularPrice` is the undiscounted one.
// Early bird is therefore active exactly when regularPrice > price — the identical rule
// the summary already used, now stated once.
//
// NOT 'use client' on purpose: the server pass-picker screen and the client registration
// flow both import it, and it has no hooks or handlers.

import { cn } from '@/lib/utils/cn'

export const inr = (rupees: number) => `₹${rupees.toLocaleString('en-IN')}`

/** True when the effective price is below the regular one. */
export function isEarlyBird(price: number, regularPrice: number, isFree?: boolean): boolean {
  return !isFree && price > 0 && regularPrice > price
}

export function PassPrice({
  price, regularPrice, isFree, align = 'right', size = 'md', showBadge = true, className,
}: {
  price:        number
  regularPrice: number
  isFree?:      boolean
  align?:       'left' | 'right'
  /** sm — inline rows and the mobile bar. md — cards. lg — the summary total. */
  size?:        'sm' | 'md' | 'lg'
  /** Off where the surrounding copy already says "Early bird". */
  showBadge?:   boolean
  className?:   string
}) {
  const early = isEarlyBird(price, regularPrice, isFree)
  const free  = isFree || price <= 0

  const priceCls = size === 'lg' ? 'text-fs-lg font-bold' : size === 'md' ? 'text-fs-md font-bold' : 'text-fs-sm font-bold'

  return (
    <span className={cn('inline-flex flex-col', align === 'right' ? 'items-end' : 'items-start', className)}>
      {early && (
        <span className="text-fs-2xs text-muted-foreground line-through">{inr(regularPrice)}</span>
      )}
      <span className={cn(priceCls, 'tabular-nums', early ? 'text-emerald-600' : 'text-foreground')}>
        {free ? 'Free' : inr(price)}
      </span>
      {early && showBadge && (
        <span className="text-fs-2xs font-bold uppercase tracking-wide text-emerald-600">Early bird</span>
      )}
    </span>
  )
}
