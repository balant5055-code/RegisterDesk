// Team & Staff Access — shared types and the role→permission matrix.
//
// The matrix is the single source of truth for what each role may do. Routes
// must never hard-code role checks; they resolve permissions via lib/team/access.

export type TeamRole = 'owner' | 'admin' | 'manager' | 'checkin_staff' | 'finance'

export type TeamPermission =
  | 'events'
  | 'registrations'
  | 'broadcasts'
  | 'certificates'
  | 'checkin'
  | 'participants'   // H.3: owns the Participant Identifier Engine (assign/release/
                     // swap/reserve/block/retire/restore/pools/config/bulk/migration view)
  | 'wallet'
  | 'settlements'
  | 'transactions'

export type TeamStatus = 'invited' | 'active' | 'suspended'

export const ALL_PERMISSIONS: TeamPermission[] = [
  'events', 'registrations', 'broadcasts', 'certificates', 'checkin', 'participants',
  'wallet', 'settlements', 'transactions',
]

// Owner = full access. The other roles get exactly the slices below — note that
// finance has NO registrations access and checkin_staff has NO finance access.
// `participants` (identifier management) is granted to the operational roles that
// run on-ground participant work; finance is excluded.
//
// RD-CHECKIN-STAFF-01 — `checkin_staff` is a TRUE least-privilege gate role and
// holds `checkin` and NOTHING else. It previously carried `participants`, which
// gates the entire Participant Identifier Engine (pools, bulk assign, export,
// history, migration, swap, release — see lib/identifiers/organizerScope.ts), so a
// gate operator could reach every identifier surface in the workspace.
//
// Assigning an identifier during check-in does NOT need `participants`: that one
// narrow capability lives inside the check-in operation itself, which is why this
// permission must never be handed back to solve a "staff cannot set a bib" report.
export const ROLE_PERMISSIONS: Record<TeamRole, TeamPermission[]> = {
  owner:         [...ALL_PERMISSIONS],
  admin:         ['events', 'registrations', 'broadcasts', 'certificates', 'checkin', 'participants'],
  manager:       ['events', 'registrations', 'checkin', 'participants'],
  checkin_staff: ['checkin'],
  finance:       ['wallet', 'settlements', 'transactions'],
}

/**
 * True when a role's ENTIRE grant is gate check-in — i.e. it has no organizer
 * surface at all.
 *
 * Derived from the matrix rather than comparing `role === 'checkin_staff'`, so a
 * future gate-only role inherits the same containment automatically and this file
 * stays the single source of truth (routes must never hard-code role checks).
 */
export function isCheckinOnlyRole(role: TeamRole): boolean {
  const perms = ROLE_PERMISSIONS[role] ?? []
  return perms.length === 1 && perms[0] === 'checkin'
}

// ─── Event assignment (RD-CHECKIN-STAFF-01) ──────────────────────────────────
//
// These two helpers are PURE and live here, beside the matrix, rather than next to
// the code that calls them. lib/team/access.ts and lib/team/service.ts both import
// `adminDb`, which boots the Admin SDK at module load, so anything importing them
// cannot be exercised in the repo's `node`-environment vitest run. The same split
// exists for the same reason in lib/registrations/attendeePhotoMime.ts and
// lib/certificates/placeholders.ts.

/** The minimum a caller must present to have their event scope decided. */
export interface EventScopeSubject {
  role:     TeamRole
  isOwner:  boolean
  eventIds: string[]
}

/**
 * May this caller act on `eventId`?
 *
 *   • owners and non-gate roles         → yes
 *   • gate role with no assignment ([]) → yes (rows predating this field)
 *   • gate role with an assignment      → only the events named in it
 *
 * Scope is enforced ONLY for gate-only roles. Broader roles already hold
 * workspace-wide permissions and can reach the same event through the organizer
 * surfaces, so narrowing them here would be a false promise rather than a control.
 *
 * Matching is exact: no trimming, no case folding. An id is an opaque key, and a
 * forgiving comparison here would be a way to reach a neighbouring event.
 */
export function isEventInScope(subject: EventScopeSubject, eventId: string): boolean {
  if (subject.isOwner) return true
  if (!isCheckinOnlyRole(subject.role)) return true
  if (subject.eventIds.length === 0) return true
  return subject.eventIds.includes(eventId)
}

/** Upper bound on an assignment list — it is walked on every gate scan. */
export const MAX_ASSIGNED_EVENTS = 50

/**
 * Normalises an owner-supplied event assignment.
 *
 * Returns the cleaned list, or `null` when the input is present but malformed.
 * That distinction is the point: coercing a bad payload to `[]` would silently
 * promote it into workspace-wide access — the exact opposite of what an owner
 * narrowing a gate operator's scope is asking for. Absent/undefined legitimately
 * means unrestricted, which is the pre-existing behaviour for every member.
 */
export function sanitizeEventIds(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') return null
    const id = v.trim()
    // Same shape the event routes accept. Keeps a path-traversal-ish value out of a
    // field that is later interpolated into a Firestore document path.
    if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) return null
    if (!out.includes(id)) out.push(id)
  }
  return out.length > MAX_ASSIGNED_EVENTS ? null : out
}

// Roles an owner may assign when inviting / changing roles. 'owner' is excluded —
// ownership is implicit to the account holder and cannot be granted.
export const ASSIGNABLE_ROLES: TeamRole[] = ['admin', 'manager', 'checkin_staff', 'finance']

export function isAssignableRole(role: string): role is TeamRole {
  return (ASSIGNABLE_ROLES as string[]).includes(role)
}

export function permissionsForRole(role: TeamRole): TeamPermission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])]
}

export interface TeamMemberDocument {
  id:           string
  organizerUid: string            // the workspace owner this member belongs to
  memberUid:    string | null     // null until the invite is accepted
  email:        string            // normalized (trim + lowercase)
  role:         TeamRole
  permissions:  TeamPermission[]  // snapshot of permissionsForRole(role)
  /**
   * RD-CHECKIN-STAFF-01 — event assignment for gate-only roles.
   *
   * Holds eventDraft ids (the same id `/dashboard/events/[eventId]` uses). EMPTY
   * or ABSENT means "every event in the workspace", which is what every member
   * created before this field existed implicitly had — so existing rows keep
   * working untouched and no backfill is required.
   *
   * Only enforced for gate-only roles (isCheckinOnlyRole). Broader roles already
   * hold workspace-wide permissions, so scoping them here would be a false
   * promise: they can reach the same data through the organizer surfaces.
   */
  eventIds?:    string[]
  status:       TeamStatus
  invitedBy:    string            // owner uid who created the invite
  invitedAt:    unknown           // Firestore Timestamp
  acceptedAt:   unknown | null    // Firestore Timestamp
  createdAt:    unknown
  updatedAt:    unknown
  // Capability token for the accept link — never returned to clients.
  inviteToken:  string | null
}

// Shape returned to clients — excludes inviteToken.
export interface TeamMemberView {
  id:           string
  memberUid:    string | null
  email:        string
  role:         TeamRole
  permissions:  TeamPermission[]
  eventIds:     string[]          // [] = all events in the workspace
  status:       TeamStatus
  invitedAt:    string | null
  acceptedAt:   string | null
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000   // invites expire after 7 days

export const TEAM_COLLECTION = 'teamMembers'
