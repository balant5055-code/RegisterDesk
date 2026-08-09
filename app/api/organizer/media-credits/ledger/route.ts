// GET /api/organizer/media-credits/ledger
//
// Recent ledger entries for the organizer, newest first, cursor-paginated. READ ONLY.
//
// The ledger is the source of truth for the balance, so this is the endpoint that lets an
// organizer audit the number the balance endpoint reports. Entries are append-only and this
// module exposes no verb that could edit or remove one.
//
// Query: ?limit=25&cursor={entryId}

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { ledgerService } from '@/features/media-credits/services'

const DEFAULT_LIMIT = 25
const MAX_LIMIT     = 100

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const url    = new URL(req.url)
  const raw    = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit  = Math.min(Math.max(1, Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_LIMIT), MAX_LIMIT)
  const cursor = url.searchParams.get('cursor')

  // `listEntries` tenant-checks the cursor itself, so a caller cannot page from another
  // workspace's entryId even by guessing one.
  const page = await ledgerService.listEntries(authz.workspaceUid, limit, cursor)

  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } })
}
