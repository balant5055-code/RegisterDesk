// DELETE /api/organizer/assets/[assetId] — remove an asset library record (owner-only).
// The Storage object is left in place (organizer-scoped, harmless); the metadata record
// is what governs library visibility.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getAsset, deleteAsset } from '@/lib/assetLibrary/service'

type Params = { params: Promise<{ assetId: string }> }

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { assetId } = await params
  const asset = await getAsset(assetId)
  if (!asset || asset.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
  }
  await deleteAsset(assetId)
  return NextResponse.json({ success: true })
}
