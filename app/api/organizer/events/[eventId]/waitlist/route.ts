// GET   /api/organizer/events/[eventId]/waitlist — counts + ONE bounded page of entries
// PATCH /api/organizer/events/[eventId]/waitlist — update waitlistEnabled / waitlistLimit
//
// ═══ RD-EVENT-15 · WHAT THIS ROUTE USED TO COST ══════════════════════════════
// GET issued an UNBOUNDED `.get()`:
//
//     waitlists.where('eventSlug','==',slug).orderBy('joinedAt','desc').get()
//
// so every mount transferred every waitlist entry that had ever existed for the event —
// each carrying a name, an email address and a phone number — and the browser then did
// the counting and the filtering itself. Every promote, remove, toggle and limit-save ran
// the whole thing again. An event with 5,000 entries cost 5,000 document reads per click.
//
// It is now: three `count()` aggregates (which transfer NO documents) plus at most one
// page of PAGE_SIZE entries. Cost is flat in the size of the queue.
//
// ═══ AND WHAT IT USED TO CLAIM ═══════════════════════════════════════════════
//   · `counterData.waitlistCount ?? 0` — an unreadable counter printed as "0 joined".
//   · `eventData.waitlistEnabled === true` on a `{}` fallback — a failed event read
//     printed as "the waitlist is off", which is a setting, not an absence.
//   · `orderBy('joinedAt','desc')` — NEWEST FIRST, on a queue that is served oldest
//     first. The person at the top of the list was the last one who should be promoted.
// Every one of those is a stated `null` or a corrected order below.

import { NextRequest, NextResponse } from 'next/server'
import { FieldPath, FieldValue }     from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { WAITLIST_ENABLED }          from '@/lib/registrations/gate'
import {
  SEARCH_MAX_CHARS, classifySearch, isSearchable, normalizeEmail, rowMatches, searchMeta,
  type TextSearchMeta,
} from '@/lib/registrations/search'
import {
  MAX_WAITLIST_LIMIT, isValidWaitlistLimit, resolveWaitlistSettings, waitlistSettingUpdates,
  type WaitlistSettingPatch, type WaitlistSettingSource,
} from '@/lib/waitlist/waitlistSettings'
import type { WaitlistDocument, WaitlistStatus } from '@/lib/waitlist/types'
import type { WaitlistRow } from '@/lib/waitlist/waitlistView'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

/** One page of the queue. Large enough to work in, small enough to stay flat. */
export const PAGE_SIZE = 25

/**
 * Ceiling on documents a free-text search may scan.
 *
 * Firestore has no substring index and there is no normalized name field on a waitlist
 * document, so name and phone search is a bounded projected scan — the same shape
 * RD-EVENT-12 gave the Registration Manager. The bound is REPORTED, never hidden.
 */
export const SEARCH_SCAN_CAP = 500
export const SEARCH_RESULT_CAP = PAGE_SIZE

function err(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status })
}

export interface WaitlistListResponse {
  entries: WaitlistRow[]
  /** null on any status whose aggregate failed. NEVER 0. */
  counts: { waiting: number | null; invited: number | null; removed: number | null }
  settings: {
    /** null = the event document could not be read; the switch is UNKNOWN, not off. */
    waitlistEnabled: boolean | null
    waitlistLimit:   number | null
    /** true = a cap IS stored but is not a usable number, so it is enforcing nothing. */
    limitInvalid?:   boolean
    /** `legacy` = the document predates the RD-EVENT-15A field consolidation. */
    source?:         'canonical' | 'legacy' | 'default'
  }
  /** The platform-wide kill switch in lib/registrations/gate.ts. */
  platformEnabled: boolean
  /** false = this event has never been published, so it has no public join page. */
  eventPublished:  boolean
  /** Opaque cursor for the next page; null when this is the last one. */
  nextCursor: string | null
  /** Present only for a text search — says how much of the queue was actually scanned. */
  search?: { kind: string } & TextSearchMeta
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

interface EventContext {
  uid: string
  /** null = the caller's own event, never published. A STATE, not an error. */
  slug: string | null
  /** The draft document, already read for the slug. Reused, never re-fetched. */
  draft: Record<string, unknown>
}

/**
 * A draft that does not exist and one belonging to someone else answer 404 with identical
 * words, so the route never confirms an event exists to a caller who may not see it.
 */
/**
 * Reads the caller's draft, tolerating an eventId that is not a legal document id.
 *
 * `adminDb.doc()` THROWS on a path with the wrong number of segments, so a probe like
 * `..%2F..%2Fadmin` used to escape as an unhandled 500 carrying a Next digest. An id that
 * cannot name a document cannot name an event the caller owns, so it is a 404 — the same
 * answer, in the same words, as an event that belongs to somebody else.
 */
async function readOwnDraft(uid: string, eventId: string) {
  try {
    return await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  } catch {
    return null
  }
}

async function authAndEvent(
  req: NextRequest,
  eventId: string,
): Promise<EventContext | NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return err(authz.error, authz.status)
  const uid = authz.workspaceUid

