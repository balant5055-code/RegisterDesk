// GET /api/organizer/reports/exports/[jobId]/download
//
// Secure, expiring download for a completed report export.
//
// ═══ RD-ANALYTICS-12-04 · WHAT CHANGED, AND WHY ══════════════════════════════
// This route used to end by redirecting to `job.output.url` — a
// `firebaseStorageDownloadTokens` capability URL minted at upload and PERSISTED on the job.
// It was unauthenticated, exempt from Storage rules (a download-token URL is served by an
// endpoint that never consults them), and had no expiry of its own, so it outlived the
// application's 24-hour expiry by the six days of object retention. Every control below was
// discarded the moment the redirect was issued: a captured URL kept working after
// cancellation, after expiry, and after the caller lost the permission (P1-2).
//
// It also accepted the caller's full Firebase ID token in `?token=`, so a session credential
// — not a download-scoped one — travelled in a URL, into logs, history and copied links
// (P1-3).
//
// Now the object stays private and a SHORT-LIVED signed URL is minted per request, only
// after every check below has passed. Authentication is by `Authorization` header only.
//
// ═══ WHAT DID NOT CHANGE ═════════════════════════════════════════════════════
// The authorization boundary from RD-ANALYTICS-12-03 is untouched, and still runs BEFORE any
// storage call. The signed URL is a delivery capability issued after authorization — never
// the authorization itself.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { getReportExportJob, permissionForExportJob } from '@/lib/reports/exportJob'
import { signedReadUrl, SIGNED_URL_MAX_SECONDS } from '@/lib/firebase/storage/admin'

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params

  /**
   * Header auth only.
   *
   * The `?token=` branch is gone: it existed so a bare `<a download>` would work, and the
   * cost was the caller's whole session credential in a URL. The UI now fetches with an
   * `Authorization` header — the pattern the synchronous report download in the same page
   * already used.
   */
  const authReq = req
  /**
   * RD-ANALYTICS-12-03 · the SAME boundary the sibling routes use.
   *
   * This previously called `verifyCaller` + `resolveWorkspaceUid` directly, which skipped
   * the gate-only-role exclusion that `authorizeAnyWorkspace` applies — so an account
   * "limited to event check-in" satisfied the ownership test and could fetch a financial
   * export. Going through the shared helper restores that exclusion here rather than
   * restating it, and hands back the caller's CURRENT permissions for the check below.
   */
  const authz = await authorizeAnyWorkspace(authReq)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const job = await getReportExportJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ error: 'Export not found' }, { status: 404 })
  }

  /**
   * The report's own permission, re-checked AT DOWNLOAD TIME.
   *
   * Generation checked it once and nothing checked it again, so a caller who has since lost
   * `transactions` — or never had it and merely holds the jobId — kept full access. The
   * permission comes from the registry via `permissionForExportJob`, never from the request,
   * and is read from `authz.permissions`, which was resolved server-side moments ago: a
   * revocation therefore takes effect on the next download rather than at token expiry.
   *
   * ═══ WHY 404 AND NOT 403 ═════════════════════════════════════════════════════
   * The caller supplied nothing but an opaque jobId. Answering "403: missing required
   * permission: transactions" would confirm both that the export exists and that it is
   * financial — facts this caller is not entitled to. The route already answers 404 for
   * every other "you may not have this" case, so this stays consistent with it and leaks
   * nothing. An unregistered kind is refused the same way rather than treated as
   * permission-free.
   */
  const need = permissionForExportJob(job)
  if (!need || !authz.permissions.includes(need)) {
    return NextResponse.json({ error: 'Export not found' }, { status: 404 })
  }
  // A cancelled job may still carry an `output` (cancelJob does not clear it), so
  // gate on status too — a cancelled export must not remain downloadable.
  if (job.status === 'cancelled') {
    return NextResponse.json({ error: 'This export was cancelled.' }, { status: 410 })
  }
  if (!job.output) {
    return NextResponse.json({ error: 'Export is not ready yet' }, { status: 409 })
  }

  const expiresMs = job.output.expiresAt instanceof Object && typeof (job.output.expiresAt as { toMillis?: unknown }).toMillis === 'function'
    ? (job.output.expiresAt as { toMillis(): number }).toMillis()
    : 0
  if (expiresMs > 0 && expiresMs < Date.now()) {
    return NextResponse.json({ error: 'This download link has expired. Generate the report again.' }, { status: 410 })
  }

  /**
   * The signed URL — minted HERE, after every check above, and never stored.
   *
   * ═══ THE TTL IS THE LESSER OF TWO BOUNDS ═════════════════════════════════════
   * 300 seconds is the ceiling the rest of the product uses for a download capability. But a
   * URL must never outlive the report it serves, so when the job expires sooner the signature
   * expires with it. Without that `min`, a download requested one second before expiry would
   * hand out five more minutes of access to a report the API is about to call expired — which
   * is a smaller version of exactly the defect this phase removes.
   */
  const remainingSeconds = expiresMs > 0
    ? Math.floor((expiresMs - Date.now()) / 1000)
    : SIGNED_URL_MAX_SECONDS
  const ttl = Math.min(SIGNED_URL_MAX_SECONDS, remainingSeconds)
  // Already refused above when the job has expired; this is the belt-and-braces case where
  // the remaining life rounds to nothing.
  if (ttl < 1) {
    return NextResponse.json({ error: 'This download link has expired. Generate the report again.' }, { status: 410 })
  }

  let url: string
  try {
    url = await signedReadUrl(job.output.path, {
      expiresInSeconds: ttl,
      filename:    job.output.filename,
      contentType: job.output.contentType,
    })
  } catch (err) {
    // Never fall back to the capability URL — that is the mechanism being retired. The
    // storage path is deliberately kept out of the response.
    console.error('[reports/exports/download] signing failed:', { jobId, err })
    return NextResponse.json(
      { error: 'This download is temporarily unavailable. Please try again shortly.' },
      { status: 503 },
    )
  }

  // 302, never 301: a permanent redirect would be cached and pin the browser to one expiring
  // signature. `no-store` for the same reason, and because this is a financial artifact.
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'no-store' },
  })
}
