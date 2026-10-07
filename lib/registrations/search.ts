// RD-EVENT-12 · Registration search, as pure functions.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// The organizer reported "attendee search is not working". It was two bugs wearing
// each other's clothes, and both lived in one line of the API route:
//
//     const looksLikeTicket = /^rd[-_ ]?[a-z0-9]/i.test(q) || /^[a-z0-9]{6,}$/i.test(q)
//
// The second alternative matches ANY single ASCII word of six characters or more. So
// "Bartholomew" and "Murugan" were classified as TICKET CODES, upper-cased, looked up
// against `ticketCode`, and returned empty — a real attendee, reported as "no results".
// A one-word name is the single most likely thing anyone types into an attendee search.
//
// Anything the heuristic did NOT catch — a Tamil name, two words, a short name — fell
// through to a path with no name predicate at all, so the client compensated by asking
// for `all=true` and filtering up to 2,000 documents in the browser. That worked, at the
// cost of two thousand document reads per search, and silently stopped working at all
// past the 2,000 ceiling: on a 20,000-person event the search simply could not see most
// people.
//
// So: a ticket code is now recognised by its ACTUAL shape, and a name is searched as a
// name — server-side, projected and bounded. Pure; no I/O, no Firestore.

/** How a query should be resolved. */
export type SearchKind = 'email' | 'ticket' | 'phone' | 'text'

/**
 * Ticket codes are `RD` followed by the generated body — `RD-ORTS-00071`, `RD-MEGA-000123`.
 *
 * Requiring the prefix is the whole fix: it is what distinguishes a code from a word.
 * The body may carry further separators (real codes have two hyphens), so they are
 * allowed THROUGHOUT rather than only after `RD` — an earlier attempt permitted just one
 * and classified every genuine ticket code as text, which the tests caught.
 *
 * A bare `RD` is not a code, and neither is `Rdx`: a body of at least three characters
 * is required. This still cannot be perfect — someone genuinely named "RD Sharma" exists
 * — which is exactly why a ticket lookup that finds nothing FALLS THROUGH to the text
 * search rather than reporting "no such person".
 */
const TICKET_RE = /^rd(?:[-_ ][a-z0-9][a-z0-9\-_ ]*|[a-z0-9]{3,})$/i

/**
 * Digits, with the punctuation people paste out of a contacts app — including the
 * leading parenthesis of `(900) 000-1012`, which an earlier pattern rejected.
 */
const PHONE_RE = /^[+(]?[\d(][\d\s()+-]{5,}$/

export function classifySearch(raw: string): SearchKind {
  const q = raw.trim()
  if (q.includes('@'))     return 'email'
  if (TICKET_RE.test(q))   return 'ticket'
  if (PHONE_RE.test(q))    return 'phone'
  return 'text'
}

/** The ticket code as stored: upper-case, no separators inside the query. */
export function normalizeTicket(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase()
}

/** Digits only — so `+91 90000 01234`, `9000001234` and `(900) 000-1234` agree. */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Case- and accent-insensitive comparison key.
 *
 * `toLocaleLowerCase` alone leaves "José" and "Jose" as different people to a search
 * box; NFD + combining-mark strip makes them the same, which is what someone typing a
 * name into a hurry actually means. Tamil and other non-Latin scripts have no case and
 * no combining marks to strip, so they pass through unchanged and still match exactly.
 */
export function foldForSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase()
    .trim()
}

/** The fields a free-text query is matched against, in the order a human would expect. */
export interface SearchableRow {
  name:       string
  email:      string
  phone?:     string | null
  ticketCode?: string | null
  /**
   * RD-EVENT-20 · the participant's ISSUED identifier — a bib number, delegate id,
   * badge number, whatever this event calls it.
   *
   * It was missing, and it is the single most-typed lookup at an event desk: someone
   * holds a printed number and asks who it belongs to. Typing it returned nothing at
   * all, because the query classified as free text and free text had no identifier
   * field to match. The route also tries an EXACT indexed lookup first (see
   * `registrations/route.ts`), so this substring pass is the fallback that catches a
   * case or spacing difference rather than the primary path.
   */
  identifier?: string | null
}

/**
 * Does this row match the query?
 *
 * Substring, not prefix: an organizer looking for "Subramanian" should find
 * "Lakshmi Venkatesan Subramanian" — searching by surname is the common case, and a
 * prefix match would silently fail it. Phone is compared digits-to-digits so the
 * stored `+919000001234` matches a typed `9000001234`.
 */
export function rowMatches(row: SearchableRow, query: string): boolean {
  const q = foldForSearch(query)
  if (!q) return false

  if (foldForSearch(row.name).includes(q))  return true
  if (foldForSearch(row.email).includes(q)) return true
  if (row.ticketCode && foldForSearch(row.ticketCode).includes(q)) return true
  // The identifier is matched WHOLE, not as a substring: "500" must not return
  // 5001, 5002 and 5003 when somebody meant participant 500. A name is browsed;
  // an identifier is looked up.
  if (row.identifier && foldForSearch(row.identifier) === q) return true

  const digits = normalizePhone(query)
  if (digits.length >= 4 && row.phone && normalizePhone(row.phone).includes(digits)) return true

  return false
}

/**
 * The server's minimum. One character matches most of an event and is not a search;
 * below this the caller should show the unfiltered list rather than pretend to filter.
 */
export const SEARCH_MIN_CHARS = 2

export function isSearchable(raw: string): boolean {
  return raw.trim().length >= SEARCH_MIN_CHARS
}

/** Longer than any real name or code; a guard against a pathological query. */
export const SEARCH_MAX_CHARS = 120

// ─── Result shape ─────────────────────────────────────────────────────────────

/**
 * What the caller must be told about a text search, beyond the rows.
 *
 * `scanned`/`scanLimit` exist so the UI can say "searched the 1,000 most recent" rather
 * than implying it searched everyone. Firestore has no substring index, and this
 * codebase has no normalized name field to build one on, so a free-text search is a
 * bounded scan — and the ONE thing it must never do is let that bound pass unmentioned.
 */
export interface TextSearchMeta {
  scanned:   number
  scanLimit: number
  truncated: boolean   // the scan hit its ceiling — there may be matches it never saw
  capped:    boolean    // more matches than the result cap
}

export function searchMeta(scanned: number, scanLimit: number, matched: number, resultCap: number): TextSearchMeta {
  return {
    scanned,
    scanLimit,
    truncated: scanned >= scanLimit,
    capped:    matched > resultCap,
  }
}