  const snap = await readOwnDraft(uid, eventId)
  if (!snap?.exists) return err('Event not found', 404)

  const data = snap.data() as Record<string, unknown>
  // Canonical slug source — the draft stores it at eventDetails.seo.urlSlug (set by
  // publish), NOT a top-level `slug` field. Matches bibs/registrations/coupons.
  // RD-CE-FIX C1 · the pointer is client-writable — only a slug proven to be THIS workspace's live
  // event is used (the waitlist query below has no owner filter).
  const slug    = await resolveOwnedEventSlug(uid, eventId, data)
  // The draft is returned so the unpublished case can resolve its settings from the
  // document this function already read — no second read for an event with no live doc.
  return { uid, slug, draft: data }
}

// ─── Serialise ────────────────────────────────────────────────────────────────

const toIso = (v: unknown): string | null =>
  (v as { toDate?: () => Date } | null)?.toDate?.()?.toISOString() ?? null

function serialise(d: FirebaseFirestore.QueryDocumentSnapshot, position: number | null): WaitlistRow {
  const data = d.data() as WaitlistDocument
  const a = (data.attendee ?? {}) as Partial<WaitlistDocument['attendee']>
  return {
    id:        d.id,
    passId:    typeof data.passId === 'string' ? data.passId : '',
    passName:  typeof data.passName === 'string' ? data.passName : '',
    attendee:  {
      name:  typeof a.name  === 'string' ? a.name  : '',
      email: typeof a.email === 'string' ? a.email : '',
      phone: typeof a.phone === 'string' ? a.phone : '',
    },
    status:    (['waiting', 'invited', 'removed'] as const).includes(data.status) ? data.status : 'waiting',
    joinedAt:  toIso(data.joinedAt),
    invitedAt: toIso(data.invitedAt),
    position,
  }
}

/**
 * `joinedAt|docId|offset` — the pair the ascending queue order is keyed on, plus how many
 * rows precede this page.
 *
 * The offset is what lets queue POSITION continue across pages: page two starts at 26, not
 * at 1. It is carried rather than recomputed because recomputing it would cost a second
 * aggregate per page. It is a snapshot, exactly like the cursor itself — if someone joins
 * or is removed while an organizer pages through, the numbers shift by one, which is true
 * of every cursor-paginated queue and is why position is shown beside a joined-at time
 * rather than on its own.
 */
function encodeCursor(d: FirebaseFirestore.QueryDocumentSnapshot, nextOffset: number): string {
  const iso = toIso((d.data() as WaitlistDocument).joinedAt) ?? ''
  return Buffer.from(`${iso}|${d.id}|${nextOffset}`).toString('base64url')
}

