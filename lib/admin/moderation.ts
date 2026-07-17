// Shared content-moderation primitives for events and campaigns. Server-only.
//
// Moderation status lives on events/{slug} and donationCampaigns/{slug}. A
// missing moderationStatus is treated as 'active' EVERYWHERE (backward
// compatible — no migration). Public discovery, detail pages, and the
// registration/donation entry points all enforce this single source of truth.

export type ModerationStatus = 'active' | 'under_review' | 'taken_down'

/** Moderation fields layered onto an events/{slug} or donationCampaigns/{slug} doc. */
export interface ModerationFields {
  moderationStatus?: ModerationStatus
  moderationReason?: string
  moderationBy?:     string   // admin uid
  moderationAt?:     unknown   // Firestore Timestamp
}

export type ModerationCode = 'CONTENT_UNDER_REVIEW' | 'CONTENT_TAKEN_DOWN'

const MESSAGES: Record<ModerationCode, string> = {
  CONTENT_UNDER_REVIEW: 'This content is under review and temporarily unavailable.',
  CONTENT_TAKEN_DOWN:   'This content is no longer available.',
}

/** Thrown by assertContentAvailable when content is under review or taken down. */
export class ContentModerationError extends Error {
  constructor(public readonly code: ModerationCode) {
    super(MESSAGES[code])
    this.name = 'ContentModerationError'
  }
}

/** Normalises any value (incl. undefined) to an effective status. */
export function effectiveModerationStatus(status: ModerationStatus | undefined | null): ModerationStatus {
  return status === 'under_review' || status === 'taken_down' ? status : 'active'
}

/** True when content is publicly available (active or unset). */
export function isContentActive(status: ModerationStatus | undefined | null): boolean {
  return effectiveModerationStatus(status) === 'active'
}

/** True only when content has been taken down. */
export function isContentTakenDown(status: ModerationStatus | undefined | null): boolean {
  return effectiveModerationStatus(status) === 'taken_down'
}

/**
 * Strict guard: throws ContentModerationError when content is taken down OR
 * under review. Public enforcement that should block ONLY taken-down content
 * uses isContentTakenDown instead (under-review content stays live while an
 * admin investigates).
 */
export function assertContentAvailable(status: ModerationStatus | undefined | null): void {
  const eff = effectiveModerationStatus(status)
  if (eff === 'taken_down')   throw new ContentModerationError('CONTENT_TAKEN_DOWN')
  if (eff === 'under_review') throw new ContentModerationError('CONTENT_UNDER_REVIEW')
}
