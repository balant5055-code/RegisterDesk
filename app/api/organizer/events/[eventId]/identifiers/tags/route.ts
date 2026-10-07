// RD-EVENT-19F-B — Timing tags: summary, mapping page, and single-participant edits.
//
//   GET  → capability + readiness counts + ONE bounded page of the mapping table
//   POST → { action: 'assign' | 'remove', registrationId, tag? }
//
// Counts come from `count()` aggregates, so a 20,000-participant event costs the
// same as a 20-participant one and the browser never downloads a roster.

import { NextRequest, NextResponse } from 'next/server'
import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { resolveIdentifierScope, assertRegistrationInScope } from '@/lib/identifiers/organizerScope'
import { resolveIdentifierConfig } from '@/lib/identifiers/config'
import { resolveEventAssignmentGate } from '@/lib/identifiers/assignmentDecision'
import { assignTimingTag, removeTimingTag, countAssignedTags, lookupTimingTag } from '@/lib/identifiers/timingTagEngine'
import { lookupIdentifier } from '@/lib/identifiers/engine'
import { planSearch, tagLookupVariants } from '@/lib/identifiers/timingWorkspace'
import { foldForSearch } from '@/lib/registrations/search'
import {
  resolveTagMapping, requiresMapping, resolveTagReadiness, TimingTagError,
} from '@/lib/identifiers/timingTags'
import { ROSTER_STATUSES } from '@/lib/identifiers/eligibility'
import { article } from '@/lib/identifiers/identifierWorkspace'

export const dynamic = 'force-dynamic'

const PAGE = 50
/** A targeted search returns a handful of exact matches, never a listing. */
const SEARCH_LIMIT = 25
/** Three aggregates per pass; the cap keeps a pathological event bounded. */
const MAX_BREAKDOWN_PASSES = 24
/**
 * How many documents a NAME search may scan. Mirrors the registrations route's
 * own ceiling, and is reported to the caller rather than silently applied.
 */
const NAME_SCAN_CAP = 1000

/** Exact, event-wide figures for one pass. Every field is number | null. */
interface PassFigures {
  passId:         string
  passName:       string
  total:          number | null
  withIdentifier: number | null
  withTag:        number | null
}

/** One row of the mapping table. Deliberately minimal — name is needed, nothing else. */
interface MappingRow {
  registrationId: string
  name:           string
  /** RD-BIB-TIMING-04 · additive, from the SAME attendee map already projected. */
  email:          string
  mobile:         string
  passName:       string
  passId:         string | null
  identifier:     string | null
  tag:            string | null
}

/** One registration document → one mapping row. Used by the page and by search. */
function toMappingRow(id: string, r: Record<string, unknown>): MappingRow {
  const a = r.attendee as { name?: unknown; email?: unknown; phone?: unknown } | undefined
  const idv = (r.identifier as { value?: unknown } | undefined)?.value
  const tg = r.timingTag as { tag?: unknown; state?: unknown } | null | undefined
  return {
    registrationId: id,
    name: typeof a?.name === 'string' ? a.name : '',
    email: typeof a?.email === 'string' ? a.email : '',
    mobile: typeof a?.phone === 'string' ? a.phone : '',
    passName: typeof r.passName === 'string' ? r.passName : '',
    passId: typeof r.passId === 'string' ? r.passId : null,
    identifier: typeof idv === 'string' ? idv : null,
    tag: tg?.state === 'assigned' && typeof tg.tag === 'string' ? tg.tag : null,
  }
}

const countOf = (q: FirebaseFirestore.Query): Promise<number | null> =>
  q.count().get().then(s => s.data().count as number).catch(() => null)

