// RD-PRINT-BILL-P4 · The server-side badge purchase QUOTE. Server-only. Read-only: a quote (and a
// coupon preview inside it) never writes and never consumes coupon usage.
//
// Fails CLOSED, in this order — the first refusal wins:
//   1. the code release gate (RELEASED_FOR_PURCHASE.print_badges) — authoritative, even for free coupons
//   1b. RD-PRINT-P8 — the workspace owner is a paid ID-badge PILOT organizer (stored config only;
//       unreadable ⇒ 503, malformed ⇒ refused, not listed ⇒ PILOT_ONLY)
//   2. the caller is the workspace OWNER (a general `events` permission is not enough)
//   3. the live event belongs to the workspace and is published (not cancelled / completed / archived)
//   4. the event override is readable and the event's badges are not free / complimentary
//   5. the catalog: readable, switched on for sale, priced
//   6. a GST rate is configured AND a recorded approval matches that rate and the tax treatment
//   7. the quantity (100 – 100,000, or the stricter configured bounds)
//   8. the coupon (if any), validated on the GST-inclusive gross exactly as redemption will
//   9. the net amount is chargeable (0, or at least ₹1)

import { adminDb } from '@/lib/firebase/admin'
import { businessConfig } from '@/lib/config/businessConfigService'
import { effectiveLifecycleStatus } from '@/lib/events/listingTabs'
import { isServicePurchaseReleased } from '../serviceAllowances'
import { getServiceCatalog } from '../serviceAllowanceConfig'
import { readStoredPrintBadgeOverride } from '../printBadgeCommercial'
import { getBadgeCoupon, getBadgeCouponOrganizerCount, getAllowFreeBadgeCoupons } from '../badgeCoupons/store'
import { normalizeBadgeCouponCode, BADGE_COUPON_CODE_RE, validateBadgeCoupon } from '../badgeCoupons/validate'
import { readBadgeTaxApproval } from './taxApproval'
import { readPrintBadgePilot } from '../printBadgePilotServer'
import { isPilotOrganizer } from '../printBadgePilot'
import {
  BADGE_ORDER_PURPOSE, isBadgePurchaseLifecycle, quantityBounds, buildBadgeSnapshot, badgeTaxApprovalProblem,
  type BadgePurchaseSnapshot, type BadgeOrderCoupon,
} from './pricing'

export interface BadgeQuote {
  slug:         string
  draftId:      string
  organizerUid: string
  snapshot:     BadgePurchaseSnapshot
  /** The bounds the quantity was checked against (for the caller's display). */
  bounds:       { min: number; max: number }
}

export type BadgeQuoteResult =
  | { ok: true; quote: BadgeQuote }
  | { ok: false; status: number; code: string; message: string }

const SLUG_RE = /^[A-Za-z0-9_-]{1,128}$/
const no = (status: number, code: string, message: string): BadgeQuoteResult => ({ ok: false, status, code, message })

/** The live event, only when it belongs to this workspace (by uid) and names its draft. */
export async function readOwnedLiveEvent(slug: string, workspaceUid: string): Promise<{ ev: Record<string, unknown>; draftId: string } | null> {
  if (!SLUG_RE.test(slug)) return null
  const snap = await adminDb.collection('events').doc(slug).get()
  const ev = snap.exists ? snap.data() as Record<string, unknown> : null
  if (!ev || ev.uid !== workspaceUid || typeof ev.draftId !== 'string' || !SLUG_RE.test(ev.draftId)) return null
  return { ev, draftId: ev.draftId }
}

/** Pure, shared with settlement: may badges be bought for this live event document now? */
export function badgeEventProblem(ev: Record<string, unknown> | undefined, organizerUid: string, draftId: string): string | null {
  if (!ev || ev.uid !== organizerUid || ev.draftId !== draftId) return 'EVENT_NOT_FOUND'
  if (!isBadgePurchaseLifecycle(effectiveLifecycleStatus(ev))) return 'EVENT_NOT_ELIGIBLE'
  return null
}

