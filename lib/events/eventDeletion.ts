// RD-EVENT-DELETE · permanent deletion of an ARCHIVED event. Server-only.
//
// ═══ WHAT THIS IS ════════════════════════════════════════════════════════════
// The only irreversible operation an organizer can perform on an event. It runs as a
// resumable job on the shared kernel (lib/jobs/kernel) because a large event's registrations
// cannot be deleted inside one request, and a half-finished delete must be able to continue
// rather than restart.
//
// ═══ THE MANIFEST IS A PURE FUNCTION, AND THAT IS THE POINT ══════════════════
// `buildDeletionManifest` takes three ids and returns the exact ordered list of things that
// will be destroyed. It touches nothing. That makes the retention policy — the part where a
// mistake is permanent and legally material — reviewable in a test rather than only in
// production.
//
// ═══ RETAINED ON PURPOSE ═════════════════════════════════════════════════════
// Financial and audit records are NOT deleted: platformTransactions, walletTransactions,
// settlementRequests, settlementReleases, walletClawbacks, organizerRevenueWallets,
// eventLicenses, licenseOrders, donations/donationPayments/donationReceipts, adminAuditLogs.
// The settlement, clawback and reconciliation engines read these, and they are the records a
// tax authority would ask for. "Permanent deletion" removes the event's OPERATIONAL data.
//
// Shared/global resources are never touched: globalCertificateTemplates,
// emailSuppressionList, platformSettings, users.
//
// ═══ TWO COLLECTIONS ON THE ORIGINAL LIST ARE DELIBERATELY EXCLUDED ══════════
//   • paymentEvents — NOT event-scoped. `paymentEvents/{eventId}` is keyed by the RAZORPAY
//     WEBHOOK event id and is the webhook idempotency ledger (see app/api/razorpay/webhook).
//     Deleting it would let already-processed payment webhooks replay. The name collision is
//     the trap; the schema is unrelated to RegisterDesk events.
//   • reportExportJobs — NOT reliably event-owned. `ReportExportJob extends Job`, and the
//     base Job carries no event key at all; the only event reference is an OPTIONAL nested
//     `filters.event`, documented as "entityId / eventSlug" and absent entirely for an
//     organizer-wide export. There is no field that identifies exactly one event, so these
//     are left alone.
//
// (An earlier revision also excluded `sessionCheckIns` on the belief that it carried only
// `sessionId`. That was wrong — the belief came from one read site that happens to query by
// session, not from the type. It carries `eventSlug` + `organizerUid` and is now deleted.)
//
// ═══ SPEAKER PHOTOS ══════════════════════════════════════════════════════════
// `eventSpeakers.photoUrl` is a caller-supplied string stored verbatim (service.ts
// createSpeaker) — it is NOT built through buildObjectKey, so it can point anywhere,
// including an external host or another prefix. It is therefore never deleted by key. The
// prefix sweep below removes any speaker photo that genuinely lives under
// `events/{eventSlug}/`; anything outside that prefix is left untouched rather than
// deleted on an assumption.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { storage }    from '@/features/platform-storage'
import { captureError } from '@/lib/monitoring/sentry'

/** Collections that must NEVER be deleted by this module. Asserted by tests. */
export const RETAINED_COLLECTIONS = [
  'platformTransactions', 'walletTransactions', 'settlementRequests', 'settlementReleases',
  'walletClawbacks', 'organizerRevenueWallets', 'eventLicenses', 'licenseOrders',
  'donations', 'donationPayments', 'donationReceipts', 'adminAuditLogs',
  // Not event-scoped despite the name — see the header.
  'paymentEvents',
  // Shared / global.
  'globalCertificateTemplates', 'emailSuppressionList', 'platformSettings', 'users',
] as const

/** One unit of deletion work. Ordered; executed front to back. */
export type DeletionStep =
  /** Every doc in `collection` where `field == value`. Deleted in bounded pages. */
  | { kind: 'query'; label: string; collection: string; field: string; value: string }
  /** A single document at an absolute path. Idempotent — a missing doc is a success. */
  | { kind: 'doc'; label: string; path: string }
  /** Every doc in a subcollection of one parent document. */
  | { kind: 'subcollection'; label: string; parentPath: string; name: string }
  /** Every R2 object under `events/{eventSlug}/`. */
  | { kind: 'storage'; label: string; eventSlug: string }

export interface DeletionTarget {
  /** The public slug — `events/{slug}`, and the key most event data is scoped by. */
  eventSlug:    string
  /** The draft id — what certificate data and the draft document are keyed by. */
  eventId:      string
  organizerUid: string
}

