// RD-BADGE-01 · Finisher Badges — the module's PUBLIC surface.
//
// ─── Contract ────────────────────────────────────────────────────────────────
//   • A badge is built from the OFFICIAL SNAPSHOT and nothing else. This module's import
//     graph contains no path to `raceImportSessions`, so a badge for an unpublished result
//     is not merely forbidden — it is unreachable.
//   • Bytes are stored ONLY through @/features/platform-storage. Cloudflare R2 is never named.
//   • Firestore holds metadata only; the PNG lives in object storage.
//   • No new RBAC — the organizer surface sits behind the existing Race Operations gate.

export { BadgeShare }        from './components/BadgeShare'
export { BadgeStatusClient } from './components/BadgeStatusClient'

export { ensureBadge, resolveBadgeUrl, readBadgeBytes } from './services/badgeService'
export type { BadgeOutcome, GenerateResult } from './services/badgeService'

// ── Pure design layer (no SDK, no React, no I/O — unit-tested) ──────────────
export {
  BADGE_COLORS, LIMITS, buildViewModel, fit, formatEventDate, ordinal, presentStatus,
} from './render/design'
export type { BadgeViewModel, StatusPresentation } from './render/design'

// ── Types ───────────────────────────────────────────────────────────────────
export {
  BADGE_HEIGHT, BADGE_MIME, BADGE_SCHEMA_VERSION, BADGE_STATUS_LABEL,
  BADGE_TEMPLATE_VERSION, BADGE_WIDTH, FINISHER_BADGES, badgeId,
} from './types'
export type {
  BadgeDoc, BadgeRaceStatusView, BadgeRenderInput, BadgeStatus, PublicBadgeView,
} from './types'
