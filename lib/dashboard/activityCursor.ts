// RD-DASH-03 · The activity feed's key, cursor and constants. PURE — no Firestore, no clock.
//
// Split out of activityFeed.ts, which imports the Admin SDK at module scope and so boots
// Firestore on import. The paging boundary is the one part of this feature that MUST be
// provably correct — a comparator that disagrees with its cursor by one tie-break silently
// skips or repeats a row — and it cannot be proven by a test that needs a live project.

export type ActivityType = 'registration' | 'checkin'

/** Rows per page. The card is a preview of the Registrations module, not a log. */
export const ACTIVITY_PAGE_SIZE = 10

/**
 * Firestore's `in` ceiling. Beyond it the event set cannot be pushed into the query and the
 * scope filter has to run in memory, which costs the reader its exact `hasMore`.
 */
export const MAX_IN_VALUES = 30

/** Extra rows fetched per stream so a cluster of identical timestamps cannot starve a page. */
export const TIE_BUFFER = 5

/** The sort key. Identical to the cursor's — that identity is the whole point. */
export interface ActivityKey {
  ms:       number
  type:     ActivityType
  sourceId: string
}

/**
 * Newest first, then a STABLE tie-break.
 *
 * Two activities sharing a millisecond is ordinary — a bulk import produces hundreds. Without
 * a deterministic tie-break they swap places between requests, and a page boundary that lands
 * inside the cluster then drops one row and repeats another.
 */
export function compareDesc(a: ActivityKey, b: ActivityKey): number {
  return (b.ms - a.ms) || a.type.localeCompare(b.type) || a.sourceId.localeCompare(b.sourceId)
}

/**
 * The cursor is base64url of the sort key — NOT a Firestore snapshot.
 *
 * It carries no document path, no collection name and nothing the client could address; it is
 * exactly the three values needed to resume the merge.
 */
export function encodeActivityCursor(key: ActivityKey): string {
  return Buffer.from(JSON.stringify([key.ms, key.type, key.sourceId]), 'utf8').toString('base64url')
}

/** Anything malformed decodes to null, which the reader treats as "start at page one". */
export function decodeActivityCursor(raw: string | null | undefined): ActivityKey | null {
  if (!raw) return null
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(v) || v.length !== 3) return null
    const [ms, type, sourceId] = v
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
    if (type !== 'registration' && type !== 'checkin') return null
    if (typeof sourceId !== 'string') return null
    return { ms, type, sourceId }
  } catch { return null }
}

/**
 * An event draft's public slug — `eventDetails.seo.urlSlug`, or null when unpublished.
 *
 * Shared so the dashboard route and the paging endpoint resolve scope from ONE definition. A
 * second copy reading the wrong nesting would silently scope the feed to nothing.
 */
export function draftSlug(d: Record<string, unknown>): string | null {
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo as Record<string, unknown>) ?? {}
  return typeof seo.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : null
}
