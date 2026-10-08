// RD-COMMS-P2-B — creating a broadcast's runner job EXACTLY ONCE, and only once it is complete.
// Server-only.
//
// THE INVARIANTS
//   • one campaign ⇒ at most one executable job. The job id is deterministic (wab_/eb_<campaignId>)
//     and the right to PREPARE it is claimed on the campaign document in a transaction, so two
//     drivers (a send, the settlement sweep, two cron runners) can never each build one.
//   • a job is never processable half-built. Its recipient rows are written FIRST; the job
//     document — the only thing listActiveJobs / leaseJob can see — is created LAST, in a
//     transaction that also requires the campaign to still be `sending` and to still point at
//     this job (a campaign cancelled mid-preparation never gets a job).
//   • a preparer that dies is recovered: its claim (`jobPreparingAt`) goes stale after
//     JOB_PREP_STALE_MS and the next driver re-claims, clears the partial rows and rebuilds.
//
// Status changes of a campaign go through transitionCampaign — a status-GUARDED write, so a
// terminal state can never be overwritten by another terminal transition (cancel vs finalize).

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { txnCreateJob } from '@/lib/jobs/kernel'

/** A preparation claim older than this is presumed dead (its driver crashed mid-snapshot). */
export const JOB_PREP_STALE_MS = 15 * 60_000

export type BroadcastJobKind = 'whatsapp' | 'email'
export const broadcastJobIdFor = (kind: BroadcastJobKind, campaignId: string) => `${kind === 'whatsapp' ? 'wab' : 'eb'}_${campaignId}`
const pointerField = (kind: BroadcastJobKind) => (kind === 'whatsapp' ? 'whatsappJobId' : 'emailJobId')

export type JobClaim =
  | { kind: 'adopt'; jobId: string }       // the job exists — drive it
  | { kind: 'prepare'; jobId: string }     // THIS caller builds it (recipients, then the job doc)
  | { kind: 'busy' }                       // another driver is building it right now
  | { kind: 'not_sending' }                // the campaign is not (or no longer) sending

const millisOf = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: unknown }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : null

/** Decides, atomically, who builds the campaign's job (or that it already exists). */
export async function claimBroadcastJob(
  ref: FirebaseFirestore.DocumentReference, kind: BroadcastJobKind, jobsCollection: string, now: number = Date.now(),
): Promise<JobClaim> {
  return adminDb.runTransaction<JobClaim>(async txn => {
    const s = await txn.get(ref)
    const c = (s.data() ?? {}) as Record<string, unknown>
    if (!s.exists || c.status !== 'sending') return { kind: 'not_sending' }
    const existing = typeof c[pointerField(kind)] === 'string' && c[pointerField(kind)] ? String(c[pointerField(kind)]) : null
    const jobId = existing ?? broadcastJobIdFor(kind, ref.id)
    const jobSnap = await txn.get(adminDb.collection(jobsCollection).doc(jobId))
    if (jobSnap.exists) {
      if (!existing) txn.update(ref, { [pointerField(kind)]: jobId })
      return { kind: 'adopt', jobId }
    }
    const preparingMs = millisOf(c.jobPreparingAt)
    if (existing && preparingMs !== null && now - preparingMs < JOB_PREP_STALE_MS) return { kind: 'busy' }
    txn.update(ref, { [pointerField(kind)]: jobId, jobPreparingAt: Timestamp.fromMillis(now), updatedAt: FieldValue.serverTimestamp() })
    return { kind: 'prepare', jobId }
  })
}

/**
 * Status-GUARDED campaign write: applies `patch` only while the campaign's status is one of
 * `from`. Returns whether it applied. Used for every terminal transition so cancel / finalize /
 * fail can never overwrite each other.
 */
export async function transitionCampaign(
  ref: FirebaseFirestore.DocumentReference, from: readonly string[], patch: Record<string, unknown>,
): Promise<boolean> {
  return adminDb.runTransaction<boolean>(async txn => {
    const s = await txn.get(ref)
    if (!s.exists || !from.includes(String((s.data() as { status?: unknown }).status))) return false
    txn.update(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() })
    return true
  })
}

/**
 * Builds a broadcast job in the only safe order: (1) clear any rows a dead preparer left, (2)
 * write every recipient row, (3) CREATE the job document — in a transaction that, when a
 * `campaign` is given, also requires that campaign to still be `sending` and to point at this
 * job, and clears its preparation claim. Returns the job, the already-existing job (adopted), or
 * null when the campaign stopped sending meanwhile (no job is created).
 */
export async function buildBroadcastJob<T>(args: {
  jobsCollection: string
  jobId:          string
  seed:           Record<string, unknown>
  rows:           ReadonlyArray<Record<string, unknown>>
  campaign?:      { ref: FirebaseFirestore.DocumentReference; kind: BroadcastJobKind }
}): Promise<T | null> {
  const jobRef = adminDb.collection(args.jobsCollection).doc(args.jobId)
  const existing = await jobRef.get()
  if (existing.exists) return existing.data() as T

  const rowsCol = jobRef.collection('recipients')
  await adminDb.recursiveDelete(rowsCol)
  for (let i = 0; i < args.rows.length; i += 400) {
    const batch = adminDb.batch()
    for (let j = i; j < Math.min(i + 400, args.rows.length); j++) batch.set(rowsCol.doc(`r${String(j).padStart(7, '0')}`), args.rows[j])
    await batch.commit()
  }

  const created = await adminDb.runTransaction<'created' | 'exists' | 'abandoned'>(async txn => {
    const [jSnap, cSnap] = await Promise.all([txn.get(jobRef), args.campaign ? txn.get(args.campaign.ref) : Promise.resolve(null)])
    if (jSnap.exists) return 'exists'
    if (args.campaign) {
      const c = (cSnap?.data() ?? {}) as Record<string, unknown>
      if (!cSnap?.exists || c.status !== 'sending' || c[pointerField(args.campaign.kind)] !== args.jobId) return 'abandoned'
      txn.update(args.campaign.ref, { jobPreparingAt: FieldValue.delete() })
    }
    txnCreateJob(txn, args.jobsCollection, args.jobId, args.seed, args.rows.length)
    return 'created'
  })
  if (created === 'abandoned') return null
  return (await jobRef.get()).data() as T
}
