// Publish Governance — the immutable publish baseline store (EA-4 S1). Server-only.
//
// publishBaselines/{eventId} (eventId = draftId). Event-owned governance data,
// decoupled from commercial license metadata. Created lazily on the first governed
// publish (grandfathers every legacy event). Server-only: an explicit deny in
// firestore.rules blocks all client access.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { GOVERNANCE_VERSION } from './config'
import type { PublishBaseline, EventIdentity, GovernanceOverrides } from './types'

export const PUBLISH_BASELINES_COLLECTION = 'publishBaselines'
const col = () => adminDb.collection(PUBLISH_BASELINES_COLLECTION)

export async function getBaseline(eventId: string): Promise<PublishBaseline | null> {
  const snap = await col().doc(eventId).get()
  return snap.exists ? (snap.data() as PublishBaseline) : null
}

/**
 * Idempotent, atomic. On the FIRST governed publish (no baseline) captures the
 * immutable identity snapshot. On every subsequent successful publish only bumps
 * publishCount — the identity is NEVER rewritten (that is the whole point).
 */
export async function recordPublish(
  eventId:    string,
  identity:   EventIdentity,
  licenseRef: PublishBaseline['licenseRef'],
): Promise<void> {
  const ref = col().doc(eventId)
  await adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    // Only bump when the identity snapshot already exists. A doc that exists WITHOUT
    // an identity is an admin override-stub (see setBaselineOverrides) — treat this
    // publish as the identity capture and fill it in without clobbering overrides.
    if (snap.exists && (snap.data() as PublishBaseline).identity) {
      txn.update(ref, {
        publishCount: FieldValue.increment(1),
        updatedAt:    FieldValue.serverTimestamp(),
      })
      return
    }
    txn.set(ref, {
      eventId,
      governanceVersion: GOVERNANCE_VERSION,
      identity,
      firstPublishedAt:  FieldValue.serverTimestamp(),
      publishCount:      1,
      licenseRef,
      createdAt:         FieldValue.serverTimestamp(),
      updatedAt:         FieldValue.serverTimestamp(),
    }, { merge: true })
  })
}

/** Admin governance overrides (force-publish / bypass identity / bypass reg-safety).
 *  Written by the admin license console with a reason. Reads-merges-writes so a
 *  single override field never clobbers the others (or the identity snapshot). */
export async function setBaselineOverrides(eventId: string, patch: GovernanceOverrides): Promise<void> {
  const ref = col().doc(eventId)
  await adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    const current = (snap.exists ? (snap.data() as PublishBaseline).overrides : undefined) ?? {}
    txn.set(ref, {
      eventId,
      overrides: { ...current, ...patch, setAt: FieldValue.serverTimestamp() },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
  })
}
