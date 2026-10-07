// RD-CAPACITY-01 · Server-only. THE single runtime source of an event's commercial terms.
//
// Resolution order, highest wins:
//
//   1. the event's OWN stored terms          — events/{slug}.commercial  (admin override,
//                                              or the snapshot frozen at activation)
//   2. the global defaults                   — businessConfig.licensing.commercial
//   3. the platform code defaults            — DEFAULT_COMMERCIAL_TERMS
//
// ═══ WHY THE EVENT LAYER OUTRANKS THE GLOBAL ONE ════════════════════════════
// A Super Admin who changes the activation rate tomorrow must not change what an event
// already activated under today's rate would be charged to change its capacity, and must
// never change what a completed payment says it charged. So an activated event carries its
// own terms, and this resolver prefers them. Changing the global rate therefore affects
// events that have NOT yet stored terms — new ones — which is the intended behaviour and
// the reason nothing here writes.
//
// The per-event value is a PARTIAL: `normalizeCommercialTerms` keeps the fields it can
// validate and falls back to the global layer for the rest, so an admin who overrides only
// the rate for one event does not have to restate the other five, and one corrupt field
// cannot take that event's pricing offline.

import { adminDb }      from '@/lib/firebase/admin'
import { businessConfig } from '@/lib/config/businessConfigService'
import {
  DEFAULT_COMMERCIAL_TERMS,
  normalizeCommercialTerms,
  assessStoredCommercialTerms,
  type CommercialTerms,
} from './capacityCommercial'

/** The field on events/{slug} that holds an event's own commercial terms. */
export const EVENT_COMMERCIAL_FIELD = 'commercial'

// ═══ RD-EVENT-COMMERCE-04A · FAIL CLOSED on a corrupt or unreadable global group ═══
// The previous rule fell back to the code defaults whenever the stored config was invalid or
// could not be read. That is NOT provably safe: an admin who set ₹3.00 and whose stored value
// was later corrupted would silently be charging ₹1.50 — an unintended underpriced order. The
// defaults are used only when the group was NEVER configured (or a key is simply absent).
//
//   absent            → approved code defaults (unchanged behaviour)
//   valid             → the stored values
//   invalid / unreadable → COMMERCIAL_TERMS_UNAVAILABLE: every quote function refuses it with
//                       INVALID_TERMS, so no activation, capacity change, add-on or publish that
//                       needs a price can proceed until an admin corrects the configuration.
// Nothing here repairs or rewrites the stored doc.

/**
 * Deliberately INVALID terms (negative rate) handed to charging paths when the global group
 * cannot be trusted. `isCommercialTerms` rejects it, and every quote function begins with that
 * check, so it can only ever produce a refusal — never an amount.
 */
export const COMMERCIAL_TERMS_UNAVAILABLE: Readonly<CommercialTerms> = Object.freeze({
  ...DEFAULT_COMMERCIAL_TERMS, activationRatePaise: -1,
})

export type GlobalCommercialTermsResolution =
  | { ok: true;  terms: CommercialTerms; source: 'defaults' | 'configured' }
  | { ok: false; reason: 'CONFIG_INVALID' | 'CONFIG_UNREADABLE'; errors: string[] }

/** The global terms WITH their integrity verdict. Use this where the caller must explain a refusal. */
export async function resolveGlobalCommercialTerms(): Promise<GlobalCommercialTermsResolution> {
  try {
    const { stored, loadFailed } = await businessConfig.getStoredLayer()
    if (loadFailed) {
      return { ok: false, reason: 'CONFIG_UNREADABLE', errors: ['The business configuration could not be read.'] }
    }
    const rawGroup = (stored.licensing as Record<string, unknown> | undefined)?.commercial
    const integrity = assessStoredCommercialTerms(rawGroup)
    if (integrity.state === 'invalid') return { ok: false, reason: 'CONFIG_INVALID', errors: integrity.errors }
    const licensing = await businessConfig.getSection('licensing')
    return {
      ok: true,
      terms: normalizeCommercialTerms(licensing.commercial, DEFAULT_COMMERCIAL_TERMS),
      source: integrity.state === 'absent' ? 'defaults' : 'configured',
    }
  } catch {
    return { ok: false, reason: 'CONFIG_UNREADABLE', errors: ['The business configuration could not be read.'] }
  }
}

/** The GLOBAL terms for CHARGING paths. Fails closed (see COMMERCIAL_TERMS_UNAVAILABLE). */
export async function getGlobalCommercialTerms(): Promise<CommercialTerms> {
  const r = await resolveGlobalCommercialTerms()
  if (r.ok) return r.terms
  console.error(`[commercial] global capacity pricing unavailable (${r.reason}) — refusing to price: ${r.errors.join('; ')}`)
  return { ...COMMERCIAL_TERMS_UNAVAILABLE }
}

/**
 * DISPLAY-ONLY terms (public pricing page, entitlements summary). Never used to charge: when the
 * configured group is unusable it shows the approved published model rather than an invalid
 * value, while every charging path refuses.
 */
export async function getDisplayCommercialTerms(): Promise<CommercialTerms> {
  const r = await resolveGlobalCommercialTerms()
  return r.ok ? r.terms : { ...DEFAULT_COMMERCIAL_TERMS }
}

/**
 * Apply an event's stored partial terms onto the global ones. PURE — exported separately
 * so a caller that already holds the event document (a transaction, a route that read it
 * for other reasons) resolves the terms without a second read.
 */
export function resolveEventCommercialTerms(
  storedEventTerms: unknown,
  globalTerms:      CommercialTerms,
): CommercialTerms {
  return normalizeCommercialTerms(storedEventTerms, globalTerms)
}

/**
 * The EFFECTIVE terms for one event, by id/slug. Reads the event document; a missing
 * event (a draft that has never been published) resolves to the global terms, which is
 * what a first activation must be priced against.
 */
export async function getEventCommercialTerms(eventId: string): Promise<CommercialTerms> {
  const globalTerms = await getGlobalCommercialTerms()
  if (!eventId) return globalTerms
  try {
    const snap = await adminDb.collection('events').doc(eventId).get()
    if (!snap.exists) return globalTerms
    const stored = (snap.data() as Record<string, unknown> | undefined)?.[EVENT_COMMERCIAL_FIELD]
    return resolveEventCommercialTerms(stored, globalTerms)
  } catch {
    return globalTerms
  }
}
