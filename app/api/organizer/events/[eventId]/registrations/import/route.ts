// POST /api/organizer/events/[eventId]/registrations/import
//
// RM-2.3A — Creates a Registration Import JOB from parsed template rows. It
// RE-VALIDATES server-side with the SAME engine/context as the preview (never
// trusting client-marked status), resolves each importable row into the shape
// createRegistration expects, and enqueues the job. NO registration is created
// here — the background runner (cron / process endpoint) does the writes.
//
// Body:  { rows: Record<string,string>[], headers: string[], fileName? }
// Reply: { success, jobId, job }

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }   from '@/lib/team/workspace'
import { organizerStatusGuard } from '@/lib/admin/organizerStatus'
import { normalizeEmail, normalizePhone } from '@/lib/registrations/editValidation'
import { validateImportRows, buildColumnResolver } from '@/lib/registrations/importValidation'
import { buildImportContext }   from '@/lib/registrations/importContext'
import {
  createRegistrationImportJob, writeFailedImportRows, listRecentImportJobs,
  type RegistrationImportRow, type ImportJobStats,
} from '@/lib/registrations/importJob'
import { serializeJob }         from '@/lib/jobs/serialize'
import { IMPORT_MAX_ROWS }      from '@/lib/registrations/importTemplate'

// GET — the last 10 import jobs for this event (Recent Imports list).
export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { eventId } = await context.params
  const jobs = await listRecentImportJobs(eventId, authz.workspaceUid, 10)
  return NextResponse.json({ jobs: jobs.map(serializeJob) }, { headers: { 'Cache-Control': 'no-store' } })
}

const H_NAME  = 'Full Name *'
const H_EMAIL = 'Email *'
const H_PHONE = 'Phone'
const H_PASS  = 'Pass *'

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ error: blocked.message }, { status: 403 })

  const { eventId } = await context.params

  let body: { rows?: unknown; headers?: unknown; fileName?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const rows     = Array.isArray(body.rows)    ? (body.rows    as Record<string, string>[]) : null
  const headers  = Array.isArray(body.headers) ? (body.headers as string[])                 : null
  const fileName = typeof body.fileName === 'string' ? body.fileName : undefined
  if (!rows || !headers) return NextResponse.json({ error: 'rows[] and headers[] are required' }, { status: 400 })
  if (rows.length === 0)  return NextResponse.json({ error: 'No rows to import' }, { status: 400 })
  if (rows.length > IMPORT_MAX_ROWS) {
    return NextResponse.json({ error: `Too many rows (max ${IMPORT_MAX_ROWS}).` }, { status: 400 })
  }

  // ── Authoritative server-side validation (same context as the preview) ──────
  const built = await buildImportContext(uid, eventId, rows)
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status })
  if (built.stopped) {
    return NextResponse.json({ error: `Import unavailable — ${built.stopped.message}` }, { status: 422 })
  }

  const { validatedRows } = validateImportRows(rows, headers, built.ctx)
  const resolveField = buildColumnResolver(built.ctx.form)

  // ── Validation breakdown of the WHOLE file (for the summary) ────────────────
  const stats: ImportJobStats = { ready: 0, warning: 0, duplicate: 0, error: 0 }
  for (const vr of validatedRows) {
    if (vr.status === 'READY')          stats.ready++
    else if (vr.status === 'WARNING')   stats.warning++
    else if (vr.status === 'DUPLICATE') stats.duplicate++
    else if (vr.status === 'ERROR')     stats.error++
  }

  // ── Resolve importable rows (READY | WARNING) → createRegistration inputs ────
  const importRows: RegistrationImportRow[] = []
  for (const vr of validatedRows) {
    if (vr.status !== 'READY' && vr.status !== 'WARNING') continue
    const row = rows[vr.rowNumber - 2]
    if (!row) continue

    const passId = built.passIdByName.get((row[H_PASS] ?? '').trim().toLowerCase())
    if (!passId) continue   // defensive; validation already guarantees this for READY/WARNING

    const phoneRaw = (row[H_PHONE] ?? '').trim()
    const formResponses: Record<string, unknown> = {}
    for (const h of headers) {
      const fid = resolveField(h)
      if (fid) formResponses[fid] = row[h] ?? ''
    }

    importRows.push({
      passId,
      attendee: {
        name:  (row[H_NAME] ?? '').trim(),
        email: normalizeEmail((row[H_EMAIL] ?? '').trim()),
        ...(phoneRaw ? { phone: normalizePhone(phoneRaw) } : {}),
        formResponses,
      },
      amountPaise:           0,
      paymentStatusOverride: 'not_required',   // bulk import = pre-arranged / free entries
      cells:                 row,
      rowNumber:             vr.rowNumber,
    })
  }

  if (importRows.length === 0) {
    return NextResponse.json({ error: 'No rows are ready to import.' }, { status: 400 })
  }

  const job = await createRegistrationImportJob(
    {
      eventId, eventSlug: built.slug, organizerUid: uid, createdBy: authz.callerUid,
      fileName, headers, fileTotal: rows.length, stats,
    },
    importRows,
  )

  // Persist validation-rejected rows (ERROR / DUPLICATE) so they can be downloaded,
  // fixed and re-imported — alongside execution failures recorded during processing.
  const rejected = validatedRows
    .filter(vr => vr.status === 'ERROR' || vr.status === 'DUPLICATE')
    .map(vr => ({ key: `v_${vr.rowNumber}`, cells: rows[vr.rowNumber - 2] ?? {}, error: vr.reasons.join('; ') }))
  if (rejected.length) await writeFailedImportRows(job.jobId, rejected)

  return NextResponse.json(
    { success: true, jobId: job.jobId, job: serializeJob(job) },
    { status: 201 },
  )
}