function decodeCursor(raw: string | null): { iso: string; id: string; offset: number } | null {
  if (!raw) return null
  try {
    const [iso, id, off] = Buffer.from(raw, 'base64url').toString('utf8').split('|')
    if (!iso || !id) return null
    if (Number.isNaN(new Date(iso).getTime())) return null
    const offset = Number(off)
    return { iso, id, offset: Number.isInteger(offset) && offset >= 0 ? offset : 0 }
  } catch {
    return null
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const { eventId } = await context.params
  const auth        = await authAndEvent(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { slug, draft } = auth

  const params  = req.nextUrl.searchParams
  const rawFilter = params.get('status')
  const filter: WaitlistStatus | null =
    rawFilter === 'waiting' || rawFilter === 'invited' || rawFilter === 'removed' ? rawFilter : null
  const rawQuery = (params.get('q') ?? '').slice(0, SEARCH_MAX_CHARS)
  const cursor   = decodeCursor(params.get('cursor'))

  // Never published — there is no public page to join from and no entries to hold. That
  // is a STATE about the caller's own event, not a 404.
  //
  // The settings still come back, resolved from the draft this request already read: an
  // organizer configuring an event before publishing should see the switch they set in
  // the builder, not a blank. Zero extra reads.
  if (!slug) {
    const draftSettings = resolveWaitlistSettings(draft as WaitlistSettingSource)
    const empty: WaitlistListResponse = {
      entries: [], counts: { waiting: 0, invited: 0, removed: 0 },
      settings: {
        waitlistEnabled: draftSettings.enabled,
        waitlistLimit:   draftSettings.limit,
        limitInvalid:    draftSettings.limitInvalid,
        source:          draftSettings.source,
      },
      platformEnabled: WAITLIST_ENABLED, eventPublished: false, nextCursor: null,
    }
    return NextResponse.json(empty)
  }

  const col  = adminDb.collection('waitlists').where('eventSlug', '==', slug)
  // `null` on failure, NEVER 0 — a zero here would tell the organizer "nobody is waiting"
  // about a query that never completed.
  const settle = async <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null)
  const countOf = (s: WaitlistStatus) =>
    settle(col.where('status', '==', s).count().get().then(r => r.data().count))

  let settings: WaitlistListResponse['settings'] = { waitlistEnabled: null, waitlistLimit: null }
  let counts = { waiting: null as number | null, invited: null as number | null, removed: null as number | null }

  try {
    const [waiting, invited, removed, eventSnap] = await Promise.all([
      countOf('waiting'), countOf('invited'), countOf('removed'),
      settle(adminDb.collection('events').doc(slug).get()),
    ])
    counts = { waiting, invited, removed }

    if (eventSnap?.exists) {
      // Resolved from the PUBLISHED document — the same one `checkRegistrationGate`
      // reads — through the same function, so this workspace cannot report a switch
      // position the gate would disagree with.
      const s = resolveWaitlistSettings(eventSnap.data() as WaitlistSettingSource)
      settings = {
        waitlistEnabled: s.enabled,
        waitlistLimit:   s.limit,
        limitInvalid:    s.limitInvalid,
        source:          s.source,
      }
    }
    // A failed or absent event read leaves `waitlistEnabled: null` — unknown, not off.
  } catch {
    return err('The waitlist could not be loaded. Please try again.', 503)
  }

  // ── The page ──────────────────────────────────────────────────────────────
  //
  // ASCENDING by joinedAt: a queue is served oldest first, so position 1 is the person
  // who has waited longest. The old route ordered DESCENDING, which put the newest
  // arrival at the top of a list whose whole purpose is "who is next".
  try {
    if (isSearchable(rawQuery)) {
      return NextResponse.json(await runSearch(col, rawQuery, filter, settings, counts))
    }

    // The document id is an EXPLICIT second sort key, for two reasons. It makes the queue
    // order total, so two people who joined in the same millisecond always come back in
    // the same sequence and neither is skipped by a cursor. And the Admin SDK accepts a
    // cursor value per declared orderBy: with only `joinedAt` declared, a two-value
    // startAfter is refused outright ("Too many cursor values specified"), which is what
    // made the second page 503. Firestore's composite indexes already end with
    // `__name__` ascending, so this needs no additional index.
    let q = (filter ? col.where('status', '==', filter) : col)
      .orderBy('joinedAt', 'asc')
      .orderBy(FieldPath.documentId(), 'asc')
    if (cursor) q = q.startAfter(new Date(cursor.iso), cursor.id)

    // +1 tells a full page apart from the last page without a second query.
    const snap = await q.limit(PAGE_SIZE + 1).get()
    const hasMore = snap.size > PAGE_SIZE
    const docs = hasMore ? snap.docs.slice(0, PAGE_SIZE) : snap.docs
    const offset = cursor?.offset ?? 0

    // Position is meaningful ONLY in the waiting queue, ordered oldest first. In a mixed
    // or filtered view the rank of a row is not its place in any queue, so it is null
    // rather than a number that would mean something different on every tab.
    const positioned = docs.map((d, i) => serialise(
      d,
      filter === 'waiting' ? offset + i + 1 : null,
    ))

    const body: WaitlistListResponse = {
      entries: positioned,
      counts,
      settings,
      platformEnabled: WAITLIST_ENABLED,
      eventPublished: true,
      nextCursor: hasMore ? encodeCursor(docs[docs.length - 1], offset + docs.length) : null,
    }
    return NextResponse.json(body)
  } catch {
    // Fixed copy. A Firestore message, an index URL or a digest tells the organizer
    // nothing and tells everyone else too much.
    return err('The waitlist could not be loaded. Please try again.', 503)
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Server-side search over the queue.
 *
 * An email is an EXACT indexed lookup — `attendee.email` is stored lower-cased and there
 * is already a composite index on (eventSlug, attendee.email, status). Everything else is
 * a bounded projected scan: Firestore cannot do substrings, and the alternative — shipping
 * the whole queue to the browser and filtering it there — is the cost this phase removed.
 */
async function runSearch(
  col: FirebaseFirestore.Query,
  rawQuery: string,
  filter: WaitlistStatus | null,
  settings: WaitlistListResponse['settings'],
  counts: WaitlistListResponse['counts'],
): Promise<WaitlistListResponse> {
  const kind = classifySearch(rawQuery)
  const base: Omit<WaitlistListResponse, 'entries' | 'search'> = {
    counts, settings, platformEnabled: WAITLIST_ENABLED, eventPublished: true, nextCursor: null,
  }

  if (kind === 'email') {
    let q = col.where('attendee.email', '==', normalizeEmail(rawQuery))
    if (filter) q = q.where('status', '==', filter)
    const snap = await q.limit(SEARCH_RESULT_CAP).get()
    return {
      ...base,
      entries: snap.docs.map(d => serialise(d, null)),
      search: { kind, ...searchMeta(snap.size, SEARCH_SCAN_CAP, snap.size, SEARCH_RESULT_CAP) },
    }
  }

  // Projected scan — only the fields the matcher reads leave Firestore, so a name search
  // never transfers a document it is going to discard in full.
  const snap = await (filter ? col.where('status', '==', filter) : col)
    .orderBy('joinedAt', 'asc')
    .orderBy(FieldPath.documentId(), 'asc')
    .select('attendee', 'passId', 'passName', 'status', 'joinedAt', 'invitedAt')
    .limit(SEARCH_SCAN_CAP)
    .get()

  const matched = snap.docs.filter(d => {
    const a = (d.data() as WaitlistDocument).attendee ?? { name: '', email: '', phone: '' }
    return rowMatches({ name: a.name ?? '', email: a.email ?? '', phone: a.phone ?? null }, rawQuery)
  })

  return {
    ...base,
    entries: matched.slice(0, SEARCH_RESULT_CAP).map(d => serialise(d, null)),
    search: { kind, ...searchMeta(snap.size, SEARCH_SCAN_CAP, matched.length, SEARCH_RESULT_CAP) },
  }
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

interface WaitlistSettingsBody {
  enabled?: boolean
  limit?:   number | null
}

export async function PATCH(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const { eventId } = await context.params
  const auth        = await authAndEvent(req, eventId)
  if (auth instanceof NextResponse) return auth
  const { uid, slug } = auth

  let body: WaitlistSettingsBody
  try {
    const parsed = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    body = parsed as WaitlistSettingsBody
  } catch {
    return err('Invalid request body', 400)
  }

  const patch: WaitlistSettingPatch = {}

  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') return err('enabled must be true or false.', 400)
    patch.enabled = body.enabled
  }
  if ('limit' in body) {
    if (body.limit === null) {
      patch.limit = null
    } else if (isValidWaitlistLimit(body.limit)) {
      patch.limit = body.limit
    } else {
      // Silently coercing a bad limit to "unlimited" is how a typo turns into an
      // uncapped queue. 0, negatives, decimals, strings and NaN are all refused.
      return err(
        `The waitlist limit must be a whole number between 1 and ${MAX_WAITLIST_LIMIT.toLocaleString('en-IN')}, or blank for no limit.`,
        400,
      )
    }
  }

  const updates = waitlistSettingUpdates(patch, FieldValue.delete())
  if (Object.keys(updates).length === 0) return err('No valid fields to update', 400)

  // ── Written to the DRAFT and the LIVE document, atomically ────────────────
  //
  // RD-EVENT-15A · this used to write a top-level field on the published document only.
  // The builder's own copy of the setting therefore never moved, and the next republish
  // — which rebuilds `events/{slug}` from the draft — put the stale value back.
  //
  // The shape is the one `buildEventEditUpdate` established for every other post-publish
  // organizer edit: one flat field-path map, one batch, both documents. Because the paths
  // are exact, a concurrent edit to any OTHER event setting cannot be clobbered by this
  // write, and vice versa.
  try {
    const meta = { updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }
    const batch = adminDb.batch()
    batch.update(adminDb.doc(`users/${uid}/eventDrafts/${eventId}`), { ...updates, ...meta })
    if (slug) batch.update(adminDb.collection('events').doc(slug), { ...updates, ...meta })
    await batch.commit()
  } catch {
    return err('The waitlist settings could not be saved. Please try again.', 503)
  }

  // The saved values are echoed back so the client renders what was STORED rather than
  // what it sent, and no second read is needed to find out.
  return NextResponse.json({
    success: true,
    settings: {
      ...('enabled' in body ? { waitlistEnabled: patch.enabled } : {}),
      ...('limit'   in body ? { waitlistLimit: patch.limit ?? null, limitInvalid: false } : {}),
      source: 'canonical' as const,
    },
  })
}
