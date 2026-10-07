// RD-EVENT-19F-B — Timing tags: the canonical domain.
//
// PURE. No I/O, no SDK, no React — so the assignment engine, the import job, the
// API and the screen all reason about a tag through ONE implementation.
//
// ═══ WHAT A TIMING TAG IS ════════════════════════════════════════════════════
// A physical device — an RFID chip, a transponder, an NFC badge inlay — carried by a
// participant so an EXTERNAL timing system can read them. It is a THIRD credential,
// distinct from the two that already exist:
//
//   QR ticket code  → admits somebody at the gate            (check-in)
//   identifier      → the number printed on their bib/badge  (RD-EVENT-19A…E)
//   timing tag      → what a timing mat or reader sees       (this file)
//
// They are deliberately not interchangeable. A tag never admits anybody, and
// check-in semantics are untouched by this module.
//
// ═══ EVENT-TYPE NEUTRALITY ═══════════════════════════════════════════════════
// Nothing here knows what a marathon is. The identifier's name and the tag's name
// are both configuration, so the same code serves a road race issuing bib chips, a
// conference issuing RFID delegate badges and an expo issuing exhibitor tags.
//
// ═══ THE TWO SUPPORTED MODELS ════════════════════════════════════════════════
//   'mapped'      — the tag is its own value, mapped to a participant.  (Model B)
//   'identifier'  — the tag IS the identifier; no mapping is kept.      (Model A)
// Model A is an EXPLICIT configuration choice. It is never inferred from the event
// type, because a provider's convention has nothing to do with what an event is.

import type { AccentTone } from '@/lib/dashboard/accents'
// RD-BIB-TIMING-01 · the indefinite article follows the CONFIGURED noun.
import { article } from './identifierWorkspace'

// ─── Configuration ──────────────────────────────────────────────────────────

export type TagMappingMode = 'mapped' | 'identifier'

/** `identifierConfigs/{eventSlug}.tagMapping` — absent ⇒ the feature is off. */
export interface TagMappingConfig {
  enabled: boolean
  mode:    TagMappingMode
  /** What this event calls the device. Configuration, never derived from event type. */
  label:   string
}

/**
 * The device noun an event gets before anybody configures one.
 *
 * RD-BIB-TIMING-03 · was 'Timing Tag'. "Tag" is the ENGINE's noun — it names the
 * lock collection and the mirror field — and it was reaching the organizer as a
 * tab label on every event that had not set its own. "Chip" is what the physical
 * device is called by the people who hand them out, and it is the word the
 * workspace is expected to show.
 *
 * It remains only a DEFAULT: every surface reads `tagMapping.label`, so an event
 * that calls them Bands or Transponders overrides this the moment it is set.
 */
export const DEFAULT_TAG_LABEL = 'Timing Chip'

export const DEFAULT_TAG_MAPPING: TagMappingConfig = {
  enabled: false, mode: 'mapped', label: DEFAULT_TAG_LABEL,
}

/**
 * Reads the stored configuration defensively. An event that predates this feature
 * has no `tagMapping` at all, which resolves to "off" — so nothing appears anywhere
 * until an organizer turns it on. No migration, no backfill.
 */
export function resolveTagMapping(raw: unknown): TagMappingConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TAG_MAPPING }
  const r = raw as Partial<TagMappingConfig>
  return {
    enabled: r.enabled === true,
    mode:    r.mode === 'identifier' ? 'identifier' : 'mapped',
    label:   typeof r.label === 'string' && r.label.trim() ? r.label.trim() : DEFAULT_TAG_LABEL,
  }
}

/**
 * In `identifier` mode there is nothing to map: the tag a reader sees IS the value
 * already printed. Mapping screens and imports are therefore inert, and the export
 * simply repeats the identifier in the tag column.
 */
export const requiresMapping = (cfg: TagMappingConfig): boolean =>
  cfg.enabled && cfg.mode === 'mapped'

// ─── The value ──────────────────────────────────────────────────────────────

/**
 * Vendor tag ids are longer and freer than identifiers — "TAG-A83F92",
 * "E2004704A1B2C3D4E5F60718" (a 24-char EPC), "0x1A2B3C". 64 would reject a real
 * 96-bit EPC written in hex, so the ceiling is set above every format we found
 * while staying far below anything that endangers a Firestore document id.
 */
export const MAX_TAG_LENGTH = 128

export type TagRejection = 'EMPTY' | 'TOO_LONG' | 'ILLEGAL_CHARACTER'

