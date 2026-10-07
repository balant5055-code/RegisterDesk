// RD-EVENT-21 · A participant's OPERATIONAL IDENTITY, as pure functions.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// A participant carries three separate credentials, and the platform had no single
// place that said so:
//
//   ticketCode   the CHECK-IN credential — what the QR encodes, what the gate scans
//   identifier   the PRINTED number — bib, delegate id, badge, entry number
//   timingTag    the physical TIMING DEVICE — a chip strapped to a person or a shoe
//
// They are never interchangeable. A timing tag scanned at a gate admits nobody; an
// identifier typed into a scanner authenticates nothing. Merging them — or labelling
// all three "ID" — is the single most expensive mistake an operations screen can make,
// because it is only discovered on event morning.
//
// ═══ WHY THE PRECEDENCE RULE LIVES HERE ══════════════════════════════════════
// The identifier reaches a registration through TWO mirrors, both written by the
// engine in the same transaction as the authoritative lock:
//
//   identifier.value   canonical (RD-EVENT-19A)
//   bibNumber          the legacy mirror, kept so events that predate the engine —
//                      and every consumer still reading it — keep working
//
// Four surfaces need that precedence: the registration table, the participant drawer,
// the 360 workspace and the on-site directory. Four copies of `a ?? b` is three
// chances to disagree, so there is one copy, here, and it is tested.
//
// NOTHING in this file writes. The locks remain the authority; these are mirrors.

import type { RegistrationIdentifier } from '@/lib/identifiers/types'
import type { RegistrationTimingTag } from '@/lib/identifiers/timingTags'
// Both PURE — the browser gets no Admin SDK from either.
import { poolsForPass } from '@/lib/identifiers/eligibility'
import { effectiveRanges, describeRanges, isInRanges } from '@/lib/identifiers/ranges'

/**
 * The fields these rules read. Structural, so the raw Firestore document and the
 * serialized API row both satisfy it without casting.
 */
export interface RegistrationIdentitySubject {
  identifier?: RegistrationIdentifier | null
  bibNumber?:  string | null
  timingTag?:  RegistrationTimingTag | null
}

/**
 * The participant's issued identifier, or null when they hold none.
 *
 * Canonical first, legacy second. An empty string is treated as absent: a blank
 * mirror is not an identifier, and rendering one produces a cell that looks assigned
 * and reads as nothing.
 */
export function resolveIdentifierValue(reg: RegistrationIdentitySubject | null | undefined): string | null {
  const canonical = reg?.identifier?.value
  if (typeof canonical === 'string' && canonical.trim() !== '') return canonical
  const legacy = reg?.bibNumber
  if (typeof legacy === 'string' && legacy.trim() !== '') return legacy
  return null
}

/**
 * The label THIS registration's identifier was issued under — "Participant Number",
 * "Delegate Number", "Badge Number".
 *
 * Stamped onto the mirror at assignment time, so it survives a later config rename
 * and describes what is actually printed on the person's bib. Null when the
 * registration holds no identifier, or predates the label being recorded — the
 * caller then falls back to the event's configured label.
 */
export function resolveIdentifierLabel(reg: RegistrationIdentitySubject | null | undefined): string | null {
  const label = reg?.identifier?.label
  return typeof label === 'string' && label.trim() !== '' ? label : null
}

/**
 * The timing tag the participant is CURRENTLY carrying, or null.
 *
 * Only an `assigned` tag counts. A `replaced` or `removed` one is history — it may
 * physically be on someone else's wrist by now — and presenting it as current is how
 * a results file gets attributed to the wrong person. History belongs in the
 * timeline, which is where the drawer puts it.
 */
export function resolveTimingTag(reg: RegistrationIdentitySubject | null | undefined): string | null {
  const tag = reg?.timingTag
  if (!tag || tag.state !== 'assigned') return null
  return typeof tag.tag === 'string' && tag.tag.trim() !== '' ? tag.tag : null
}

/**
 * The optimistic patch to apply to a row after an identifier action succeeds.
 *
 * BOTH mirrors move together, because `resolveIdentifierValue` reads canonical first:
 * patching only `bibNumber` (as the drawer used to) left a released identifier still
 * showing its old value, since `identifier.value` was untouched and won the
 * precedence. The row would then contradict the panel that had just cleared it.
 *
 * On a fresh assignment there is no canonical object to build — the engine owns those
 * fields and the action response carries only the value — so `identifier` stays null
 * and the legacy mirror carries the new value until the next real load. That is
 * exactly what the precedence rule is for.
 */
export function identifierPatch(
  prev: RegistrationIdentitySubject | null | undefined,
  next: string | null,
): { bibNumber: string | null; identifier: RegistrationIdentifier | null } {
  if (next === null) return { bibNumber: null, identifier: null }
  const canonical = prev?.identifier
  return {
    bibNumber:  next,
    identifier: canonical ? { ...canonical, value: next } : null,
  }
}

// ─── Presentation vocabulary ─────────────────────────────────────────────────

