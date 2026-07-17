// POST /api/organizer/print-templates/import
//
// PA-8 — Imports selected templates from a bundled Professional Collection into the
// organizer's event. Each becomes an ORDINARY printTemplate: it REUSES the existing
// createPrintTemplate (metadata) + savePrintDesign (design JSON, validated by the
// existing validateDesign). No new collection, no second storage model, no renderer.
//
// Body:  { collectionId, eventId, templateIndices: number[] }
// Reply: { success, templates: PrintTemplate[] }

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }             from '@/lib/firebase/admin'
import { authorizeWorkspace }  from '@/lib/team/workspace'
import { organizerStatusGuard } from '@/lib/admin/organizerStatus'
import { createPrintTemplate, savePrintDesign } from '@/lib/printAssets/firestore'
import { validateDesign }      from '@/lib/printAssets/validation'
import { getCollection }       from '@/lib/printAssets/collections'
import type { PrintTemplate }  from '@/lib/printAssets/types'

export type ImportCollectionResponse =
  | { success: true;  templates: PrintTemplate[] }
  | { success: false; error: string }

const MAX_IMPORT = 30

export async function POST(req: NextRequest): Promise<NextResponse<ImportCollectionResponse>> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ success: false, error: blocked.message }, { status: 403 })

  let body: { collectionId?: unknown; eventId?: unknown; templateIndices?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }

  const collectionId = typeof body.collectionId === 'string' ? body.collectionId : ''
  const eventId      = typeof body.eventId === 'string' ? body.eventId : ''
  const collection   = getCollection(collectionId)
  if (!collection) return NextResponse.json({ success: false, error: 'Unknown collection' }, { status: 400 })
  if (!eventId)     return NextResponse.json({ success: false, error: 'eventId is required' }, { status: 400 })

  const indices = Array.isArray(body.templateIndices)
    ? [...new Set(body.templateIndices.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < collection.templates.length))]
    : []
  if (indices.length === 0) return NextResponse.json({ success: false, error: 'Select at least one template' }, { status: 400 })
  if (indices.length > MAX_IMPORT) return NextResponse.json({ success: false, error: `Import at most ${MAX_IMPORT} templates at once` }, { status: 400 })

  // Event ownership — the event must belong to this workspace.
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })

  const created: PrintTemplate[] = []
  for (const i of indices) {
    const src = collection.templates[i]
    // Reuse the existing create path (metadata, starts as draft).
    const tpl = await createPrintTemplate(uid, authz.callerUid, {
      eventId,
      name:        src.name.slice(0, 120),
      description: `${collection.name} collection`,
      assetType:   src.assetType,
      canvas:      src.canvas,
    })
    // Apply the collection's design via the existing validated save path.
    const parsed = validateDesign({ design: src.design })
    if (parsed.ok) await savePrintDesign(tpl.id, parsed.value)
    created.push({ ...tpl, design: parsed.ok ? parsed.value : tpl.design })
  }

  return NextResponse.json({ success: true, templates: created }, { status: 201 })
}
