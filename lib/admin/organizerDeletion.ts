// RD-ORGANIZER-REMAINING-ALL · Deleting an organizer account. Server-only.
//
// ═══ THE SHAPE OF THE PROBLEM ════════════════════════════════════════════════
// An organizer uid is referenced by events, registrations, money and Firebase Auth. Deleting
// the account by uid — which is what `DELETE /api/organizer/settings` did — removes the
// identity and leaves every one of those references pointing at nothing. A published event
// whose `uid` no longer resolves cannot be moderated, settled, or explained to its attendees.
//
// So this module is mostly NOT a delete. It is an eligibility gate that refuses, plus an
// explicit manifest for the narrow case where refusing is unnecessary.
//
// ═══ THE RULE ════════════════════════════════════════════════════════════════
// An organizer is deletable only when they have never really used the platform: no events in
// ANY lifecycle state, no drafts, no registrations, no campaigns, no money. "Zero ACTIVE
// events" is not the test — an archived or cancelled event is still an event, and its
// attendees still hold tickets naming an organizer.
//
// ═══ WHAT IS DELETED VERSUS WHAT BLOCKS ══════════════════════════════════════
// Every collection in the repository was classified explicitly (see the three tables below).
// Nothing is deleted because a document happened to contain the uid — `deleteWhere(uid)` as a
// strategy is exactly how financial history disappears. A collection is in the manifest only
// when its ownership is unambiguous AND its loss is acceptable; anything financial or auditable
// BLOCKS the deletion instead of being destroyed by it.
//
// ═══ ORDERING ════════════════════════════════════════════════════════════════
// Firestore first, then storage, then the staff credentials, then `users/{uid}`, and Firebase
// Auth LAST. Auth is the only irreversible, unrecoverable step: while it still exists the job
// is re-runnable and the account is still identifiable. Deleting it first would leave an
// un-attributable pile of orphaned documents.

import { FieldValue } from 'firebase-admin/firestore'
import { SERVICE_REQUESTS_COLLECTION } from '@/lib/wallet/serviceRequestRules'
import { adminDb, adminAuth } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import { deleteByPrefix } from '@/lib/firebase/storage/admin'
import { TEAM_COLLECTION } from '@/lib/team/types'
import { STAFF_COLLECTION, STAFF_USERNAME_COLLECTION } from '@/lib/staff/types'
import type { SettlementStatus } from '@/lib/settlements/types'
import { createJob, getJob, leaseJob, commitChunk } from '@/lib/jobs/kernel'
import {
  buildOrganizerDeletionManifest, encodeProgress, decodeProgress,
  ORGANIZER_DELETION_JOBS,
  type OrganizerDeletionStep, type OrganizerStepProgress,
} from '@/lib/admin/organizerDeletionManifest'

// The PLAN is pure and lives next door (organizerDeletionManifest.ts) so it can be reasoned
// about and unit-tested without Firebase. Re-exported here so callers have one import site.
export {
  buildOrganizerDeletionManifest, encodeProgress, decodeProgress,
  ORGANIZER_RETAINED_COLLECTIONS, SHARED_COLLECTIONS, ORGANIZER_DELETION_JOBS,
} from '@/lib/admin/organizerDeletionManifest'
export type { OrganizerDeletionStep, OrganizerStepProgress } from '@/lib/admin/organizerDeletionManifest'

// ═══════════════════════════════════════════════════════════════════════════════
// 2 · ELIGIBILITY
// ═══════════════════════════════════════════════════════════════════════════════

export type DeletionBlockCode =
  | 'EVENTS_EXIST'
  | 'EVENT_DRAFTS_EXIST'
  | 'CAMPAIGN_DRAFTS_EXIST'
  | 'DONATION_CAMPAIGNS_EXIST'
  | 'REGISTRATIONS_EXIST'
  | 'WALLET_BALANCE_NONZERO'
  | 'WALLET_CLAWBACKS_EXIST'
  | 'PLATFORM_TRANSACTIONS_EXIST'
  | 'SETTLEMENTS_PENDING'
  | 'LICENSE_RECORDS_EXIST'
  | 'TEAM_MEMBERS_EXIST'
  | 'SERVICE_REQUESTS_OPEN'
  | 'BADGE_BILLING_RECORDS_EXIST'

export interface DeletionBlocker {
  code:   DeletionBlockCode
  /** One short sentence an admin can act on. Never exposes an amount or a document id. */
  reason: string
}

