// /api/admin/organizers/[uid]/delete — RD-ORGANIZER-REMAINING-ALL
//
//   GET    → the eligibility verdict, so the console can show WHY deletion is unavailable
//   DELETE → evaluate again, then create/resume the deletion job
//
// ═══ THE AUTHORIZATION SHAPE ═════════════════════════════════════════════════
// Admin only, via `resolveAdminUid` — the same verifier every other admin route uses. There is
// deliberately no `verifyCaller` path: an organizer must not be able to reach this even for
// their own account, because the whole point of the endpoint is that a human with platform
// authority decides, after the server has proved the account is safe to remove.
//
// The target uid comes from the ROUTE, never from the body. A body-supplied target would make
// the endpoint's authorization a function of its own input.
//
// ═══ WHY ELIGIBILITY IS RE-EVALUATED HERE ════════════════════════════════════
// The console also calls GET to decide whether to offer the action. That verdict is a display.
// Between rendering it and clicking, an event can be created — so the DELETE re-runs every
// probe itself and refuses on its own reading. The UI is never the gate.
//
// ═══ RD-PREPROD · D3 — A REASON AND A DURABLE AUDIT ═══════════════════════════
// DELETE requires a written reason (3–500 characters, the same policy as every Super Admin
// financial action — parseFinancialReason). The ONLY body field read is `reason`; the target
// stays the route param. Before any data is touched an `organizer.deletion_requested` row is
// written to adminAuditLogs (actor, organizer uid, reason, server timestamp); if that write
// fails, nothing is deleted. Each run's outcome is then recorded as `organizer.deletion_result`
// (outcome, document count, failure COUNT — never names, emails, amounts or failure detail).
//
// ═══ WHAT IS NOT RETURNED ════════════════════════════════════════════════════
// Blockers carry a code and a sentence. No amounts, no document ids, no counts: an admin needs
// to know that a settlement is pending, not what it is worth.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { logAdminAction, logAdminActionOrRecord } from '@/lib/admin/audit'
import {
  evaluateDeletionEligibility, driveOrganizerDeletion,
  ORGANIZER_DELETION_JOBS,
} from '@/lib/admin/organizerDeletion'
import { getJob } from '@/lib/jobs/kernel'
import { captureError } from '@/lib/monitoring/sentry'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

