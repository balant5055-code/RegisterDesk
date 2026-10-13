// RD-PRINT-P8 (W5) · The paid ID-badge PILOT — which organizers may buy badge units and use paid
// badge generation. PURE (no Firestore; safe in client bundles — the Business Configuration editor
// validates with it).
//
//   licensing.printBadgePilot = { enforced: true, organizerUids: string[] }   (workspace OWNER uids)
//
// The authority is the STORED Business Configuration document only (never the resolved view, whose
// read failures silently fall back to code defaults, and never a client value). Fail closed:
//   absent ............ enforced, empty list ⇒ NOBODY is in the pilot
//   malformed ......... { ok: false, reason: 'invalid' }      ⇒ callers deny
//   unreadable ........ { ok: false, reason: 'unavailable' }  ⇒ callers deny / 503 (printBadgePilotServer.ts)
//   enforced: false ... treated as INVALID while PILOT_ENFORCEMENT_LOCKED — opening paid badges to every
//                       organizer is a separately approved code change, never a configuration edit.
// Membership adds nothing on its own: the code release gates, the catalog, GST approval and every
// other purchase / billing check still apply to a pilot organizer.

import type { EffectivePrintBadgeTerms } from './printBadgeCommercial'

export const PRINT_BADGE_PILOT_MAX_ORGANIZERS = 200
/** A Firebase Auth uid (the workspace owner's), as stored on orders and jobs. */
export const PRINT_BADGE_PILOT_UID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** While true, `enforced: false` can neither be saved nor honoured (general availability needs a code change). */
export const PILOT_ENFORCEMENT_LOCKED = true

export interface PrintBadgePilotConfig { enforced: boolean; organizerUids: string[] }

export const DEFAULT_PRINT_BADGE_PILOT: Readonly<PrintBadgePilotConfig> = Object.freeze({ enforced: true, organizerUids: [] })

const PATH = 'licensing.printBadgePilot'
const KEYS = new Set(['enforced', 'organizerUids'])

/** Validation for a stored or submitted pilot setting (errors only; the enforcement lock is separate). */
export function validatePrintBadgePilot(v: unknown, path = PATH): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [`${path} must be an object`]
  const o = v as Record<string, unknown>
  const errors: string[] = []
  for (const k of Object.keys(o)) if (!KEYS.has(k)) errors.push(`${path}.${k} is not a recognised setting`)
  if (typeof o.enforced !== 'boolean') errors.push(`${path}.enforced must be true or false`)
  if (!Array.isArray(o.organizerUids)) {
    errors.push(`${path}.organizerUids must be a list of organizer uids`)
  } else {
    if (o.organizerUids.length > PRINT_BADGE_PILOT_MAX_ORGANIZERS) errors.push(`${path}.organizerUids cannot list more than ${PRINT_BADGE_PILOT_MAX_ORGANIZERS} organizers`)
    const bad = o.organizerUids.filter(u => typeof u !== 'string' || !PRINT_BADGE_PILOT_UID_RE.test(u))
    if (bad.length) errors.push(`${path}.organizerUids contains ${bad.length} value(s) that are not organizer uids`)
    if (new Set(o.organizerUids).size !== o.organizerUids.length) errors.push(`${path}.organizerUids contains duplicates`)
  }
  return errors
}

/** Valid values that are LOCKED: switching enforcement off. */
export function printBadgePilotLocks(v: unknown): string[] {
  const o = typeof v === 'object' && v !== null ? v as Record<string, unknown> : null
  return PILOT_ENFORCEMENT_LOCKED && o?.enforced === false
    ? ['ID badge pilot: opening paid ID badges to every organizer is locked — only listed pilot organizers can take part.']
    : []
}

export type PrintBadgePilotRead =
  | { ok: true; organizerUids: ReadonlySet<string> }
  | { ok: false; reason: 'unavailable' | 'invalid' }

/** Interprets the STORED value (`undefined` = never configured). Pure; the caller reports read failures. */
export function parsePrintBadgePilot(stored: unknown): PrintBadgePilotRead {
  if (stored === undefined) return { ok: true, organizerUids: new Set() }
  if (validatePrintBadgePilot(stored).length > 0) return { ok: false, reason: 'invalid' }
  const o = stored as PrintBadgePilotConfig
  if (o.enforced !== true) return { ok: false, reason: 'invalid' }    // see PILOT_ENFORCEMENT_LOCKED
  return { ok: true, organizerUids: new Set(o.organizerUids) }
}

/** Whether `uid` is a pilot organizer. A failed or invalid read is never membership. */
export function isPilotOrganizer(read: PrintBadgePilotRead, uid: unknown): boolean {
  return read.ok && typeof uid === 'string' && read.organizerUids.has(uid)
}

/**
 * Effective badge terms for an organizer OUTSIDE the pilot: free, whatever the global switch and the
 * event override say (the override can only make an event free or complimentary, never paid). A
 * pilot organizer's terms are returned unchanged.
 */
export function withPilotMembership(terms: EffectivePrintBadgeTerms, member: boolean): EffectivePrintBadgeTerms {
  if (member || terms.mode === 'free') return terms
  return { ...terms, mode: 'free', reason: 'not_in_pilot', chargeable: false }
}