export async function quoteBadgePurchase(args: {
  workspaceUid: string; isOwner: boolean; slug: string; quantity: unknown; couponCode?: unknown; nowMs?: number
  /** RD-PRINT-P8 — read the pilot bypassing the config cache (order creation: before any money). */
  freshPilot?: boolean
}): Promise<BadgeQuoteResult> {
  const nowMs = args.nowMs ?? Date.now()
  // 1 — the code gate is authoritative (no configuration, coupon or free order can bypass it).
  if (!isServicePurchaseReleased(BADGE_ORDER_PURPOSE)) return no(403, 'NOT_RELEASED', 'ID badge purchases are not available yet.')
  // 1b — RD-PRINT-P8: pilot organizers only (the workspace OWNER uid — the organizer the order is for).
  const pilot = await readPrintBadgePilot({ fresh: args.freshPilot === true })
  if (!pilot.ok) {
    return pilot.reason === 'unavailable'
      ? no(503, 'CONFIG_UNAVAILABLE', 'Badge pricing could not be read. Please try again.')
      : no(409, 'PILOT_CONFIG_INVALID', 'ID badge purchases are paused while RegisterDesk corrects the pilot settings.')
  }
  if (!isPilotOrganizer(pilot, args.workspaceUid)) return no(403, 'PILOT_ONLY', 'ID badge purchases are open to pilot organizers only.')
  // 2 — owner only.
  if (!args.isOwner) return no(403, 'OWNER_REQUIRED', 'Only the event owner can buy badges.')
  // 3 — the live event.
  const live = await readOwnedLiveEvent(args.slug, args.workspaceUid)
  if (!live) return no(404, 'EVENT_NOT_FOUND', 'Event not found.')
  const evProblem = badgeEventProblem(live.ev, args.workspaceUid, live.draftId)
  if (evProblem) return no(409, evProblem, 'Badges can be bought only for a published event that is not cancelled, completed or archived.')
  // 4 — the event override.
  const ov = readStoredPrintBadgeOverride(live.ev.printBadgeCommercial)
  if (!ov.ok) return no(409, 'OVERRIDE_UNREADABLE', 'This event’s badge settings need attention from RegisterDesk before badges can be bought.')
  if (ov.override?.enabled === false || ov.override?.complimentary === true) {
    return no(409, 'BADGES_NOT_CHARGED', 'Badges for this event are free — no units are needed.')
  }
  // 5 — the catalog.
  const catalog = await getServiceCatalog()
  const state = catalog.state.print_badges
  if (state === 'unavailable') return no(503, 'CONFIG_UNAVAILABLE', 'Badge pricing could not be read. Please try again.')
  if (state === 'not_released') return no(403, 'NOT_RELEASED', 'ID badge purchases are not available yet.')
  if (state === 'disabled') return no(409, 'NOT_FOR_SALE', 'ID badges are not on sale right now.')
  if (state !== 'available') return no(409, 'PRICE_NOT_CONFIGURED', 'Badge pricing is not configured yet.')
  const cfg = catalog.config.print_badges
  // 6 — GST: configured AND approved for exactly this rate + treatment. Never assumed.
  const approval = await readBadgeTaxApproval()
  if (!approval.ok) return no(503, 'CONFIG_UNAVAILABLE', 'Badge pricing could not be read. Please try again.')
  const taxProblem = badgeTaxApprovalProblem(approval.approval, cfg.gstRatePercent)
  if (taxProblem) return no(409, taxProblem, 'Badge purchases are not available until the GST treatment is approved.')
  // 7 — quantity / price.
  const fromEvent = typeof ov.override?.unitPricePaise === 'number'
  const unitPricePaise = fromEvent ? ov.override!.unitPricePaise! : cfg.unitPricePaise
  const bounds = quantityBounds(cfg)
  const quantity = typeof args.quantity === 'number' ? args.quantity : NaN
  const configVersion = await businessConfig.getVersion().catch(() => null)
  const base = { quantity, unitPricePaise, priceSource: fromEvent ? 'event' as const : 'global' as const, configVersion, gstRatePercent: cfg.gstRatePercent, bounds, taxApprovalId: approval.approval!.approvalId }
  const plain = buildBadgeSnapshot({ ...base, coupon: null })
  if (!plain.ok) return no(plain.code === 'QUANTITY_INVALID' ? 400 : 409, plain.code, plain.message)

  // 8 — the coupon (read-only: validation never consumes usage).
  let coupon: BadgeOrderCoupon | null = null
  const rawCode = typeof args.couponCode === 'string' ? args.couponCode.trim() : ''
  if (rawCode) {
    const code = normalizeBadgeCouponCode(rawCode)
    if (!BADGE_COUPON_CODE_RE.test(code)) return no(409, 'COUPON_REFUSED', 'This coupon code is not valid.')
    const [doc, count, allowFree] = await Promise.all([
      getBadgeCoupon(code), getBadgeCouponOrganizerCount(code, args.workspaceUid), getAllowFreeBadgeCoupons(),
    ])
    if (!count.ok) return no(409, 'COUPON_REFUSED', 'This coupon’s usage could not be verified. Please try again.')
    const v = validateBadgeCoupon(doc, {
      organizerUid: args.workspaceUid, eventId: args.slug, purchasePaise: plain.snapshot.grossPaise,
      organizerRedemptions: count.count, eventCouponsAllowed: ov.override?.couponsAllowed ?? true, allowFreeCoupons: allowFree,
    }, nowMs)
    if (!v.ok) return { ok: false, status: 409, code: 'COUPON_REFUSED', message: v.message }
    coupon = { code, discountPaise: v.discountPaise, snapshot: v.snapshot, minPurchasePaise: doc?.minPurchasePaise ?? null }
  }
  // 9 — the final snapshot (refuses a net between 1 and 99 paise).
  const built = buildBadgeSnapshot({ ...base, coupon })
  if (!built.ok) return no(409, built.code, built.message)
  return { ok: true, quote: { slug: args.slug, draftId: live.draftId, organizerUid: args.workspaceUid, snapshot: built.snapshot, bounds } }
}
