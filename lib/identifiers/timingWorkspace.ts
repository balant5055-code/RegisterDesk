// RD-BIB-TIMING-03 — the Timing Chips operational workspace: pure logic.
//
// PURE. No I/O, no SDK, no React. Everything the workspace decides — which
// participants a filter shows, what a search matches, what state a row is in and
// what the pass breakdown says — is decided here, so it can be tested without a
// browser and cannot drift between the list, the counters and the empty states.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  THIS MODULE DECIDES NOTHING ABOUT WRITES.                                ║
// ║  Assignment, replacement and removal remain the timing engine's, and the   ║
// ║  BIB → chip dependency is enforced inside its transaction. Everything here  ║
// ║  is presentation: what the organizer is shown and offered.                  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Nothing here knows what a "bib" or a "chip" is. Both nouns are configuration
// (`config.label`, `tagMapping.label`) and are supplied by the caller.

/** One participant, as the workspace needs them. Mirrors the roster projection. */
export interface WorkspaceRow {
  id:        string
  name:      string
  email:     string
  mobile:    string
  passId:    string | null
  passName:  string
  /** The printed number, or null. */
  identifier: string | null
  /** The timing device, or null. */
  tag:       string | null
}

/**
 * A row's operational state. Exactly one applies, and the order below is the
 * order the dependency runs in.
 */
export type RowState =
  | 'blocked'   // no number, so no device is possible
  | 'needs_tag' // has the number, waiting for a device
  | 'ready'     // holds both

export function rowState(row: Pick<WorkspaceRow, 'identifier' | 'tag'>): RowState {
  if (!row.identifier) return 'blocked'
  return row.tag ? 'ready' : 'needs_tag'
}

/** The status filters, in the order they are offered. */
export type StatusFilter = 'all' | 'needs_tag' | 'has_tag' | 'no_identifier' | 'ready'

export const STATUS_FILTERS: readonly StatusFilter[] = [
  'all', 'needs_tag', 'has_tag', 'no_identifier', 'ready',
] as const

/**
 * The label for a status filter, in the event's OWN two nouns.
 *
 * `has_tag` and `ready` are deliberately different things: a participant can hold
 * a device, and "ready" additionally requires the number — which the dependency
 * guarantees, so today they coincide. They are kept apart because the guarantee
 * is the ENGINE's, not this module's, and a filter that silently means something
 * else the day that changes is worse than one that is explicit.
 */
export function statusFilterLabel(
  filter: StatusFilter, identifierLabel: string, tagLabel: string,
): string {
  switch (filter) {
    case 'all':           return 'All'
    case 'needs_tag':     return `Needs ${tagLabel}`
    case 'has_tag':       return `${tagLabel} assigned`
    case 'no_identifier': return `${identifierLabel} missing`
    case 'ready':         return 'Ready for timing'
  }
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Normalises a search term or a searchable value.
 *
 * Lower-cased, and every separator a person or a scanner might introduce is
 * removed: spaces, hyphens, brackets, dots. That makes "CHIP-10480" match
 * "chip 10480", and "+91 98765-43210" match "9876543210".
 */
export function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[\s\-()./+]/g, '')
}

/**
 * A mobile number reduced to its comparable digits.
 *
 * India-first: a leading country code or a trunk 0 is dropped so the last ten
 * digits compare equal however the number was typed. Nothing is validated here —
 * this is a search key, not a phone-number parser.
 */
export function mobileKey(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length > 10) return digits.slice(-10)
  return digits
}

/** Every string a row can be found by. */
function haystack(row: WorkspaceRow): string[] {
  return [
    normalizeSearch(row.name),
    normalizeSearch(row.email),
    normalizeSearch(row.mobile),
    mobileKey(row.mobile),
    normalizeSearch(row.identifier ?? ''),
    normalizeSearch(row.tag ?? ''),
  ].filter(Boolean)
}

/**
 * Whether a row matches a search term.
 *
 * Substring, not prefix: an organizer reading a chip off a bag often has only
 * the trailing digits, and a participant is as often looked up by surname.
 */
export function matchesSearch(row: WorkspaceRow, term: string): boolean {
  const q = normalizeSearch(term)
  if (!q) return true
  const mk = mobileKey(term)
  return haystack(row).some(h => h.includes(q)) || (mk.length >= 4 && mobileKey(row.mobile).includes(mk))
}

// ─── Classifying a search term ───────────────────────────────────────────────

