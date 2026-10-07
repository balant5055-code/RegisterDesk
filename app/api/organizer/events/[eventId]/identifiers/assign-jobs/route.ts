// RD-EVENT-19E — Identifier assignment jobs.
//
//   POST → create one job PER PASS SCOPE and drive the first chunk of each.
//   GET  → the active jobs for this event, so a reload can rejoin a run.
//
// The client sends a SELECTION ("this pass", or "all passes"), never a list of
// registration ids: the roster is walked server-side, so a 20,000-participant
// event costs no roster download and no 20,000-id request body.
//
// Everything authoritative is resolved on the server — the workspace, the event,
// the identifier config, the pass→pool mapping and the lifecycle gate. A client
// may name a pass; it cannot name a pool for a pass it does not own, because the
// pool is looked up from the stored configuration by `planScopes`.

import { NextRequest, NextResponse } from 'next/server'
import { resolveIdentifierScope } from '@/lib/identifiers/organizerScope'
import { resolveIdentifierConfig } from '@/lib/identifiers/config'
import { resolveEventAssignmentGate } from '@/lib/identifiers/assignmentDecision'
import { serializeJob, type SerializedJob } from '@/lib/jobs/serialize'
import { listActiveJobs } from '@/lib/jobs/kernel'
import {
  createIdentifierAssignmentJob, processIdentifierAssignmentChunk, planScopes,
  getIdentifierAssignmentJob, IDENTIFIER_ASSIGNMENT_JOBS,
  type IdentifierAssignmentJob,
} from '@/lib/identifiers/assignmentJob'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export type SerializedAssignJob = SerializedJob<IdentifierAssignmentJob>

/** A job could not be created for this scope, and why. */
interface ScopeRefusal { passId: string | null; passName: string | null; reason: string }

export interface CreateAssignJobsResponse {
  ok:       boolean
  jobs:     SerializedAssignJob[]
  refused:  ScopeRefusal[]
  error?:   string
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  const active = await listActiveJobs<IdentifierAssignmentJob>(IDENTIFIER_ASSIGNMENT_JOBS, 25)
  return NextResponse.json({
    ok: true,
    jobs: active
      .filter(j => j.organizerUid === scope.workspaceUid && j.eventId === eventId)
      .map(serializeJob),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  // The SAME gate the single-assignment route applies. A UI-disabled button is
  // not a security boundary; this is.
  const gate = resolveEventAssignmentGate(scope.lifecycleStatus)
  if (!gate.open) {
    return NextResponse.json({ error: gate.detail, code: gate.reason }, { status: 409 })
  }

  let body: { selection?: { kind?: string; passIds?: unknown } }
  try { body = await req.json() as typeof body } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const kind = body.selection?.kind
  if (kind !== 'all_passes' && kind !== 'pass') {
    return NextResponse.json({ error: "selection.kind must be 'all_passes' or 'pass'" }, { status: 400 })
  }
  const passIds = Array.isArray(body.selection?.passIds)
    ? (body.selection!.passIds as unknown[]).filter((v): v is string => typeof v === 'string' && !!v)
    : []
  if (kind === 'pass' && passIds.length === 0) {
    return NextResponse.json({ error: 'Select at least one pass.' }, { status: 400 })
  }

  const { config, isStored } = await resolveIdentifierConfig(scope.slug)
  if (!isStored || config.enabled === false) {
    return NextResponse.json({ error: 'Identifiers are not configured for this event.', code: 'IDENTIFIERS_DISABLED' }, { status: 409 })
  }

  // A client-named pass is only ever a SELECTOR. The pool it maps to comes from
  // the stored configuration, so a forged pass id cannot reach another pool.
  const scopes = planScopes(
    config, scope.passes,
    kind === 'all_passes' ? { kind: 'all_passes' } : { kind: 'pass', passIds },
  )
  // …and a pass this event does not have is refused outright.
  const known = new Set(scope.passes.map(p => p.id))
  const requested = scopes.filter(s => s.passId === null || !scope.passesKnown || known.has(s.passId))
  const unknownPasses = scopes.filter(s => !requested.includes(s))

  const jobs: SerializedAssignJob[] = []
  const refused: ScopeRefusal[] = unknownPasses.map(s => ({
    passId: s.passId, passName: s.passName, reason: 'PASS_MISSING',
  }))

  for (const s of requested) {
    if (s.blocked || !s.poolId) {
      refused.push({ passId: s.passId, passName: s.passName, reason: s.blocked ?? 'POOL_MISSING' })
      continue
    }
    const job = await createIdentifierAssignmentJob({
      eventId, eventSlug: scope.slug,
      organizerUid: scope.workspaceUid, createdBy: scope.callerUid,
      passId: s.passId, passName: s.passName, poolId: s.poolId,
      label: config.label,
      // RD-BIB-01 · frozen onto the job, so editing the config while a run is in
      // flight cannot re-order a sequence that is already half-issued. Absent on the
      // config ⇒ 'document', which is what every existing event has always done.
      order: config.assignmentOrder ?? 'document',
      // The roster size is not counted up front: that would be an extra aggregate
      // per scope for a progress bar. `counts.processed` is the honest measure.
      total: 0,
    })
    // Drive the first chunk now so the organizer sees movement immediately; the
    // cron and the client poller complete the rest.
    try { await processIdentifierAssignmentChunk(job.jobId) } catch { /* the tick will retry */ }
    const after = await getIdentifierAssignmentJob(job.jobId)
    jobs.push(serializeJob(after ?? job))
  }

  if (jobs.length === 0) {
    return NextResponse.json({ ok: false, jobs, refused, error: 'No pass in this selection can be assigned yet.' }, { status: 409 })
  }
  return NextResponse.json({ ok: true, jobs, refused }, { status: 201 })
}
