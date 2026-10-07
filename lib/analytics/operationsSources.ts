// RD-ANALYTICS-10 · the operational capability signals and their bounded counters.
//
// ═══ WHY A SEPARATE MODULE ═══════════════════════════════════════════════════
// Operations is the first part of Analytics whose CONTENT depends on per-event
// configuration rather than on a permission or a workspace flag. That resolution has its
// own failure modes and its own cost profile, so it lives beside the producer rather than
// inside it — and it can be tested without standing up the whole analytics payload.
//
// ═══ THE RULE THIS MODULE EXISTS TO ENFORCE ══════════════════════════════════
// A capability is read from the event's own configuration. It is NEVER inferred from
// `eventType`. Timing chips are not a sports feature: they are a switch any event may turn
// on, and a sports event whose organizer never turned it on does not have them. The
// analytics panel table used to say `eventTypes: ['sports']`, which was wrong in both
// directions at once.
//
// ═══ AND THE COST RULE ═══════════════════════════════════════════════════════
// One configuration document, then `count()` aggregates only. Every aggregate here is
// bounded by the event's CONFIGURATION (how many pools it defined, how many tag states
// exist) and never by how many people registered — so a 100,000-participant event costs
// what a 100-participant one costs, which is the property RD-ANALYTICS-03 established and
// every phase since has had to preserve.

import { adminDb } from '@/lib/firebase/admin'
import { resolveIdentifierConfig } from '@/lib/identifiers/config'
import { resolveTagMapping } from '@/lib/identifiers/timingTags'
import { TIMING_TAG_LOCKS } from '@/lib/identifiers/timingTagEngine'

/**
 * What an event is configured to do operationally.
 *
 * Both flags default to FALSE and both labels to null, so a failed or missing read makes a
 * panel absent rather than making it appear empty. That is the same fail-closed direction
 * the rest of the capability model takes.
 */
export interface OperationalCapabilities {
  identifiersEnabled: boolean
  /** What THIS event calls its identifiers — "Bib", "Badge", "Token". Never hardcoded. */
  identifierLabel:    string | null
  timingEnabled:      boolean
  /** What THIS event calls its timing device. Defaults to "Timing Chip" when unset. */
  timingLabel:        string | null
}

export const NO_OPERATIONAL_CAPABILITIES: OperationalCapabilities = {
  identifiersEnabled: false, identifierLabel: null,
  timingEnabled: false, timingLabel: null,
}

/**
 * Resolve both capabilities from the ONE document that owns them.
 *
 * `resolveIdentifierConfig` merges a stored document over the defaults, and `isStored` is
 * what separates "this event configured identifiers" from "this event has never been
 * touched and is looking at a default object". Without that check every event in the
 * product would report the default config's `enabled` value as its own.
 *
 * Never throws: a failed read yields no capabilities, so Operations shows its universal
 * half and omits the conditional panels rather than failing the whole request.
 */
export async function resolveOperationalCapabilities(
  eventSlug: string,
): Promise<OperationalCapabilities> {
  try {
    const { config, isStored } = await resolveIdentifierConfig(eventSlug)
    if (!isStored) return NO_OPERATIONAL_CAPABILITIES

    const tag = resolveTagMapping(config.tagMapping)
    return {
      identifiersEnabled: config.enabled === true,
      identifierLabel:    typeof config.label === 'string' && config.label ? config.label : null,
      // Independent of `enabled`: an event may run chips against pre-printed numbers it
      // did not issue, and one that issues numbers need not use chips at all.
      timingEnabled:      tag.enabled === true,
      timingLabel:        tag.label || null,
    }
  } catch {
    return NO_OPERATIONAL_CAPABILITIES
  }
}

/** A count that may not have been measured. Never zero for "we could not read it". */
type Count = number | null

const countOf = (q: FirebaseFirestore.Query): Promise<Count> =>
  q.count().get().then(s => s.data().count).catch(() => null)

/**
 * How far identifier assignment has got.
 *
 * ═══ WHY THE REGISTRATION SIDE, NOT THE LOCK SIDE ════════════════════════════
 * `assigned` could be counted from `identifierLocks`, and RD-BIB-01 explains why that is
 * the wrong denominator to pair it with: a lock carries no registration status, so a lock
 * held by a cancelled entrant would be subtracted from a roster that never contained them.
 * Both figures here come from the SAME population — this organizer, this event, status
 * confirmed — so the subtraction never crosses collections.
 *
 * THREE states, not two. `hasIdentifier` true and false do not necessarily sum to the
 * roster: a registration created before the field existed carries neither. That residue is
 * reported as `unrecorded` rather than folded into "without", because folding it would
 * claim those people are waiting for a number when nobody knows.
 *
 * Three equality-only aggregates, served by merged single-field indexes — no composite to
 * deploy, and zero documents transferred.
 */
export interface IdentifierProgress {
  eligible:   Count
  withIdentifier:    Count
  withoutIdentifier: Count
  /** Confirmed registrations that predate the `hasIdentifier` field. Null ⇒ uncomputable. */
  unrecorded: Count
}

export async function readIdentifierProgress(
  organizerUid: string,
  eventSlug:    string,
): Promise<IdentifierProgress> {
  const base = adminDb.collection('registrations')
    .where('organizerUid', '==', organizerUid)
    .where('eventSlug',    '==', eventSlug)
    .where('status',       '==', 'confirmed')

  const [eligible, withIdentifier, withoutIdentifier] = await Promise.all([
    countOf(base),
    countOf(base.where('hasIdentifier', '==', true)),
    countOf(base.where('hasIdentifier', '==', false)),
  ])

  const unrecorded = eligible === null || withIdentifier === null || withoutIdentifier === null
    ? null
    : Math.max(0, eligible - withIdentifier - withoutIdentifier)

  return { eligible, withIdentifier, withoutIdentifier, unrecorded }
}

/**
 * How far timing-chip assignment has got.
 *
 * `identifierTagLocks` is the authority — a deterministic document id makes "this tag, in
 * this event" a uniqueness constraint the datastore enforces. Counting per STATE matters:
 * a replaced or removed tag is not an attached one, and summing them would report more
 * chips in play than exist.
 *
 * Two equality-only aggregates against the state field, zero documents. The roster side is
 * NOT counted here — a chip follows the participant, and this module reports how many are
 * attached, not who holds them.
 */
export interface TimingProgress {
  attached: Count
  replaced: Count
  removed:  Count
}

export async function readTimingProgress(eventSlug: string): Promise<TimingProgress> {
  const base = adminDb.collection(TIMING_TAG_LOCKS).where('eventSlug', '==', eventSlug)
  const [attached, replaced, removed] = await Promise.all([
    countOf(base.where('state', '==', 'assigned')),
    countOf(base.where('state', '==', 'replaced')),
    countOf(base.where('state', '==', 'removed')),
  ])
  return { attached, replaced, removed }
}