/** Shape shared by both verbs so the console can render one thing. */
interface EligibilityBody {
  uid:       string
  exists:    boolean
  deletable: boolean
  blockers:  { code: string; reason: string }[]
  identity:  { name: string; email: string; organizationName: string } | null
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> },
): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { uid } = await params
  if (!uid) return NextResponse.json({ error: 'uid is required' }, { status: 400 })

  try {
    const e = await evaluateDeletionEligibility(uid)
    if (!e.exists) return NextResponse.json({ error: 'Organizer not found' }, { status: 404 })

    // A job already in flight is reported so the console does not offer the action twice.
    const job = await getJob(ORGANIZER_DELETION_JOBS, `orgdel_${uid}`)

    const body: EligibilityBody & { jobStatus: string | null } = {
      uid,
      exists:    e.exists,
      deletable: e.deletable,
      blockers:  e.blockers,
      identity:  e.identity,
      jobStatus: job?.status ?? null,
    }
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    captureError(err, { scope: 'admin.organizer_delete_eligibility', area: 'organizer' })
    return NextResponse.json({ error: 'Could not evaluate deletion eligibility' }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> },
): Promise<NextResponse> {
  // RD-INTEG — an irreversible removal of an account that has held money (wallet, refunds) is a
  // Super Admin action (ADMIN_UIDS), like every other money-adjacent write. (RD-SEC-01: the
  // legacy admin claim alone grants nothing — not even the GET verdict.)
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const adminUid = gate.uid

  const { uid } = await params
  if (!uid) return NextResponse.json({ error: 'uid is required' }, { status: 400 })

  // An admin deleting their own account would remove the identity performing the deletion
  // mid-run, and the audit trail would name a uid that no longer resolves.
  if (uid === adminUid) {
    return NextResponse.json({ error: 'An admin cannot delete their own account here.' }, { status: 409 })
  }

  // RD-PREPROD · D3 — a written reason is required. Only `reason` is read from the body.
  const payload = await req.json().catch(() => null) as { reason?: unknown } | null
  const parsedReason = parseFinancialReason(payload?.reason)
  if (!parsedReason.ok) return reasonErrorResponse(parsedReason)
  const reason = parsedReason.reason

  let eligibility
  try {
    eligibility = await evaluateDeletionEligibility(uid)
  } catch (err) {
    // A failed probe is NOT permission to proceed. Refusing is the only safe reading of "I
    // could not determine whether this organizer has events."
    captureError(err, { scope: 'admin.organizer_delete_eligibility', area: 'organizer' })
    return NextResponse.json({ error: 'Could not verify that this organizer is safe to delete.' }, { status: 503 })
  }

  if (!eligibility.exists) {
    // ═══ RD-ORGDEL-AUTH-01 · "no profile" does NOT always mean "nothing left" ═══
    // `exists` is read from users/{uid}, and the manifest deletes that document
    // second-to-last — immediately BEFORE the irreversible Firebase Auth step. So an
    // interrupted deletion lands here with its Auth user still alive, and answering 404
    // ("nothing left to delete") stranded that orphan permanently: the email stayed
    // unusable for every future signup and no retry could ever reach the job.
    //
    // The job document is the record that tells the two states apart. A non-terminal job
    // for this uid means a deletion really is still owed, so this resumes it instead.
    // Authorization is unchanged — only an admin reaches this line, and the job could only
    // have been created by an admin request that already passed the eligibility gate.
    const job = await getJob(ORGANIZER_DELETION_JOBS, `orgdel_${uid}`)
    const resumable = job !== null && job.status !== 'completed' && job.status !== 'cancelled'
    if (!resumable) {
      // Genuinely nothing left: never deleted, or deleted cleanly. 404 is honest.
      return NextResponse.json({ error: 'Organizer not found' }, { status: 404 })
    }
    return finishDeletion(uid, adminUid, reason, { resumed: true })
  }

  if (!eligibility.deletable) {
    return NextResponse.json({
      error:     'This organizer cannot be deleted yet.',
      deletable: false,
      blockers:  eligibility.blockers,
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
  }

  return finishDeletion(uid, adminUid, reason, { resumed: false })
}

/**
 * Drive (or resume) the deletion job and translate its outcome into the response.
 *
 * RD-ORGDEL-AUTH-01 · extracted so the ORDINARY path and the RESUME path (an interrupted
 * deletion whose users/{uid} is already gone) answer identically. Two copies of this switch
 * would be two chances to report a partial deletion as a completed one.
 */
async function finishDeletion(
  uid: string,
  adminUid: string,
  reason: string,
  opts: { resumed: boolean },
): Promise<NextResponse> {
  // RD-PREPROD · D3 — no deletion without its audit row: written (awaited) BEFORE the job runs.
  try {
    await logAdminAction({
      adminUid, actorRole: 'super_admin',
      action: 'organizer.deletion_requested', entityType: 'organizer', entityId: uid,
      reason, metadata: { resumed: opts.resumed },
    })
  } catch (err) {
    captureError(err, { scope: 'admin.organizer_delete_audit', area: 'organizer' })
    return NextResponse.json({ error: 'Could not record the audit entry. Nothing was deleted.' }, { status: 503 })
  }

  // The outcome of this run. Never throws (a failed write is itself recorded for reconciliation).
  const recordResult = (outcome: string, deleted: number, failureCount: number) =>
    logAdminActionOrRecord({
      adminUid, actorRole: 'super_admin',
      action: 'organizer.deletion_result', entityType: 'organizer', entityId: uid,
      reason, metadata: { outcome, deleted, failureCount, resumed: opts.resumed },
    })

  try {
    const r = await driveOrganizerDeletion({ uid, adminUid })
    await recordResult(r.outcome, r.deleted, r.failures.length)

    switch (r.outcome) {
      case 'completed':
        console.info(`[admin] organizer deleted · uid=${uid} by=${adminUid} docs=${r.deleted}`
          + (opts.resumed ? ' (resumed an interrupted deletion)' : ''))
        return NextResponse.json({
          success: true, finished: true, deleted: r.deleted, failures: [],
          ...(opts.resumed ? { resumed: true } : {}),
        })

      case 'already_completed':
        // The job document says this deletion already ran to completion.
        return NextResponse.json({ success: true, finished: true, alreadyCompleted: true, deleted: 0, failures: [] })

      case 'busy':
        return NextResponse.json({
          success: false, finished: false,
          error: 'A deletion for this organizer is already running. Retry shortly to continue.',
        }, { status: 409 })

      case 'cancelled':
        return NextResponse.json({
          success: false, finished: false,
          error: 'The deletion job for this organizer was cancelled.',
        }, { status: 409 })

      case 'not_found':
        return NextResponse.json({ success: false, error: 'The deletion job could not be created.' }, { status: 500 })

      case 'unfinished':
      default:
        // Partial work is NEVER reported as success. The cursor is committed, so retrying
        // continues from where this run stopped.
        return NextResponse.json({
          success: false, finished: false,
          deleted:  r.deleted,
          failures: r.failures.slice(0, 20),
          error: r.failures.length
            ? 'Some data could not be deleted. Retry to continue.'
            : 'Deletion is taking longer than one request allows. Retry to continue where it stopped.',
        }, { status: 500 })
    }
  } catch (err) {
    captureError(err, { scope: 'admin.organizer_delete', area: 'organizer' })
    await recordResult('error', 0, 1)
    return NextResponse.json({ error: 'Deletion failed. Retry to continue where it stopped.' }, { status: 500 })
  }
}
