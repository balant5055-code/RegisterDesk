// RD-EVENT-19F-B — Timing tag import: PREVIEW and COMMIT.
//
//   POST { mode: 'preview' | 'commit', rows: [{ rowNumber, identifier, tag }] }
//
// `preview` writes NOTHING. It resolves each row's identifier against the event and
// each tag against the event's existing locks, and returns a verdict per row with
// machine-readable reasons. `commit` re-validates on the server — the client's
// preview is never trusted — and creates a job for the rows that survive.
//
// The FILE is parsed in the browser by the existing race-operations CSV/XLSX
// providers; only the two columns that matter cross the wire.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { resolveIdentifierScope } from '@/lib/identifiers/organizerScope'
import { resolveIdentifierConfig } from '@/lib/identifiers/config'
import { resolveEventAssignmentGate } from '@/lib/identifiers/assignmentDecision'
import { serializeJob } from '@/lib/jobs/serialize'
import { identifierAssignmentBlockedBy } from '@/lib/identifiers/eligibility'
import { TIMING_TAG_LOCKS } from '@/lib/identifiers/timingTagEngine'
import {
  resolveTagMapping, requiresMapping, validateTagRows, normalizeTag,
  type TagImportRow, type TagValidationContext, type TimingTagLockDoc,
} from '@/lib/identifiers/timingTags'
import {
  createTimingTagImportJob, processTimingTagImportChunk, getTimingTagImportJob,
  TAG_IMPORT_MAX_ROWS,
} from '@/lib/identifiers/timingTagImportJob'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Builds the validation context with BOUNDED reads.
 *
 * Only the identifiers actually present in the file are resolved, in `in` chunks of
 * ten, so a 50-row file costs five queries and a 20,000-row file costs 2,000 — never
 * a scan of the event, and never a download of the roster.
 */
async function buildContext(
  organizerUid: string, eventSlug: string, rows: TagImportRow[],
): Promise<TagValidationContext> {
  // Identifiers are stored with the event's own case policy (default: preserve), so
  // the query values must be the file's OWN text — upper-casing them would miss a
  // stored "del-0001". The upper-case form is included as well when it differs, so a
  // file that shouts still matches a stored lower-case value. For a numeric bib file
  // the two are identical and this costs nothing.
  const identifiers = [...new Set(
    rows.flatMap(r => {
      const raw = r.identifier.trim()
      if (!raw) return []
      const upper = raw.toUpperCase()
      return upper === raw ? [raw] : [raw, upper]
    }),
  )]
  const tags = [...new Set(rows.map(r => normalizeTag(r.tag)).filter(Boolean))]

  const byIdentifier: TagValidationContext['byIdentifier'] = new Map()
  const takenTags:    TagValidationContext['takenTags']    = new Map()

  const base = adminDb.collection('registrations')
    .where('organizerUid', '==', organizerUid)
    .where('eventSlug', '==', eventSlug)

  // Identifiers are stored with the organizer's own casing; the file may differ, so
  // both the query value and the comparison are folded.
  for (let i = 0; i < identifiers.length; i += 10) {
    const chunk = identifiers.slice(i, i + 10)
    const snap = await base.where('identifier.value', 'in', chunk)
      .select('identifier', 'status', 'timingTag').get()
    for (const d of snap.docs) {
      const r = d.data() as Record<string, unknown>
      const value = (r.identifier as { value?: unknown } | undefined)?.value
      if (typeof value !== 'string') continue
      const tg = r.timingTag as { normalizedTag?: unknown; state?: unknown } | null | undefined
      byIdentifier.set(normalizeTag(value), {
        registrationId: d.id,
        terminal: identifierAssignmentBlockedBy(r) !== null,
        currentTag: tg?.state === 'assigned' && typeof tg.normalizedTag === 'string'
          ? tg.normalizedTag : null,
      })
    }
  }

  for (let i = 0; i < tags.length; i += 10) {
    const chunk = tags.slice(i, i + 10)
    const snap = await adminDb.collection(TIMING_TAG_LOCKS)
      .where('eventSlug', '==', eventSlug)
      .where('state', '==', 'assigned')
      .where('normalizedTag', 'in', chunk)
      .select('normalizedTag', 'registrationId').get()
    for (const d of snap.docs) {
      const l = d.data() as Pick<TimingTagLockDoc, 'normalizedTag' | 'registrationId'>
      if (l.registrationId) takenTags.set(l.normalizedTag, l.registrationId)
    }
  }

  return { byIdentifier, takenTags }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  let body: { mode?: string; rows?: unknown }
  try { body = await req.json() as typeof body } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const mode = body.mode === 'commit' ? 'commit' : 'preview'

  const { config } = await resolveIdentifierConfig(scope.slug)
  const mapping = resolveTagMapping(config.tagMapping)
  if (!requiresMapping(mapping)) {
    return NextResponse.json({
      error: `${mapping.label} mapping is not available for this event.`,
      code: mapping.enabled ? 'TAG_MODE_IS_IDENTIFIER' : 'TAG_MAPPING_DISABLED',
    }, { status: 409 })
  }

  // A preview writes nothing, so it stays available on a read-only event; only the
  // commit is gated — the same split the bulk identifier route uses.
  if (mode === 'commit') {
    const gate = resolveEventAssignmentGate(scope.lifecycleStatus)
    if (!gate.open) return NextResponse.json({ error: gate.detail, code: gate.reason }, { status: 409 })
  }

  const raw = Array.isArray(body.rows) ? body.rows : []
  if (raw.length === 0) return NextResponse.json({ error: 'This file has no rows.' }, { status: 400 })
  if (raw.length > TAG_IMPORT_MAX_ROWS) {
    return NextResponse.json({ error: `That file has too many rows (max ${TAG_IMPORT_MAX_ROWS.toLocaleString('en-IN')}).` }, { status: 400 })
  }

  const rows: TagImportRow[] = raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>
    return {
      rowNumber:  typeof o.rowNumber === 'number' ? o.rowNumber : i + 1,
      identifier: typeof o.identifier === 'string' ? o.identifier : '',
      tag:        typeof o.tag === 'string' ? o.tag : '',
    }
  })

  // Validated on the SERVER in both modes — a commit never trusts the preview the
  // browser is holding, which may be stale or forged.
  const context = await buildContext(scope.workspaceUid, scope.slug, rows)
  const report = validateTagRows(rows, context)

  if (mode === 'preview') {
    return NextResponse.json({ ok: true, mode, report, label: mapping.label },
      { headers: { 'Cache-Control': 'no-store' } })
  }

  // Only rows that are committable AND would change something become work.
  const items = report.rows
    .filter(r => r.verdict !== 'invalid' && !r.issues.includes('UNCHANGED') && r.registrationId)
    .map(r => ({ registrationId: r.registrationId!, tag: r.tag.trim(), rowNumber: r.rowNumber }))

  if (items.length === 0) {
    return NextResponse.json({ ok: false, report, error: 'No row in this file would change anything.' }, { status: 409 })
  }

  const job = await createTimingTagImportJob({
    eventId, eventSlug: scope.slug,
    organizerUid: scope.workspaceUid, createdBy: scope.callerUid,
    label: mapping.label, rows: items,
  })
  try { await processTimingTagImportChunk(job.jobId) } catch { /* the cron will retry */ }
  const after = await getTimingTagImportJob(job.jobId)

  return NextResponse.json(
    { ok: true, mode, report, job: serializeJob(after ?? job) }, { status: 201 },
  )
}
