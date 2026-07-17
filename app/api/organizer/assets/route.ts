// GET  /api/organizer/assets — list the organizer's reusable assets (filters: category, folder, q)
// POST /api/organizer/assets — register an uploaded asset's metadata
//
// The image bytes are uploaded client-side via the EXISTING organizer-asset flow
// (uploadOrganizerLibraryAsset → organizer-assets/{uid}/library-…); this route stores
// only the metadata record. No new upload engine.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace, authorizeAnyWorkspace } from '@/lib/team/workspace'
import { createAsset, listAssets, serializeAsset } from '@/lib/assetLibrary/service'
import { validateAssetInput } from '@/lib/assetLibrary/types'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { searchParams } = new URL(req.url)
  const assets = await listAssets(authz.workspaceUid, {
    category: searchParams.get('category') ?? undefined,
    folder:   searchParams.get('folder') ?? undefined,
    q:        searchParams.get('q') ?? undefined,
  })
  return NextResponse.json({ assets: assets.map(serializeAsset) })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = validateAssetInput(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const asset = await createAsset(authz.workspaceUid, parsed.value, authz.callerUid)
  return NextResponse.json({ success: true, asset: serializeAsset(asset) }, { status: 201 })
}
