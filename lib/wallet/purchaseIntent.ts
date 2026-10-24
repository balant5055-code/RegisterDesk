// lib/wallet/purchaseIntent.ts
// The Wallet's "Increase Limit" hand-off into the EXISTING purchase flow — the event wizard's
// License & Services step (draft add-ons and published capacity / service purchases), never a
// parallel checkout. Client-only (sessionStorage); it carries only navigation intent: which event,
// which service to bring into view, and where to return. Prices, quantities and payment are
// decided by that step and its server routes exactly as before.
//
//   Wallet ──Increase Limit──▶ /dashboard/events/new/visibility?draftId=…&step=license&service=…&returnTo=…
//          ◀──── after a VERIFIED purchase (published events) the step returns to `returnTo`
//                (the Wallet, or — RD-PURCHASE-RETURN-01 — the Certificates tab / Broadcasts it came from)

import type { RequestableService } from './serviceRequestRules'

const KEY = 'rd_wallet_purchase_intent'
const TTL_MS = 60 * 60 * 1000
// RD-PRINT-BILL-P6 — 'print_badges' lands on License & Services' own ID badges section (published events).
const SERVICES: readonly RequestableService[] = ['registrations', 'whatsapp', 'certificates', 'media', 'print_badges']

export interface PurchaseIntent {
  draftId:  string
  service:  RequestableService | null
  returnTo: string
  at:       number
}

/**
 * RD-PURCHASE-RETURN-01 — the ONLY return targets (never an arbitrary / external URL): the Wallet,
 * an event's Certificates tab, and the Broadcasts composer. Exact shapes — no extra parameters, no
 * fragments. Checked when the hand-off is built (increaseLimitHref), recorded (intentFromParams) and
 * consumed (readIntent). Navigation only — never authorization: the draft is scoped by its id and
 * every purchase is verified server-side, wherever the organizer lands afterwards.
 */
const RETURN_TARGETS: readonly { re: RegExp; label: string }[] = [
  { re: /^\/dashboard\/wallet(\?eventId=[A-Za-z0-9_-]{1,128})?$/,                label: 'Return to Wallet' },
  { re: /^\/dashboard\/events\/[A-Za-z0-9_-]{1,128}\?tab=certificates$/,          label: 'Return to Certificates' },
  { re: /^\/dashboard\/communications\/broadcasts(\?event=[A-Za-z0-9_-]{1,200})?$/, label: 'Return to Broadcasts' },
]

export function safeReturnTo(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return RETURN_TARGETS.some(t => t.re.test(v)) ? v : null
}

/** The link text for a (validated) return target — named after where it actually goes. */
export function returnLabelFor(returnTo: string): string {
  return RETURN_TARGETS.find(t => t.re.test(returnTo))?.label ?? 'Return to Wallet'
}

export const walletHrefFor = (draftId: string) => `/dashboard/wallet?eventId=${encodeURIComponent(draftId)}`
/** RD-PURCHASE-RETURN-01 — the event's Certificates tab (`draftId` is the dashboard event id). */
export const certificatesTabHrefFor = (draftId: string) => `/dashboard/events/${encodeURIComponent(draftId)}?tab=certificates`
/** RD-PURCHASE-RETURN-01 — the Broadcasts composer, preselecting the event by its public slug. */
export const broadcastsHrefFor = (eventSlug?: string | null) =>
  eventSlug ? `/dashboard/communications/broadcasts?event=${encodeURIComponent(eventSlug)}` : '/dashboard/communications/broadcasts'

/**
 * `returnTo` defaults to the Wallet — the existing behaviour for every Wallet-started purchase. A
 * target outside the allow-list is replaced by the Wallet, never passed through.
 */
export function increaseLimitHref(draftId: string, service: RequestableService, returnTo?: string | null): string {
  const qs = new URLSearchParams({ draftId, step: 'license', service, returnTo: safeReturnTo(returnTo) ?? walletHrefFor(draftId) })
  return `/dashboard/events/new/visibility?${qs.toString()}`
}

/** Reads the hand-off from the relay's query string (null when it is not one). */
export function intentFromParams(p: { get(k: string): string | null }, now = Date.now()): PurchaseIntent | null {
  const draftId = p.get('draftId')
  if (!draftId || !/^[A-Za-z0-9_-]{1,128}$/.test(draftId) || p.get('step') !== 'license') return null
  const returnTo = safeReturnTo(p.get('returnTo'))
  if (!returnTo) return null
  const s = p.get('service')
  return { draftId, service: SERVICES.includes(s as RequestableService) ? s as RequestableService : null, returnTo, at: now }
}

export function saveIntent(i: PurchaseIntent | null): void {
  try { if (i) sessionStorage.setItem(KEY, JSON.stringify(i)); else sessionStorage.removeItem(KEY) } catch { /* storage unavailable */ }
}

/** The pending hand-off for THIS draft (expired or other-draft intents are ignored). */
export function readIntent(draftId: string | null | undefined, now = Date.now()): PurchaseIntent | null {
  if (!draftId) return null
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const i = JSON.parse(raw) as PurchaseIntent
    if (i.draftId !== draftId || now - i.at > TTL_MS || !safeReturnTo(i.returnTo)) return null
    return i
  } catch { return null }
}

export const clearIntent = () => saveIntent(null)