/**
 * Everything that will be destroyed, in order.
 *
 * Ordering is deliberate: bulk child data first, then the counters and configs that describe
 * it, then storage, and the `events/{slug}` document LAST. If the job dies midway the event
 * document still exists, so the job remains discoverable and re-runnable — deleting the
 * anchor first would strand whatever was left.
 *
 * Every entry is scoped by an id that belongs to exactly ONE event. Collections whose schema
 * could not prove single-event ownership are excluded rather than guessed at (see header).
 */
export function buildDeletionManifest(t: DeletionTarget): DeletionStep[] {
  const { eventSlug: slug, eventId, organizerUid } = t
  const bySlug = (collection: string, label = collection): DeletionStep =>
    ({ kind: 'query', label, collection, field: 'eventSlug', value: slug })
  const byEventId = (collection: string, label = collection): DeletionStep =>
    ({ kind: 'query', label, collection, field: 'eventId', value: eventId })

  return [
    // ── Bulk operational child data (scoped by the globally-unique slug) ──────
    bySlug('registrations'),
    bySlug('registrationAuditLogs'),
    bySlug('waitlists'),
    bySlug('speakerApplications'),
    bySlug('sponsorApplications'),
    bySlug('eventNominations'),
    bySlug('identifierHistory'),
    bySlug('broadcastCampaigns'),
    bySlug('certificatePhotoGrants'),
    bySlug('raceResultSnapshots'),
    bySlug('emailLogs'),

    // ── Conference/sessions module ───────────────────────────────────────────
    // All five carry `organizerUid` + `eventSlug` as first-class fields
    // (lib/sessions/types.ts). sessionCheckIns in particular is written only inside a
    // transaction that REFUSES the write unless the session's event and the registration's
    // event agree, so its eventSlug is doubly attributed — not a denormalised guess.
    bySlug('eventSessions'),
    bySlug('eventTracks'),
    bySlug('eventHalls'),
    bySlug('eventSpeakers'),
    bySlug('sessionCheckIns'),

    // ── Certificate data (keyed by the DRAFT id, not the slug) ───────────────
    byEventId('certificates'),
    byEventId('certificateRecords'),
    byEventId('certificateJobs'),
    byEventId('certificateClaims'),
    byEventId('certificateTemplates'),

    // ── Per-event job records and designs ────────────────────────────────────
    // Every one of these carries `eventId` = the DRAFT id (importJob.ts documents it as
    // `// draftId`); the seven job types also carry `eventSlug`, so either key identifies the
    // same single event. `printTemplates` has ONLY eventId — despite the name it is an
    // event-scoped design, not a reusable organizer-level asset.
    byEventId('certificateZipJobs'),
    byEventId('registrationImportJobs'),
    byEventId('registrationBulkJobs'),
    byEventId('printGenerationJobs'),
    byEventId('printPackageJobs'),
    byEventId('printTemplates'),
    byEventId('emailBroadcastJobs'),
    byEventId('whatsappBroadcastJobs'),

    // `scheduledReminders.eventId` stores the event SLUG, not the draft id — the field name
    // is misleading and its own type says so. Querying it with the draft id would silently
    // delete nothing and leave every reminder behind.
    { kind: 'query', label: 'scheduledReminders', collection: 'scheduledReminders', field: 'eventId', value: slug },

    // ── Per-event singleton documents ────────────────────────────────────────
    { kind: 'doc', label: 'registrationCounters', path: `registrationCounters/${slug}` },
    { kind: 'doc', label: 'waitlistCounters',     path: `waitlistCounters/${slug}` },
    { kind: 'doc', label: 'bibCounters',          path: `bibCounters/${slug}` },
    { kind: 'doc', label: 'identifierConfigs',    path: `identifierConfigs/${slug}` },
    { kind: 'doc', label: 'donationCampaigns',    path: `donationCampaigns/${slug}` },
    { kind: 'doc', label: 'donationCounters',     path: `donationCounters/${slug}` },
    { kind: 'doc', label: 'certificateSettings',  path: `certificateSettings/${eventId}` },
    { kind: 'doc', label: 'certificateTemplate(legacy)', path: `certificateTemplates/${eventId}` },

    // ── Subcollections of the event document ─────────────────────────────────
    { kind: 'subcollection', label: 'events/changeLog',    parentPath: `events/${slug}`, name: 'changeLog' },
    { kind: 'subcollection', label: 'events/editHistory',  parentPath: `events/${slug}`, name: 'editHistory' },

    // ── Object storage, everything under this event's prefix ─────────────────
    { kind: 'storage', label: 'r2:events/' + slug, eventSlug: slug },

    // ── Anchors, last ────────────────────────────────────────────────────────
    { kind: 'doc', label: 'eventDraft', path: `users/${organizerUid}/eventDrafts/${eventId}` },
    { kind: 'doc', label: 'events',     path: `events/${slug}` },
  ]
}

