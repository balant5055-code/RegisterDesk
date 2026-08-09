// RD-BADGE-01 · Finisher Badges — domain types.
//
// SDK-FREE by contract: no firebase-admin, no @aws-sdk, no next/*, no React. Firestore
// Timestamps are typed `unknown`, matching every existing document type in this codebase.
//
// ─── The security invariant ──────────────────────────────────────────────────
// A badge is derived from the OFFICIAL SNAPSHOT and nothing else. Import sessions and their
// draft results are never read by this module — `raceImportSessions` does not appear
// anywhere in its import graph. A badge therefore cannot exist for an unpublished result.

export const FINISHER_BADGES = 'finisherBadges'

/** Bump when the stored shape changes; readers refuse an unknown version. */
export const BADGE_SCHEMA_VERSION = 1

/** Bump when the DESIGN changes, so an old badge can be told from a current one and
 *  regenerated deliberately rather than by guesswork. */
export const BADGE_TEMPLATE_VERSION = 1

export const BADGE_WIDTH  = 1080
export const BADGE_HEIGHT = 1080
export const BADGE_MIME   = 'image/png'

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * `pending`   — the result is published; no badge image exists yet.
 * `generated` — the PNG is in object storage.
 * `failed`    — generation was attempted and did not succeed; `error` says why.
 */
export type BadgeStatus = 'pending' | 'generated' | 'failed'

export const BADGE_STATUS_LABEL: Readonly<Record<BadgeStatus, string>> = {
  pending:   'Pending',
  generated: 'Generated',
  failed:    'Failed',
}

// ─── The document ─────────────────────────────────────────────────────────────

/**
 * finisherBadges/{badgeId}
 *
 * `badgeId` is DETERMINISTIC — `{eventSlug}__{passId}__{BIBKEY}` — so generating the same
 * badge twice overwrites one record instead of creating two, and a regenerate is idempotent.
 *
 * Only metadata lives here. The PNG bytes live exclusively in object storage.
 */
export interface BadgeDoc {
  badgeId:         string
  schemaVersion:   number
  templateVersion: number

  // ── Scope. `organizerUid` is the tenant key and is NEVER included in a public view. ──
  organizerUid: string
  eventId:      string
  eventSlug:    string
  passId:       string
  passSlug:     string

  /** Normalised bib — the same key the snapshot entry is stored under. */
  bibKey:       string
  bibNumber:    string

  /** Snapshot version the badge was rendered from. A newer snapshot makes it stale. */
  snapshotVersion: number

  status:      BadgeStatus
  /** Storage KEY, never a URL. Null until generated. */
  path:        string | null
  size:        number
  visibility:  'PUBLIC' | 'SIGNED_URL'
  /** sha256 of the PNG bytes. */
  checksum:    string | null
  /** Organizer-facing failure reason. Null unless `status === 'failed'`. */
  error:       string | null

  generatedAt: unknown | null
  createdAt:   unknown
  updatedAt:   unknown
}

// ─── Render input ─────────────────────────────────────────────────────────────

/**
 * Everything the renderer needs. A plain, serialisable object with no Firestore or storage
 * types, so the design can be unit-tested and previewed without either.
 *
 * Assembled ONLY from the Official Snapshot (plus the published event's public logo).
 */
export interface BadgeRenderInput {
  eventName:   string
  eventDate:   string | null
  /** Absolute https URL of the event logo, or null. Optional by design — see the report. */
  eventLogoUrl: string | null
  raceName:    string
  runnerName:  string | null
  bibNumber:   string
  /** Formatted chip time, e.g. "01:48:32". Null for a non-finisher. */
  chipTime:    string | null
  /** Overall position. Null when unranked (DNF / DNS / DQ). */
  overallRank: number | null
  status:      'finished' | 'dnf' | 'dns' | 'dq'
  finisherCount: number
}

// ─── Views ────────────────────────────────────────────────────────────────────

/** What a PUBLIC surface may see. Carries no organizer identifier and no storage key. */
export interface PublicBadgeView {
  status:    BadgeStatus
  /** Resolved per visibility at read time; null when it cannot be resolved. */
  imageUrl:  string | null
  /** Stable page URL a participant can copy and share. */
  shareUrl:  string
  width:     number
  height:    number
}

/** Organizer-facing per-race roll-up for the Finisher Badges screen. */
export interface BadgeRaceStatusView {
  eventSlug:   string
  passSlug:    string
  raceName:    string
  /** Finishers in the published snapshot — the denominator. */
  eligible:    number
  generated:   number
  pending:     number
  failed:      number
  snapshotVersion: number
}

/** Deterministic id. Two identical inputs always address one record. */
export function badgeId(eventSlug: string, passId: string, bibKey: string): string {
  return `${eventSlug}__${passId}__${bibKey}`
}
