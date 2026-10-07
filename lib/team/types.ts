// Team & Staff Access — shared types and the role→permission matrix.
//
// The matrix is the single source of truth for what each role may do. Routes
// must never hard-code role checks; they resolve permissions via lib/team/access.

// RD-CHECKIN-2.0 — `checkin_lead` is the gate role that may ALSO create walk-in
// registrations. It is a second GATE-ONLY role, not a step towards the organizer
// surfaces: its whole grant is `checkin` + `walkin`, both of which are event-day
// operations. isCheckinOnlyRole below is derived from the matrix rather than from a
// role name, so the existing containment applies to it automatically.
export type TeamRole = 'owner' | 'admin' | 'manager' | 'checkin_staff' | 'checkin_lead' | 'finance'

export type TeamPermission =
  | 'events'
  | 'registrations'
  | 'broadcasts'
  | 'certificates'
  | 'checkin'
  /**
   * RD-CHECKIN-2.0 — creating a registration AT THE GATE.
   *
   * ═══ THE MISMATCH THIS CLOSES ══════════════════════════════════════════════
   * Walk-in was gated on `registrations` while every surface offering it calls
   * itself check-in. `registrations` carries the entire registration module —
   * editing, cancelling, refund-adjacent state, bulk export — so the only way to
   * let a gate operator register a walk-up was to hand them all of it. The audit
   * found the resulting contradiction sitting in one file: the walk-in route's own
   * header comment said `checkin`, its code said `registrations`, and the gate role
   * could reach neither the button nor the route.
   *
   * So walk-in gets its own permission. It is strictly narrower than
   * `registrations`: it admits ONE operation — create + admit at an event this
   * caller is assigned to — and nothing else. Owner/admin/manager receive it, so
   * every role that could perform a walk-in before still can.
   */
  | 'walkin'
  | 'participants'   // H.3: owns the Participant Identifier Engine (assign/release/
                     // swap/reserve/block/retire/restore/pools/config/bulk/migration view)
  | 'wallet'
  | 'settlements'
  | 'transactions'

export type TeamStatus = 'invited' | 'active' | 'suspended'

export const ALL_PERMISSIONS: TeamPermission[] = [
  'events', 'registrations', 'broadcasts', 'certificates', 'checkin', 'walkin', 'participants',
  'wallet', 'settlements', 'transactions',
]

/**
 * RD-CHECKIN-2.0 — the permissions that are EVENT-DAY GATE work and nothing else.
 *
 * A role whose entire grant lies inside this set has no organizer surface at all,
 * which is what `isCheckinOnlyRole` means and what every containment in this
 * codebase keys on: refusal from `authorizeAnyWorkspace`, and mandatory event
 * assignment in `isEventInScope` / `isEventSlugInScope`.
 *
 * Adding a permission here WIDENS what a gate role may hold, so it is deliberately
 * a short explicit list rather than anything inferred from a role name.
 */
export const GATE_PERMISSIONS: TeamPermission[] = ['checkin', 'walkin']

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
  admin:         ['events', 'registrations', 'broadcasts', 'certificates', 'checkin', 'walkin', 'participants'],
  manager:       ['events', 'registrations', 'checkin', 'walkin', 'participants'],
  checkin_staff: ['checkin'],
  // Gate lead — check-in PLUS on-site registration, and nothing else. Still
  // gate-only: every permission it holds is in GATE_PERMISSIONS, so it inherits
  // event assignment enforcement and exclusion from organizer aggregates without
  // any code needing to know this role's name.
  checkin_lead:  ['checkin', 'walkin'],
  finance:       ['wallet', 'settlements', 'transactions'],
}

/**
 * True when a role's ENTIRE grant is event-day gate work — i.e. it has no
 * organizer surface at all.
 *
 * Derived from the matrix rather than comparing against a role name, so a future
 * gate-only role inherits the same containment automatically and this file stays
 * the single source of truth (routes must never hard-code role checks).
 *
 * ═══ WHY THE OLD RULE WAS THE WRONG RULE ═════════════════════════════════════
 * This read `perms.length === 1 && perms[0] === 'checkin'`. That was ACCURATE
 * while exactly one gate role existed and WRONG as a rule: the moment
 * `checkin_lead` arrived (checkin + walkin) the literal would have answered
 * `false`, which silently exempts a gate operator from event assignment AND lets
 * them past `authorizeAnyWorkspace` into the organizer aggregates. Two real
 * containments, both lost, from adding one permission to one role.
 *
 * The rule is: every permission this role holds is gate work. An empty grant is
 * not a gate role — it is a role with nothing, and must not inherit gate routing.
 */
