// GET /api/organizer/events/[eventId]/registrations/export[?format=csv|xlsx]
//
// Exports registrations using THE canonical column definition
// (lib/registrations/exportColumns) — the same one the client bulk export uses, so both
// buttons produce identical data. Columns, ordering and cell values live there; this
// route only authorizes, queries, filters and serializes.
//
// FORMATS
//   csv  (default) — streamed page-by-page, UNCAPPED. Memory stays bounded to one batch
//                    regardless of event size, and CSV is append-only so it can stream.
//   xlsx           — a real OOXML workbook via the existing dependency-free writer.
//                    A ZIP central directory can only be written once every entry is
//                    known, so XLSX cannot stream and is row-CAPPED; the cap is disclosed
//                    in-file via ReportTable.truncated rather than silently truncating.
//
// FILTERS: status / payment / passId / checkin / from / to are pushed into Firestore;
// `q` is applied in-stream (Firestore has no substring search). Every filter the table
// offers now narrows the export — previously `q` was ignored entirely, so an operator who
// searched for one attendee and pressed Export received the whole event.

import { NextRequest, NextResponse } from 'next/server'
import { Timestamp }                 from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspaceDownload } from '@/lib/team/workspace'
import { csvCell as csvEscape }       from '@/lib/utils/csv'
import { tablesToXlsx }               from '@/lib/reports/xlsx'
import type { ReportTable, ReportRow } from '@/lib/reports/types'
import {
  buildRegistrationExportColumns,
  buildRegistrationExportRow,
  registrationMatchesQuery,
  exportCellValue,
} from '@/lib/registrations/exportColumns'

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const BATCH_SIZE = 1_000
/** XLSX must be fully materialised before the ZIP can be written. Beyond this the
 *  workbook stops being openable on a normal machine — CSV remains the uncapped path. */
