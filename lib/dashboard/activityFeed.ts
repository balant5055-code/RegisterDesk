// RD-DASH-03 · The dashboard activity feed. Server-only, READ-ONLY, paged.
//
// ═══ ONE READER, TWO ENTRY POINTS ════════════════════════════════════════════
// The dashboard route renders page 1 as part of its single payload; the paging endpoint
// serves every page after that. Both call `readActivityPage`, so a row can never appear on
// one and not the other, and the scope rules exist in exactly one place.
//
// ═══ TWO STREAMS, ONE ORDER ══════════════════════════════════════════════════
// A registration and a check-in are different events on the same document, ordered by
// different fields. The feed is their merge, so paging cannot be a simple Firestore cursor:
// it is a WATERMARK. Each page asks both streams for everything at or before the last row
// shown, merges, re-sorts on the shared comparator, and takes the next slice. The comparator
// and the cursor use the identical key, which is what stops a row being skipped or repeated
// when two events share a millisecond.
//
// ═══ WHY THERE IS NO TOTAL ═══════════════════════════════════════════════════
// An exact "1–10 of N" needs count() over both streams. The registration count is served by
// an existing index; the check-in count is NOT — `count()` with an inequality on
// `checkedInAt` fails FAILED_PRECONDITION on a query whose document form works fine. Half a
// total is not a total, and a fabricated one is worse than none, so the feed reports what it
// can prove: the page it is on and whether another exists.

import { adminDb } from '@/lib/firebase/admin'
import { Timestamp } from 'firebase-admin/firestore'
import type { Query } from 'firebase-admin/firestore'
import type { RegistrationDocument } from '@/lib/registrations/types'

/**
 * The key, the cursor and the constants are PURE and live in ./activityCursor, so the
 * paging boundary can be proven without a live Firestore project. They are re-exported
 * here because both entry points import this module.
 */
export {
  ACTIVITY_PAGE_SIZE, MAX_IN_VALUES, TIE_BUFFER,
  compareDesc, encodeActivityCursor, decodeActivityCursor, draftSlug,
  type ActivityType, type ActivityKey,
} from './activityCursor'

import {
  ACTIVITY_PAGE_SIZE, MAX_IN_VALUES, TIE_BUFFER,
  compareDesc, decodeActivityCursor, encodeActivityCursor,
  type ActivityType, type ActivityKey,
} from './activityCursor'

// ─── Shapes ───────────────────────────────────────────────────────────────────

// RD-DASH-12 · `attendeeEmail` is GONE from this shape.
//
// It was read (`select('attendee.email')`), serialised into the dashboard payload and
// into every page of the paging endpoint, and rendered by nothing — RecentActivityCard
// prints "{attendeeName} registered" and never the address. lib/metadata/registry.ts
// classifies this field `sensitive: true`, and GET /api/organizer/dashboard requires NO
// specific permission, so a `finance` member — a role with no `registrations` grant at
// all — received ten participants' real addresses on every dashboard load.
//
// The name stays: it is what the row says.
export interface ActivityFeedItem {
  type:          ActivityType
  sourceId:      string
  eventSlug:     string
  /**
   * RD-ANALYTICS-12-17 · `null` when the caller holds neither `registrations` nor
   * `transactions`. The name is not sent to the browser at all in that case — it is not
   * fetched, not serialised and not hidden client-side.
   */
  attendeeName:  string | null
  eventName:     string
  passName:      string
  /** ISO 8601. `registeredAt` for a registration, `checkedInAt` for a check-in — never mixed. */
  timestamp:     string
}

export interface ActivityPage {
  items:      ActivityFeedItem[]
  pageSize:   number
  hasMore:    boolean
  /** Opaque. Feed it back as `cursor` to get the next page. */
  nextCursor: string | null
  /** Rows that could not be read at all. Disclosed, never silently dropped. */
  skipped:    number
  /**
   * False when the event set exceeded `MAX_IN_VALUES` and scope had to be applied in memory.
   * `hasMore` is then a best effort and a "Next" may land on a short page.
   */
  exact:      boolean
  /**
   * RD-DASH-15 · the page could not be read at all.
   *
   * `readActivityPage` itself never throws — a stream that fails contributes nothing and
   * the other still renders — so this is always false here. It exists for the CALLER,
   * whose own catch previously produced `items: []` and let the card say "No recent
   * activity yet": a statement about the workspace on the strength of a failed call.
   *
   * An empty feed and an unread feed are different facts and the card now says which.
   */
  unavailable: boolean
}

