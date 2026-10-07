// RD-PHOTO-01 · Photos are a PAID event service: no free allowance, at most 3,000 per event, bought
// ONLY on License & Services, never sold by Media Studio. The pure rule, the purchase UI's ceiling,
// the Import gate, and the absence of any Media Studio payment path.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  MAX_EVENT_PHOTO_CAPACITY, checkPhotoPurchase, maxAdditionalPhotos, paidPhotoCapacity, photoCapacityFigures, mediaUnitsIn,
} from '@/lib/licensing/photoCapacity'
import { newPhotoUnits, checkPhotoSelection } from '@/lib/licensing/photoCapacityServer'
import { ServiceQuantitySelector, type ServiceCatalogEntry } from '@/components/wizard/ServiceQuantitySelector'
import { photoCapacityVerdict } from '@/features/media-studio/components/PhotoCapacityCard'
import { SERVICE_LABELS, DEFAULT_SERVICE_ALLOWANCES } from '@/lib/licensing/serviceAllowances'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: { collection: () => { throw new Error('not in unit tests') } } }))

const read = (p: string) => readFileSync(p, 'utf8')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
}

describe('the 3,000 rule (server, pure)', () => {
  it('is exactly 3,000', () => { expect(MAX_EVENT_PHOTO_CAPACITY).toBe(3000) })
  it.each([
    [0, 3000, true], [0, 3001, false],          // #3 / #4
    [500, 2500, true], [500, 2501, false],      // #5 / #6
    [2999, 1, true],                            // #7
    [3000, 1, false], [3000, 0, true],          // #8
    [1000, 2000, true], [2500, 500, true], [2500, 501, false],
  ])('capacity %i + %i ⇒ allowed=%s', (cap, add, ok) => {
    expect(checkPhotoPurchase(cap, add).ok).toBe(ok)
  })
  it('max additional = 3,000 − capacity, never negative', () => {
    expect([0, 500, 1000, 2500, 3000, 3200].map(maxAdditionalPhotos)).toEqual([3000, 2500, 2000, 500, 0, 0])
  })
  it('#17 · capacity is PAID units only — nothing for merely existing', () => {
    expect(paidPhotoCapacity(undefined)).toBe(0)
    expect(paidPhotoCapacity({ purchased: 1000, carriedIn: 200, carriedOut: 100, refunded: 300 })).toBe(800)
    expect(photoCapacityFigures(0, 0)).toMatchObject({ capacity: 0, remaining: 0, maxAdditional: 3000 })
    expect(photoCapacityFigures(500, 125)).toMatchObject({ capacity: 500, used: 125, remaining: 375 })
  })
  it('#9 · draft quantities are a TOTAL (only the shortfall is new); published are ADDITIONAL', () => {
    const ledger = { capacity: 1200, purchased: 1000 }   // 1,000 bought + 200 carried in
    expect(newPhotoUnits('draft', 1500, ledger)).toBe(500)
    expect(newPhotoUnits('published', 1500, ledger)).toBe(1500)
    expect(checkPhotoSelection('draft', 2800, ledger).ok).toBe(true)     // 1,200 + 1,800 = 3,000
    expect(checkPhotoSelection('draft', 2801, ledger).ok).toBe(false)
    expect(checkPhotoSelection('published', 1801, ledger).ok).toBe(false)
  })
  it('only media lines count toward the cap', () => {
    expect(mediaUnitsIn([{ service: 'media', quantity: 7 }, { service: 'whatsapp', quantity: 900 }])).toBe(7)
  })
})

