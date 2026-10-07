// RD-CHECKIN-2.0 — how a gate query becomes Firestore queries. PURE.
//
// ═══ THE ARCHITECTURE THIS REPLACES ══════════════════════════════════════════
// The old lookup fetched the first 500 registrations of the event with no ordering
// and filtered them in the route's process. On the audit fixture — 2,395 people on
// one event — the attendee at document position ~2,100 could not be found by name,
// email or phone at all. Not slowly: never. The bound was invisible to the operator,
// and the failure was indistinguishable from "no such person".
//
// The audit's other finding is what makes the replacement cheap: EVERY index this
// needs was already deployed and simply unused —
//     eventSlug + attendee.email · eventSlug + attendee.phone · eventSlug + ticketCode
//     organizerUid + eventSlug + identifier.value
// The 500-document scan was never a Firestore limitation. It was a route ignoring
// the indexes sitting beside it.
//
// So every lookup below is an EQUALITY or a RANGE against an index. None is O(event
// size). The only bound left is the number of ROWS returned, which is a display
// decision, not a reachability one.
//
// ═══ WHY THIS FILE HAS NO I/O ════════════════════════════════════════════════
// Which queries to run is a rule; running them is plumbing. The rules are the part
// that must be provable without a Firestore, so they live here and the route
// executes what this returns. Same pure/IO split as lib/registrations/search.ts,
// whose classifier this deliberately reuses rather than growing a second one.

import {
  classifySearch, normalizeTicket, normalizeEmail, normalizePhone,
  SEARCH_MIN_CHARS, SEARCH_MAX_CHARS,
} from '@/lib/registrations/search'

export type LookupStrategy =
  | 'ticket'
  | 'email'
  | 'phone'
  | 'identifier'
  | 'registrationId'
  | 'name'

/** One indexed query the route should run. Every variant is exact or a prefix range. */
export type LookupProbe =
  | { kind: 'ticket';         value: string }
  | { kind: 'email';          value: string }
  | { kind: 'phone';          candidates: string[] }
  | { kind: 'identifier';     value: string }
  | { kind: 'registrationId'; value: string }
  | { kind: 'name';           prefixes: string[] }

export interface LookupPlan {
  /** What the operator appears to have typed. Drives the UI's explanation. */
  strategy: LookupStrategy
  /** Ordered: cheapest and most certain first. The route stops at the first hit. */
  probes:   LookupProbe[]
  /**
   * True when this plan can miss a real attendee for a reason the operator needs to
   * know about — today only the name path, which is a PREFIX search. Never set for
   * an exact lookup, because an exact lookup either finds the person or proves the
   * value does not exist in this event.
   */
  partial:  boolean
}

// ─── Bounds ──────────────────────────────────────────────────────────────────
//
// These cap the number of QUERIES, not the reachable portion of the event. Each
// query is independently index-served, so raising them costs round-trips and never
// changes who is findable.

export const MAX_PHONE_CANDIDATES = 10
export const MAX_NAME_PREFIXES    = 4
/** Rows returned for a name search. A gate operator picks from a list this long. */
export const MAX_NAME_RESULTS     = 25

export { SEARCH_MIN_CHARS, SEARCH_MAX_CHARS }

/**
 * Firestore document ids for registrations are auto-generated 20-character
 * alphanumerics. Recognising that shape lets an operator paste a registration id
 * and get a direct document read; anything else falls through to the other
 * strategies, so a name that happens to look id-shaped is never lost.
 */
const REGISTRATION_ID_RE = /^[A-Za-z0-9_-]{16,48}$/

/**
 * A value that could plausibly be an issued identifier — a bib, delegate number or
 * badge id. Short, no whitespace, at least one digit.
 *
 * Kept permissive because the LABEL and the format are the organizer's, not ours:
 * the identifier engine owns validity, and this only decides whether it is worth
 * one O(1) lock read before falling through to a name search.
 */
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,31}$/

/**
 * The stored forms of a phone number that this plan will probe.
 *
 * ═══ WHY A CANDIDATE SET AND NOT A CANONICAL FIELD ═══════════════════════════
 * `attendee.phone` is stored with `normalizePhone(phone) { return phone.trim() }`,
 * and the validator explicitly permits spaces, hyphens and parentheses. So the same
 * person can be stored as `9876543210`, `+919876543210` or `+91 98765 43210`, and a
 * single equality query on one canonical form would miss the other two.
 *
 * Writing a canonical field would fix that properly — and would require rewriting
 * every historical registration, which is a data migration. Per the phase rules
 * that is REPORTED, not performed. This closes as much of the gap as can be closed
 * without touching stored data: it probes the forms this product's own write paths
 * actually produce, each one an indexed equality, capped so the cost stays flat.
 *
 * What it still cannot match is a number stored with separators the operator does
 * not reproduce exactly. That limitation is surfaced to the operator rather than
 * hidden behind a scan that would appear to work and quietly stop at 500 documents.
 */
