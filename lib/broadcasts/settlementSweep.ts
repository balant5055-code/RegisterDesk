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
import { settleBroadcastBilling } from '@/lib/communications/billing'
import { reconcileBroadcastBilledUnits } from '@/lib/whatsapp/acceptance'
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

export interface SweepOutcome { scanned: number; settled: number; finalized: number; redelivered: number; skipped: number; errored: number }

export async function sweepBroadcastSettlements(now: number = Date.now()): Promise<SweepOutcome> {
  const out: SweepOutcome = { scanned: 0, settled: 0, finalized: 0, redelivered: 0, skipped: 0, errored: 0 }
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
        const updated = millisOf(c.updatedAt)
        if (!jobId && updated !== null && now - updated > STUCK_NO_JOB_MS) {
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
  return out
}
