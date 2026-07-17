// GET /api/organizer/global-templates — browse PUBLISHED global templates
// (featured first). Filters: category, q. Read-only catalog for import.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { listPublishedGlobalTemplates, serializeGlobalTemplate } from '@/lib/certificates/globalTemplates'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { searchParams } = new URL(req.url)
  const templates = (await listPublishedGlobalTemplates({
    category: searchParams.get('category') ?? undefined,
    q:        searchParams.get('q') ?? undefined,
  })).map(serializeGlobalTemplate)
  return NextResponse.json({ templates })
}
