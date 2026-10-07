// GET /api/organizer/events/[eventId]/checkin/search?q=...
//
// RD-CHECKIN-2.0 — THE authoritative attendee resolver.
//
// One route resolves every way a gate operator can name a person: a scanned QR, a
// typed ticket code, an email address, a mobile number, an issued identifier (bib /
// delegate number), a registration id, and a name. QR and manual entry deliberately
// come through here rather than each growing their own resolution, so there is one
// place that decides which registration a query means.
//
// ═══ WHAT WAS REMOVED, AND WHY IT MATTERED ═══════════════════════════════════
// This route used to load the first 500 registrations of the event — unordered —
// and filter them in-process. On a 2,395-person event the participant at document
// position ~2,100 was unreachable by name, email or phone. Not slow: invisible. The
// operator was shown "no results", which is indistinguishable from "no such person".
//
// The audit's finding was that the fix needed no new infrastructure: the indexes
// were already deployed and simply unused —
//     eventSlug + attendee.email · eventSlug + attendee.phone · eventSlug + ticketCode
//     organizerUid + eventSlug + identifier.value
// plus the identifier engine's deterministic lock documents, which are O(1) by id.
//
// Every path below is therefore an EQUALITY or an indexed PREFIX RANGE. Nothing
// scans, nothing is capped at a document position, and no result is filtered in the
// browser. The one index this did NOT already have is named in the name-search
// section below; it is declared in firestore.indexes.json and is NOT deployed.
//
// ═══ EVENT READINESS ═════════════════════════════════════════════════════════
// Ownership, publication and lifecycle come from ONE resolver
// (lib/checkin/readiness.ts) shared with every other check-in surface, so the
// landing page's "Open Check-in" and this route can no longer disagree.
//
// Security, unchanged in shape and stricter in effect:
//   1. authorizeEvent — token, workspace, `checkin` permission, and (for gate-only
//      roles) that this operator is assigned to THIS event, from the ROUTE PATH.
//   2. Every query is scoped to the event's own slug, and every row is additionally
//      checked against the workspace uid before it is returned.
//   3. A ticket code, identifier or registration id belonging to another event —
//      even the same organizer's — returns the same empty answer as a nonexistent
//      one, so nothing here can be used to probe for existence elsewhere.

import { NextRequest, NextResponse } from 'next/server'
import type { Query }                from 'firebase-admin/firestore'
import { adminDb }        from '@/lib/firebase/admin'
import { authorizeEvent } from '@/lib/team/workspace'
import { resolveCheckinReadiness, CHECKIN_BLOCKED_COPY } from '@/lib/checkin/readiness'
import { resolveIdentifierConfig }   from '@/lib/identifiers/config'
import { lookupIdentifier }          from '@/lib/identifiers/engine'
import {
  planLookup, lookupNotice, MAX_NAME_RESULTS,
  type LookupPlan, type LookupStrategy,
} from '@/lib/checkin/lookup'
import { SEARCH_MIN_CHARS, SEARCH_MAX_CHARS } from '@/lib/registrations/search'
import type { RegistrationDocument } from '@/lib/registrations/types'

// ─── Response types ───────────────────────────────────────────────────────────

export interface AttendeeSearchResult {
  id:            string
  ticketCode:    string
  attendeeName:  string
  attendeeEmail: string
  attendeePhone: string | undefined
  passName:      string
  status:        string
  checkedIn:     boolean
  checkedInAt:   string | null
  /**
   * RD-CHECKIN-2.0 — the issued identifier, on EVERY row.
   *
   * A result list that shows a bib number lets an operator disambiguate two people
   * with the same name without opening either record. It is read from the
   * registration document already loaded, so it costs no additional query — the
   * alternative (fetching each row's identifier) would be the N+1 this design
   * exists to avoid.
   */
  identifierValue?: string | null
  /** Present only on a single resolved attendee — never on a list. See `detail`. */
  paymentStatus?: string
  /**
   * The attendee's own registration answers, LABELLED.
   *
   * Attached ONLY when the query resolved to exactly ONE person by an exact
   * lookup. A name search returns a list, and attaching form answers there would
   * hand a gate operator the gender, date of birth and blood group of everyone
   * whose name starts with "S" — bulk participant data, which is precisely what
   * this role must not receive.
   */
  detail?: AttendeeDetail
}

/** One labelled answer from the attendee's registration form. */
export interface AttendeeFormAnswer {
  fieldId: string
  label:   string
  value:   string
}

