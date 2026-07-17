// Shared workspace resolution — the bridge that lets team members operate an
// owner's resources. Every organizer route resolves identity through here.
//
// The model: a caller acts inside exactly ONE workspace.
//   • Owner (no active memberships) → workspaceUid = callerUid.
//   • Team member                   → workspaceUid = the owner's organizerUid.
//
// Routes then use workspaceUid wherever they used to use the raw uid for
// ownership (subcollection paths, `where('organizerUid','==',…)`, resource
// `organizerUid` comparisons). For owners nothing changes; for members it
// transparently scopes to the owner's data — gated by the permission check.

import { verifyCaller, requirePermission, activeMemberships, type AccessResult } from '@/lib/team/access'
import { permissionsForRole, type TeamRole, type TeamPermission } from '@/lib/team/types'

export interface WorkspaceContext {
  callerUid:    string
  workspaceUid: string
  role:         TeamRole
  permissions:  TeamPermission[]
  isOwner:      boolean
}

/**
 * Resolves which workspace the caller is acting in.
 *
 * Phase B.1 assumes a single active workspace per caller. If a caller both owns
 * a workspace AND is a member elsewhere, the membership wins (documented
 * limitation — a workspace switcher is the follow-up). Owners have no member
 * row, so they always resolve to their own workspace.
 */
export async function resolveWorkspaceUid(callerUid: string): Promise<WorkspaceContext> {
  const memberships = await activeMemberships(callerUid)
  if (memberships.length === 0) {
    return { callerUid, workspaceUid: callerUid, role: 'owner', permissions: permissionsForRole('owner'), isOwner: true }
  }
  const m = memberships[0]
  return { callerUid, workspaceUid: m.organizerUid, role: m.role, permissions: permissionsForRole(m.role), isOwner: false }
}

/**
 * Resource-level authorization: the caller may act on a resource owned by
 * `resourceOrganizerUid` only if they are that workspace's owner or an active
 * member with the permission. Delegates entirely to requirePermission so the
 * matrix stays the single source of truth.
 */
export async function requireResourcePermission(
  callerUid: string, resourceOrganizerUid: string, permission: TeamPermission,
): Promise<AccessResult> {
  return requirePermission(callerUid, resourceOrganizerUid, permission)
}

// ─── Route-level convenience wrappers ────────────────────────────────────────

export interface WorkspaceAuthz extends WorkspaceContext {
  ok:     boolean
  status: number
  error:  string            // '' when ok; a message when !ok (always a string for route typing)
}

const denied = (status: number, error: string): WorkspaceAuthz => ({
  ok: false, status, error, callerUid: '', workspaceUid: '', role: 'owner', permissions: [], isOwner: false,
})

/**
 * One-call route guard for workspace-scoped routes (lists, creates, subcollection
 * and `where`-based queries). Verifies the token, resolves the workspace, and
 * checks the permission. On success, use `authz.workspaceUid` as the owner uid.
 */
export async function authorizeWorkspace(req: Request, permission: TeamPermission): Promise<WorkspaceAuthz> {
  const caller = await verifyCaller(req)
  if (!caller) return denied(401, 'Unauthorized')
  const ctx = await resolveWorkspaceUid(caller.uid)
  if (!ctx.permissions.includes(permission)) {
    return { ...ctx, ok: false, status: 403, error: `Missing required permission: ${permission}.` }
  }
  return { ...ctx, ok: true, status: 200, error: '' }
}

/**
 * Like authorizeWorkspace but for routes that need workspace context WITHOUT a
 * specific permission (e.g. the dashboard aggregate). Any active member of the
 * workspace — or the owner — passes.
 */
export async function authorizeAnyWorkspace(req: Request): Promise<WorkspaceAuthz> {
  const caller = await verifyCaller(req)
  if (!caller) return denied(401, 'Unauthorized')
  const ctx = await resolveWorkspaceUid(caller.uid)
  return { ...ctx, ok: true, status: 200, error: '' }
}

/**
 * Download-friendly variant of authorizeWorkspace. Identical guarantees (same
 * verifyCaller email-verification gate, same workspace + permission resolution),
 * but the Firebase ID token may arrive in a `?token=` query param instead of the
 * Authorization header — required for `<a download>` / new-tab navigations that
 * cannot set request headers. Prefers the header when both are present. Reuses
 * authorizeWorkspace so the authorization flow stays single-sourced.
 */
export async function authorizeWorkspaceDownload(req: Request, permission: TeamPermission): Promise<WorkspaceAuthz> {
  const headerToken = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  const queryToken  = new URL(req.url).searchParams.get('token') ?? ''
  const token = headerToken || queryToken
  const authedReq = token
    ? new Request(req.url, { headers: { Authorization: `Bearer ${token}` } })
    : req
  return authorizeWorkspace(authedReq, permission)
}
