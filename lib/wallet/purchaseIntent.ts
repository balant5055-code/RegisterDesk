// lib/wallet/purchaseIntent.ts
// The Wallet's "Increase Limit" hand-off into the EXISTING purchase flow — the event wizard's
// License & Services step (draft add-ons and published capacity / service purchases), never a
// parallel checkout. Client-only (sessionStorage); it carries only navigation intent: which event,
// which service to bring into view, and where to return. Prices, quantities and payment are
// decided by that step and its server routes exactly as before.
//
//   Wallet ──Increase Limit──▶ /dashboard/events/new/visibility?draftId=…&step=license&service=…&returnTo=…
//          ◀──── after a VERIFIED purchase (published events) the step returns to `returnTo`

import type { RequestableService } from './serviceRequestRules'

const KEY = 'rd_wallet_purchase_intent'
const TTL_MS = 60 * 60 * 1000
const SERVICES: readonly RequestableService[] = ['registrations', 'whatsapp', 'certificates', 'media']

export interface PurchaseIntent {
  draftId:  string
  service:  RequestableService | null
  returnTo: string
  at:       number
}

/** Only the Wallet itself may be a return target (never an arbitrary / external URL). */
export function safeReturnTo(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (!/^\/dashboard\/wallet(\?eventId=[A-Za-z0-9_-]{1,128})?$/.test(v)) return null
  return v
}

export const walletHrefFor = (draftId: string) => `/dashboard/wallet?eventId=${encodeURIComponent(draftId)}`

export function increaseLimitHref(draftId: string, service: RequestableService): string {
  const qs = new URLSearchParams({ draftId, step: 'license', service, returnTo: walletHrefFor(draftId) })
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