const XLSX_ROW_CAP = 50_000

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<Response> {
  // ── Auth — canonical download guard (header or ?token= for <a download>) ──
  const authz = await authorizeWorkspaceDownload(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await context.params

  // ── Resolve event slug ─────────────────────────────────────────────────────
  // Reading the draft from users/{uid}/... is the ownership check: another organizer's
  // eventId simply does not exist under this uid, so it 404s before any query runs.
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const d       = draftSnap.data() as Record<string, unknown>
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo  as Record<string, unknown>) ?? {}
  const slug    = typeof seo.urlSlug === 'string' ? seo.urlSlug : ''
  if (!slug) return NextResponse.json({ error: 'Event not published' }, { status: 400 })

  // ── Field label map — drives the custom-answer columns ─────────────────────
  const rawForm = d.registrationForm as {
    sections?: Array<{ fields: Array<{ id: string; label: string }> }>
  } | null
  const fieldLabels: Record<string, string> = {}
  for (const section of rawForm?.sections ?? []) {
    for (const field of section.fields ?? []) {
      if (field.id && field.label) fieldLabels[field.id] = field.label
    }
  }

  const columns = buildRegistrationExportColumns(fieldLabels)
  const ctx     = { eventId, eventSlug: slug, fieldLabels }

  // ── Query: the SAME filters the list route applies ─────────────────────────
  const p = req.nextUrl.searchParams
  const format = p.get('format') === 'xlsx' ? 'xlsx' : 'csv'
  const q      = (p.get('q') ?? '').trim()

  let baseQuery: FirebaseFirestore.Query = adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)

  const exStatus = p.get('status');  if (exStatus) baseQuery = baseQuery.where('status', '==', exStatus)
  const exPay    = p.get('payment'); if (exPay)    baseQuery = baseQuery.where('paymentStatus', '==', exPay)
  const exPass   = p.get('passId');  if (exPass)   baseQuery = baseQuery.where('passId', '==', exPass)

  // checkin='yes' is a real equality filter. 'no' is deliberately NOT pushed to Firestore:
  // `checkedIn` is ABSENT on never-checked-in documents (the paid path's regDoc never
  // writes it), and Firestore excludes docs missing the field from an `== false` query —
  // so a server-side "not checked in" filter would silently drop exactly the rows the
  // operator asked for. It is applied in-stream below instead, which is exact.
  const exCheckin = p.get('checkin')
  if (exCheckin === 'yes') baseQuery = baseQuery.where('checkedIn', '==', true)
  const wantNotCheckedIn = exCheckin === 'no'

  const exFrom = p.get('from')
  if (exFrom) { const dt = new Date(`${exFrom}T00:00:00`);   if (!Number.isNaN(dt.getTime())) baseQuery = baseQuery.where('registeredAt', '>=', Timestamp.fromDate(dt)) }
  const exTo   = p.get('to')
  if (exTo)   { const dt = new Date(`${exTo}T23:59:59.999`); if (!Number.isNaN(dt.getTime())) baseQuery = baseQuery.where('registeredAt', '<=', Timestamp.fromDate(dt)) }

  baseQuery = baseQuery.orderBy('registeredAt', 'asc')

  const stamp    = new Date().toISOString().slice(0, 10)
  const baseName = `${slug}-registrations-${stamp}`

  /** Raw doc → canonical row, or null when an in-stream filter excludes it. */
  const rowFor = (doc: FirebaseFirestore.QueryDocumentSnapshot): ReportRow | null => {
    const raw: Record<string, unknown> = { ...(doc.data() as Record<string, unknown>), id: doc.id }
    // Truthiness, not `=== false`, so a missing field counts as "not checked in".
    if (wantNotCheckedIn && raw.checkedIn) return null
    if (q && !registrationMatchesQuery(raw, q)) return null
    return buildRegistrationExportRow(raw, ctx)
  }

  // ══ XLSX — materialised (capped), then one workbook ═══════════════════════
  if (format === 'xlsx') {
    const rows: ReportRow[] = []
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined
    let capped = false

    for (;;) {
      const snap = await (cursor ? baseQuery.startAfter(cursor).limit(BATCH_SIZE) : baseQuery.limit(BATCH_SIZE)).get()
      if (snap.empty) break
      for (const doc of snap.docs) {
        const row = rowFor(doc)
        if (row) rows.push(row)
        if (rows.length >= XLSX_ROW_CAP) { capped = true; break }
      }
      if (capped || snap.docs.length < BATCH_SIZE) break
      cursor = snap.docs[snap.docs.length - 1]
    }

    const table: ReportTable = {
      id:      'Registrations',
      title:   `${slug} registrations`,
      columns,
      // Cell values pass through the SAME serializer the CSV uses, so the two formats
      // can never disagree; 'money' stays a number so Excel can SUM it.
      rows:    rows.map(r => {
        const out: ReportRow = {}
        for (const c of columns) {
          const v = exportCellValue(r[c.key] ?? null, c.type)
          out[c.key] = v === '' ? null : v
        }
        return out
      }),
      truncated: capped,
    }
    // Money columns are already rupee NUMBERS here, so re-running the 'money' formatter
    // in the writer would divide by 100 a second time. Declaring them 'number' keeps the
    // cell numeric without a second conversion.
    table.columns = columns.map(c => (c.type === 'money' ? { ...c, type: 'number' as const } : c))

    const body = new Uint8Array(tablesToXlsx([table]))
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${baseName}.xlsx"`,
        'Cache-Control':       'no-store',
      },
    })
  }

  // ══ CSV — streamed, uncapped ══════════════════════════════════════════════
  const encoder = new TextEncoder()
  const csvLine = (cells: (string | number)[]) => cells.map(csvEscape).join(',')

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // UTF-8 BOM so Excel renders Tamil/Hindi/₹ correctly — parity with tableToCsv.
        controller.enqueue(encoder.encode('﻿' + csvLine(columns.map(c => c.label))))
        let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined
        for (;;) {
          const snap = await (cursor ? baseQuery.startAfter(cursor).limit(BATCH_SIZE) : baseQuery.limit(BATCH_SIZE)).get()
          if (snap.empty) break
          let chunk = ''
          for (const doc of snap.docs) {
            const row = rowFor(doc)
            if (!row) continue
            chunk += `\r\n${csvLine(columns.map(c => exportCellValue(row[c.key] ?? null, c.type)))}`
          }
          if (chunk) controller.enqueue(encoder.encode(chunk))
          if (snap.docs.length < BATCH_SIZE) break
          cursor = snap.docs[snap.docs.length - 1]
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${baseName}.csv"`,
      'Cache-Control':       'no-store',
    },
  })
}