export function phoneCandidates(raw: string): string[] {
  const typed  = (raw ?? '').trim()
  const digits = normalizePhone(typed)
  if (!digits) return []

  const out: string[] = []
  const push = (v: string) => {
    if (v && !out.includes(v) && out.length < MAX_PHONE_CANDIDATES) out.push(v)
  }

  // Exactly what the operator typed, first: if they read it off the same screen it
  // was entered on, this is the one that hits.
  push(typed)
  push(digits)

  // India-first: a 10-digit subscriber number with the common country-code forms.
  const last10 = digits.length >= 10 ? digits.slice(-10) : ''
  if (last10) {
    push(last10)
    push(`+91${last10}`)
    push(`91${last10}`)
    push(`+91 ${last10}`)
    push(`+91-${last10}`)
    // The GROUPED form — `+91 98765 43210` — which is what a phone's own contacts
    // app produces and therefore what a great many attendees paste into the
    // registration form. Missing it was a real hole: the emulator fixture stored a
    // number in exactly this shape and the lookup could not find it.
    const grouped = `${last10.slice(0, 5)} ${last10.slice(5)}`
    push(`+91 ${grouped}`)
    push(grouped)
  }
  push(`+${digits}`)

  return out
}

/**
 * Case variants of a name prefix.
 *
 * Firestore range queries are byte-ordered and therefore case-SENSITIVE, and this
 * codebase has no folded name field to range over (see the note in
 * lib/registrations/search.ts). Rather than pretend otherwise, the plan probes the
 * casings real registration data is actually written in — as typed, Title Case,
 * lower, UPPER — which between them cover self-service forms, CSV imports and
 * gate-typed walk-ins.
 *
 * Bounded and de-duplicated: typing "Arun" yields two distinct probes, not four.
 */
export function namePrefixes(raw: string): string[] {
  const q = (raw ?? '').trim().replace(/\s+/g, ' ')
  if (!q) return []

  const title = q.replace(/(^|\s)(\S)/g, (_m, sp: string, ch: string) => sp + ch.toLocaleUpperCase())
  const seeds = [q, title, q.toLocaleLowerCase(), q.toLocaleUpperCase()]

  const out: string[] = []
  for (const s of seeds) {
    if (s && !out.includes(s) && out.length < MAX_NAME_PREFIXES) out.push(s)
  }
  return out
}

export interface PlanOptions {
  /** True when this event issues identifiers, so an identifier probe is worth a read. */
  identifiersEnabled: boolean
}

/**
 * Turn one typed query into the ordered set of indexed queries that resolve it.
 *
 * The ordering is the design: certainty first. A ticket code, an email address or an
 * identifier identifies exactly one person, so those are tried before a name — which
 * is a browse, returns a list, and must never auto-select.
 */
export function planLookup(raw: string, opts: PlanOptions): LookupPlan {
  const q = (raw ?? '').trim()
  const kind = classifySearch(q)

  if (kind === 'ticket') {
    return { strategy: 'ticket', partial: false, probes: [{ kind: 'ticket', value: normalizeTicket(q) }] }
  }

  if (kind === 'email') {
    // Safe as an EXACT match: every write path stores email trim+lower-cased —
    // the public submit route, the walk-in route and the CSV importer all do it.
    // Verified across all three before this was made the only email strategy.
    return { strategy: 'email', partial: false, probes: [{ kind: 'email', value: normalizeEmail(q) }] }
  }

  if (kind === 'phone') {
    const candidates = phoneCandidates(q)
    return {
      strategy: 'phone',
      // A phone lookup CAN miss (see phoneCandidates), so the operator is told.
      partial:  true,
      probes:   candidates.length ? [{ kind: 'phone', candidates }] : [],
    }
  }

  // Free text. It may still be an identifier or a registration id, both of which
  // resolve to exactly one person — so they are probed first, and a miss simply
  // falls through to the name search rather than reporting "not found".
  const probes: LookupProbe[] = []
  if (opts.identifiersEnabled && IDENTIFIER_RE.test(q)) {
    probes.push({ kind: 'identifier', value: q })
  }
  if (REGISTRATION_ID_RE.test(q) && !q.includes(' ')) {
    probes.push({ kind: 'registrationId', value: q })
  }

  const prefixes = namePrefixes(q)
  if (prefixes.length) probes.push({ kind: 'name', prefixes })

  return {
    strategy: probes.length && probes[0].kind !== 'name' ? 'identifier' : 'name',
    partial:  prefixes.length > 0,
    probes,
  }
}

/**
 * What the UI must tell the operator about the search they just ran.
 *
 * Returned even on success. A prefix search that found three people has still not
 * searched the way the operator assumes it did, and the moment they type a surname
 * and see nothing they need to already know why.
 */
export function lookupNotice(plan: LookupPlan, found: number, effective?: LookupStrategy): string | null {
  // The EFFECTIVE strategy, not the planned one: a free-text query plans an
  // identifier probe first and a name probe second, so a name hit reached that way
  // must still carry the prefix caveat.
  const strategy = effective ?? plan.strategy
  if (strategy === 'name') {
    return found === 0
      ? 'Name search matches from the start of the name. Try the first name, or search by ticket code, email or phone.'
      : 'Name search matches from the start of the name.'
  }
  if (strategy === 'phone' && found === 0) {
    return 'No exact match. Numbers are matched exactly as they were entered — try with or without the country code.'
  }
  return null
}
