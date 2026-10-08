// RD-INTEG · D3 — backstop for broadcast billing settlement ("charge on Meta accept").
//
// Every terminal path settles inline (finalizeBroadcast, the no-job early exit in send.ts,
// syncCampaignTerminal, the cancel route). Each of those is a best-effort step AFTER the
// campaign's status write, so a crash between the two would leave money/prepaid units charged
// for recipients WhatsApp never accepted. This sweep finds every campaign still marked
// `billingSettlement: 'pending'` and finishes the job, and recovers the two stuck shapes:
//   • 'sending' whose job already COMPLETED (onComplete never ran)      → finalize it now;
//   • 'sending' whose job was CANCELLED/FAILED (the terminal sync never ran) → sync + settle;
//   • 'sending' with NO job long after it was charged (crash before the job was created)
//     → deliver it (send.ts adopts an orphan job rather than creating a second one).
// It never settles while a worker could still send: a job that is active or holds a live lease
// is skipped until a later tick.

import { adminDb } from '@/lib/firebase/admin'
import { getJob } from '@/lib/jobs/kernel'
import type { Job } from '@/lib/jobs/types'
import { settleBroadcastBilling, releaseHeldBroadcastUnits } from '@/lib/communications/billing'
import { reconcileBroadcastBilledUnits } from '@/lib/whatsapp/acceptance'
import { releaseExpiredWhatsAppHolds } from '@/lib/whatsapp/funding'
import { EMAIL_BROADCAST_JOBS, finalizeEmailCampaign, syncEmailCampaignTerminal, type EmailBroadcastJob } from './emailJob'
import {
  WHATSAPP_BROADCAST_JOBS, countAcceptedRecipients, finalizeWhatsAppCampaign, syncCampaignTerminal,
} from './whatsappJob'

const SWEEP_BATCH = 25
/** A charged campaign with no job after this long is treated as crashed before job creation. */
const STUCK_NO_JOB_MS = 15 * 60_000
const TERMINAL = new Set(['sent', 'partial', 'failed', 'cancelled'])
/**
 * cancelJob clears the lease, so a worker that was mid-page when the organizer cancelled is not
 * visible as a lease. It finishes that page (at most a few messages) and commits within its lease
 * window; until a job has been quiet for longer than that, it is not settled.
 */
const SETTLE_GRACE_MS = 2 * 60_000

/** True when a job lease (a Firestore Timestamp, millis, or null) is still held. */
export function isLeaseLive(lockedUntil: unknown, now: number = Date.now()): boolean {
  if (lockedUntil == null) return false
  const ms = typeof lockedUntil === 'number' ? lockedUntil
    : typeof (lockedUntil as { toMillis?: unknown }).toMillis === 'function' ? (lockedUntil as { toMillis: () => number }).toMillis()
    : NaN
  return Number.isFinite(ms) && ms > now
}

const millisOf = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: unknown }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : null

export interface SweepOutcome {
  scanned: number; settled: number; finalized: number; redelivered: number; skipped: number; errored: number
  /** RD-COMMS-P2-A — expired transactional funding holds / held broadcast units given back. */
  holdsReleased: number; heldUnitsReleased: number
  /** RD-COMMS-P2-B — email campaigns brought out of a stuck `sending` (finalized / synced / redelivered). */
  emailRecovered: number
}

