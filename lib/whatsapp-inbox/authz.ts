// WhatsApp Inbox — the ONE authorization gate for every organizer inbox route (Phase 1b).
// Server-only.
//
//   1. authorizeWorkspace(req, 'broadcasts') — verified token, active workspace, moderation,
//      and the permission. `broadcasts` is held by exactly owner + admin (lib/team/types
//      ROLE_PERMISSIONS), which is the approved Inbox audience; no new permission exists.
//   2. The `whatsappInbox` feature flag. Off ⇒ 404, so the feature does not exist to a
//      caller until it is switched on. Checked AFTER auth so an unauthenticated probe always
//      gets 401 and learns nothing about the flag.
//
// The returned `workspaceUid` is the ONLY organizer id a route may use. No route reads an
// organizer id from the URL, query or body.

import { NextResponse } from 'next/server'
import { authorizeWorkspace, type WorkspaceAuthz } from '@/lib/team/workspace'
import { getFeatureFlags } from '@/lib/config/resolveFeatureFlags'

export const INBOX_NOT_ENABLED = 'The WhatsApp Inbox is not enabled.'

export type InboxAuthz =
  | { ok: true;  authz: WorkspaceAuthz }
  | { ok: false; response: NextResponse }

export async function authorizeInbox(req: Request): Promise<InboxAuthz> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) {
    return { ok: false, response: NextResponse.json({ success: false, error: authz.error }, { status: authz.status }) }
  }
  let enabled = false
  try { enabled = (await getFeatureFlags()).whatsappInbox === true } catch { enabled = false }
  if (!enabled) {
    return { ok: false, response: NextResponse.json({ success: false, error: INBOX_NOT_ENABLED }, { status: 404 }) }
  }
  return { ok: true, authz }
}
