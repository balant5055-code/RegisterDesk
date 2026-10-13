// RD-PRINT-BILL-P7 · Shared helpers for the Super Admin ID-badge readers. Server-only, READ-ONLY.
//
// A SECTION is one independently-read part of a view. A section that could not be read is
// `{ ok: false, reason: 'unavailable' }` — never an empty list or a zero, so "nothing there" and
// "could not look" can never be confused. Errors are logged by TYPE only (never their text, which
// could quote stored data).

export type Section<T> = { ok: true; data: T } | { ok: false; reason: 'unavailable' }

export async function section<T>(label: string, read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await read() }
  } catch (e) {
    console.error(`[admin/print-badges] ${label} unavailable`, { type: e instanceof Error ? e.name : typeof e })
    return { ok: false, reason: 'unavailable' }
  }
}

/** A page of documents in document-id order. */
export interface Page<T> { items: T[]; hasMore: boolean; nextCursor: string | null }

/** Document ids used as cursors: the id alphabet of every collection read here. */
export const CURSOR_RE = /^[A-Za-z0-9_:.~-]{1,200}$/
export const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** A bounded page size: integer within [1, max], else `fallback`. */
export function pageSize(raw: string | null | undefined, fallback: number, max: number): number {
  if (raw === null || raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback
}

export const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)
export const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)
export const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
export const iso = (v: unknown): string | null =>
  v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null
export const tsMs = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : null

/** Last 6 characters of a gateway id, for lists (the full id is shown only in the order detail). */
export const maskId = (id: string | null): string | null => (id ? `…${id.slice(-6)}` : null)

/**
 * A BOUNDED list: at most `limit` items. `truncated` is true when more exist — the list is then
 * incomplete and must be presented as such, never as the whole set.
 */
export interface Bounded<T> { items: T[]; truncated: boolean; limit: number }

/** Reads at most `limit` documents of `q` (limit + 1 probe) and says whether more exist. */
export async function boundedRead<T>(
  q: FirebaseFirestore.Query, limit: number, map: (d: FirebaseFirestore.QueryDocumentSnapshot) => T,
): Promise<Bounded<T>> {
  const snap = await q.limit(limit + 1).get()
  return { items: snap.docs.slice(0, limit).map(map), truncated: snap.size > limit, limit }
}

/** Pages a query in document-id order (limit + 1 probe), starting after `cursor`. */
export async function pageByDocId<T>(
  q: FirebaseFirestore.Query, cursor: string | null, limit: number,
  map: (d: FirebaseFirestore.QueryDocumentSnapshot) => T, idPath: FirebaseFirestore.FieldPath,
): Promise<Page<T>> {
  let query = q.orderBy(idPath)
  if (cursor) query = query.startAfter(cursor)
  const snap = await query.limit(limit + 1).get()
  const docs = snap.docs.slice(0, limit)
  const hasMore = snap.size > limit
  return { items: docs.map(map), hasMore, nextCursor: hasMore && docs.length ? docs[docs.length - 1].id : null }
}