export async function sweepBroadcastSettlements(now: number = Date.now()): Promise<SweepOutcome> {
  const out: SweepOutcome = { scanned: 0, settled: 0, finalized: 0, redelivered: 0, skipped: 0, errored: 0, holdsReleased: 0, heldUnitsReleased: 0, emailRecovered: 0 }

  // RD-COMMS-P2-A — unresolved WhatsApp funding past the webhook window (lib/whatsapp/funding.ts):
  // transactional holds never accepted, and broadcast units held for recipients with no verdict.
  try { out.holdsReleased = (await releaseExpiredWhatsAppHolds(now)).released } catch (err) {
    out.errored++
    console.error('[broadcast-settlement-sweep] hold release failed:', err instanceof Error ? err.message : err)
  }
  const withHeld = await adminDb.collection('broadcastCampaigns').where('unknownHeldUnits', '>', 0).limit(SWEEP_BATCH).get()
  for (const d of withHeld.docs) {
    try { out.heldUnitsReleased += await releaseHeldBroadcastUnits(d.id, now) } catch { out.errored++ }
  }

  const pending = () => adminDb.collection('broadcastCampaigns').where('billingSettlement', '==', 'pending')
  const [ended, sending] = await Promise.all([
    pending().where('status', 'in', [...TERMINAL]).limit(SWEEP_BATCH).get(),
    pending().where('status', '==', 'sending').limit(SWEEP_BATCH).get(),
  ])
  const all = [...ended.docs, ...sending.docs]
  // RD-CLOSE — settled campaigns whose post-settlement catch-up did not complete.
  const catchUps = await adminDb.collection('broadcastCampaigns').where('billingCatchUp', '==', 'pending').limit(SWEEP_BATCH).get()
  for (const d of catchUps.docs) {
    try { await reconcileBroadcastBilledUnits(d.id); out.settled++ } catch { out.errored++ }
  }
  out.scanned = all.length

  for (const doc of all) {
    const c = doc.data() as { status?: string; channel?: string; whatsappJobId?: unknown; updatedAt?: unknown }
    try {
      const jobId = typeof c.whatsappJobId === 'string' && c.whatsappJobId ? c.whatsappJobId : null
      const job = jobId ? await getJob<Job>(WHATSAPP_BROADCAST_JOBS, jobId) : null
      const jobUpdated = job ? millisOf((job as { updatedAt?: unknown }).updatedAt) : null
      const jobActive = !!job && (job.status === 'pending' || job.status === 'processing' || isLeaseLive(job.lockedUntil, now)
        || (jobUpdated !== null && now - jobUpdated < SETTLE_GRACE_MS))

      if (TERMINAL.has(String(c.status))) {
        if (jobActive) { out.skipped++; continue }
        await settleBroadcastBilling(doc.id, jobId ? await countAcceptedRecipients(jobId) : 0)
        out.settled++
        continue
      }

      if (c.status === 'sending') {
        if (job && job.status === 'completed' && !jobActive && jobId) {
          await finalizeWhatsAppCampaign(jobId, doc.id)   // settles inside finalizeBroadcast
          out.finalized++
          continue
        }
        if (job && jobId && (job.status === 'cancelled' || job.status === 'failed') && !jobActive) {
          await syncCampaignTerminal(jobId, job.status)   // marks terminal + settles
          out.finalized++
          continue
        }
        // No job: never built, or (RD-COMMS-P2-B) its preparer died after claiming it — the claim
        // refreshes updatedAt, so this also waits out a live preparation before re-claiming.
        const updated = millisOf(c.updatedAt)
        if ((!jobId || !job) && updated !== null && now - updated > STUCK_NO_JOB_MS) {
          const { deliverBroadcastCampaign } = await import('./send')
          await deliverBroadcastCampaign(doc.id)
          out.redelivered++
          continue
        }
      }
      out.skipped++
    } catch (err) {
      out.errored++
      console.error('[broadcast-settlement-sweep] campaign error:', { campaignId: doc.id, err: err instanceof Error ? err.message : err })
    }
  }
  // RD-COMMS-P2-B — email campaigns stuck in `sending` (email never enters billing settlement).
  try { out.emailRecovered = await recoverStuckEmailCampaigns(now) } catch (err) {
    out.errored++
    console.error('[broadcast-settlement-sweep] email recovery failed:', err instanceof Error ? err.message : err)
  }
  return out
}

/**
 * RD-COMMS-P2-B — an EMAIL campaign must never sit in `sending` forever. Email carries no billing
 * settlement, so the pass above never sees it. For each `sending` email campaign:
 *   • its job COMPLETED but the completion hook never ran       → finalize it (counts from the job);
 *   • its job FAILED / was CANCELLED but the campaign was not synced (e.g. the reaper failed it)
 *                                                               → sync it to the same terminal state;
 *   • no job long after it started (a crash before / while building it) → deliver again (the build
 *     claim adopts or rebuilds the ONE job — never a second one).
 * A job that is pending, leased or recently active is left to its drivers. Already-delivered emails
 * are never re-sent (the per-recipient `sent` flags), and unreached recipients are never counted sent.
 */
export async function recoverStuckEmailCampaigns(now: number = Date.now()): Promise<number> {
  const snap = await adminDb.collection('broadcastCampaigns')
    .where('status', '==', 'sending').where('channel', '==', 'email').limit(SWEEP_BATCH).get()
  let recovered = 0
  for (const doc of snap.docs) {
    const c = doc.data() as { emailJobId?: unknown; updatedAt?: unknown }
    try {
      const jobId = typeof c.emailJobId === 'string' && c.emailJobId ? c.emailJobId : null
      const job = jobId ? await getJob<EmailBroadcastJob>(EMAIL_BROADCAST_JOBS, jobId) : null
      if (job && jobId) {
        const jobUpdated = millisOf((job as { updatedAt?: unknown }).updatedAt)
        const active = job.status === 'pending' || job.status === 'processing' || isLeaseLive(job.lockedUntil, now)
          || (jobUpdated !== null && now - jobUpdated < SETTLE_GRACE_MS)
        if (active) continue
        if (job.status === 'completed') { await finalizeEmailCampaign(job); recovered++; continue }
        if (job.status === 'failed' || job.status === 'cancelled') { await syncEmailCampaignTerminal(jobId, job.status); recovered++; continue }
        continue
      }
      const updated = millisOf(c.updatedAt)
      if (updated !== null && now - updated > STUCK_NO_JOB_MS) {
        const { deliverBroadcastCampaign } = await import('./send')
        await deliverBroadcastCampaign(doc.id)
        recovered++
      }
    } catch (err) {
      console.error('[broadcast-settlement-sweep] email campaign error:', { campaignId: doc.id, err: err instanceof Error ? err.message : err })
    }
  }
  return recovered
}