/**
 * Normalises a tag for COMPARISON and for the lock's document id.
 *
 * Trimmed, and upper-cased — unlike an identifier, whose case policy is
 * configurable. A tag is a machine-read device id: providers hand out `a83f92` and
 * `A83F92` for the same physical chip, and treating those as two chips would let
 * one device be issued to two people. Internal separators are preserved, because
 * "TAG-001" and "TAG001" may genuinely be different stock.
 *
 * The DISPLAY value keeps the organizer's own casing — only the key is folded.
 */
export function normalizeTag(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : ''
}

/** The exact text the organizer supplied, trimmed but not folded. */
export const displayTag = (raw: unknown): string =>
  typeof raw === 'string' ? raw.trim() : ''

export type TagCheck =
  | { ok: true;  tag: string; normalized: string }
  | { ok: false; reason: TagRejection }

/**
 * A tag must be usable as a document-id fragment and printable on a manifest.
 * Control characters and the Firestore path separator are refused outright rather
 * than silently stripped — a tag we rewrote is not the tag on the device.
 */
export function validateTag(raw: unknown): TagCheck {
  const tag = displayTag(raw)
  if (tag.length === 0) return { ok: false, reason: 'EMPTY' }
  if ([...tag].length > MAX_TAG_LENGTH) return { ok: false, reason: 'TOO_LONG' }
  // Control characters and the Firestore path separator. Checked by code point
  // rather than a regex literal so the source stays plain ASCII. A tag carrying
  // either could not round-trip through a document id, and stripping it would
  // mean the stored tag is not the one printed on the device.
  for (const ch of tag) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x20 || c === 0x7f || ch === String.fromCharCode(47)) {
      return { ok: false, reason: 'ILLEGAL_CHARACTER' }
    }
  }
  return { ok: true, tag, normalized: normalizeTag(tag) }
}

// ─── Documents ──────────────────────────────────────────────────────────────

/**
 * A tag's lifecycle. Deliberately three states, not six.
 *
 * There is no `returned` and no `retired`: RegisterDesk does not manage physical
 * chip stock, so a state it cannot observe would be a field nobody could keep true.
 */
export type TimingTagState = 'assigned' | 'replaced' | 'removed'

/**
 * identifierTagLocks/{eventSlug}__{normalizedTag} — the AUTHORITY.
 *
 * Same shape of guarantee as `identifierLocks`: a deterministic document id makes
 * "this tag, in this event" a uniqueness constraint the datastore enforces, rather
 * than a rule the application hopes it applied.
 *
 * Keyed PER EVENT on purpose. A physical chip is reusable stock — the same device
 * legitimately appears in next year's race — so global uniqueness would forbid the
 * ordinary operation. Within one event, an `assigned` tag belongs to exactly one
 * participant.
 */
export interface TimingTagLockDoc {
  eventSlug:      string
  /** As the organizer typed it, for display and export. */
  tag:            string
  /** Folded form; also the document-id fragment. */
  normalizedTag:  string
  state:          TimingTagState
  registrationId: string | null
  /**
   * The identifier the participant held WHEN THE TAG WAS ATTACHED.
   *
   * Recorded for provenance and for the start-list export, NOT as the owner: a tag
   * follows the PARTICIPANT, so changing somebody's identifier leaves their tag
   * attached and simply makes this field historical.
   */
  identifierValue: string | null
  passId:         string | null
  /** Set on the OLD lock when a replacement happens. Never overwritten. */
  replacedBy:     string | null
  reason:         string | null
  source:         'manual' | 'import'
  /** The import run that created this, when there was one. */
  jobId:          string | null
  assignedBy:     string
  assignedAt:     unknown
  updatedAt:      unknown
}

