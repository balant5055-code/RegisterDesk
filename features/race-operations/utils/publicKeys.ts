// RD-RACEOPS-01 Sprint 4 · Public key normalisation.
//
// PURE. No SDK, no I/O. Every public URL segment and every searchable key is derived
// here, so the write path and the read path cannot disagree about what a key looks like.

/**
 * Normalised bib key — the ENTRY DOCUMENT ID, which is what makes a public bib lookup a
 * single document GET instead of a query.
 *
 * Upper-cased and stripped of separators, so `a-101`, `A 101` and `A101` all resolve to
 * one entry. Leading zeros are PRESERVED: `0042` and `42` are different bibs on the
 * course, and collapsing them would merge two runners.
 */
export function bibKey(bib: string): string {
  return bib.trim().toUpperCase().replace(/[\s\-_/]/g, '')
}

/**
 * RD-RESULTS-FIX-01 · The DOCUMENT id of one snapshot entry.
 *
 * ═══ WHY THE VERSION IS IN THE KEY ═══════════════════════════════════════════
 * Entries used to be keyed on the bib alone. The snapshot model documents versioning as
 * "rows from a superseded version become invisible WITHOUT a mass delete — which leaves the
 * old rows available for forensics", but with a bare bib key that was not what happened:
 * publishing version 2 wrote to the SAME document id and OVERWROTE version 1.
 *
 * So a superseded version was destroyed rather than retained, and rollback — restoring a
 * previous published version — was impossible, because there was nothing to roll back to.
 *
 * Including the version makes the stated behaviour true. Every public query is unaffected:
 *   • leaderboard   `where('v','==',V).orderBy('overallRank')`  — same index
 *   • name search   `where('v','==',V).orderBy('nameLower')`    — same index
 *   • bib lookup    a single GET on this id                     — still O(1)
 *
 * The bib is kept in the id rather than an auto-id precisely so the lookup stays a GET.
 */
export function entryKey(version: number, bib: string): string {
  return `v${Math.max(1, Math.trunc(version))}__${bibKey(bib)}`
}

/** True when a URL segment could be a bib at all — cheap guard before any read. */
export function isPlausibleBib(segment: string): boolean {
  const key = bibKey(segment)
  return key.length > 0 && key.length <= 32 && /^[A-Z0-9]+$/.test(key)
}

/**
 * URL slug for a race, derived from the pass name. Stored on the snapshot at publish time
 * so the public URL is stable even if the organizer later renames the pass.
 *
 * Falls back to the passId when the name has no usable characters, so a slug is never empty.
 */
export function passSlug(passName: string, passId: string): string {
  const slug = passName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || passId.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/**
 * Lower-cased name used for PREFIX search.
 *
 * Firestore has no substring search, so name lookup is a range query on this field
 * (`>= q` and `<= q + PREFIX_UPPER_BOUND`), which is index-backed and fast. That means it
 * matches names that START WITH the query — "pri" finds "Priya Sharma", but "sharma" does
 * not. The UI says so explicitly, so the behaviour is never a surprise.
 */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Upper bound for a Firestore prefix range query. U+F8FF sorts above every ordinary
 * character, so [q, q + PREFIX_UPPER_BOUND] brackets exactly the strings beginning with q. */
export const PREFIX_UPPER_BOUND = ""
