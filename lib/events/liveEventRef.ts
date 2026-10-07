// RD-EVENT-SLUG · Locating the LIVE document for a published draft. SERVER-ONLY.
//
// ═══ THE INVARIANT THIS DEFENDS ══════════════════════════════════════════════
//
//     users/{uid}/eventDrafts/{draftId}.eventDetails.seo.urlSlug  ===  events/{id}
//
// That pointer is the whole link between a draft and its public page, and it is stored on
// a document the WIZARD writes directly from the browser (lib/firebase/firestore/drafts.ts
// → updateDoc). A server route therefore cannot treat it as trusted input: a client-side
// normalisation once lowercased it and severed the link, and every write path that keyed
// off it either failed loudly (save-changes → 404) or, worse, silently skipped the live
// write and reported success (PATCH /edit).
//
// ═══ THE SECOND POINTER IS THE SAFE ONE ══════════════════════════════════════
// `events/{slug}.draftId` is written by publish and by nothing else — no client path can
// reach the `events` collection. It is the reverse of the same single relationship, NOT a
// second source of truth: it introduces no new identifier and nothing has to be kept in
// sync with it. It is what lets this module tell three genuinely different situations
// apart, which a bare `.exists` check cannot:
//
//   MISSING             — no live document for this draft at all
//   SLUG_MISMATCH       — the live document exists; the draft's pointer names something else
//   SLUG_OWNED_BY_OTHER — the named document exists but belongs to a different draft
//
// This module RESOLVES and REPORTS. It never writes, never renames a live document and
// never creates one — a published slug is a public URL, and repairing one is a deliberate
// operation, not something a save should do behind the organizer's back.

import type { Firestore } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

type DocRef  = FirebaseFirestore.DocumentReference
type DocSnap = FirebaseFirestore.DocumentSnapshot

export type LiveEventLookupFailure =
  | 'NO_SLUG'             // the draft carries no urlSlug — it was never published
  | 'MISSING'             // no live document names this draft
  | 'SLUG_MISMATCH'       // live document found by draftId, but the draft points elsewhere
  | 'SLUG_OWNED_BY_OTHER' // the slug names a live document belonging to another draft
  | 'AMBIGUOUS'           // more than one live document claims this draft — never guess

export type LiveEventLookup =
  | { ok: true;  slug: string; ref: DocRef; snap: DocSnap }
  | { ok: false; reason: LiveEventLookupFailure; slug: string | null; canonicalSlug?: string }

/** The draft's stored public slug, or null when it has none. */
export function draftPublicSlug(draft: Record<string, unknown>): string | null {
  const details = draft.eventDetails as Record<string, unknown> | undefined
  const seo     = details?.seo as Record<string, unknown> | undefined
  const raw     = typeof seo?.urlSlug === 'string' ? seo.urlSlug.trim() : ''
  return raw || null
}

/**
 * RD-CE-FIX C1 · Does the live `events/{slug}` document belong to `draftId` in the workspace
 * `ownerUid`? Both server-written stamps must agree: `uid` (the owning workspace) is REQUIRED,
 * and `draftId`, when present, must name this draft. Draft ids are client-chosen global keys, so
 * a matching `draftId` alone proves nothing; a document with no `uid` is never claimed (fail closed).
 */
export function liveEventBelongsTo(
  data:     Record<string, unknown> | undefined,
  ownerUid: string,
  draftId:  string,
): boolean {
  if (!data || !ownerUid) return false
  if (typeof data.draftId === 'string' && data.draftId !== draftId) return false
  return typeof data.uid === 'string' && data.uid === ownerUid
}

/**
 * RD-CE-FIX C1 · The draft's public slug ONLY when the live document proves it is this
 * workspace's event; null otherwise (never published, or the client-writable pointer names
 * someone else's event). Every route that turns a draft into an `events/{slug}` read, write or
 * `eventSlug` query goes through this (or the batched form) — never through the raw pointer.
 */
export async function resolveOwnedEventSlug(
  ownerUid: string,
  draftId:  string,
  draft:    Record<string, unknown>,
  db:       Firestore = adminDb,
): Promise<string | null> {
  const slug = draftPublicSlug(draft)
  if (!slug) return null
  const snap = await db.collection('events').doc(slug).get()
  return snap.exists && liveEventBelongsTo(snap.data(), ownerUid, draftId) ? slug : null
}

/**
 * Batched ownership resolution that ALSO returns the live event data it had to read anyway
 * (RD-FIN-02 — capacity is derived from it, so list endpoints need no second read).
 */
