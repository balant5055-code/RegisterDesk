// RD-ORGANIZER-REMAINING-ALL · WHAT an organizer deletion touches. PURE — no Firestore, no
// Auth, no Storage, no clock.
//
// ═══ WHY THIS IS SPLIT FROM THE EXECUTOR ═════════════════════════════════════
// The plan is the part worth arguing about: which collections are the organizer's, which are
// the platform's, which hold money, and in what order the irreversible steps happen. All of
// that is a pure function of a uid, and it should be readable and testable without standing up
// Firebase — the executor next door cannot even be imported into a unit test, because
// `lib/firebase/admin` parses a service-account key at module scope.
//
// Keeping them together (as `lib/events/eventDeletion` does) would mean the only way to check
// "is a financial collection in the delete plan?" is an emulator run. That is the wrong cost
// for the most important question in the module.

// ═══════════════════════════════════════════════════════════════════════════════
// 1 · RETENTION CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Financial and audit records. NEVER deleted by organizer cleanup — their presence BLOCKS the
 * deletion instead, so the choice is always "keep the organizer" rather than "lose the record".
 *
 * `payoutProfileHistory` is here although `organizerPayoutProfiles` is deletable: the profile is
 * current configuration, the history is an append-only trail of who changed bank details and
 * when. Losing the trail while keeping nothing to explain is the worst of both outcomes.
 */
export const ORGANIZER_RETAINED_COLLECTIONS = [
  'platformTransactions', 'walletTransactions', 'walletTopups', 'walletClawbacks',
  'settlementRequests', 'settlementReleases', 'organizerRevenueWallets',
  'eventLicenses', 'licenseOrders', 'failedRefunds', 'suspiciousPayments',
  'adminAuditLogs', 'payoutProfileHistory', 'paymentEvents', 'paymentIntents',
  'donations', 'donationPayments', 'donationReceipts', 'donationRefunds',
] as const

/**
 * Shared / platform-owned. Not the organizer's to delete at all, whatever it contains.
 *
 * Every name here was verified to be a real ROOT collection in the codebase. An earlier draft
 * also listed `system` and `backupStatus` (neither exists as a Firestore collection — `system`
 * is a storage asset type) and `emailTemplates`, which is the opposite of shared: it exists
 * ONLY as `users/{uid}/emailTemplates`, so it is organizer-owned and IS in the manifest.
 *
 * A guessed name in a safety list is worse than an omission: it reads as a considered decision
 * and protects nothing.
 */
export const SHARED_COLLECTIONS = [
  'globalCertificateTemplates', 'platformSettings', 'emailSuppressionList', 'emailSuppressionAudit',
  'platformCampaigns', 'changeLog',
] as const

// ═══════════════════════════════════════════════════════════════════════════════
// 2 · THE MANIFEST
// ═══════════════════════════════════════════════════════════════════════════════

/** One unit of deletion work. Ordered; executed front to back. */
export type OrganizerDeletionStep =
  /** Every doc in `collection` where `field == value`, in bounded pages. */
  | { kind: 'query'; label: string; collection: string; field: string; value: string }
  /** A single document. Idempotent — a missing doc is a success. */
  | { kind: 'doc'; label: string; path: string }
  /** Every doc in a subcollection of one parent document. */
  | { kind: 'subcollection'; label: string; parentPath: string; name: string }
  /** Firebase Storage objects under an authoritatively organizer-owned prefix. */
  | { kind: 'storagePrefix'; label: string; prefix: string }
  /** The `staffUsernames/{username}` locks this workspace holds, found via staffAccounts. */
  | { kind: 'staffUsernameLocks'; label: string; organizerUid: string }
  /** The Firebase Auth users behind this workspace's staff credentials. */
  | { kind: 'staffAuthUsers'; label: string; organizerUid: string }
  /** The organizer's own Firebase Auth user. IRREVERSIBLE — always last. */
  | { kind: 'auth'; label: string; uid: string }

/** Collection names, taken from the modules that own them rather than guessed. */
const STAFF_ACCOUNTS  = 'staffAccounts'   // lib/staff/types.ts STAFF_COLLECTION
const TEAM_MEMBERS    = 'teamMembers'     // lib/team/types.ts TEAM_COLLECTION

/**
 * Everything that will be destroyed, in order.
 *
 * Only collections whose ownership is unambiguous appear here. Event-scoped collections are
 * deliberately ABSENT rather than included-and-empty: eligibility guarantees zero events and
 * zero drafts, so there is nothing for them to match, and listing them would imply this
 * manifest is a safe way to delete event data. It is not — that is `lib/events/eventDeletion`.
 *
 * ORDERING. Bulk child data, then per-organizer configuration, then storage, then the staff
 * credentials, then `users/{uid}`, and Firebase Auth LAST. Auth is the only unrecoverable step:
 * while it exists the job is re-runnable and the account is still attributable.
 */
