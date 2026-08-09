// RD-AI-01 · Route authorization — SERVER ONLY.
//
// THE single gate for every organizer-facing AI route.
//
// ─── Why `events` and not a new permission ───────────────────────────────────
// An AI job analyses an event's own photos and produces organizer-only working data about
// that event. Anyone trusted to manage the event's media is trusted to see what the pipeline
// made of it, so this reuses the EXISTING `events` permission and adds nothing to
// `ALL_PERMISSIONS`. The production RBAC matrix is untouched — the doctrine every prior
// sprint followed, and the same call Media Studio makes.

import { authorizeWorkspace } from '@/lib/team/workspace'

export type AIAuthz =
  | { ok: true;  callerUid: string; workspaceUid: string }
  | { ok: false; status: number; error: string }

export async function authorizeAI(req: Request): Promise<AIAuthz> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return { ok: false, status: authz.status, error: authz.error }
  return { ok: true, callerUid: authz.callerUid, workspaceUid: authz.workspaceUid }
}
