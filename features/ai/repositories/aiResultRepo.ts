// RD-AI-01 · AI result persistence — SERVER ONLY.
//
// The only module that writes `aiResults`.
//
// ═══ ORGANIZER-ONLY ═══════════════════════════════════════════════════════════
// Every result is written `ORGANIZER_ONLY` and this module offers NO way to write anything
// else. An AI inference about a participant is the organizer's working data until a human
// decides to publish it; the pipeline has no authority to make a machine guess public, and
// `firestore.rules` denies the collection outright so no browser can read it either.
// ══════════════════════════════════════════════════════════════════════════════

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  AI_PIPELINE_VERSION, AI_RESULTS, AI_SCHEMA_VERSION,
  type AIJobKind, type AIResultDoc,
} from '@/features/ai/types'

const results = () => adminDb.collection(AI_RESULTS)

export interface StoreResultInput {
  resultId:     string
  jobId:        string
  organizerUid: string
  eventId:      string
  eventSlug:    string
  assetId:      string
  kind:         AIJobKind
  providerId:      string
  providerVersion: string | null
  payload:    Readonly<Record<string, unknown>>
  confidence: number | null
}

/**
 * Writes the result of one job.
 *
 * `set` with a deterministic id (the job's id) makes this idempotent: a re-analysis
 * overwrites one record rather than accumulating, and a retried commit after a dropped
 * response is harmless. Only the CURRENT result is kept — history is not retained, which is
 * a deliberate trade recorded in docs/RD-AI-ARCHITECTURE.md.
 */
export async function storeResult(input: StoreResultInput): Promise<AIResultDoc> {
  const ref = results().doc(input.resultId)
  const existing = await ref.get()

  await ref.set({
    resultId:      input.resultId,
    schemaVersion: AI_SCHEMA_VERSION,
    organizerUid:  input.organizerUid,
    eventId:       input.eventId,
    eventSlug:     input.eventSlug,
    assetId:       input.assetId,
    jobId:         input.jobId,
    kind:          input.kind,
    providerId:      input.providerId,
    providerVersion: input.providerVersion,
    pipelineVersion: AI_PIPELINE_VERSION,
    payload:    input.payload,
    confidence: input.confidence,
    // Not a parameter. See the header.
    visibility: 'ORGANIZER_ONLY',
    createdAt:  existing.exists ? existing.get('createdAt') : FieldValue.serverTimestamp(),
    updatedAt:  FieldValue.serverTimestamp(),
  })

  return (await ref.get()).data() as AIResultDoc
}

/** Tenant-checked read. Another workspace's result reads as absent, never as forbidden. */
export async function getOwnedResult(
  resultId: string, organizerUid: string,
): Promise<AIResultDoc | null> {
  const snap = await results().doc(resultId).get()
  if (!snap.exists) return null
  const doc = snap.data() as AIResultDoc
  if (doc.organizerUid !== organizerUid) return null
  return doc.schemaVersion === AI_SCHEMA_VERSION ? doc : null
}

/**
 * Removes the result for a job — used when the asset it describes is deleted.
 *
 * Idempotent: deleting a missing result succeeds.
 */
export async function deleteResult(resultId: string): Promise<void> {
  await results().doc(resultId).delete()
}