// ─── Execution ────────────────────────────────────────────────────────────────

/** Docs deleted per Firestore batch. Firestore's hard limit is 500. */
const PAGE = 300

export interface StepProgress {
  /** Index of the step to run next. Equal to the manifest length ⇒ finished. */
  step:    number
  deleted: number
  failures: string[]
}

/**
 * Runs ONE bounded page of work and reports how far it got.
 *
 * Returns `done: false` while the current step still has documents, so the caller can commit
 * a cursor and come back. Nothing here is destructive beyond the single page it reports, and
 * re-running a page is safe: deleting an already-deleted document is a no-op in Firestore and
 * in the storage layer.
 */
export async function runDeletionStep(
  manifest: DeletionStep[],
  progress: StepProgress,
): Promise<{ progress: StepProgress; done: boolean }> {
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

      case 'storage': {
        // Bounded by the SAME prefix the platform uses for this event's assets, so nothing
        // outside `events/{slug}/` can be reached even if a key were malformed.
        const page = await storage.listEvent(step.eventSlug, { limit: 200 })
        if (page.objects.length === 0) return advance(progress)

        const failures: string[] = []
        for (const obj of page.objects) {
          await storage.delete(obj.path).catch((err: unknown) => {
            failures.push(obj.path)
            captureError(err, { scope: 'event_delete_storage', area: 'event', key: obj.path })
          })
        }
        const next = {
          ...progress,
          deleted:  progress.deleted + (page.objects.length - failures.length),
          failures: [...progress.failures, ...failures],
        }
        // A page that deleted nothing but reported failures would loop forever; stop
        // advancing only while real progress is being made.
        if (failures.length === page.objects.length) return advance(next)
        return { progress: next, done: false }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    captureError(err, { scope: 'event_delete_step', area: 'event', step: step.label })
    // The step is recorded as failed and the job moves on, so one unreachable collection
    // cannot block the rest — but the failure is carried to the end and the job is REPORTED
    // as failed. It must never present itself as a clean deletion.
    return advance({ ...progress, failures: [...progress.failures, `${step.label}: ${message}`] })
  }
}

function advance(p: StepProgress): { progress: StepProgress; done: boolean } {
  return { progress: { ...p, step: p.step + 1 }, done: false }
}

async function deleteDocs(refs: FirebaseFirestore.DocumentReference[]): Promise<void> {
  const batch = adminDb.batch()
  for (const ref of refs) batch.delete(ref)
  await batch.commit()
}

// ─── Cursor encoding (the kernel stores ONE string) ───────────────────────────

/** `step:deleted:failureCount` — enough to resume exactly where the last page stopped. */
export function encodeProgress(p: StepProgress): string {
  return `${p.step}:${p.deleted}:${p.failures.length}`
}

export function decodeProgress(cursor: string | null): StepProgress {
  if (!cursor) return { step: 0, deleted: 0, failures: [] }
  const [s, d] = cursor.split(':')
  const step = Number(s), deleted = Number(d)
  return {
    step:    Number.isFinite(step)    && step    >= 0 ? step    : 0,
    deleted: Number.isFinite(deleted) && deleted >= 0 ? deleted : 0,
    failures: [],
  }
}

/** Marks the job document itself. Kept separate so the manifest stays pure. */
export const EVENT_DELETION_JOBS = 'eventDeletionJobs'

export interface EventDeletionSummary {
  ok:       boolean
  deleted:  number
  failures: string[]
}

/**
 * Runs the whole manifest to completion within one invocation, bounded by `maxPages`.
 *
 * `ok` is false whenever ANY step failed, even if everything else succeeded — a partial
 * deletion must never be reported as a clean one. Safe to call again: every remaining step
 * re-runs against whatever is left, and steps whose data is already gone advance immediately.
 */
export async function runEventDeletion(
  target:   DeletionTarget,
  maxPages = 400,
  start:    StepProgress = { step: 0, deleted: 0, failures: [] },
): Promise<{ summary: EventDeletionSummary; progress: StepProgress; finished: boolean }> {
  const manifest = buildDeletionManifest(target)
  let progress = start

  for (let i = 0; i < maxPages; i++) {
    const r = await runDeletionStep(manifest, progress)
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
