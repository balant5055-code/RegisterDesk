// CRM identity — normalized email is the single identity key, so the same person
// maps to ONE contact per organizer regardless of how they entered the system.

import crypto from 'crypto'
import type { CrmActivityType } from '@/lib/crm/types'

/** Lowercase + trim. (Intentionally does NOT strip +tags or dots — those can be
 *  distinct real addresses; merging them would conflate different people.) */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

/** Deterministic contact id — same (organizer, email) always yields the same id. */
export function contactIdFor(organizerUid: string, normalizedEmail: string): string {
  return sha256(`${organizerUid}:${normalizedEmail}`)
}

/** Deterministic activity id — dedupes replays / re-runs (no double counting). */
export function activityIdFor(contactId: string, type: CrmActivityType, entityId: string): string {
  return sha256(`${contactId}:${type}:${entityId}`)
}
