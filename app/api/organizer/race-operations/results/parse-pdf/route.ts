// POST /api/organizer/race-operations/results/parse-pdf
//
// RD-RACEOPS-RESULTS-06 · Turns an uploaded text PDF into the SAME cell matrices a
// spreadsheet upload produces, and returns them. It stores nothing, reads no Firestore
// result data and creates no session — the browser then runs the identical mapping,
// validation and commit path it runs for CSV and XLSX.
//
// ═══ WHY A ROUTE AT ALL ══════════════════════════════════════════════════════
// CSV and XLSX are parsed in the browser. A PDF reader is a large parser over untrusted
// bytes, so it stays on the server: the organizer's bundle keeps its size, and the parse
// happens behind the authorization and the size cap that already guard this module. The
// response is a small JSON matrix — the PDF itself is never persisted anywhere.
//
// ═══ UNTRUSTED INPUT ═════════════════════════════════════════════════════════
// Only text extraction runs (see parsers/pdf/extract.ts): no rendering, no embedded
// JavaScript, no attachments, no outbound fetches, no filesystem writes, and PDF metadata
// is never read. A failure returns a typed code and an organizer-facing sentence — never a
// stack trace.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { resolveRaceOpsEvent } from '@/features/race-operations/repositories/eventReadRepo'
import { extractPdfPages, PDF_MAX_BYTES } from '@/features/race-operations/import/parsers/pdf/extract'
import { reconstruct } from '@/features/race-operations/import/parsers/pdf/reconstruct'
import { RESULTS_MAX_ROWS } from '@/features/race-operations/import/constants'

/** The PDF reader is a Node library; this handler must not run on the edge. */
export const runtime = 'nodejs'

export interface ParsePdfResponse {
  shape:     'table' | 'blocks'
  /** Header row first — the shape `tabulate()` already consumes. */
  results:   string[][]
  splits:    string[][] | null
  pagesUsed: number
  /** Provider wording → canonical header, e.g. "Net Time" → "Chip Time". Display only. */
  labelMap:  Record<string, string>
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  // RD-RACEOPS-02B · the event must still admit Race Operations. Parsing is cheap, but it
  // is the organizer's own event that grants the right to do it here.
  const eventId = req.nextUrl.searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })
  const gate = await resolveRaceOpsEvent(authz.workspaceUid, eventId)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > PDF_MAX_BYTES) {
    return NextResponse.json({ error: 'This PDF is too large to read.' }, { status: 413 })
  }

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await req.arrayBuffer())
  } catch {
    return NextResponse.json({ error: 'The upload could not be read. Try selecting the file again.' }, { status: 400 })
  }
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: 'This file is empty — there is nothing to import.' }, { status: 400 })
  }
  if (bytes.byteLength > PDF_MAX_BYTES) {
    return NextResponse.json({ error: 'This PDF is too large to read.' }, { status: 413 })
  }

  const extracted = await extractPdfPages(bytes)
  if (!extracted.ok) {
    return NextResponse.json({ error: extracted.error.message, code: extracted.error.code }, { status: 422 })
  }

  const built = reconstruct(extracted.pages)
  if (!built.ok) {
    return NextResponse.json({ error: built.error.message, code: built.error.code }, { status: 422 })
  }

  // The row cap is the module's, not this route's — a PDF cannot become a bigger import
  // than a spreadsheet can. `- 1` because the header row is not a result.
  if (built.value.results.length - 1 > RESULTS_MAX_ROWS) {
    return NextResponse.json({
      error: `This PDF has ${(built.value.results.length - 1).toLocaleString('en-IN')} rows. The maximum is ${RESULTS_MAX_ROWS.toLocaleString('en-IN')} per upload — split it by race and upload each separately.`,
    }, { status: 413 })
  }

  const body: ParsePdfResponse = {
    shape:     built.value.shape,
    results:   built.value.results,
    splits:    built.value.splits,
    pagesUsed: built.value.pagesUsed,
    labelMap:  built.labelMap,
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