/**
 * What an EMPTY identifier cell says, and it is not "0" and not blank.
 *
 * "Not assigned" is a statement about a SUCCESSFUL read: this event issues
 * identifiers, this person does not have one yet. It is not interchangeable with
 * `IDENTIFIER_UNKNOWN`, which is what a surface must say when it could not find out.
 */
export const IDENTIFIER_UNASSIGNED = 'Not assigned'

/** The read failed, or the event's identifier configuration could not be loaded. */
export const IDENTIFIER_UNKNOWN = 'Unknown'

/** The generic fallback label, used only when the event's own label is unavailable. */
export const IDENTIFIER_GENERIC_LABEL = 'Identifier'

/**
 * The generic fallback for the timing credential.
 *
 * RD-BIB-TIMING-03 · was 'Timing Tag'. "Tag" is the engine's noun; the organizer
 * surfaces that consume this (check-in operations, the registrations table) show
 * it to a person, so it reads as the device is actually called. Used ONLY when
 * the event's own configured label could not be read.
 */
export const TIMING_TAG_GENERIC_LABEL = 'Timing Chip'

/**
 * The event's identity vocabulary and capabilities, as the UI needs them.
 *
 * `null` is a THIRD state, distinct from enabled and disabled: the configuration
 * could not be read. A surface holding null must not tell an organizer that nobody
 * has an identifier — it does not know that — so it falls back to what the rows
 * themselves carry.
 */
export interface EventIdentity {
  identifierEnabled: boolean
  identifierLabel:   string
  tagsEnabled:       boolean
  tagLabel:          string
  /**
   * RD-BIB-01 · the event's configured number ranges, so a manual entry can show
   * which numbers this participant's pass is allowed BEFORE it is submitted.
   *
   * The server remains authoritative — the engine refuses an out-of-range value in
   * the same transaction as the lock — this only means the organizer finds out while
   * typing rather than after pressing a button.
   */
  pools?: import('@/lib/identifiers/types').IdentifierPool[]
}

/**
 * RD-BIB-01 · the numbers a given pass may be issued, as text, or null when the
 * event places no limit on them.
 *
 * Reuses the SAME two pure functions the server uses — `poolsForPass` decides which
 * ranges apply to the pass, `describeRanges` writes them — so the hint beside the
 * input and the refusal from the engine can never describe different numbers.
 */
export function allowedNumbersForPass(
  identity: EventIdentity | null,
  passId:   string | null | undefined,
): { text: string | null; ranges: import('@/lib/identifiers/types').IdentifierRange[] } {
  if (!identity?.pools?.length) return { text: null, ranges: [] }
  const pools = poolsForPass(identity.pools, passId ?? null)
  const ranges = pools.flatMap(p => effectiveRanges(p))
  return { text: ranges.length > 0 ? describeRanges(ranges) : null, ranges }
}

/** Is this value inside what the pass allows? `null` ⇒ unknown, never a refusal. */
export function isAllowedNumber(
  ranges: import('@/lib/identifiers/types').IdentifierRange[],
  raw:    string,
): boolean | null {
  if (ranges.length === 0) return null
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  return isInRanges(ranges, n)
}

/**
 * How an identifier column should behave for this event.
 *
 *   'configured'  the event issues identifiers → always show the column; an empty
 *                 cell reads "Not assigned", which is a fact.
 *   'observed'    the configuration is unknown, but rows carry values → show the
 *                 column for the values that exist; an empty cell reads "—", because
 *                 whether that person SHOULD have one is genuinely unknown.
 *   'hidden'      the event issues none, or none is known and none is present.
 */
export type IdentifierColumnMode = 'configured' | 'observed' | 'hidden'

export function identifierColumnMode(
  identity: EventIdentity | null,
  rows: readonly RegistrationIdentitySubject[],
): IdentifierColumnMode {
  if (identity) return identity.identifierEnabled ? 'configured' : 'hidden'
  return rows.some(r => resolveIdentifierValue(r) !== null) ? 'observed' : 'hidden'
}

/**
 * The column heading: the event's configured label, else the label the rows were
 * issued under, else the generic word. Never "Bib" unless the organizer chose it.
 */
export function identifierColumnLabel(
  identity: EventIdentity | null,
  rows: readonly RegistrationIdentitySubject[],
): string {
  if (identity?.identifierLabel) return identity.identifierLabel
  for (const r of rows) {
    const label = resolveIdentifierLabel(r)
    if (label) return label
  }
  return IDENTIFIER_GENERIC_LABEL
}

/** What an empty identifier cell says, given what the surface actually knows. */
export function emptyIdentifierText(mode: IdentifierColumnMode): string {
  return mode === 'configured' ? IDENTIFIER_UNASSIGNED : IDENTIFIER_UNKNOWN
}

/**
 * Should the timing-tag column exist?
 *
 * Only for events that map tags. It is deliberately NOT inferred from the rows: a
 * column that materialises the moment one person is given a tag would appear and
 * disappear as the operator works, and most event types never issue tags at all.
 */
export function showTimingTagColumn(identity: EventIdentity | null): boolean {
  return identity?.tagsEnabled === true
}