/**
 * What an exact, index-free server lookup can resolve a term against.
 *
 * The workspace's local list covers a bounded working set; a term that could
 * identify somebody EXACTLY is also sent to the server, which resolves it through
 * the authoritative lock documents and equality queries. Nothing here guesses a
 * single answer — a term that could be two things (a five-digit number is a
 * plausible number AND a plausible partial) reports both, and the server tries
 * both. Two cheap document reads beat one confident wrong guess.
 */
export interface SearchPlan {
  /** The term, trimmed. Empty means "no server lookup". */
  term:       string
  /** Look the term up as a timing device. */
  asTag:      boolean
  /** Look the term up as a printed number. */
  asIdentifier: boolean
  /** Exact-match this mobile. Empty when the term cannot be one. */
  asMobile:   string
  /** Exact-match this email. Empty when the term is not one. */
  asEmail:    string
  /**
   * FALSE when the term can only be matched by scanning names, which Firestore
   * cannot do without a search index. The UI must say so rather than reporting
   * "not found" for somebody who exists.
   */
  exactlyResolvable: boolean
}

/**
 * The device-id spellings a lookup should TRY — never a replacement for the id.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE AUTHORITATIVE ID IS UNTOUCHED.                                       ║
 * ║  `normalizeTag` uppercases but PRESERVES separators, because the separator ║
 * ║  is part of the uniqueness key: `A-1` and `A 1` are two different chips,   ║
 * ║  and collapsing them would let one participant's device resolve to         ║
 * ║  another's. That rule is unchanged and is not weakened here.               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This is SEARCH ONLY. An organizer reading a chip off a bag types the separator
 * they see — or a space, or none. So a lookup tries each spelling as its own
 * exact document read and returns EVERY one that resolves. If two genuinely
 * different chips exist that differ only by separator, both are shown, with their
 * stored values, and the organizer picks — nothing is silently merged and no
 * ownership is inferred.
 */
export function tagLookupVariants(raw: string): string[] {
  const term = raw.trim()
  if (!term) return []
  const out = new Set<string>([term])
  // The separators people actually substitute for one another.
  const core = term.replace(/[\s\-_.]/g, '')
  if (core && core !== term) {
    out.add(core)
    // Re-insert each separator at the boundary between the letters and the digits,
    // which is where these ids conventionally break: "BIGCHIP20001" → "BIGCHIP-20001".
    const split = /^([A-Za-z]+)[\s\-_.]*([0-9].*)$/.exec(term.replace(/\s+/g, ' '))
    if (split) for (const sep of ['-', ' ', '_']) out.add(`${split[1]}${sep}${split[2]}`)
  } else {
    const split = /^([A-Za-z]+)([0-9].*)$/.exec(term)
    if (split) for (const sep of ['-', ' ', '_']) out.add(`${split[1]}${sep}${split[2]}`)
  }
  // A bounded set: at most the original, the bare form and three separators.
  return [...out].slice(0, 5)
}

export function planSearch(raw: string): SearchPlan {
  const term = raw.trim()
  const empty: SearchPlan = {
    term: '', asTag: false, asIdentifier: false, asMobile: '', asEmail: '',
    exactlyResolvable: false,
  }
  if (!term) return empty

  const isEmail = term.includes('@')
  const digits  = term.replace(/\D/g, '')
  // A mobile is only exact-matchable when the whole term is digits/separators and
  // there are enough of them to be a real number.
  const mobileish = /^[\d\s\-()+.]+$/.test(term) && digits.length >= 10
  // Anything that is not obviously an email can be a device id or a number: both
  // are looked up by a deterministic document id, so trying both costs two reads.
  const looksLikeCredential = !isEmail

  // A credential lookup is a deterministic document read, so trying one costs a
  // read and a miss simply falls through. It is therefore attempted generously —
  // "BIGCHIP 20001" is a device id spelled with a space, and refusing to look it
  // up because it contains a space would be the wrong kind of caution.
  //
  // `exactlyResolvable` is the CONSERVATIVE half, and it is a different question:
  // "if this finds nothing, have we actually searched the whole event?" A term
  // with two alphabetic words is a person's name, and a name can only be matched
  // by scanning — so the caller must not claim event-wide coverage for it.
  const words = term.split(/\s+/).filter(Boolean)
  const alphabeticWords = words.filter(w => /^[A-Za-z]+$/.test(w)).length
  const nameShaped = alphabeticWords >= 2

  return {
    term,
    asTag:        looksLikeCredential,
    asIdentifier: looksLikeCredential,
    asMobile:     mobileish ? mobileKey(term) : '',
    asEmail:      isEmail ? term.toLowerCase() : '',
    exactlyResolvable: isEmail || mobileish || (!nameShaped && /\d/.test(term)),
  }
}

// ─── Filtering ───────────────────────────────────────────────────────────────

