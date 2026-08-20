// GET/POST /api/cron/job-reaper
//
// RD-JOB-CONT-01 — the last of three layers that keep a broadcast job moving.
//
//   1. the continuation chain — immediate, the common case
//   2. the 5-minute cron      — backstop when a chain is dropped
//   3. THIS                   — revives, or finally fails, a job both of the above missed
//
// WHY IT EXISTS. A `processing` job whose driver died leaves no trace: `error` stays null,
// counts stop moving, and nothing anywhere looks for it. That is how a 218-recipient
// campaign sat at 54/218 for half an hour showing a healthy-looking progress bar. A job
// must end up either finished or explicitly failed with a reason someone can act on — never
// silently parked forever.
//
// WHAT IT WILL NOT DO. It never touches a job that is making progress or whose lease is
// held. Reviving a live job would mean two drivers on one campaign; the lease already
// prevents a double commit, but the correct behaviour is not to try. Both guards are
// tested, and both are mutation-tested.
//
// It writes NOTHING itself except through the existing kernel helpers (failJob), so the
// lease/fencing model in lib/jobs/kernel.ts is untouched.
//
// Auth: `Authorization: Bearer <CRON_SECRET>`. Fail-closed.

import { NextRequest, NextResponse } from 'next/server'
import { listActiveJobs, failJob }   from '@/lib/jobs/kernel'
import type { Job }                  from '@/lib/jobs/types'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { recordCronExecution }       from '@/lib/monitoring/cronMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import { EMAIL_BROADCAST_JOBS, processEmailBroadcastChunk }       from '@/lib/broadcasts/emailJob'
import { WHATSAPP_BROADCAST_JOBS, processWhatsAppBroadcastChunk } from '@/lib/broadcasts/whatsappJob'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

/**
 * Idle time before a `processing` job is considered stalled and worth reviving.
 *
 * Comfortably longer than one chunk budget (45s) plus one lease (60s) plus a scheduled
 * tick (5 min), so a job that is simply between drivers is never disturbed.
 */
export const STALE_AFTER_MS = 10 * 60_000

/**
 * Idle time after which reviving has been tried and the job is declared failed.
 *
 * Failing it is the point: an organizer can see a reason and re-send, instead of watching a
 * progress bar that will never move.
 */
export const HARD_STALE_AFTER_MS = 30 * 60_000

const CRON_BUDGET_MS = 50_000
const JOB_BATCH      = 25

const CHANNELS = [
  { collection: EMAIL_BROADCAST_JOBS,    drive: processEmailBroadcastChunk,    label: 'email'    },
  { collection: WHATSAPP_BROADCAST_JOBS, drive: processWhatsAppBroadcastChunk, label: 'whatsapp' },
] as const

const millis = (v: unknown): number =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function'
    ? (v as { toMillis: () => number }).toMillis()
    : 0

interface ReapOutcome { collection: string; jobId: string; action: string; idleMs: number }

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  const outcomes: ReapOutcome[] = []
  let healthy = 0, leased = 0, revived = 0, stillStale = 0, failed = 0, errored = 0

  for (const channel of CHANNELS) {
    if (Date.now() - start > CRON_BUDGET_MS) break
    const jobs = await listActiveJobs<Job>(channel.collection, JOB_BATCH)

    for (const job of jobs) {
      if (Date.now() - start > CRON_BUDGET_MS) break
      if (job.status !== 'processing') continue      // pending jobs belong to the normal cron

      const now    = Date.now()
      const idleMs = now - millis(job.updatedAt)

      // GUARD 1 — recent progress. A healthy job is left completely alone.
      if (idleMs < STALE_AFTER_MS) { healthy++; continue }

      // GUARD 2 — a live lease. Someone is driving it right now; two drivers on one
      // campaign is precisely what the lease exists to prevent, so we do not become one.
      if (millis(job.lockedUntil) > now) { leased++; continue }

      try {
        const r = await channel.drive(job.jobId)
        if (r.processed > 0) {
          revived++
          outcomes.push({ collection: channel.collection, jobId: job.jobId, action: 'revived', idleMs })
        } else if (idleMs >= HARD_STALE_AFTER_MS) {
          // Reviving did not help and it has been stuck a long time. Fail it with something
          // a human can read — the alternative is an eternal `processing`.
          await failJob(
            channel.collection, job.jobId,
            `Stalled at ${job.counts.processed}/${job.counts.total} (cursor ${job.cursor ?? 'none'}). ` +
            `No progress for ${Math.round(idleMs / 60_000)} minutes; continuation, the scheduled ` +
            `cron and a reaper retry all failed to advance it.`,
          )
          failed++
          outcomes.push({ collection: channel.collection, jobId: job.jobId, action: 'failed', idleMs })
        } else {
          stillStale++
          outcomes.push({ collection: channel.collection, jobId: job.jobId, action: 'still_stale', idleMs })
        }
      } catch (err) {
        errored++
        console.error('[cron/job-reaper] revive failed:', { collection: channel.collection, jobId: job.jobId, err })
        captureError(err, { scope: 'cron.job_reaper', area: 'broadcast', jobId: job.jobId })
        outcomes.push({ collection: channel.collection, jobId: job.jobId, action: 'error', idleMs })
      }
    }
  }

  const durationMs = Date.now() - start
  void recordCronExecution('job-reaper', {
    ok: errored === 0,
    durationMs,
    detail: JSON.stringify({ healthy, leased, revived, stillStale, failed, errored }),
  }).catch(() => {})

  await flushMonitoring()
  return NextResponse.json({ durationMs, healthy, leased, revived, stillStale, failed, errored, jobs: outcomes })
}

export const GET  = handle
export const POST = handle