/** Everything the confirmation view shows beyond the row fields above. */
export interface AttendeeDetail {
  eventName: string
  /** The event's configured identifier label + the attendee's value, when assigned. */
  identifierLabel: string | null
  identifierValue: string | null
  /**
   * RD-CHECKIN-2.0 — the timing chip, present ONLY when the event has timing
   * enabled. Absent (not null, not 'â€"') on every other event, so a non-timing
   * gate cannot render timing vocabulary it was never given.
   */
  timingLabel?: string
  timingValue?: string | null
  /** Registration-form answers, labelled and ordered. Empty when the form had none. */
  answers: AttendeeFormAnswer[]
}

export interface AttendeeSearchResponse {
  results:    AttendeeSearchResult[]
  /** True when more people match than were returned. Never means "unsearched". */
  truncated:  boolean
  /** 'exact' = a deterministic single-person lookup; 'scan' = the bounded name list. */
  searchMode: 'exact' | 'scan'
  /** Which resolution actually ran. Additive; existing callers ignore it. */
  strategy:   LookupStrategy
  /**
   * An honest sentence about what this search could NOT see, or null. Set for the
   * prefix-based name search and for a phone miss. NEVER set for an exact lookup,
   * which either finds the person or proves the value is not in this event.
   */
  notice:     string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISO(ts: unknown): string | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function identifierOf(reg: RegistrationDocument): string | null {
  const v = (reg as { identifier?: { value?: unknown } }).identifier?.value
  return typeof v === 'string' && v ? v : null
}

/**
 * Renders the attendee's form answers with their real labels.
 *
 * The registration form stores answers keyed by opaque field id
 * (`f_hvcpas0a: "Male"`), so the labels come from the event's own form definition —
 * which the caller already holds, because ownership was proved by reading that same
 * draft. No extra read, and no field name is invented: an id with no matching
 * definition is DROPPED rather than shown raw. Iterating the FORM (not the answers)
 * is what makes the order the organizer's.
 */
function labelledAnswers(draft: Record<string, unknown>, reg: RegistrationDocument): AttendeeFormAnswer[] {
  const form   = draft.registrationForm as Record<string, unknown> | undefined
  const fields = Array.isArray(form?.fields) ? form.fields as Array<Record<string, unknown>> : []
  const responses = reg.attendee?.formResponses ?? {}

  const out: AttendeeFormAnswer[] = []
  for (const f of fields) {
    const fieldId = typeof f.id === 'string' ? f.id : ''
    const label   = typeof f.label === 'string' ? f.label : ''
    if (!fieldId || !label) continue

    const raw = (responses as Record<string, unknown>)[fieldId]
    if (raw === undefined || raw === null || raw === '') continue

    let value: string
    if (Array.isArray(raw))            value = raw.filter(v => v !== null && v !== undefined).join(', ')
    else if (typeof raw === 'object')  continue
    else                               value = String(raw)

    if (value) out.push({ fieldId, label, value })
  }
  return out
}

function toResult(id: string, reg: RegistrationDocument): AttendeeSearchResult {
  return {
    id,
    ticketCode:    reg.ticketCode,
    attendeeName:  reg.attendee.name,
    attendeeEmail: reg.attendee.email,
    attendeePhone: reg.attendee.phone,
    passName:      reg.passName,
    status:        reg.status,
    checkedIn:     reg.checkedIn,
    checkedInAt:   toISO(reg.checkedInAt),
    identifierValue: identifierOf(reg),
  }
}

function sortResults(results: AttendeeSearchResult[]): void {
  // Not-yet-checked-in first, then alphabetical — the most useful order at a gate.
  results.sort((a, b) => {
    if (a.checkedIn !== b.checkedIn) return a.checkedIn ? 1 : -1
    return a.attendeeName.localeCompare(b.attendeeName)
  })
}

/**
 * The upper sentinel for a Firestore prefix range.
 *
 * U+F8FF is in the Private Use Area and sorts above every character that appears in
 * a human name, so `[p, p + PREFIX_HIGH]` is exactly the set of values beginning
 * with `p` — no scan, no client-side filter.
 */
const PREFIX_HIGH = '\uf8ff'

/** A Firestore "this query needs an index that is not deployed" failure. */
function isMissingIndex(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown }
  return e?.code === 9 || (typeof e?.message === 'string' && /requires an index/i.test(e.message))
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<AttendeeSearchResponse | { error: string }>> {

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  // eventId is read from the ROUTE PATH first so authorizeEvent can confirm a
  // gate-only operator is assigned to THIS event before any attendee data is
  // queried — lookup for an unassigned event returns 403, not results.
  const { eventId } = await context.params

  const authz = await authorizeEvent(req, 'checkin', eventId)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // ── 2. Event readiness — the ONE resolver ──────────────────────────────────
  const ready = await resolveCheckinReadiness(uid, eventId)
  if (!ready.ok) {
    return NextResponse.json(
      { error: CHECKIN_BLOCKED_COPY[ready.reason] },
      { status: ready.reason === 'not_found' ? 404 : 403 },
    )
  }
  const slug = ready.eventSlug

  // ── 3. Parse + validate query ──────────────────────────────────────────────
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (q.length < 2) {
    return NextResponse.json({ results: [], truncated: false, searchMode: 'scan', strategy: 'name', notice: null })
  }
  if (q.length > SEARCH_MAX_CHARS) {
    return NextResponse.json({ error: 'Query too long' }, { status: 400 })
  }
  void SEARCH_MIN_CHARS   // the literal above and the shared constant are pinned together by tests

  // ── 4. Plan ────────────────────────────────────────────────────────────────
  // One config read decides two things: whether an identifier probe is worth a
  // round-trip, and how identifier values are cased for the lock lookup.
  const { config: idConfig } = await resolveIdentifierConfig(slug)
  const plan: LookupPlan = planLookup(q, { identifiersEnabled: idConfig.enabled })

  const base = adminDb.collection('registrations') as Query

  /** Rows this workspace and event actually own. Applied to every path. */
  const own = (id: string, reg: RegistrationDocument | undefined): AttendeeSearchResult | null => {
    if (!reg) return null
    if (reg.organizerUid !== uid) return null
    if (reg.eventSlug !== slug)   return null
    return toResult(id, reg)
  }

  let rows: AttendeeSearchResult[] = []
  let indexMissing = false
  /**
   * Which probe actually produced the rows — NOT which one the plan led with.
   *
   * The distinction matters: a free-text query plans an identifier probe first and
   * a name probe second, so keying the response (and the decision to attach full
   * registration detail) off `plan.strategy` would label a NAME result as an exact
   * identifier hit and hand over that person's form answers.
   */
  let resolvedBy: LookupStrategy | null = null

  for (const probe of plan.probes) {
    // ── Ticket code — globally unique, one read ──────────────────────────────
    if (probe.kind === 'ticket') {
      const snap = await base.where('ticketCode', '==', probe.value).limit(1).get()
      const doc  = snap.docs[0]
      const row  = doc ? own(doc.id, doc.data() as RegistrationDocument) : null
      if (row) rows = [row]
    }

    // ── Email — exact, safe: every write path stores trim+lowercase ──────────
    else if (probe.kind === 'email') {
      const snap = await base
        .where('eventSlug', '==', slug)
        .where('attendee.email', '==', probe.value)
        .limit(MAX_NAME_RESULTS)
        .get()
      rows = snap.docs.map(d => own(d.id, d.data() as RegistrationDocument)).filter((r): r is AttendeeSearchResult => r !== null)
    }

    // ── Mobile — a bounded set of stored forms, each an indexed equality ─────
    // Parallel because they are independent and small; the cost is round-trips,
    // never documents scanned. See phoneCandidates for why a candidate set rather
    // than one canonical form (the stored value is only `.trim()`ed, and
    // canonicalising it retroactively would be a data migration).
    else if (probe.kind === 'phone') {
      const snaps = await Promise.all(probe.candidates.map(c =>
        base.where('eventSlug', '==', slug).where('attendee.phone', '==', c).limit(10).get(),
      ))
      const seen = new Set<string>()
      for (const snap of snaps) {
        for (const d of snap.docs) {
          if (seen.has(d.id)) continue
          const row = own(d.id, d.data() as RegistrationDocument)
          if (row) { seen.add(d.id); rows.push(row) }
        }
      }
    }

    // ── Identifier — the EXISTING engine, never a second lookup system ───────
    // `lookupIdentifier` reads one deterministic lock document
    // (`identifierLocks/{slug}__{value}`) and returns the registration it belongs
    // to. O(1) by document id, scoped to this event by the key itself.
    else if (probe.kind === 'identifier') {
      const hit = await lookupIdentifier(slug, probe.value, idConfig.format.caseMode ?? 'preserve')
      if (hit.exists && hit.registrationId) {
        const doc = await adminDb.collection('registrations').doc(hit.registrationId).get()
        const row = doc.exists ? own(doc.id, doc.data() as RegistrationDocument) : null
        if (row) rows = [row]
      }
    }

    // ── Registration id — one document read, then the same ownership check ───
    else if (probe.kind === 'registrationId') {
      const doc = await adminDb.collection('registrations').doc(probe.value).get()
      const row = doc.exists ? own(doc.id, doc.data() as RegistrationDocument) : null
      if (row) rows = [row]
    }

    // ── Name — an indexed PREFIX RANGE, not a scan ───────────────────────────
    //
    // Firestore cannot do substring or fuzzy matching, and this codebase has no
    // folded name field to build one on. Rather than pretend otherwise, this is a
    // prefix range over `attendee.name`, probed in the casings real registration
    // data is written in, and the operator is TOLD it matches from the start of the
    // name (see lookupNotice). Position in the collection is irrelevant: the
    // attendee at document 2,100 is found in the same number of reads as the one
    // at document 3.
    //
    // ═══ THE ONE INDEX THIS PHASE ADDS ═══════════════════════════════════════
    //     registrations: eventSlug ASC, attendee.name ASC
    // Declared in firestore.indexes.json and NOT DEPLOYED. Until it is, this branch
    // fails with FAILED_PRECONDITION, which is caught and reported honestly below —
    // it must never silently degrade back into a bounded scan, because a scan that
    // looks like it works is the exact defect this route was rewritten to remove.
    else if (probe.kind === 'name') {
      const seen = new Set<string>()
      try {
        const snaps = await Promise.all(probe.prefixes.map(p =>
          base
            .where('eventSlug', '==', slug)
            .orderBy('attendee.name')
            .startAt(p)
            // U+F8FF sorts above every ordinary character, so [p, p+U+F8FF] is
            // exactly the set of names beginning with p.
            .endAt(p + PREFIX_HIGH)
            .limit(MAX_NAME_RESULTS + 1)
            .get(),
        ))
        for (const snap of snaps) {
          for (const d of snap.docs) {
            if (seen.has(d.id)) continue
            const row = own(d.id, d.data() as RegistrationDocument)
            if (row) { seen.add(d.id); rows.push(row) }
          }
        }
      } catch (err) {
        if (!isMissingIndex(err)) throw err
        indexMissing = true
      }
    }

    // `resolvedBy` is set from the probe that actually matched, so a name hit
    // reached through a free-text plan is reported — and treated — as a name hit.
    if (rows.length) { resolvedBy = probe.kind === 'registrationId' ? 'registrationId' : probe.kind; break }
  }

  if (indexMissing) {
    // Honest, and deliberately not a 200 with zero rows: "no results" would be a
    // lie about a person who is standing at the gate.
    return NextResponse.json(
      { error: 'Name search is not available yet on this deployment. Use ticket code, email, phone or bib number.' },
      { status: 503 },
    )
  }

  const truncated = rows.length > MAX_NAME_RESULTS
  const results   = truncated ? rows.slice(0, MAX_NAME_RESULTS) : rows
  sortResults(results)

  // ── 5. Detail — one resolved person only ───────────────────────────────────
  // Never on a list, and never on the name path, which is a browse.
  if (results.length === 1 && resolvedBy !== null && resolvedBy !== 'name') {
    const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
    const draft     = (draftSnap.data() ?? {}) as Record<string, unknown>
    const doc       = await adminDb.collection('registrations').doc(results[0].id).get()
    const reg       = doc.data() as RegistrationDocument | undefined
    if (reg) {
      const stored = (reg as { identifier?: { label?: unknown } }).identifier
      const tag    = (reg as { timingTag?: { tag?: unknown; state?: unknown } }).timingTag
      // Timing vocabulary appears ONLY when the event enabled tag mapping. Not when
      // a chip happens to exist, not when the field is present — the event's own
      // configuration is the only thing that makes this event a timed one.
      const timingOn = idConfig.tagMapping?.enabled === true
      results[0].paymentStatus = reg.paymentStatus
      results[0].detail = {
        eventName:       reg.eventName ?? ready.eventName,
        identifierLabel: typeof stored?.label === 'string' && stored.label ? stored.label : idConfig.label,
        identifierValue: identifierOf(reg),
        ...(timingOn ? {
          // Printed VERBATIM — a configured label is the organizer's words.
          timingLabel: idConfig.tagMapping!.label,
          timingValue: tag?.state === 'assigned' && typeof tag.tag === 'string' ? tag.tag : null,
        } : {}),
        answers: labelledAnswers(draft, reg),
      }
    }
  }

  return NextResponse.json({
    results,
    truncated,
    searchMode: (resolvedBy ?? plan.strategy) === 'name' ? 'scan' : 'exact',
    strategy:   resolvedBy ?? plan.strategy,
    notice:     lookupNotice(plan, results.length, resolvedBy ?? undefined),
  })
}
