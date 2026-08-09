// RD-BADGE-01 · Badge metadata persistence — SERVER ONLY.
//
// The only module that writes `finisherBadges`. Metadata only — the PNG bytes live in object
// storage, reached through @/features/platform-storage.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  BADGE_SCHEMA_VERSION, BADGE_TEMPLATE_VERSION, FINISHER_BADGES, badgeId,
  type BadgeDoc, type BadgeStatus,
} from '@/features/finisher-badges/types'

const badges = () => adminDb.collection(FINISHER_BADGES)

export async function getBadge(id: string): Promise<BadgeDoc | null> {
  const snap = await badges().doc(id).get()
  if (!snap.exists) return null
  const doc = snap.data() as BadgeDoc
  return doc.schemaVersion === BADGE_SCHEMA_VERSION ? doc : null
}

/**
 * Tenant-checked read. A badge belonging to another workspace reads as absent, never as
 * forbidden — that leaks nothing about what exists.
 */
export async function getOwnedBadge(id: string, organizerUid: string): Promise<BadgeDoc | null> {
  const doc = await getBadge(id)
  return doc && doc.organizerUid === organizerUid ? doc : null
}

export interface BadgeScope {
  organizerUid:    string
  eventId:         string
  eventSlug:       string
  passId:          string
  passSlug:        string
  bibKey:          string
  bibNumber:       string
  snapshotVersion: number
}

/**
 * Records a successfully generated badge.
 *
 * `set` with a deterministic id makes this idempotent: regenerating overwrites one record
 * rather than accumulating duplicates, and a retried request after a dropped response is
 * harmless.
 */
export async function recordGenerated(params: BadgeScope & {
  path:       string
  size:       number
  checksum:   string
  visibility: 'PUBLIC' | 'SIGNED_URL'
}): Promise<BadgeDoc> {
  const id  = badgeId(params.eventSlug, params.passId, params.bibKey)
  const ref = badges().doc(id)
  const existing = await ref.get()

  const doc = {
    ...params,
    badgeId:         id,
    schemaVersion:   BADGE_SCHEMA_VERSION,
    templateVersion: BADGE_TEMPLATE_VERSION,
    status:          'generated' satisfies BadgeStatus,
    error:           null,
    generatedAt:     FieldValue.serverTimestamp(),
    // Preserved across a regenerate so the record keeps its original creation time.
    createdAt:       existing.exists ? existing.get('createdAt') : FieldValue.serverTimestamp(),
    updatedAt:       FieldValue.serverTimestamp(),
  }

  await ref.set(doc)
  return (await ref.get()).data() as BadgeDoc
}

/**
 * Records a failure so the organizer sees WHY rather than a silent absence.
 *
 * `message` is organizer-facing and must never carry a stack trace.
 */
export async function recordFailure(
  scope: BadgeScope, message: string,
): Promise<void> {
  const id  = badgeId(scope.eventSlug, scope.passId, scope.bibKey)
  const ref = badges().doc(id)
  const existing = await ref.get()

  await ref.set({
    ...scope,
    badgeId:         id,
    schemaVersion:   BADGE_SCHEMA_VERSION,
    templateVersion: BADGE_TEMPLATE_VERSION,
    status:          'failed' satisfies BadgeStatus,
    // A previous success is NOT erased by a later failed regenerate — the old image is still
    // in storage and still serveable, which is better than showing a participant nothing.
    path:            existing.exists ? existing.get('path') : null,
    size:            existing.exists ? (existing.get('size') ?? 0) : 0,
    checksum:        existing.exists ? existing.get('checksum') : null,
    visibility:      existing.exists ? existing.get('visibility') : 'PUBLIC',
    error:           message.slice(0, 400),
    generatedAt:     existing.exists ? existing.get('generatedAt') : null,
    createdAt:       existing.exists ? existing.get('createdAt') : FieldValue.serverTimestamp(),
    updatedAt:       FieldValue.serverTimestamp(),
  }, { merge: true })
}

export interface BadgeCounts {
  generated: number
  failed:    number
}

/**
 * Counts badges for one race, using aggregate queries — no document reads.
 *
 * `pending` is deliberately NOT stored per participant: writing a `pending` record for every
 * finisher at publish time would mean 20,000 writes to represent "nothing has happened yet".
 * It is derived instead: pending = eligible − generated − failed.
 */
export async function countForRace(
  organizerUid: string, eventSlug: string, passId: string,
): Promise<BadgeCounts> {
  const base = badges()
    .where('organizerUid', '==', organizerUid)
    .where('eventSlug', '==', eventSlug)
    .where('passId', '==', passId)

  const [generated, failed] = await Promise.all([
    base.where('status', '==', 'generated').count().get(),
    base.where('status', '==', 'failed').count().get(),
  ])

  return {
    generated: generated.data().count,
    failed:    failed.data().count,
  }
}

/** Bib keys already generated for a race — lets a bulk run skip finished work. */
export async function generatedBibKeys(
  organizerUid: string, eventSlug: string, passId: string, limit = 5000,
): Promise<Set<string>> {
  const snap = await badges()
    .where('organizerUid', '==', organizerUid)
    .where('eventSlug', '==', eventSlug)
    .where('passId', '==', passId)
    .where('status', '==', 'generated')
    .limit(limit)
    .get()

  return new Set(snap.docs.map(d => (d.data() as BadgeDoc).bibKey))
}