// ─── Reading ──────────────────────────────────────────────────────────────────

const tsToDate = (v: unknown): Date | null => {
  if (!v) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (v instanceof Timestamp) return v.toDate()
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try { const d = (v as { toDate: () => Date }).toDate(); return Number.isNaN(d.getTime()) ? null : d } catch { return null }
  }
  if (typeof v === 'number') { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d }
  return null
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export interface ActivityScope {
  organizerUid: string
  /** One event, or null for the workspace. */
  eventSlug:    string | null
  /** The dashboard-visible event set — archived events contribute nothing to the feed. */
  dashboardSlugs: string[]
  /** Feed window. Both streams share it, so the two halves mean the same thing by "recent". */
  since:        Date
  /**
   * RD-ANALYTICS-12-17 · may this caller be told WHO the activity belongs to?
   *
   * ═══ WHY THE UNION, AND WHY IT IS NOT `registrations` ALONE ════════════════
   * `registrations` is the obvious answer and is the wrong one on its own. Finance holds
   * no `registrations`, yet /api/organizer/payment-issues authorizes with `transactions`
   * and returns attendee names — because a payment issue cannot be worked without knowing
   * whose payment it is. Gating this feed on `registrations` alone would blank names on
   * finance's dashboard while the finance section three clicks away kept showing them:
   * one product, two answers, which is the defect class this sequence has been closing.
   *
   * So the rule is the union of the two permissions that ALREADY grant attendee names.
   * It changes nobody's access today — every role that reaches this reader holds one of
   * them — and it is a guard against the role that does not yet exist.
   *
   * REQUIRED, not optional-defaulting-false: a caller must state the answer, so a future
   * entry point cannot inherit a silent default in either direction.
   */
  canReadAttendeeName: boolean
}

/**
 * Apply the event scope to a query.
 *
 * Pushed INTO the query wherever Firestore allows, because a scope applied in memory after a
 * limited read silently shortens the page — the rows are gone but the limit was already spent.
 */
function applyScope(base: Query, scope: ActivityScope): { q: Query; inQuery: boolean } {
  if (scope.eventSlug) return { q: base.where('eventSlug', '==', scope.eventSlug), inQuery: true }
  if (scope.dashboardSlugs.length > 0 && scope.dashboardSlugs.length <= MAX_IN_VALUES) {
    return { q: base.where('eventSlug', 'in', scope.dashboardSlugs), inQuery: true }
  }
  return { q: base, inQuery: false }
}

