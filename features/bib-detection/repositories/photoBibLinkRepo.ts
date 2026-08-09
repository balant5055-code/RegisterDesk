// RD-BIB-01 · Photo ↔ runner links — SERVER ONLY.
//
// The only module that writes `photoBibLinks`.
//
// ═══ ORGANIZER-ONLY ═══════════════════════════════════════════════════════════
// A link says "this photograph appears to show bib 137, who ran the 10K". It is a machine's
// unreviewed guess about a person, so it is denied to every client in `firestore.rules` and
// no public route reads it. The runner gallery that will eventually use it is a later
// sprint, and it will read through a projection built for that purpose.
// ══════════════════════════════════════════════════════════════════════════════

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  BIB_SCHEMA_VERSION, PHOTO_BIB_LINKS,
  type BibDetectionSummary, type BibReviewStatus, type PhotoBibLinkDoc,
} from '@/features/bib-detection/types'
import { toBibSummary, type PhotoBibLinkSeed } from '@/features/bib-detection/utils/linkDoc'

const links = () => adminDb.collection(PHOTO_BIB_LINKS)

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Replaces every link for ONE photo, atomically.
 *
 * Replace, not append: re-running detection must not leave behind links for bibs the model
 * no longer sees, or a corrected read would coexist with the wrong one it replaced. Links
 * absent from `seeds` are deleted in the same batch.
 *
 * A human's review survives a re-run — `reviewStatus`, `reviewedBy` and `reviewedAt` are
 * carried over for any link that still exists. Discarding a verification because the
 * pipeline ran again would make review pointless.
 */
export async function replaceLinksForAsset(
  assetId: string, seeds: readonly PhotoBibLinkSeed[],
): Promise<{ written: number; removed: number }> {
  const existingSnap = await links().where('assetId', '==', assetId).get()
  const existing = new Map(
    existingSnap.docs.map(d => [d.id, d.data() as PhotoBibLinkDoc]),
  )

  const batch    = adminDb.batch()
  const keepIds  = new Set(seeds.map(s => s.linkId))

  for (const seed of seeds) {
    const previous = existing.get(seed.linkId)
    batch.set(links().doc(seed.linkId), {
      ...seed,
      // Preserve the human's decision across a re-run.
      reviewStatus: previous?.reviewStatus ?? seed.reviewStatus,
      reviewedBy:   previous?.reviewedBy   ?? null,
      reviewedAt:   previous?.reviewedAt   ?? null,
      detectedAt:   FieldValue.serverTimestamp(),
      createdAt:    previous?.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt:    FieldValue.serverTimestamp(),
    })
  }

  let removed = 0
  for (const [id] of existing) {
    if (keepIds.has(id)) continue
    batch.delete(links().doc(id))
    removed++
  }

  await batch.commit()
  return { written: seeds.length, removed }
}