export interface DeletionEligibility {
  deletable: boolean
  blockers:  DeletionBlocker[]
  /** Present only when the organizer profile exists. */
  identity:  { name: string; email: string; organizationName: string } | null
  exists:    boolean
}

/**
 * Settlement states that are still in flight — money the platform still owes or is moving.
 *
 * Typed as `SettlementStatus[]` deliberately. An earlier draft of this list carried
 * 'processing' and 'on_hold', neither of which exists in the union: Firestore `in` simply never
 * matches a phantom value, so the probe would have looked thorough while testing for states
 * that cannot occur. The annotation makes that a compile error instead.
 *
 * 'paid' and 'rejected' are the only terminal states — both mean nothing is owed.
 */
const NON_TERMINAL_SETTLEMENT: SettlementStatus[] = ['pending', 'approved']

/** `true` when at least one document matches. One doc read, never a full scan. */
async function any(q: FirebaseFirestore.Query): Promise<boolean> {
  const snap = await q.limit(1).get()
  return !snap.empty
}

/**
 * Decide whether this organizer can be deleted, and say why not.
 *
 * Every check is a bounded existence probe (`limit(1)`), so this is cheap enough to call from
 * the list UI as well as from the destructive endpoint — and the endpoint calls it again
 * regardless, because a UI verdict is a display, not an authorization.
 *
 * Reads are deliberately independent: one failing probe must not be able to report
 * "deletable" for the rest. A thrown read propagates and the caller refuses.
 */