export function isCheckinOnlyRole(role: TeamRole): boolean {
  const perms = ROLE_PERMISSIONS[role] ?? []
  if (perms.length === 0) return false
  return perms.every(p => GATE_PERMISSIONS.includes(p))
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
  /**
   * RD-CHECKIN-11 — true when this caller is a GATE CREDENTIAL rather than a person
   * who was invited to a team.
   *
   * It changes exactly one decision: whether an EMPTY assignment may be read as
   * "unrestricted". Optional so every existing caller keeps its current meaning; a
   * subject that does not say is treated as a person, which is the pre-existing
   * behaviour and the only safe default for legacy rows.
   */
  isStaffCredential?: boolean
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

  // ═══ THE ZERO-ASSIGNMENT RULE (RD-CHECKIN-11) ══════════════════════════════
  // `[]` means "unrestricted" for a row written before assignment existed, and that
  // reading has to stay for those rows or a legacy gate operator loses their event.
  // It is the WRONG reading for a staff credential: such an account is created only
  // ever WITH events (create and update both refuse an empty list), so an empty
  // assignment on one is not history, it is damage — a console edit, a bad
  // migration, a malformed field coerced to []. RD-CHECKIN-10 measured what that
  // did: the credential reached an event it was never assigned to.
  //
  // So the credential fails CLOSED and the legacy person does not. Note the order —
  // this is decided BEFORE the emptiness shortcut, so `[]`, a missing field and a
  // malformed one (all normalised to []) deny alike.
  if (!Array.isArray(subject.eventIds) || subject.eventIds.length === 0) {
    return subject.isStaffCredential !== true
  }
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
export const ASSIGNABLE_ROLES: TeamRole[] = ['admin', 'manager', 'checkin_staff', 'checkin_lead', 'finance']

/**
 * RD-CHECKIN-2.0 — roles a dedicated STAFF ACCOUNT may hold.
 *
 * Staff accounts are username/password credentials created by an organizer for
 * gate operators. They are deliberately restricted to gate-only roles: a staff
 * credential must never be a route to organizer capability, and an organizer who
 * wants a colleague to have broader access invites them by email through the team
 * flow instead, where the person owns their own verified identity.
 */
export const STAFF_ROLES: TeamRole[] = ['checkin_staff', 'checkin_lead']

export function isStaffRole(role: string): role is TeamRole {
  return (STAFF_ROLES as string[]).includes(role)
}

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
  // ═══ LEGACY-COMPAT FIELDS (RD-TEAM-IMPL-01) ══════════════════════════════
  // The invitation flow that populated these is removed. They are DECLARED, not
  // written by any live path: existing documents carry them and must keep parsing,
  // and `createStaffAccount` writes `invitedBy`/`invitedAt`/`acceptedAt` as plain
  // provenance (who issued the credential, when) with `inviteToken: null`.
  //
  // Nothing reads `inviteToken` any more. It cannot reactivate anything: the only
  // consumer was `acceptInvite`, which no longer exists, and there is no route that
  // accepts a token. It is kept solely so historical rows type-check.
  invitedBy:    string            // uid that created the row
  invitedAt:    unknown           // Firestore Timestamp
  acceptedAt:   unknown | null    // Firestore Timestamp
  createdAt:    unknown
  updatedAt:    unknown
  /** @deprecated Legacy invitation artefact. Never written or read by live code. */
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

// RD-TEAM-IMPL-01 — INVITE_TTL_MS lived here. The invitation flow it bounded is
// gone (no inviteMember, no acceptInvite, no acceptance route), so a TTL for it
// would be a constant nothing can consult.

export const TEAM_COLLECTION = 'teamMembers'
