// POST /api/organizer/print-jobs/[jobId]/sheets
//
// RD-PRINT-P2 — the job's cards laid out on A4/A3 paper as ONE PDF, rendered on demand
// in memory from the job's PINNED template version (its card size included) and the
// LIVE registrations, and returned in this response with `no-store`. Nothing is stored:
// no file, no URL, no attendee copy.
//
// Body:  { sheet?: { paper, orientation, marginMm, gapMm, cropMarks }, registrationIds?: string[] }
// Reply: application/pdf · 4xx { error, code } for an invalid sheet, a card that does not
//        fit, too many cards (413, before rendering), output too large (413) or too slow (503).
//
// Security: `certificates` permission + job ownership; header token only.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintGenerationJob, renderPrintSheets, PRINT_SHEET_MAX_CARDS } from '@/lib/printAssets/generationJob'
import { validateSheetSpec } from '@/lib/printAssets/sheet/layout'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params

  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  let body: { sheet?: unknown; registrationIds?: unknown } = {}
  try { body = await req.json() as typeof body } catch { /* empty body → defaults */ }

  const spec = validateSheetSpec(body.sheet)
  if (!spec.ok) return NextResponse.json({ error: spec.error, code: 'INVALID_SHEET' }, { status: 400 })

  let registrationIds: string[] | undefined
  if (body.registrationIds !== undefined) {
    if (!Array.isArray(body.registrationIds) || !body.registrationIds.every(x => typeof x === 'string')) {
      return NextResponse.json({ error: 'registrationIds must be a list of ids', code: 'INVALID_SELECTION' }, { status: 400 })
    }
    registrationIds = [...new Set(body.registrationIds as string[])]
    if (registrationIds.length > PRINT_SHEET_MAX_CARDS) {
      return NextResponse.json(
        { error: `Select at most ${PRINT_SHEET_MAX_CARDS.toLocaleString('en-IN')} cards per print-sheet download.`, code: 'TOO_MANY_CARDS' },
        { status: 413 },
      )
    }
  }

  const out = await renderPrintSheets(job, { spec: spec.value, registrationIds })
  if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status })

  return new NextResponse(Buffer.from(out.bytes) as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type':           'application/pdf',
      'Content-Disposition':    `attachment; filename="${out.filename}"`,
      'Cache-Control':          'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'X-Print-Card-Count':     String(out.cards),
      'X-Print-Sheet-Count':    String(out.sheets),
      'X-Print-Cards-Per-Sheet': String(out.perSheet),
      'X-Print-Cards-Skipped':  String(out.skipped),
    },
  })
}