export async function GET(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  const { config } = await resolveIdentifierConfig(scope.slug)
  const mapping = resolveTagMapping(config.tagMapping)

  // ═══ RD-BIB-TIMING-02 · ONE device's availability ════════════════════════════
  //
  // `?tag=` answers "is this device free?" for the assignment panel. It is a single
  // document read on a deterministic lock id — never a listing, never a scan — and
  // it lives on the EXISTING route rather than a new one so the scope resolver, the
  // permission and the event gate above are shared verbatim.
  //
  // `lookupTimingTag` had been written and exported since RD-EVENT-19F-B and called
  // by nothing; this is its first consumer.
  const lookupValue = (req.nextUrl.searchParams.get('tag') ?? '').trim()
  if (lookupValue) {
    const lock = await lookupTimingTag(scope.slug, lookupValue)
    return NextResponse.json({
      tag: lookupValue,
      lock: lock ? { state: lock.state, registrationId: lock.registrationId ?? null } : null,
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const base = adminDb.collection('registrations')
    .where('organizerUid', '==', scope.workspaceUid)
    .where('eventSlug', '==', scope.slug)
    .where('status', '==', ROSTER_STATUSES[0])

  // ═══ RD-BIB-TIMING-04 · TARGETED SEARCH ══════════════════════════════════════
  //
  // The workspace browses a bounded working set. That is fine for browsing and
  // wrong for looking somebody up: participant #8,742 must be findable. This
  // resolves a term through the AUTHORITATIVE records — the two lock collections
  // and equality queries — so a match is exact wherever the participant sits.
  //
  // Every branch is a deterministic document id or an equality-only query, so
  // there is no composite index and no scan. `planSearch` decides which branches
  // apply; a term that could be two things tries both rather than guessing.
  const rawQuery = req.nextUrl.searchParams.get('q') ?? ''
  const plan = planSearch(rawQuery)
  if (plan.term) {
    const ids = new Set<string>()

    const [tagLock, idLock, byMobile, byEmail] = await Promise.all([
      plan.asTag
        ? Promise.all(tagLookupVariants(plan.term).map(v => lookupTimingTag(scope.slug, v).catch(() => null)))
        : null,
      plan.asIdentifier ? lookupIdentifier(scope.slug, plan.term).catch(() => null) : null,
      // Equality on a map field: served by index merging with the three above.
      plan.asMobile ? base.where('attendee.phone', '==', plan.asMobile).limit(SEARCH_LIMIT)
        .select('attendee', 'passName', 'passId', 'identifier', 'timingTag', 'organizerUid', 'eventSlug')
        .get().catch(() => null) : null,
      plan.asEmail ? base.where('attendee.email', '==', plan.asEmail).limit(SEARCH_LIMIT)
        .select('attendee', 'passName', 'passId', 'identifier', 'timingTag', 'organizerUid', 'eventSlug')
        .get().catch(() => null) : null,
    ])

    // A lock names the registration it belongs to — but only while it HOLDS it.
    // A released lock still records its last owner and must not resolve to them.
    for (const l of tagLock ?? []) {
      if (l?.state === 'assigned' && l.registrationId) ids.add(l.registrationId)
    }
    if (idLock?.registrationId) ids.add(idLock.registrationId)

    const rows: MappingRow[] = []
    const seen = new Set<string>()
    const push = (id: string, r: Record<string, unknown>) => {
      if (seen.has(id)) return
      seen.add(id)
      // Ownership is re-checked per row: a lock could name a registration in
      // another event, and the client must never be handed one.
      //
      // The projections above MUST carry `organizerUid` and `eventSlug` for this
      // to mean anything — when they did not, this guard silently rejected every
      // row it exists to protect and every mobile/email search returned nothing.
      if (r.organizerUid !== scope.workspaceUid || r.eventSlug !== scope.slug) return
      rows.push(toMappingRow(id, r))
    }
    for (const snap of [byMobile, byEmail]) {
      snap?.docs.forEach(d => push(d.id, d.data() as Record<string, unknown>))
    }
    // The lock-resolved registrations, read by id.
    const extra = [...ids].filter(id => !seen.has(id)).slice(0, SEARCH_LIMIT)
    if (extra.length > 0) {
      const docs = await adminDb.getAll(
        ...extra.map(id => adminDb.collection('registrations').doc(id)),
      )
      docs.forEach(d => { if (d.exists) push(d.id, d.data() as Record<string, unknown>) })
    }

    // ═══ RD-BIB-TIMING-05 · NAME SEARCH · a BOUNDED SERVER SCAN ════════════════
    //
    // Firestore cannot substring-match a name, and this schema carries no
    // normalized name field to range over — so a genuinely global name search is
    // not available without a search service, which is out of scope.
    //
    // What IS available is the pattern the registrations route already uses: scan
    // a bounded, PROJECTED page server-side, match in memory, and report the
    // ceiling instead of hiding it. That reaches 1,000 participants rather than
    // the 200 the browser holds, costs a bounded read, and — critically — tells
    // the caller when the scan was truncated so the UI never claims it searched
    // the whole event.
    //
    // Only for terms that could not be resolved exactly: a mobile, a number or a
    // device id has already been answered above by a document read.
    // Did an authoritative record answer this term?
    const matchedExactly = rows.length > 0
    let scanned = 0
    let truncated = false
    if (!plan.exactlyResolvable && !matchedExactly) {
      const scan = await base.limit(NAME_SCAN_CAP)
        .select('attendee', 'passName', 'passId', 'identifier', 'timingTag', 'organizerUid', 'eventSlug')
        .get().catch(() => null)
      if (scan) {
        scanned = scan.size
        truncated = scan.size >= NAME_SCAN_CAP
        const folded = foldForSearch(plan.term)
        for (const d of scan.docs) {
          if (rows.length >= SEARCH_LIMIT) break
          const r = d.data() as Record<string, unknown>
          const a = r.attendee as { name?: unknown; email?: unknown } | undefined
          const name  = typeof a?.name === 'string' ? a.name : ''
          const email = typeof a?.email === 'string' ? a.email : ''
          if (foldForSearch(name).includes(folded) || foldForSearch(email).includes(folded)) {
            push(d.id, r)
          }
        }
      }
    }

    return NextResponse.json({
      mapping,
      identifierLabel: config.label,
      search: {
        term: plan.term,
        rows,
        /**
         * FALSE when the term could only be matched by scanning names, which
         * Firestore cannot do without a search index. The UI says so rather than
         * reporting "not found" for somebody who exists — see the limitation note
         * in the workspace.
         */
        /**
         * Whether the answer came from an EXACT record read rather than a scan.
         * A term that looked name-shaped but resolved a real device or number was
         * answered event-wide, and the UI must not caveat it as a name search.
         */
        exactlyResolvable: plan.exactlyResolvable || matchedExactly,
        /** How far the name scan reached, and whether it hit its ceiling. */
        scanned,
        truncated,
      },
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // Three aggregates + one bounded page. Nothing scales with the event.
  const [eligible, identified, mapped] = await Promise.all([
    countOf(base),
    // `identifier.value` is a map field; a registration that never had one has no
    // such field at all, so this counts holders exactly.
    countOf(base.orderBy('identifier.value')),
    mapping.enabled ? countAssignedTags(scope.slug) : Promise.resolve(0),
  ])

  // ═══ RD-REPORT-04 · ROSTER-SCOPED DEVICE COUNTS ════════════════════════════
  //
  // ADDITIVE. `mapped` above is unchanged and still counts LOCKS
  // (`identifierTagLocks` where state == 'assigned'), which is the right figure for
  // "how many devices are out" — but it is the wrong denominator partner for
  // `eligible`, and Reports needs a coverage percentage.
  //
  // A lock carries no registration status. A participant who is cancelled after
  // being given a device SHOULD have it detached — the cancel route does exactly
  // that — but the detach is fire-and-forget, so a failed detach leaves an
  // `assigned` lock behind a cancelled registration. Dividing that lock count by a
  // confirmed-only roster mixes two populations and can exceed 100%.
  //
  // These three count on the REGISTRATION side, inside the SAME population
  // `eligible` already describes (this organizer, this event, status confirmed):
  //
  //   rosterMapped                confirmed AND carrying a device
  //   rosterMappedWithIdentifier  …and holding a number      → a VALID pairing
  //   rosterMappedWithoutIdentifier …and holding NO number   → the §4 ANOMALY
  //
  // The last one should always be 0: the tag engine refuses a device to anyone
  // without a number, and the identifier engine refuses to release a number while a
  // device is attached. It is counted rather than assumed, because both guards are
  // bypassed by `allowWhileTagged` on the cancel and refund paths.
  //
  // Every filter is an equality on a map field — the same shape `timingTag.state`
  // already uses just below — so Firestore serves them by merging single-field
  // indexes. No composite index, no migration, and the cost does not grow with the
  // roster.
  const tagged = base.where('timingTag.state', '==', 'assigned')
  const [rosterMapped, rosterMappedWithIdentifier, rosterMappedWithoutIdentifier] =
    mapping.enabled
      ? await Promise.all([
          countOf(tagged),
          countOf(tagged.where('hasIdentifier', '==', true)),
          countOf(tagged.where('hasIdentifier', '==', false)),
        ])
      : [null, null, null]

  const readiness = resolveTagReadiness({
    eligible, identified, mapped, config: mapping, identifierLabel: config.label,
  })

  // ═══ RD-BIB-TIMING-04 · PER-PASS FIGURES, EXACT AND EVENT-WIDE ═══════════════
  //
  // These used to be derived from the bounded list the browser had loaded, which
  // on a 5,000-participant event described the first 200 people and looked like
  // the whole pass. They are aggregates now.
  //
  // The shape is the one RD-BIB-01 already uses for per-pass identifier counts:
  // EQUALITY-ONLY filters, which Firestore serves by merging single-field indexes
  // — no composite to deploy, no migration. `timingTag.state` is an equality on a
  // map field for the same reason `hasIdentifier` is.
  //
  // Cost is three aggregates per pass, run in parallel, and an aggregate reads
  // index entries rather than documents — so this does not grow with the roster.
  let passes: PassFigures[] | null = null
  if (requiresMapping(mapping) && scope.passes.length > 0) {
    passes = await Promise.all(
      scope.passes.slice(0, MAX_BREAKDOWN_PASSES).map(async pass => {
        const q = base.where('passId', '==', pass.id)
        const [total, withIdentifier, withTag] = await Promise.all([
          countOf(q),
          countOf(q.where('hasIdentifier', '==', true)),
          countOf(q.where('timingTag.state', '==', 'assigned')),
        ])
        return { passId: pass.id, passName: pass.name, total, withIdentifier, withTag }
      }),
    )
  }

  // The page is only fetched when there is something to map — and never for the
  // Overview card, which shows three aggregates and no roster. `summary=1` keeps
  // that landing screen at three `count()` calls instead of 50 document reads.
  const summaryOnly = req.nextUrl.searchParams.get('summary') === '1'
  let rows: MappingRow[] = []
  let nextCursor: string | null = null
  if (requiresMapping(mapping) && !summaryOnly) {
    const filter = (req.nextUrl.searchParams.get('filter') ?? 'all').toLowerCase()
    const cursor = req.nextUrl.searchParams.get('cursor')
    let q = base.orderBy(FieldPath.documentId()).limit(PAGE)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.select('attendee', 'passName', 'passId', 'identifier', 'timingTag').get()
    const all: MappingRow[] = snap.docs.map(d => toMappingRow(d.id, d.data() as Record<string, unknown>))
    // Filtering is applied to the PAGE, and the filter name says so in the UI — a
    // server-side filter on two optional map fields would need indexes for a view
    // that is browsed, not searched.
    rows = filter === 'mapped' ? all.filter(r => r.tag)
         : filter === 'missing' ? all.filter(r => !r.tag && r.identifier)
         // RD-BIB-TIMING-01 · the participants who cannot receive a device at all,
         // because the prerequisite is missing. Previously unreachable from the UI.
         : filter === 'no_identifier' ? all.filter(r => !r.identifier)
         : all
    nextCursor = snap.size === PAGE ? snap.docs[snap.docs.length - 1].id : null
  }

  return NextResponse.json({
    mapping,
    identifierLabel: config.label,
    counts: { eligible, identified, mapped },
    // RD-REPORT-04 · additive; `counts` above keeps its exact shape and values.
    // Null when the device credential is off — never 0, which would read as
    // "nobody has one" on an event that issues none.
    rosterCounts: {
      mapped:               rosterMapped,
      mappedWithIdentifier: rosterMappedWithIdentifier,
      mappedWithoutIdentifier: rosterMappedWithoutIdentifier,
    },
    readiness,
    // RD-BIB-TIMING-04 · exact, event-wide per-pass figures. Null when the event
    // has no device credential or no passes — never an empty array standing in
    // for "we did not look".
    passes,
    rows,
    nextCursor,
    assignmentGate: resolveEventAssignmentGate(scope.lifecycleStatus),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  // The same lifecycle gate every identifier mutation uses. A disabled button is
  // not a security boundary.
  const gate = resolveEventAssignmentGate(scope.lifecycleStatus)
  if (!gate.open) return NextResponse.json({ error: gate.detail, code: gate.reason }, { status: 409 })

  const { config } = await resolveIdentifierConfig(scope.slug)
  const mapping = resolveTagMapping(config.tagMapping)
  if (!requiresMapping(mapping)) {
    return NextResponse.json({
      error: mapping.enabled
        ? `This event uses the ${config.label} as its ${mapping.label}, so there is nothing to map.`
        : `${mapping.label} mapping is not switched on for this event.`,
      code: mapping.enabled ? 'TAG_MODE_IS_IDENTIFIER' : 'TAG_MAPPING_DISABLED',
    }, { status: 409 })
  }

  let body: { action?: string; registrationId?: string; tag?: string; reason?: string }
  try { body = await req.json() as typeof body } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ownership is proved from the STORED registration, per row, before anything.
  const guard = await assertRegistrationInScope(body.registrationId ?? '', scope.workspaceUid, scope.slug)
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })

  try {
    if (body.action === 'remove') {
      const r = await removeTimingTag(scope.slug, body.registrationId!, scope.callerUid, body.reason ?? null)
      return NextResponse.json({ ok: true, removed: r.removed })
    }
    if (body.action === 'assign') {
      const r = await assignTimingTag({
        eventSlug: scope.slug, registrationId: body.registrationId!,
        tag: body.tag ?? '', actor: scope.callerUid, source: 'manual',
        reason: body.reason ?? null,
      })
      return NextResponse.json({ ok: true, ...r })
    }
    return NextResponse.json({ error: "action must be 'assign' or 'remove'" }, { status: 400 })
  } catch (err) {
    if (err instanceof TimingTagError) {
      // The engine speaks in codes. Each one gets a sentence a person can act on;
      // the raw code travels alongside for the client, never as the message.
      const COPY: Record<string, string> = {
        TAG_OWNED_BY_OTHER:     `That ${mapping.label} is already attached to a different participant in this event.`,
        INVALID_TAG:            `That ${mapping.label} value cannot be used — check its length and characters.`,
        REGISTRATION_TERMINAL:  'This registration is cancelled or rejected, so it cannot carry one.',
        REGISTRATION_NOT_FOUND: 'That participant could not be found in this event.',
        TAG_MAPPING_DISABLED:   `${mapping.label} mapping is not switched on for this event.`,
        TAG_MODE_IS_IDENTIFIER: 'This event uses the identifier as its tag, so there is nothing to map.',
        // RD-BIB-TIMING-01 · the dependency, in the event's OWN two nouns. The code
        // travels for the client; the organizer only ever sees this sentence.
        REGISTRATION_HAS_NO_IDENTIFIER:
          `Assign ${article(config.label)} ${config.label} to this participant before assigning ` +
          `${article(mapping.label)} ${mapping.label}.`,
      }
      const status = err.code === 'TAG_OWNED_BY_OTHER' ? 409
                   : err.code === 'REGISTRATION_NOT_FOUND' ? 404
                   : err.code === 'REGISTRATION_TERMINAL' ? 409
                   : err.code === 'REGISTRATION_HAS_NO_IDENTIFIER' ? 409 : 400
      return NextResponse.json({ error: COPY[err.code] ?? 'That could not be completed.', code: err.code }, { status })
    }
    console.error('[tags] operation failed:', err)
    return NextResponse.json({ error: 'That could not be completed.' }, { status: 500 })
  }
}
