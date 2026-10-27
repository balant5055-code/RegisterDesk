// RD-FEATURE-REQ-01 — organizer Feature Requests.
//   GET  → this workspace's requests (newest first, bounded)
//   POST → submit a request
//
// Workspace-scoped through authorizeWorkspace ('events' — owner, admin, manager), so a team member
// sees and submits for the workspace they work in; nobody ever sees another workspace's requests.
// The body is validated by the SAME pure validator the form uses, and only its whitelisted fields
// are stored — status, priority, responses and rollout are Super Admin fields and are ignored here.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { checkRateLimit } from '@/lib/rateLimit'
import { validateSubmission } from '@/lib/featureRequests/types'
import { createFeatureRequest, listWorkspaceRequests, FeatureRequestError } from '@/lib/featureRequests/service'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const requests = await listWorkspaceRequests(authz.workspaceUid)
  return NextResponse.json({ requests }, { headers: NO_STORE })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  // Burst control per person (in-process); the durable daily cap is enforced in the transaction.
  const rl = checkRateLimit(authz.callerUid, 'feature-request-submit', 5, 10 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json({ error: 'Too many requests in a short time. Please wait a few minutes.', code: 'RATE_LIMITED' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } })
  }

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const v = validateSubmission(body)
  if (!v.ok) return NextResponse.json({ error: 'Please fix the highlighted fields.', fields: v.errors, code: 'INVALID' }, { status: 400 })

  try {
    const { id } = await createFeatureRequest({ workspaceUid: authz.workspaceUid, callerUid: authz.callerUid, input: v.value })
    return NextResponse.json({ success: true, id }, { status: 201, headers: NO_STORE })
  } catch (err) {
    if (err instanceof FeatureRequestError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error('[feature-requests] create failed', err)
    return NextResponse.json({ error: 'Could not submit the request. Please try again.' }, { status: 500 })
  }
}
