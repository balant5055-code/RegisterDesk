// RD-WA-TEMPLATES-01 — Meta template status / reason normalization. PURE, client-safe.
//
// Source: Meta's `message_template_status_update` webhook reference and the template `status`
// field — APPROVED, PENDING, REJECTED, PAUSED, DISABLED, FLAGGED, REINSTATED, IN_APPEAL,
// LIMIT_EXCEEDED, LOCKED, UNLOCKED, ARCHIVED, UNARCHIVED, PENDING_DELETION, DELETED. Anything else
// becomes 'unknown' (and is stored verbatim as `rawStatus`) — never guessed into a sendable state.

import type { MetaStatus } from './types'

const MAP: Record<string, MetaStatus> = {
  APPROVED: 'approved', REINSTATED: 'approved', UNPAUSED: 'approved',
  PENDING: 'pending', IN_REVIEW: 'pending',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
  FLAGGED: 'flagged',
  IN_APPEAL: 'in_appeal',
  LOCKED: 'locked',
  LIMIT_EXCEEDED: 'limit_exceeded',
  ARCHIVED: 'archived',
  PENDING_DELETION: 'deleted', DELETED: 'deleted',
}

/** Meta's status/event string → RegisterDesk's MetaStatus ('unknown' when not recognised). */
export function normalizeMetaStatus(raw: unknown): MetaStatus {
  if (typeof raw !== 'string') return 'unknown'
  return MAP[raw.trim().toUpperCase()] ?? 'unknown'
}

/**
 * Events that do not, by themselves, say what the template's status now is (UNLOCKED, UNARCHIVED:
 * "back to what it was"). The handler records them and asks Meta for the current status instead.
 */
export function isStatusRestoringEvent(raw: unknown): boolean {
  return typeof raw === 'string' && ['UNLOCKED', 'UNARCHIVED'].includes(raw.trim().toUpperCase())
}

/** Meta's category string → 'utility' | 'marketing' | 'authentication' | null. */
export function normalizeMetaCategory(raw: unknown): 'utility' | 'marketing' | 'authentication' | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  return v === 'utility' || v === 'marketing' || v === 'authentication' ? v : null
}

/** A rejection reason as Meta sent it ('NONE' and empty mean "no reason given"). */
export function normalizeRejectionReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toUpperCase()
  return v && v !== 'NONE' ? v : null
}