export async function evaluateDeletionEligibility(uid: string): Promise<DeletionEligibility> {
  const userSnap = await adminDb.collection('users').doc(uid).get()
  const exists   = userSnap.exists
  const u        = userSnap.data() as { name?: unknown; email?: unknown; organizationName?: unknown } | undefined
  const identity = exists ? {
    name:             typeof u?.name === 'string' ? u.name : '',
    email:            typeof u?.email === 'string' ? u.email : '',
    organizationName: typeof u?.organizationName === 'string' ? u.organizationName : '',
  } : null

  const [
    hasEvents, hasEventDrafts, hasCampaignDrafts, hasDonationCampaigns,
    hasRegistrations, walletBalance, hasClawbacks, hasPlatformTx,
    hasPendingSettlement, hasLicenses, hasTeam, hasOpenServiceRequest,
    hasBadgeBilling,
  ] = await Promise.all([
    // ── EVENTS · every lifecycle state ────────────────────────────────────────
    // No status filter on purpose. An archived, cancelled or completed event is still an
    // event, still referenced by its registrations, and still names this organizer.
    any(adminDb.collection('events').where('uid', '==', uid)),
    any(adminDb.collection('users').doc(uid).collection('eventDrafts')),
    any(adminDb.collection('users').doc(uid).collection('campaignDrafts')),
    any(adminDb.collection('donationCampaigns').where('uid', '==', uid)),
    // Registrations are event-scoped, so a zero-event organizer cannot have any. Probed
    // anyway: "cannot" is an inference about the schema, and this is a destructive operation.
    any(adminDb.collection('registrations').where('organizerUid', '==', uid)),
    // RD-PREPROD · NO .catch: a failed read must propagate (the caller answers 503), exactly like
    // every other probe here. Swallowing it as 0 let an organizer with a non-zero communication
    // wallet be deleted whenever this one read failed.
    adminDb.collection('organizerWallets').doc(uid).get()
      .then(s => (s.exists ? ((s.data() as { balancePaise?: number }).balancePaise ?? 0) : 0)),
    any(adminDb.collection('walletClawbacks').where('organizerUid', '==', uid)),
    any(adminDb.collection('platformTransactions').where('organizerUid', '==', uid)),
    any(adminDb.collection('settlementRequests')
      .where('organizerUid', '==', uid)
      .where('status', 'in', NON_TERMINAL_SETTLEMENT)),
    any(adminDb.collection('eventLicenses').where('organizerUid', '==', uid)),
    any(adminDb.collection(TEAM_COLLECTION).where('organizerUid', '==', uid)),
    // RD-INTEG — an event-service refund/carry-forward request still awaiting a decision, or
    // APPROVED but not yet paid out (approval is not money moved): deleting the organizer would
    // orphan money the platform still owes.
    any(adminDb.collection(SERVICE_REQUESTS_COLLECTION)
      .where('organizerUid', '==', uid)
      .where('status', 'in', ['submitted', 'approved'])),
    // RD-PRINT-BILL-P7 — ID-badge billing evidence (approved: retain AND block, like eventLicenses):
    // a badge purchase order, an attendee billing claim or a generation billing round names this
    // organizer. These are financial records; the manifest never deletes them, so they block instead.
    Promise.all([
      any(adminDb.collection('licenseOrders').where('purpose', '==', 'print_badges').where('organizerUid', '==', uid)),
      any(adminDb.collection('printBadgeClaims').where('organizerUid', '==', uid)),
      any(adminDb.collection('printBadgeRounds').where('organizerUid', '==', uid)),
    ]).then(r => r.some(Boolean)),
  ])

  const blockers: DeletionBlocker[] = []
  const add = (code: DeletionBlockCode, reason: string) => blockers.push({ code, reason })

  if (hasEvents)            add('EVENTS_EXIST', 'This organizer owns one or more events. Events must be deleted first.')
  if (hasEventDrafts)       add('EVENT_DRAFTS_EXIST', 'This organizer has unpublished event drafts.')
  if (hasCampaignDrafts)    add('CAMPAIGN_DRAFTS_EXIST', 'This organizer has unpublished campaign drafts.')
  if (hasDonationCampaigns) add('DONATION_CAMPAIGNS_EXIST', 'This organizer owns one or more donation campaigns.')
  if (hasRegistrations)     add('REGISTRATIONS_EXIST', 'Registrations exist for this organizer.')
  if (walletBalance !== 0)  add('WALLET_BALANCE_NONZERO', 'The organizer wallet balance is not zero.')
  if (hasClawbacks)         add('WALLET_CLAWBACKS_EXIST', 'Wallet clawback records exist and must be retained.')
  if (hasPlatformTx)        add('PLATFORM_TRANSACTIONS_EXIST', 'Platform transaction history exists and must be retained.')
  if (hasPendingSettlement) add('SETTLEMENTS_PENDING', 'A settlement is still in progress.')
  if (hasLicenses)          add('LICENSE_RECORDS_EXIST', 'Event licence records exist and must be retained.')
  if (hasTeam)              add('TEAM_MEMBERS_EXIST', 'Team or staff members belong to this workspace.')
  if (hasOpenServiceRequest) add('SERVICE_REQUESTS_OPEN', 'An event-service refund or carry-forward request is awaiting a decision or an approved refund has not been paid out.')
  if (hasBadgeBilling)      add('BADGE_BILLING_RECORDS_EXIST', 'ID badge purchase or billing records exist and must be retained.')

  return { deletable: exists && blockers.length === 0, blockers, identity, exists }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4 · BOUNDED, RESUMABLE EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

/** Docs per Firestore batch. The hard limit is 500; 300 leaves headroom. */
const PAGE = 300
/** Storage objects per page. */
const STORAGE_PAGE = 200

async function deleteDocs(refs: FirebaseFirestore.DocumentReference[]): Promise<void> {
  const batch = adminDb.batch()
  for (const ref of refs) batch.delete(ref)
  await batch.commit()
}

function advance(p: OrganizerStepProgress): { progress: OrganizerStepProgress; done: boolean } {
  return { progress: { ...p, step: p.step + 1 }, done: false }
}

/**
 * Runs ONE bounded page of work and reports how far it got.
 *
 * `done: false` while the current step may still have documents, so the caller commits a
 * cursor and comes back. Re-running a page is safe: deleting an already-deleted document is a
 * no-op in Firestore, in Storage and in Auth.
 */
export async function runOrganizerDeletionStep(
  manifest: OrganizerDeletionStep[],
  progress: OrganizerStepProgress,
): Promise<{ progress: OrganizerStepProgress; done: boolean }> {
  const step = manifest[progress.step]
  if (!step) return { progress, done: true }

  try {
    switch (step.kind) {
      case 'query': {
        const snap = await adminDb.collection(step.collection)
          .where(step.field, '==', step.value)
          .limit(PAGE).get()
        if (snap.empty) return advance(progress)
        await deleteDocs(snap.docs.map(d => d.ref))
        // Stay on this step: another page may remain.
        return { progress: { ...progress, deleted: progress.deleted + snap.size }, done: false }
      }

      case 'subcollection': {
        const snap = await adminDb.doc(step.parentPath).collection(step.name).limit(PAGE).get()
        if (snap.empty) return advance(progress)
        await deleteDocs(snap.docs.map(d => d.ref))
        return { progress: { ...progress, deleted: progress.deleted + snap.size }, done: false }
      }

      case 'doc': {
        await adminDb.doc(step.path).delete()
        return advance({ ...progress, deleted: progress.deleted + 1 })
      }

      case 'storagePrefix': {
        const r = await deleteByPrefix(step.prefix, STORAGE_PAGE)
        const next = {
          ...progress,
          deleted:  progress.deleted + r.deleted,
          failures: r.failed > 0 ? [...progress.failures, `${step.label}: ${r.failed} object(s) failed`] : progress.failures,
        }
        // A page that scanned nothing is finished. A page that scanned objects but deleted
        // none would otherwise loop for ever, so it advances rather than retrying blindly.
        if (r.scanned === 0 || r.deleted === 0) return advance(next)
        return { progress: next, done: false }
      }

      case 'staffUsernameLocks': {
        // The lock's doc id is the USERNAME, so it can only be found through the staff row
        // that owns it. Bounded by the same page size; the staff rows themselves are deleted
        // by a later step, so this converges.
        const snap = await adminDb.collection(STAFF_COLLECTION)
          .where('organizerUid', '==', step.organizerUid)
          .limit(PAGE).get()
        if (snap.empty) return advance(progress)
        const usernames = snap.docs
          .map(d => (d.data() as { username?: unknown }).username)
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
        if (usernames.length === 0) return advance(progress)
        await deleteDocs(usernames.map(n => adminDb.collection(STAFF_USERNAME_COLLECTION).doc(n)))
        // Advance unconditionally: the locks for this page are gone, and the staff rows are
        // still present, so staying here would re-read the same page and delete nothing.
        return advance({ ...progress, deleted: progress.deleted + usernames.length })
      }

      case 'staffAuthUsers': {
        // A staff credential is a real Firebase Auth user (on the reserved .invalid domain).
        // Leaving it behind would leave a credential that can still authenticate into a
        // workspace that no longer exists.
        const snap = await adminDb.collection(STAFF_COLLECTION)
          .where('organizerUid', '==', step.organizerUid)
          .limit(PAGE).get()
        if (snap.empty) return advance(progress)
        const ids = snap.docs
          .map(d => (d.data() as { staffId?: unknown }).staffId)
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
        const failures: string[] = []
        let removed = 0
        for (const id of ids) {
          try { await adminAuth.deleteUser(id); removed++ }
          catch (err) {
            const code = (err as { code?: string }).code
            // Already gone is a success — this step must be safe to re-run.
            if (code === 'auth/user-not-found') { removed++; continue }
            failures.push(`staffAuth ${id}`)
            captureError(err, { scope: 'organizer_delete_staff_auth', area: 'organizer', staffId: id })
          }
        }
        const next = { ...progress, deleted: progress.deleted + removed, failures: [...progress.failures, ...failures] }
        // RD-PREPROD · a failed credential delete HOLDS this step. Advancing let the later
        // staffAccounts step delete the very rows this query finds the credentials through, so
        // no retry could ever reach them again: a live staff login over a deleted workspace.
        // Held, the driver ends the invocation (heldForRetry) and the next run retries it.
        return failures.length > 0 ? { progress: next, done: false } : advance(next)
      }

      case 'auth': {
        // THE IRREVERSIBLE STEP. It is last in the manifest, and it only runs because every
        // preceding step advanced — which for a failing step means it was recorded in
        // `failures`, and the job is then reported as NOT ok even though it reached the end.
        try {
          await adminAuth.deleteUser(step.uid)
          return advance({ ...progress, deleted: progress.deleted + 1 })
        } catch (err) {
          const code = (err as { code?: string }).code
          if (code === 'auth/user-not-found') return advance({ ...progress, deleted: progress.deleted + 1 })
          throw err
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    captureError(err, { scope: 'organizer_delete_step', area: 'organizer', step: step.label })
    const failed = { ...progress, failures: [...progress.failures, `${step.label}: ${message}`] }

    // ═══ RD-ORGDEL-AUTH-01 · the AUTH step does NOT advance past its own failure ═══
    // For a bulk step, advancing is right: one unreachable collection must not wedge the
    // rest of the plan, and the recorded failure stops the job reporting a clean deletion.
    //
    // The Auth step is different in two ways that invert that trade-off. It is LAST, so
    // refusing to advance cannot block any other work — there is none. And its failure is
    // the one with a lasting, user-visible consequence: every preceding step has already
    // run (including users/{uid}), so advancing leaves a Firebase Auth user with no
    // RegisterDesk data behind it. That orphan keeps the email permanently unusable —
    // the next signup for it fails with EMAIL_EXISTS — and because the cursor had moved
    // past the step, no retry would ever attempt the delete again.
    //
    // Holding the cursor ON this step is what makes the deletion genuinely resumable:
    // the next run re-leases the same job and retries exactly the one thing that failed.
    if (step.kind === 'auth') return { progress: failed, done: false }

    return advance(failed)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5 · THE JOB
// ═══════════════════════════════════════════════════════════════════════════════


export interface OrganizerDeletionSummary {
  ok:       boolean
  deleted:  number
  failures: string[]
}

/**
 * Runs the whole manifest, bounded by `maxPages`.
 *
 * `ok` is false whenever ANY step failed, even if everything else succeeded — a partial
 * deletion must never be reported as a clean one. Safe to call again from any point: each
 * remaining step re-runs against whatever is left, and a step whose data is already gone
 * advances immediately.
 *
 * ELIGIBILITY IS NOT RE-CHECKED HERE. The caller checks it before creating the job, and
 * re-checking mid-run would make a resumed job refuse itself: its first pages have already
 * deleted the very documents the gate reads.
 */
export async function runOrganizerDeletion(
  uid:      string,
  maxPages = 400,
  start:    OrganizerStepProgress = { step: 0, deleted: 0, failures: [] },
): Promise<{ summary: OrganizerDeletionSummary; progress: OrganizerStepProgress; finished: boolean }> {
  const manifest = buildOrganizerDeletionManifest(uid)
  let progress = start

  for (let i = 0; i < maxPages; i++) {
    const r = await runOrganizerDeletionStep(manifest, progress)
    progress = r.progress
    if (r.done || progress.step >= manifest.length) {
      return {
        summary:  { ok: progress.failures.length === 0, deleted: progress.deleted, failures: progress.failures },
        progress,
        finished: true,
      }
    }
  }

  // Budget exhausted — genuinely unfinished. Never reported as complete.
  return {
    summary:  { ok: false, deleted: progress.deleted, failures: [...progress.failures, 'deletion did not finish in this run'] },
    progress,
    finished: false,
  }
}

/** Timestamp helper for the job document. */
export const now = () => FieldValue.serverTimestamp()

// ═══════════════════════════════════════════════════════════════════════════════
// 6 · THE DRIVEN, LEASED, RESUMABLE JOB
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Drive the deletion under a KERNEL LEASE, persisting progress after every page.
 *
 * ═══ WHY THE KERNEL AND NOT JUST `runOrganizerDeletion` ══════════════════════
 * `lib/events/eventDeletion` re-runs its whole manifest from step 0 every time, which is safe
 * (an emptied step advances immediately) but re-reads everything and has no way to stop two
 * callers working at once. Deleting an organizer ends in an irreversible Auth delete, so two
 * concurrent admin clicks must not both be walking the manifest. The kernel's lease gives
 * mutual exclusion and its cursor gives real resumption — a resumed run starts at the step
 * that was interrupted, not at the beginning.
 *
 * ═══ WHY NOT A `JobStrategy` ════════════════════════════════════════════════
 * The runner's contract is item-oriented: fetch a page of items, process each, commit. Here the
 * work IS the fetch — a bounded query that deletes what it read. Expressing that as
 * fetchPage/processItem would mean a fetch that mutates, which inverts the contract the runner
 * relies on for retry safety. So this uses the kernel's primitives directly and keeps the
 * step engine above unchanged.
 *
 * `budgetMs` bounds one invocation. An unfinished run leaves the job `processing` with its
 * cursor committed and the lease renewed; once the lease expires another request resumes it.
 */
export async function driveOrganizerDeletion(input: {
  uid:      string
  adminUid: string
  budgetMs?: number
  leaseMs?:  number
}): Promise<{
  outcome:  'completed' | 'unfinished' | 'busy' | 'already_completed' | 'cancelled' | 'not_found'
  deleted:  number
  failures: string[]
}> {
  const { uid, adminUid } = input
  const budgetMs = input.budgetMs ?? 25_000
  const leaseMs  = input.leaseMs  ?? 60_000

  const manifest = buildOrganizerDeletionManifest(uid)
  // Deterministic id: a repeated admin request resumes THIS job rather than starting a second
  // one. Two jobs walking the same manifest is the one thing the lease cannot save us from,
  // because they would hold different documents' leases.
  const jobId = `orgdel_${uid}`

  const existing = await getJob(ORGANIZER_DELETION_JOBS, jobId)
  if (!existing) {
    await createJob(ORGANIZER_DELETION_JOBS, jobId, {
      organizerUid: uid,
      createdBy:    adminUid,
      kind:         'organizer_deletion',
    }, manifest.length)
  }

  const lease = await leaseJob(ORGANIZER_DELETION_JOBS, jobId, leaseMs)
  if (!lease.proceed) {
    const map = {
      busy: 'busy', completed: 'already_completed', cancelled: 'cancelled', not_found: 'not_found',
    } as const
    return { outcome: map[lease.reason], deleted: 0, failures: [] }
  }

  let leaseTag = lease.leaseTag
  let progress = decodeProgress(lease.job.cursor ?? null)
  // RD-PREPROD · the cursor keeps only the failure COUNT, and decodeProgress drops it. Resuming
  // past a recorded failure therefore forgot it, and a run that then reached the end committed
  // 'completed' over a partial deletion. A cursor that recorded failures re-walks the manifest
  // from step 0 instead: every finished step is a no-op on re-run, and the failed ones are retried.
  if (Number((lease.job.cursor ?? '').split(':')[2]) > 0) progress = { ...progress, step: 0 }
  const startedAt = Date.now()

  for (;;) {
    const before         = progress.step
    const failuresBefore = progress.failures.length
    const r = await runOrganizerDeletionStep(manifest, progress)
    progress = r.progress
    const reachedEnd = r.done || progress.step >= manifest.length
    // A step held for retry (see the Auth branch in runOrganizerDeletionStep) or an
    // exhausted budget both end this invocation without finishing.
    const heldForRetry = progress.step === before && progress.failures.length > failuresBefore
    const outOfBudget  = Date.now() - startedAt > budgetMs
    // RD-ORGDEL-AUTH-01 · reaching the end of the manifest is NOT the same as finishing.
    // `finished` is what the kernel turns into status 'completed', and a completed job can
    // never be leased again (lib/jobs/kernel leaseJob). Committing it while a failure was
    // recorded therefore closed the job over an incomplete deletion — and every retry came
    // back 'already_completed', which the route reports as success. A run that recorded a
    // failure leaves the job 'processing' with its cursor committed, so it stays resumable.
    const finished = reachedEnd && progress.failures.length === 0

    const commit = await commitChunk(ORGANIZER_DELETION_JOBS, jobId, {
      // One "processed" unit per STEP completed, so the job's counts track the manifest the
      // admin can see rather than a document total nobody declared up front.
      deltaProcessed: progress.step > before ? 1 : 0,
      deltaSucceeded: progress.step > before ? 1 : 0,
      deltaFailed:    0,
      cursor:         encodeProgress(progress),
      lastError:      progress.failures.at(-1) ?? null,
      finished,
      leaseMs,
      // RD-ORGDEL-AUTH-01 · hand the lease back when this invocation stops WITHOUT
      // finishing. This deletion is client-driven — an admin pressing Retry — so holding a
      // 60 s lease after yielding would answer that retry with 'busy' and make a recoverable
      // Auth failure look like a stuck job. Applied inside the fenced transaction, so a
      // stale worker can never clear the live owner's lease, and only on the commit this
      // invocation is about to return from, so two drivers never walk the manifest at once.
      releaseLease: !finished && (reachedEnd || heldForRetry || outOfBudget),
      expectedLeaseTag: leaseTag,
    })

    // Fenced means another worker re-leased this job while this page was running. Stop
    // immediately and without reporting success — the other driver owns the cursor now.
    if (commit.fenced) return { outcome: 'busy', deleted: progress.deleted, failures: progress.failures }
    leaseTag = commit.leaseTag

    if (reachedEnd) {
      return {
        outcome:  progress.failures.length === 0 ? 'completed' : 'unfinished',
        deleted:  progress.deleted,
        failures: progress.failures,
      }
    }

    // A step that recorded a failure WITHOUT advancing is being deliberately held for a
    // retry (the Auth step). Looping here would hammer it for the whole budget with no
    // chance of the underlying cause clearing, so this invocation ends honestly and the
    // committed cursor lets the next request try again.
    if (heldForRetry) {
      return { outcome: 'unfinished', deleted: progress.deleted, failures: progress.failures }
    }

    if (outOfBudget) {
      // Genuinely unfinished. The cursor is committed, so the next request continues here.
      return { outcome: 'unfinished', deleted: progress.deleted, failures: progress.failures }
    }
  }
}