async function readStream(
  type: ActivityType, field: 'registeredAt' | 'checkedInAt',
  scope: ActivityScope, cursor: ActivityKey | null, fetchLimit: number,
): Promise<{ rows: Array<ActivityFeedItem & { _key: ActivityKey }>; skipped: number; hitLimit: boolean }> {
  const { q: scoped, inQuery } = applyScope(
    adminDb.collection('registrations').where('organizerUid', '==', scope.organizerUid), scope,
  )
  let q = scoped.where(field, '>=', Timestamp.fromDate(scope.since))
  // The watermark. `<=` rather than `<` so rows sharing the cursor's millisecond are still
  // returned; the ones already shown are removed by the comparator below.
  if (cursor) q = q.where(field, '<=', Timestamp.fromMillis(cursor.ms))

  const snap = await q.orderBy(field, 'desc').limit(fetchLimit)
    // RD-ANALYTICS-12-17 · the name is not even READ for a caller who may not see it, so
    // there is nothing to leak through a later refactor, a log line or a serialiser.
    // Argument order is otherwise unchanged: this still projects, never transferring a
    // whole registration document.
    .select(field, 'eventSlug', 'eventName', 'passName',
            ...(scope.canReadAttendeeName ? ['attendee.name'] : []))
    .get()

  const allowed = new Set(scope.dashboardSlugs)
  const rows: Array<ActivityFeedItem & { _key: ActivityKey }> = []
  let skipped = 0

  for (const doc of snap.docs) {
    // `.data()` itself can throw on a corrupt snapshot: one bad row must cost one row, never
    // the endpoint. This feed returned 500 for the whole dashboard once already.
    let r: Partial<RegistrationDocument>
    try { r = doc.data() as Partial<RegistrationDocument> } catch { skipped++; continue }

    const slug = str(r.eventSlug)
    // Only needed when the scope could not be pushed into the query.
    if (!inQuery) {
      if (!slug) continue
      if (!allowed.has(slug)) continue
    }

    const when = tsToDate(type === 'checkin' ? r.checkedInAt : r.registeredAt)
    if (!when) { skipped++; continue }

    const key: ActivityKey = { ms: when.getTime(), type, sourceId: doc.id }
    // Strictly AFTER the cursor in sort order — this is what makes the page boundary exact
    // when several activities share a millisecond.
    if (cursor && compareDesc(key, cursor) <= 0) continue

    const a = (r.attendee ?? {}) as Partial<RegistrationDocument['attendee']>
    rows.push({
      type,
      sourceId:      doc.id,
      eventSlug:     slug,
      // An absent name is STATED, not blanked: "  registered" reads as a rendering bug.
      // `null` is a different fact again — not "we have no name for this row" but "you may
      // not be told it" — and the card renders a subject-less title for it.
      attendeeName:  scope.canReadAttendeeName
        ? (str(a.name).trim() || 'Unnamed attendee')
        : null,
      eventName:     str(r.eventName),
      passName:      str(r.passName),
      timestamp:     when.toISOString(),
      _key:          key,
    })
  }

  return { rows, skipped, hitLimit: snap.size >= fetchLimit }
}

/**
 * One page of the merged feed, newest first.
 *
 * Never throws: a stream that fails contributes nothing and the other still renders, because
 * half a feed is worth more to an organizer than an error card.
 */
export async function readActivityPage(
  scope: ActivityScope,
  opts: { cursor?: string | null; pageSize?: number } = {},
): Promise<ActivityPage> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? ACTIVITY_PAGE_SIZE, 50))
  const cursor   = decodeActivityCursor(opts.cursor)
  const empty: ActivityPage = {
    items: [], pageSize, hasMore: false, nextCursor: null, skipped: 0, exact: true,
    // A MEASURED empty: this organizer has no dashboard-visible events, so there is
    // nothing a feed could contain. Not a failure.
    unavailable: false,
  }
  // An organizer with no dashboard-visible events has no feed — and `in []` is not a query.
  if (!scope.eventSlug && scope.dashboardSlugs.length === 0) return empty

  const fetchLimit = pageSize + 1 + TIE_BUFFER
  const [reg, chk] = await Promise.all([
    readStream('registration', 'registeredAt', scope, cursor, fetchLimit).catch(() => null),
    readStream('checkin',      'checkedInAt',  scope, cursor, fetchLimit).catch(() => null),
  ])

  const merged = [...(reg?.rows ?? []), ...(chk?.rows ?? [])].sort((a, b) => compareDesc(a._key, b._key))
  const page   = merged.slice(0, pageSize)
  const last   = page[page.length - 1]

  // When the scope IS the query, `merged` holds every candidate the streams could offer, so
  // an overflow is proof of another page. When it had to be filtered in memory, a stream that
  // hit its own limit may still be hiding one, so that counts too — at the cost of an
  // occasional Next that lands on a short page, which `exact: false` discloses.
  const inMemoryScope = !scope.eventSlug &&
    (scope.dashboardSlugs.length === 0 || scope.dashboardSlugs.length > MAX_IN_VALUES)
  const hitLimit = Boolean(reg?.hitLimit || chk?.hitLimit)

  return {
    items:      page.map(({ _key, ...rest }) => rest),   // eslint-disable-line @typescript-eslint/no-unused-vars
    pageSize,
    hasMore:    merged.length > pageSize || (inMemoryScope && hitLimit),
    nextCursor: last ? encodeActivityCursor(last._key) : null,
    skipped:    (reg?.skipped ?? 0) + (chk?.skipped ?? 0),
    exact:      !inMemoryScope,
    // Both streams are individually caught above, so reaching here means a page was
    // produced — possibly a partial one, which `skipped` discloses.
    unavailable: false,
  }
}