export async function resolveOwnedEvents(
  ownerUid: string,
  drafts:   ReadonlyArray<{ id: string; data: Record<string, unknown> }>,
  db:       Firestore = adminDb,
): Promise<Map<string, { slug: string; data: Record<string, unknown> }>> {
  const claims = drafts
    .map(d => ({ id: d.id, slug: draftPublicSlug(d.data) }))
    .filter((c): c is { id: string; slug: string } => c.slug !== null)
  if (claims.length === 0) return new Map()
  const snaps = await db.getAll(...claims.map(c => db.collection('events').doc(c.slug)))
  // Built from entries (no `.set` call — this module is source-pinned as write-free).
  return new Map(claims.flatMap((c, i) => {
    const data = snaps[i].exists ? snaps[i].data() : undefined
    return data && liveEventBelongsTo(data, ownerUid, c.id)
      ? [[c.id, { slug: c.slug, data }] as [string, { slug: string; data: Record<string, unknown> }]]
      : []
  }))
}

/** Batched {@link resolveOwnedEventSlug}: draftId → verified slug, for list endpoints (one getAll). */
export async function resolveOwnedEventSlugs(
  ownerUid: string,
  drafts:   ReadonlyArray<{ id: string; data: Record<string, unknown> }>,
  db:       Firestore = adminDb,
): Promise<Map<string, string>> {
  const owned = await resolveOwnedEvents(ownerUid, drafts, db)
  return new Map([...owned].map(([id, v]) => [id, v.slug] as [string, string]))
}

/**
 * Resolve the live `events/{slug}` document for a published draft.
 *
 * `draftId` is the authoritative identity — it comes from the route path, was already
 * checked against the caller's workspace, and is never client-supplied content. The slug is
 * only a lookup hint; when it disagrees with reality this reports HOW it disagrees instead
 * of collapsing every case into "not found".
 */
export async function resolveLiveEventRef(
  draftId:  string,
  draft:    Record<string, unknown>,
  ownerUid: string,
  db:       Firestore = adminDb,
): Promise<LiveEventLookup> {
  const slug = draftPublicSlug(draft)
  if (!slug) return { ok: false, reason: 'NO_SLUG', slug: null }

  const ref  = db.collection('events').doc(slug)
  const snap = await ref.get()

  if (snap.exists) {
    // A live document that names a DIFFERENT draft or workspace is another organizer's event
    // (or a recycled slug). Writing to it would publish this draft's content onto someone
    // else's public page, so this is refused rather than reconciled.
    if (!liveEventBelongsTo(snap.data(), ownerUid, draftId)) {
      return { ok: false, reason: 'SLUG_OWNED_BY_OTHER', slug }
    }
    return { ok: true, slug, ref, snap }
  }

  // The pointer is stale. Ask the reverse pointer who the live document actually is.
  // limit(2) so "exactly one" can be distinguished from "more than one" in a single read.
  const byDraft = await db.collection('events').where('draftId', '==', draftId).limit(2).get()

  if (byDraft.empty)        return { ok: false, reason: 'MISSING',   slug }
  if (byDraft.size > 1)     return { ok: false, reason: 'AMBIGUOUS', slug }

  return { ok: false, reason: 'SLUG_MISMATCH', slug, canonicalSlug: byDraft.docs[0].id }
}

/** Operator-facing message for each failure. Safe to return to an authorized organizer. */
export function liveEventLookupMessage(r: Exclude<LiveEventLookup, { ok: true }>): string {
  switch (r.reason) {
    case 'NO_SLUG':
      return 'Event has no URL slug — cannot sync to live page.'
    case 'MISSING':
      return 'Live event document not found.'
    case 'SLUG_MISMATCH':
      return `This event's saved URL (${r.slug}) no longer matches its live page (${r.canonicalSlug}). `
           + 'The public URL has not changed — an administrator must relink the event before it can be saved.'
    case 'SLUG_OWNED_BY_OTHER':
      return `The URL "${r.slug}" belongs to a different event. Saving was stopped to avoid overwriting it.`
    case 'AMBIGUOUS':
      return 'More than one live page claims this event. An administrator must resolve this before saving.'
  }
}

/** HTTP status for each failure — a mismatch is a conflict, not a missing resource. */
export function liveEventLookupStatus(r: Exclude<LiveEventLookup, { ok: true }>): number {
  switch (r.reason) {
    case 'NO_SLUG':             return 400
    case 'MISSING':             return 404
    case 'SLUG_MISMATCH':       return 409
    case 'SLUG_OWNED_BY_OTHER': return 409
    case 'AMBIGUOUS':           return 409
  }
}