/** Removes every link for a photo — used when the photo itself is deleted. */
export async function deleteLinksForAsset(assetId: string): Promise<number> {
  const snap = await links().where('assetId', '==', assetId).get()
  if (snap.empty) return 0

  const batch = adminDb.batch()
  for (const d of snap.docs) batch.delete(d.ref)
  await batch.commit()
  return snap.size
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * RD-RUNNER-01 — reads a link WITHOUT a tenant.
 *
 * A participant does not know, and must never be told, which workspace owns a photo, so the
 * tenant-checked reader below cannot serve them. This one exists for exactly that caller.
 *
 * It is NOT an authorization bypass, and the distinction matters: the document it returns is
 * never handed back to anyone. It is used only to derive the organizer and the bib that the
 * caller's OWN identity is then compared against (`resolvePhotoDownload`). Holding a link id
 * proves nothing here.
 *
 * Named and commented so it is greppable — an unscoped read into an organizer-only
 * collection should never be something a reviewer has to notice by accident.
 */
export async function getLinkById(linkId: string): Promise<PhotoBibLinkDoc | null> {
  if (!linkId || linkId.includes('/') || linkId.length > 200) return null
  const snap = await links().doc(linkId).get()
  if (!snap.exists) return null
  const doc = snap.data() as PhotoBibLinkDoc
  return doc.schemaVersion === BIB_SCHEMA_VERSION ? doc : null
}

/** Tenant-checked. Another workspace's link reads as absent, never as forbidden. */
export async function getOwnedLink(
  id: string, organizerUid: string,
): Promise<PhotoBibLinkDoc | null> {
  const snap = await links().doc(id).get()
  if (!snap.exists) return null
  const doc = snap.data() as PhotoBibLinkDoc
  if (doc.organizerUid !== organizerUid) return null
  return doc.schemaVersion === BIB_SCHEMA_VERSION ? doc : null
}

export async function listLinksForAsset(
  assetId: string, organizerUid: string,
): Promise<PhotoBibLinkDoc[]> {
  const snap = await links()
    .where('organizerUid', '==', organizerUid)
    .where('assetId', '==', assetId)
    .get()
  return snap.docs
    .map(d => d.data() as PhotoBibLinkDoc)
    .filter(d => d.schemaVersion === BIB_SCHEMA_VERSION)
}

export interface LinkPage {
  links:      PhotoBibLinkDoc[]
  nextCursor: string | null
}

/**
 * Photos linked to one bib, cursor-paginated.
 *
 * THE query the future runner gallery is built on: `(organizerUid, eventSlug, bibKey)`,
 * ordered by link id so paging is stable. Never an offset.
 */
export async function listLinksForBib(params: {
  organizerUid: string
  eventSlug:    string
  bibKey:       string
  limit?:       number
  cursor?:      string | null
}): Promise<LinkPage> {
  const limit = Math.min(Math.max(1, params.limit ?? 60), 200)

  let q = links()
    .where('organizerUid', '==', params.organizerUid)
    .where('eventSlug', '==', params.eventSlug)
    .where('bibKey', '==', params.bibKey)
    .orderBy('linkId', 'asc')
    .limit(limit)

  if (params.cursor) q = q.startAfter(params.cursor)

  const snap  = await q.get()
  const items = snap.docs.map(d => d.data() as PhotoBibLinkDoc)

  return {
    links: items,
    nextCursor: snap.size === limit && items.length > 0 ? items[items.length - 1].linkId : null,
  }
}

/**
 * Per-event tallies, using aggregate `count()` queries — no document reads, so the summary
 * costs the same for 50 photos as for 500,000.
 */
export async function summariseForEvent(
  organizerUid: string, eventId: string,
): Promise<BibDetectionSummary> {
  const base = links()
    .where('organizerUid', '==', organizerUid)
    .where('eventId', '==', eventId)

  const fields = [
    ['matchStatus',  'matched'], ['matchStatus', 'unmatched'], ['matchStatus', 'ambiguous'],
    ['reviewStatus', 'pending'], ['reviewStatus', 'verified'], ['reviewStatus', 'rejected'],
  ] as const

  const counts = await Promise.all(
    fields.map(async ([field, value]) => {
      const agg = await base.where(field, '==', value).count().get()
      return [value, agg.data().count] as const
    }),
  )

  return toBibSummary(Object.fromEntries(counts))
}

// ─── Review ───────────────────────────────────────────────────────────────────

/**
 * Records a human's verdict.
 *
 * The ONLY way `reviewStatus` leaves `pending`, and it demands a reviewer — a verification
 * with no name attached is not a verification. No UI calls this yet, by instruction.
 */
export async function setReviewStatus(params: {
  linkId:       string
  organizerUid: string
  status:       BibReviewStatus
  reviewedBy:   string
}): Promise<PhotoBibLinkDoc | null> {
  const ref = links().doc(params.linkId)

  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return null
    const doc = snap.data() as PhotoBibLinkDoc
    if (doc.organizerUid !== params.organizerUid) return null

    tx.update(ref, {
      reviewStatus: params.status,
      reviewedBy:   params.reviewedBy,
      reviewedAt:   FieldValue.serverTimestamp(),
      updatedAt:    FieldValue.serverTimestamp(),
    })

    return {
      ...doc,
      reviewStatus: params.status,
      reviewedBy:   params.reviewedBy,
    }
  })
}
