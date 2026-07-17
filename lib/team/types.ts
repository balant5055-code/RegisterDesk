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
export const ROLE_PERMISSIONS: Record<TeamRole, TeamPermission[]> = {
  owner:         [...ALL_PERMISSIONS],
  admin:         ['events', 'registrations', 'broadcasts', 'certificates', 'checkin', 'participants'],
  manager:       ['events', 'registrations', 'checkin', 'participants'],
  checkin_staff: ['checkin', 'participants'],
  finance:       ['wallet', 'settlements', 'transactions'],
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
  status:       TeamStatus
  invitedAt:    string | null
  acceptedAt:   string | null
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000   // invites expire after 7 days

export const TEAM_COLLECTION = 'teamMembers'