describe('License & Services · the photo quantity never offers more than the event may hold', () => {
  const catalog: ServiceCatalogEntry = { purchasable: true, missing: [], state: 'available', minQuantity: 1, maxQuantity: null, presets: [], unitPricePaise: 190, gstRatePercent: 18, onExhausted: 'block' }
  const render = (ceiling: number | null, quantity = 0) => renderToStaticMarkup(createElement(ServiceQuantitySelector, {
    title: 'Photos to purchase', unit: 'photo', units: 'photos', usageRule: 'x', quantity, onChange: () => {}, catalog, item: null, error: null,
    mode: 'additional', ceiling, maxReachedMessage: 'Maximum photo capacity reached (3,000)',
  }))
  it('capacity 2,500 ⇒ presets 100 / 500 only, range 1–500, slider ends at 500', () => {
    const html = render(500)
    expect(html).toContain('>100<'); expect(html).toContain('>500<')
    for (const p of ['1,000', '2,500', '5,000', '10,000']) expect(html).not.toContain(`>${p}<`)
    expect(html).toContain('1–500 photos')
    expect(html).toContain('max="500"')
    expect(html).not.toContain('No maximum')
    expect(html).not.toContain('+</span>')
  })
  it('capacity 0 ⇒ up to 3,000 and never 5,000 / 10,000', () => {
    const html = render(3000)
    expect(html).toContain('>2,500<')
    expect(html).not.toContain('>5,000<'); expect(html).not.toContain('>10,000<')
    expect(html).toContain('1–3,000 photos')
  })
  it('capacity 3,000 ⇒ "Maximum photo capacity reached", nothing selectable', () => {
    const html = render(0)
    expect(html).toContain('Maximum photo capacity reached (3,000)')
    expect(html).not.toContain('type="range"')
    expect(html).toContain('disabled=""')
  })
  it('the media line is named for what it is — and has no free base', () => {
    expect(SERVICE_LABELS.media.title).toBe('Event photo capacity')
    expect(DEFAULT_SERVICE_ALLOWANCES.media.unitPricePaise).toBeGreaterThan(0)   // every unit is priced
    const step = read('components/wizard/LicenseServicesStep.tsx')
    expect(step).toContain('there are no free photos')
    expect(step).not.toMatch(/Photo limit \{|Additional event photos|account-wide media credits/)
  })
})

describe('Media Studio · upload requires paid capacity; it never sells photos', () => {
  const v = (capacity: number, used: number, queued: number) =>
    photoCapacityVerdict({ capacity, used, remaining: Math.max(0, capacity - used), max: 3000, purchaseHref: '/x' }, false, queued)
  it('#16 · capacity 0 ⇒ "required"; full ⇒ "full"; 100 queued with 50 left ⇒ "over"; 25 ⇒ ok', () => {
    expect(v(0, 0, 1)).toBe('required')
    expect(v(10, 10, 1)).toBe('full')
    expect(v(100, 50, 100)).toBe('over')
    expect(v(100, 50, 25)).toBe('ok')
    expect(photoCapacityVerdict(null, true, 3)).toBe('loading')
  })
  it('#16 · the Import page gates BOTH Start buttons on that verdict and links only to License & Services', () => {
    const imp = read('features/media-studio/components/ImportClient.tsx')
    expect(imp).toContain('canStart={Boolean(gallery) && canImport && queue.items.length > 0 && capacityAllowsStart}')
    expect(imp).toContain('disabled={!gallery || !canImport || !capacityAllowsStart}')
    const card = read('features/media-studio/components/PhotoCapacityCard.tsx')
    expect(card).toContain('Go to License &amp; Services')
    expect(card).toContain('Photo capacity required.')
  })
  it('#15 · no Razorpay, checkout, credit purchase or top-up anywhere in Media Studio (organizer side)', () => {
    const files = [...walk('features/media-studio'), ...walk('app/(dashboard)/dashboard/media-studio')]
      .filter(f => !/[\\/]tests?[\\/]/.test(f))
    expect(files.length).toBeGreaterThan(20)
    for (const f of files) {
      const s = read(f)
      expect([f, /openRazorpayCheckout|razorpay\.orders|BuyCreditsDialog|media-credits\/purchases|wallet\/topup/i.test(s)]).toEqual([f, false])
      expect([f, /Buy credits|Purchase credits|Add credits|Top up now|Credits are not required/.test(s)]).toEqual([f, false])
    }
  })
  it('#15 · the retired Media Credits purchase UI is gone and the Credits route only explains', () => {
    const page = read('app/(dashboard)/dashboard/media-studio/credits/page.tsx')
    expect(page).not.toMatch(/CreditsDashboardClient|BuyCredits|Razorpay/)
    expect(page).toContain('Media Credits are no longer used')
    expect(read('features/media-studio/components/MediaStudioHub.tsx')).not.toContain('MEDIA_STUDIO_CREDITS')
  })
  it('#24 · the credit policy is OFF regardless of stored configuration (no second entitlement)', () => {
    const svc = read('features/media-credits/services/index.ts')
    expect(svc).toContain('export const MEDIA_CREDITS_RETIRED = true')
    expect(svc).toContain('creditsEnabled:       MEDIA_CREDITS_RETIRED ? false : m.creditsEnabled')
  })
  it('the upload routes no longer consult Media Credits; completion requires the reservation', () => {
    expect(read('app/api/organizer/media-studio/uploads/prepare/route.ts')).not.toMatch(/getCreditPolicy|openSession|ledgerService/)
    expect(read('app/api/organizer/media-studio/uploads/complete/route.ts')).not.toMatch(/getCreditPolicy|consumeInTx/)
    expect(read('features/media-studio/repositories/assetRepo.ts')).toContain('throw new UnreservedAssetError()')
  })
})

describe('Wallet + Super Admin read the same photo state', () => {
  it('#13/#14 · refundable = this event’s own UNUSED paid units; used = every photo holding capacity', () => {
    const s = read('lib/wallet/serviceRequests.ts')
    expect(s).toContain('const ownUsed = Math.min(l.purchased, used)')
    expect(s).toContain('s.ownUnused = Math.max(0, l.purchased - ownUsed - l.carriedOut - l.refunded)')
    expect(s).not.toContain('baseCap !== null && stored !== null')
  })
  it('the Wallet photo card has no organizer-wide credits link and stops at the maximum', () => {
    const w = read('app/(dashboard)/dashboard/wallet/EventWalletClient.tsx')
    expect(w).not.toContain('Photo credits')
    expect(w).toContain("'Maximum photo capacity reached'")
    expect(read('lib/wallet/eventWalletService.ts')).toContain("baseCap: 0, purchased, cap: purchased")
  })
})