export interface FilterInput {
  rows:   readonly WorkspaceRow[]
  /** null ⇒ every pass. */
  passId: string | null
  status: StatusFilter
  search: string
}

/**
 * The visible rows, for a pass filter, a status filter and a search TOGETHER.
 *
 * All three compose: "10 KM" + "Needs Timing Chip" means 10 KM participants who
 * hold a number and no device — not one or the other.
 */
export function filterRows(input: FilterInput): WorkspaceRow[] {
  const { rows, passId, status, search } = input
  return rows.filter(row => {
    if (passId !== null && row.passId !== passId) return false
    if (status !== 'all') {
      const state = rowState(row)
      if (status === 'needs_tag'     && state !== 'needs_tag') return false
      if (status === 'ready'         && state !== 'ready')     return false
      if (status === 'no_identifier' && state !== 'blocked')   return false
      // `has_tag` is about the device alone, independent of the state machine.
      if (status === 'has_tag'       && !row.tag)              return false
    }
    return matchesSearch(row, search)
  })
}

// ─── Counters ────────────────────────────────────────────────────────────────

export interface WorkspaceTotals {
  participants:   number
  withIdentifier: number
  needIdentifier: number
  withTag:        number
  needTag:        number
  ready:          number
}

/**
 * The six operational figures, over whatever set is passed in.
 *
 * `needTag` counts only participants who CAN receive one — holding a number and
 * not a device. Somebody with neither is counted in `needIdentifier`, never in
 * both, so the figures do not double-count a person.
 */
export function totals(rows: readonly WorkspaceRow[]): WorkspaceTotals {
  let withIdentifier = 0, withTag = 0, ready = 0
  for (const row of rows) {
    if (row.identifier) withIdentifier += 1
    if (row.tag) withTag += 1
    if (row.identifier && row.tag) ready += 1
  }
  return {
    participants:   rows.length,
    withIdentifier,
    needIdentifier: rows.length - withIdentifier,
    withTag,
    needTag:        withIdentifier - ready,
    ready,
  }
}

export interface PassBreakdownRow {
  passId:   string | null
  passName: string
  totals:   WorkspaceTotals
}

/**
 * Per-pass figures, in the event's own pass order.
 *
 * A pass with no participants in the set is omitted rather than shown as a row of
 * zeroes, and participants whose pass is not in the event's list are grouped last
 * under their stored pass name rather than dropped — a registration on a deleted
 * pass is exactly the thing an organizer needs to see before an event.
 */
export function passBreakdown(
  rows: readonly WorkspaceRow[], passes: readonly { id: string; name: string }[],
): PassBreakdownRow[] {
  const byPass = new Map<string | null, WorkspaceRow[]>()
  for (const row of rows) {
    const key = row.passId
    const list = byPass.get(key)
    if (list) list.push(row); else byPass.set(key, [row])
  }
  const out: PassBreakdownRow[] = []
  for (const pass of passes) {
    const list = byPass.get(pass.id)
    if (!list?.length) continue
    out.push({ passId: pass.id, passName: pass.name, totals: totals(list) })
    byPass.delete(pass.id)
  }
  // Whatever is left is on a pass the event no longer lists.
  for (const [passId, list] of byPass) {
    out.push({ passId, passName: list[0]?.passName || 'Other', totals: totals(list) })
  }
  return out
}

// ─── Empty states ────────────────────────────────────────────────────────────

/**
 * Why the list is empty, as a sentence.
 *
 * A blank panel is the least useful thing this screen can do, and the reason is
 * always knowable: nobody registered, the search matched nothing, or the filter
 * combination is genuinely empty — which for two of the filters is GOOD news and
 * should read that way.
 */
export function emptyStateMessage(input: {
  totalRows: number
  passId:    string | null
  passName:  string | null
  status:    StatusFilter
  search:    string
  identifierLabel: string
  tagLabel:  string
}): string {
  const { totalRows, passName, status, search, identifierLabel, tagLabel } = input
  if (totalRows === 0) return 'No confirmed participants yet.'
  if (search.trim()) return `No participant matches “${search.trim()}”.`
  const scope = passName ? ` on ${passName}` : ''
  switch (status) {
    case 'needs_tag':
      return `Every participant${scope} with ${identifierLabel} already has ${tagLabel}.`
    case 'no_identifier':
      return `Every participant${scope} has ${identifierLabel}.`
    case 'has_tag':
      return `No participant${scope} has ${tagLabel} yet.`
    case 'ready':
      return `No participant${scope} is ready for timing yet.`
    case 'all':
      return `No participants${scope}.`
  }
}