export function buildOrganizerDeletionManifest(uid: string): OrganizerDeletionStep[] {
  const userPath = `users/${uid}`
  const byOrganizer = (collection: string, label = collection): OrganizerDeletionStep =>
    ({ kind: 'query', label, collection, field: 'organizerUid', value: uid })

  return [
    // ── Workspace content held under the user document ───────────────────────
    // Drafts block deletion, so these are empty in practice. They are here because the
    // subcollections are unambiguously this user's, and Firestore does not cascade — a document
    // left under a deleted parent is unreachable for ever.
    { kind: 'subcollection', label: 'eventDrafts',    parentPath: userPath, name: 'eventDrafts' },
    { kind: 'subcollection', label: 'campaignDrafts', parentPath: userPath, name: 'campaignDrafts' },
    { kind: 'subcollection', label: 'notifications',  parentPath: userPath, name: 'notifications' },
    { kind: 'subcollection', label: 'emailTemplates', parentPath: userPath, name: 'emailTemplates' },

    // ── Organizer-scoped operational records ─────────────────────────────────
    // Each verified to carry `organizerUid` as a queried field in the module that writes it.
    byOrganizer('communicationUsage'),
    byOrganizer('broadcastCampaigns'),
    byOrganizer('apiKeys'),
    byOrganizer('organizerAssets'),

    // ── Per-organizer singleton documents, keyed BY uid ──────────────────────
    // Each is `collection/{uid}` in the module that owns it, so ownership is the document id
    // itself — the least ambiguous form there is.
    { kind: 'doc', label: 'mediaSettings',          path: `mediaSettings/${uid}` },
    { kind: 'doc', label: 'organizerBrandKit',      path: `organizerBrandKit/${uid}` },
    { kind: 'doc', label: 'organizerLimits',        path: `organizerLimits/${uid}` },
    { kind: 'doc', label: 'organizerPayoutProfile', path: `organizerPayoutProfiles/${uid}` },

    // ── Storage · authoritatively uid-scoped prefixes only ───────────────────
    // These two are the platform's OWN definition of organizer ownership — the same pair
    // `lib/printAssets/render/assets.ts` uses to decide whether an object belongs to a uid.
    // Nothing is deleted because a stored URL happened to contain the uid.
    { kind: 'storagePrefix', label: 'organizer-assets', prefix: `organizer-assets/${uid}/` },
    { kind: 'storagePrefix', label: 'event-assets',     prefix: `event-assets/${uid}/` },

    // ── Staff credentials ────────────────────────────────────────────────────
    // Order is load-bearing: the username locks and the Auth users are both found THROUGH
    // staffAccounts, so staffAccounts must be the last of the three. Reversing them strands a
    // global `staffUsernames` lock with no owner — reserving that username for nobody, for ever.
    { kind: 'staffUsernameLocks', label: 'staffUsernames', organizerUid: uid },
    { kind: 'staffAuthUsers',     label: 'staffAuthUsers',  organizerUid: uid },
    { kind: 'query', label: 'staffAccounts', collection: STAFF_ACCOUNTS, field: 'organizerUid', value: uid },
    { kind: 'query', label: 'teamMembers',   collection: TEAM_MEMBERS,   field: 'organizerUid', value: uid },

    // ── Memberships this organizer HELD in other workspaces ──────────────────
    // RD-WORKSPACE-OWNERSHIP-01 · the step above deletes the members OF this workspace
    // (`organizerUid == uid`). It does not touch rows that granted THIS person access to
    // somebody else's workspace (`memberUid == uid`), and those are the ones that outlive
    // the account: the manifest ends by deleting the Firebase Auth user, so the same email
    // can register again — and a surviving grant is a restriction the new account inherits
    // for a reason nothing in its own profile explains.
    //
    // Scoped by `memberUid`, so every row it matches is by definition a grant to the uid
    // being deleted. It cannot reach another person's membership: no other member's row
    // carries this uid in that field. Retry-safe like every other `query` step — it pages
    // until empty, and an already-empty result simply advances.
    //
    // Pending `status: 'invited'` rows (which carry `memberUid: null` and are matched by
    // the invite EMAIL instead) are deliberately NOT swept here. Two reasons, in order:
    // they grant nothing — `resolveTeamAccess` requires 'active', and RD-TEAM-IMPL-01
    // removed the acceptance route, so they can never become active — and this manifest is
    // replayed by step INDEX across resumes, so it must be identical on every run. An email
    // is only knowable by reading `users/{uid}`, which this manifest deletes near the end;
    // a resumed run would then build a different step list and the index would point at the
    // wrong step, including the irreversible Auth deletion. A sweep that needs the email
    // has to carry it on the job record, not derive it here.
    { kind: 'query', label: 'teamMemberships', collection: TEAM_MEMBERS, field: 'memberUid', value: uid },

    // ── The anchor, then the identity ────────────────────────────────────────
    { kind: 'doc',  label: 'userProfile', path: userPath },
    { kind: 'auth', label: 'authUser',    uid },
  ]
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3 · PROGRESS + CURSOR
// ═══════════════════════════════════════════════════════════════════════════════

export interface OrganizerStepProgress {
  /** Index of the step to run next. Equal to the manifest length ⇒ finished. */
  step:     number
  deleted:  number
  failures: string[]
}

/** `step:deleted:failureCount` — enough to resume exactly where the last page stopped. */
export function encodeProgress(p: OrganizerStepProgress): string {
  return `${p.step}:${p.deleted}:${p.failures.length}`
}

/**
 * Decode a stored cursor. Anything unusable resumes from the BEGINNING rather than from a
 * guessed position: re-running a completed step is a no-op, whereas skipping one leaves data.
 */
export function decodeProgress(cursor: string | null): OrganizerStepProgress {
  if (!cursor) return { step: 0, deleted: 0, failures: [] }
  const [s, d] = cursor.split(':')
  const step = Number(s), deleted = Number(d)
  return {
    step:     Number.isFinite(step)    && step    >= 0 ? step    : 0,
    deleted:  Number.isFinite(deleted) && deleted >= 0 ? deleted : 0,
    failures: [],
  }
}

/** The jobs collection. Here rather than in the executor so a reader can find it without
 *  pulling in Firebase. */
export const ORGANIZER_DELETION_JOBS = 'organizerDeletionJobs'