/** registrations/{id}.timingTag — a read convenience, never the authority. */
export interface RegistrationTimingTag {
  tag:           string
  normalizedTag: string
  state:         TimingTagState
  assignedAt:    unknown
  assignedBy:    string
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type TimingTagErrorCode =
  | 'TAG_MAPPING_DISABLED'
  | 'TAG_MODE_IS_IDENTIFIER'
  | 'INVALID_TAG'
  | 'TAG_OWNED_BY_OTHER'
  | 'REGISTRATION_NOT_FOUND'
  | 'REGISTRATION_TERMINAL'
  | 'REGISTRATION_HAS_NO_IDENTIFIER'
  | 'NO_TAG_TO_REMOVE'

export class TimingTagError extends Error {
  constructor(public readonly code: TimingTagErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'TimingTagError'
  }
}

// ─── Import row validation ──────────────────────────────────────────────────

/**
 * Why one row of an uploaded file cannot be committed. Every code is
 * machine-readable and every one has a sentence in TAG_ISSUE_COPY below — a row is
 * never dropped silently, and never shown a raw code.
 */
export type TagRowIssue =
  | 'IDENTIFIER_MISSING'        // no identifier cell
  | 'TAG_MISSING'               // no tag cell
  | 'TAG_INVALID'               // empty / too long / illegal character
  | 'UNKNOWN_IDENTIFIER'        // no participant in this event holds it
  | 'DUPLICATE_IDENTIFIER_IN_FILE'
  | 'DUPLICATE_TAG_IN_FILE'
  | 'TAG_TAKEN_IN_EVENT'        // already assigned to somebody else
  | 'ALREADY_MAPPED'            // this participant already has a DIFFERENT tag
  | 'UNCHANGED'                 // already mapped to exactly this tag → a no-op
  | 'REGISTRATION_TERMINAL'     // cancelled / rejected

export type TagRowVerdict = 'valid' | 'warning' | 'invalid'

export const TAG_ISSUE_SEVERITY: Readonly<Record<TagRowIssue, TagRowVerdict>> = {
  IDENTIFIER_MISSING:          'invalid',
  TAG_MISSING:                 'invalid',
  TAG_INVALID:                 'invalid',
  UNKNOWN_IDENTIFIER:          'invalid',
  DUPLICATE_IDENTIFIER_IN_FILE:'invalid',
  DUPLICATE_TAG_IN_FILE:       'invalid',
  TAG_TAKEN_IN_EVENT:          'invalid',
  REGISTRATION_TERMINAL:       'invalid',
  // Not errors: the organizer is told, and the run does something sensible.
  ALREADY_MAPPED:              'warning',   // becomes a replacement, on confirmation
  UNCHANGED:                   'warning',   // becomes a no-op
}

export const TAG_ISSUE_COPY: Readonly<Record<TagRowIssue, string>> = {
  IDENTIFIER_MISSING:           'This row has no identifier, so there is nobody to attach a tag to.',
  TAG_MISSING:                  'This row has no tag value.',
  TAG_INVALID:                  'This tag cannot be used — it is empty, too long, or contains a character that is not allowed.',
  UNKNOWN_IDENTIFIER:           'No participant in this event holds that identifier.',
  DUPLICATE_IDENTIFIER_IN_FILE: 'The same identifier appears more than once in this file.',
  DUPLICATE_TAG_IN_FILE:        'The same tag appears more than once in this file.',
  TAG_TAKEN_IN_EVENT:           'That tag is already attached to a different participant in this event.',
  ALREADY_MAPPED:               'This participant already has a different tag. Importing will replace it.',
  UNCHANGED:                    'This participant already has exactly this tag. Nothing will change.',
  REGISTRATION_TERMINAL:        'This registration is cancelled or rejected.',
}

/**
 * One row's verdict, as a sentence.
 *
 * RD-BIB-TIMING-03 · the review step is the screen an organizer reads most
 * carefully — it is where they decide whether to commit — and it was the last
 * place still saying "identifier" and "tag". Those are the engine's words, not
 * the event's. Pass the two configured labels and every sentence speaks the
 * organizer's vocabulary; omit them and the generic wording still stands, so
 * every existing caller keeps working unchanged.
 */
export const tagIssueCopy = (
  issue: TagRowIssue,
  labels?: { identifier?: string; tag?: string },
): string => {
  const base = TAG_ISSUE_COPY[issue] ?? 'This row cannot be imported.'
  if (!labels) return base
  const id  = labels.identifier?.trim()
  const tag = labels.tag?.trim()
  // Whole words only, so "identifiers" and a label containing the word survive.
  return base
    .replace(/\bidentifier\b/g, id ?? 'identifier')
    .replace(/\btag\b/g, tag ?? 'tag')
}

/** One parsed row, before it is judged. */
export interface TagImportRow {
  rowNumber:  number
  identifier: string
  tag:        string
}

export interface TagRowResult extends TagImportRow {
  verdict: TagRowVerdict
  issues:  TagRowIssue[]
  /** Resolved server-side; null when the identifier matched nobody. */
  registrationId: string | null
}

export interface TagImportReport {
  rows:    TagRowResult[]
  valid:   number
  warning: number
  invalid: number
  /** Rows that would actually change something (valid + replacements). */
  actionable: number
}

/** Known context for validating a file, gathered by the server with bounded reads. */
export interface TagValidationContext {
  /** normalized identifier → { registrationId, terminal, currentNormalizedTag } */
  byIdentifier: Map<string, { registrationId: string; terminal: boolean; currentTag: string | null }>
  /** normalized tag → registrationId currently holding it in this event. */
  takenTags:    Map<string, string>
}

/**
 * Judges every row against the file itself AND against the event, in one pass.
 *
 * PURE: the context is supplied. Nothing is dropped — an unusable row comes back
 * with its reasons attached so the preview can show it, which is the whole point of
 * a preview.
 */
export function validateTagRows(
  rows: TagImportRow[], ctx: TagValidationContext,
): TagImportReport {
  const identifierSeen = new Map<string, number>()
  const tagSeen = new Map<string, number>()
  for (const r of rows) {
    const id = normalizeTag(r.identifier)
    const tg = normalizeTag(r.tag)
    if (id) identifierSeen.set(id, (identifierSeen.get(id) ?? 0) + 1)
    if (tg) tagSeen.set(tg, (tagSeen.get(tg) ?? 0) + 1)
  }

  const results: TagRowResult[] = rows.map(row => {
    const issues: TagRowIssue[] = []
    const idKey = normalizeTag(row.identifier)
    const check = validateTag(row.tag)
    const tagKey = check.ok ? check.normalized : ''

    if (!idKey) issues.push('IDENTIFIER_MISSING')
    if (!displayTag(row.tag)) issues.push('TAG_MISSING')
    else if (!check.ok) issues.push('TAG_INVALID')

    if (idKey && (identifierSeen.get(idKey) ?? 0) > 1) issues.push('DUPLICATE_IDENTIFIER_IN_FILE')
    if (tagKey && (tagSeen.get(tagKey) ?? 0) > 1) issues.push('DUPLICATE_TAG_IN_FILE')

    const known = idKey ? ctx.byIdentifier.get(idKey) : undefined
    if (idKey && !known) issues.push('UNKNOWN_IDENTIFIER')
    if (known?.terminal) issues.push('REGISTRATION_TERMINAL')

    if (tagKey) {
      const holder = ctx.takenTags.get(tagKey)
      if (holder && known && holder !== known.registrationId) issues.push('TAG_TAKEN_IN_EVENT')
    }

    if (known && tagKey && !issues.includes('TAG_TAKEN_IN_EVENT')) {
      if (known.currentTag === tagKey) issues.push('UNCHANGED')
      else if (known.currentTag) issues.push('ALREADY_MAPPED')
    }

    const verdict: TagRowVerdict = issues.some(i => TAG_ISSUE_SEVERITY[i] === 'invalid')
      ? 'invalid'
      : issues.length > 0 ? 'warning' : 'valid'

    return { ...row, verdict, issues, registrationId: known?.registrationId ?? null }
  })

  return {
    rows: results,
    valid:   results.filter(r => r.verdict === 'valid').length,
    warning: results.filter(r => r.verdict === 'warning').length,
    invalid: results.filter(r => r.verdict === 'invalid').length,
    // An UNCHANGED row is committable but changes nothing, so it is not counted as
    // work the organizer is about to do.
    actionable: results.filter(r =>
      r.verdict !== 'invalid' && !r.issues.includes('UNCHANGED')).length,
  }
}

// ─── Column detection ───────────────────────────────────────────────────────

/**
 * Header synonyms for the two columns this import needs.
 *
 * Deliberately NOT reusing the race-operations alias table: that one maps `chipid`
 * onto the BIB column, because a results file historically used the two words for
 * the same thing. Here they are two different columns, and borrowing that table
 * would put every tag into the identifier column.
 */
export const TAG_HEADER_ALIASES = {
  identifier: [
    'bib', 'bibno', 'bibnumber', 'bibnum', 'identifier', 'identifierno',
    'participantno', 'participantnumber', 'delegateid', 'badgeno', 'badgenumber',
    'startnumber', 'startno', 'number', 'no',
  ],
  tag: [
    'tag', 'tagid', 'tagno', 'tagnumber', 'chip', 'chipid', 'chipno', 'chipnumber',
    'transponder', 'transponderid', 'rfid', 'rfidtag', 'epc', 'uid', 'deviceid',
    'timingtag', 'timingchip',
  ],
} as const

const normalizeHeader = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Best-guess column indexes. A convenience only — the organizer can always override,
 * and a guess is never committed without the preview.
 */
export function detectTagColumns(headers: readonly string[]): { identifier: number; tag: number } {
  const norm = headers.map(normalizeHeader)
  const find = (aliases: readonly string[]) => {
    for (const alias of aliases) {
      const i = norm.indexOf(normalizeHeader(alias))
      if (i >= 0) return i
    }
    return -1
  }
  // The tag column is resolved FIRST: several of its aliases ("number", "no") are
  // also identifier aliases, and a tag column claimed by the identifier would put
  // every device id in the wrong place.
  const tag = find(TAG_HEADER_ALIASES.tag)
  const identifier = (() => {
    for (const alias of TAG_HEADER_ALIASES.identifier) {
      const i = norm.indexOf(normalizeHeader(alias))
      if (i >= 0 && i !== tag) return i
    }
    return -1
  })()
  return { identifier, tag }
}

// ─── Readiness (screen model) ───────────────────────────────────────────────

export interface TagReadinessInput {
  /** Participants the roster rule counts. null ⇒ unknown. */
  eligible:  number | null
  /** Participants holding an identifier. null ⇒ unknown. */
  identified: number | null
  /** Active tag locks in this event. null ⇒ unknown. */
  mapped:    number | null
  config:    TagMappingConfig
  identifierLabel: string
}

export type TagReadinessState =
  | 'disabled'        // the capability is off for this event
  | 'identifier_mode' // the tag IS the identifier; nothing to map
  | 'unknown'         // a count could not be read
  | 'none'            // nothing mapped yet
  | 'partial'         // some mapped, some not
  | 'complete'        // everybody with an identifier has a tag
  | 'inconsistent'    // more tags than identified participants
  // RD-BIB-TIMING-01 · every device is attached, but participants remain who have
  // no identifier and therefore CANNOT receive one. Not 'complete': the provider
  // start list is still short of those people.
  | 'blocked_by_identifier'

export interface TagReadiness {
  state:       TagReadinessState
  label:       string
  explanation: string
  tone:        AccentTone
  /** Participants with an identifier but no tag. null when not derivable. */
  missing:     number | null
  /**
   * RD-BIB-TIMING-01 · participants who cannot receive a device AT ALL because
   * they hold no identifier yet. Exact when both counts are known, null otherwise —
   * both count the same population, so eligible − identified is a subtraction, not
   * a bound. This is the gap the readiness verdict used to ignore entirely.
   */
  blockedByIdentifier: number | null
}

// ─── The four-way split ─────────────────────────────────────────────────────

/**
 * RD-BIB-TIMING-03 · §10 · every participant of this event falls in exactly ONE
 * of three buckets, and the three sum to the total. This is the only place that
 * arithmetic is written down, so the Overview card, the section header and the
 * workflow strip cannot drift apart into three different answers.
 *
 *   ready            holds BOTH credentials                  = mapped
 *   needsTag         holds the number, not the device        = identified − mapped
 *   needsIdentifier  holds neither, and CANNOT hold a device = eligible − identified
 *   ─────────────────────────────────────────────────────────────────────────
 *   total            every confirmed participant             = eligible
 *
 * Each field is independently `number | null`: a figure whose inputs were not both
 * read stays unknown rather than becoming a zero. `consistent` states whether the
 * three buckets actually sum to the total — it is false, never silently patched,
 * when the stored counts disagree (more devices than numbers, say), because a
 * summary that quietly reconciles itself is how a wrong number gets printed.
 */
export interface CredentialReadiness {
  total:           number | null
  ready:           number | null
  needsTag:        number | null
  needsIdentifier: number | null
  /** True only when all four are known AND the three buckets sum to the total. */
  consistent:      boolean
}

const sub = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : Math.max(0, a - b)

export function resolveCredentialReadiness(
  input: { eligible: number | null; identified: number | null; mapped: number | null },
): CredentialReadiness {
  const { eligible, identified, mapped } = input
  const ready           = mapped
  const needsTag        = sub(identified, mapped)
  const needsIdentifier = sub(eligible, identified)
  const known = eligible !== null && ready !== null && needsTag !== null && needsIdentifier !== null
  return {
    total: eligible, ready, needsTag, needsIdentifier,
    consistent: known && ready! + needsTag! + needsIdentifier! === eligible!,
  }
}

/**
 * The readiness verdict.
 *
 * `missing` is a REAL subtraction here, unlike the unassigned-eligible figure the
 * identifier workspace refuses to state: both inputs count the same population —
 * participants of this event — and a tag lock names the registration it belongs to,
 * so `identified − mapped` is exact rather than a bound. It is null the moment
 * either input is unknown.
 */
export function resolveTagReadiness(input: TagReadinessInput): TagReadiness {
  const { config, eligible, identified, mapped } = input
  // RD-BIB-TIMING-02 · the device noun is printed EXACTLY as the organizer
  // configured it. It was lower-cased mid-sentence, so a single card could read
  // "Timing Chips assigned" beside "32 still need a timing chip" — two spellings
  // of one configured name, which reads like two different things.
  const noun = config.label
  const idNoun = input.identifierLabel

  // RD-BIB-TIMING-01 · the OTHER gap. `eligible` was already supplied by the route
  // and this function ignored it, so readiness measured only "of those who CAN get
  // a device, how many have one" — and could therefore report READY for an event
  // where people still had no identifier and so could never receive one at all.
  const blocked = eligible === null || identified === null
    ? null : Math.max(0, eligible - identified)
  const N = (v: number) => v.toLocaleString('en-IN')

  if (!config.enabled) {
    return {
      state: 'disabled', tone: 'neutral', missing: null, blockedByIdentifier: null,
      label: 'Not configured',
      explanation: `${config.label} mapping has not been configured for this event.`,
    }
  }
  if (config.mode === 'identifier') {
    return {
      state: 'identifier_mode', tone: 'verify', missing: null, blockedByIdentifier: null,
      label: 'Uses the identifier',
      explanation: `Each ${noun} is the participant's ${idNoun.toLowerCase()}, so there is nothing to map.`,
    }
  }
  if (identified === null || mapped === null) {
    return {
      state: 'unknown', tone: 'neutral', missing: null, blockedByIdentifier: blocked,
      label: 'Cannot verify',
      explanation: `${config.label} counts could not be read, so readiness is unknown.`,
    }
  }
  if (mapped > identified) {
    return {
      state: 'inconsistent', tone: 'critical', missing: null, blockedByIdentifier: blocked,
      explanation: `${N(mapped)} ${noun}s are mapped but only ${N(identified)} participants hold ${article(idNoun)} ${idNoun}.`,
      label: 'Needs attention',
    }
  }

  const missing = identified - mapped
  /** The sentence naming people who cannot be given a device at all, yet. */
  const blockedNote = blocked && blocked > 0
    ? ` ${N(blocked)} participant${blocked === 1 ? '' : 's'} cannot receive one yet — they have no ${idNoun}.`
    : ''

  if (identified === 0) {
    const stuck = !!blocked && blocked > 0
    return {
      state: stuck ? 'blocked_by_identifier' : 'none',
      tone: stuck ? 'pending' : 'neutral',
      missing: 0, blockedByIdentifier: blocked,
      label: stuck ? `${idNoun} required` : 'Nothing to map yet',
      explanation: `No participant has ${article(idNoun)} ${idNoun} yet, so there is nothing to attach a ${noun} to.`,
    }
  }
  if (mapped === 0) {
    return {
      state: 'none', tone: 'pending', missing, blockedByIdentifier: blocked,
      label: 'Not started',
      explanation: `None of the ${N(identified)} participants with ${article(idNoun)} ${idNoun} has a ${noun} yet.${blockedNote}`,
    }
  }
  if (missing === 0) {
    // Every device that CAN be attached is attached. Whether that is "ready" for
    // the provider depends on whether anybody is still without an identifier.
    if (blocked && blocked > 0) {
      return {
        state: 'blocked_by_identifier', tone: 'pending', missing: 0, blockedByIdentifier: blocked,
        label: `${idNoun} required`,
        explanation: `All ${N(identified)} participants with ${article(idNoun)} ${idNoun} have a ${noun}.${blockedNote}`,
      }
    }
    return {
      state: 'complete', tone: 'verify', missing: 0, blockedByIdentifier: blocked,
      label: 'Ready',
      explanation: `All ${N(identified)} participants with ${article(idNoun)} ${idNoun} have a ${noun}.`,
    }
  }
  return {
    state: 'partial', tone: 'pending', missing, blockedByIdentifier: blocked,
    explanation: `${N(mapped)} of ${N(identified)} participants have a ${noun}. ${N(missing)} still need one.${blockedNote}`,
    label: 'Partly mapped',
  }
}
