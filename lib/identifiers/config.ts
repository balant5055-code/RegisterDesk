// Phase H.1.5B — Participant Identity Platform: configuration resolution.
//
// Server-only (Admin SDK). Resolves the per-event IdentifierConfig, the pool a
// registration maps to, and live reuse eligibility.
//
// Backward compatibility: when an event has NO stored config, a DEFAULT config is
// returned that reproduces today's bib behaviour (numeric, 4-pad, single pool,
// reuse=never). This is what lets the legacy bib route keep working with zero
// setup — the engine is opt-in for richer behaviour, default-safe otherwise.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { IdentifierConfigError, IdentifierError } from './types'
import { effectiveRanges, rangesOverlap, validateRanges, rangesContain, bandsOutside, describeRanges } from './ranges'
import { poolAcceptsPass, eventUsesPassScopedPools } from './eligibility'
import { buildIdentifierReadModel } from './statistics'
import type {
  IdentifierUsage, PoolStateCounts, IdentifierReadModel, ReadModelContext, PassParticipantCounts,
} from './statistics'
import type {
  IdentifierConfig,
  IdentifierPool,
  IdentifierState,
  IdentifierRange,
  ReusePolicy,
  IdentifierType,
  IdentifierCaseMode,
  AssignmentStrategy,
  AssignmentOrder,
  AutoTrigger,
} from './types'

export const DEFAULT_POOL_ID = 'default'

/**
 * Re-exported so `from '@/lib/identifiers/config'` keeps working everywhere it is
 * already used. RD-EVENT-19A moved the class into ./types so the PURE range
 * validator can throw it without pulling in the Admin SDK.
 */
export { IdentifierConfigError }

// ─── Validation (P5.1 launch blocker) ───────────────────────────────────────
//
// Rejects invalid pool / config values BEFORE they are persisted, so the
// allocator never reads a corrupt config. Thrown as IdentifierConfigError so the
// API layer can map it to HTTP 400 (vs. a 500 from an uncaught throw).

const TYPES:        ReadonlySet<IdentifierType>     = new Set(['numeric', 'alphanumeric', 'random', 'pattern'])
const REUSE:        ReadonlySet<ReusePolicy>        = new Set(['never', 'before_event_start', 'after_cancel_before_checkin', 'after_event_completed', 'manual_only'])
const STRATEGIES:   ReadonlySet<AssignmentStrategy> = new Set(['manual', 'auto'])
const ORDERS:       ReadonlySet<AssignmentOrder>    = new Set(['document', 'registration'])
const TRIGGERS:     ReadonlySet<AutoTrigger>        = new Set(['on_confirmation', 'on_payment', 'on_checkin'])
const CASE_MODES:   ReadonlySet<IdentifierCaseMode> = new Set(['preserve', 'upper', 'lower'])
const MAX_PADDING = 12

// Lock states that mean a value in the pool is in active use (has a live owner
// or is intentionally held) and therefore blocks deletion of its pool.
const OCCUPIED_STATES: ReadonlySet<IdentifierState> =
  new Set<IdentifierState>(['assigned', 'consumed', 'reserved', 'blocked', 'retired'])

function isNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

/** Validates a single pool's static configuration (not cross-pool concerns). */
// ─── RD-BIB-UX-02 · the persistence contract for optional fields ────────────
//
// ═══ THE BUG THIS EXISTS TO CLOSE ════════════════════════════════════════════
// Saving a second number range returned HTTP 500 with a raw Firestore message:
//
//   Cannot use "undefined" as a Firestore value (found in field "pools.`1`.prefix")
//
// `pools[0]` is the built-in default pool, an object literal with no `prefix` KEY
// at all, so it serialized fine. `pools[1]` was the organizer's new range, built
// by the API's request parser, which wrote `prefix: undefined` whenever the field
// was absent. JSON cannot carry `undefined`, so the browser never sent it — the
// server manufactured it, one line before handing the object to Firestore.
//
// ═══ THE RULE ════════════════════════════════════════════════════════════════
// An optional field is either PRESENT with a value, or ABSENT. Never `undefined`.
// `IdentifierPool` declares `prefix?: string`, not `string | null`, so omission is
// the shape the type already describes; writing null instead would invent a third
// state ("explicitly no prefix") that nothing reads and that `p.prefix ?? ''`
// would have to keep translating away.
//
// `rangeStart`, `rangeEnd` and `templateId` ARE declared nullable, so an explicit
// null is preserved where the caller sent one — that is the legacy "unbounded"
// signal and dropping it would change meaning.
//
// This is a DOMAIN normalizer, not a generic undefined-stripper: it names every
// field, so a new optional property is a compile error here rather than a silent
// pass-through that fails in production.

/** True when the key should be written at all. */
const present = <T>(v: T | undefined): v is T => v !== undefined

/**
 * One pool, in exactly the shape Firestore may store.
 *
 * Trims `prefix`/`suffix` and drops them when empty: a prefix of "" is the same
 * configuration as no prefix, and storing the empty string would make "remove the
 * prefix" and "never had one" two different documents for one state.
 */
export function normalizePool(pool: IdentifierPool): IdentifierPool {
  const prefix = typeof pool.prefix === 'string' ? pool.prefix.trim() : undefined
  const suffix = typeof pool.suffix === 'string' ? pool.suffix.trim() : undefined

  return {
    poolId: pool.poolId,
    label:  pool.label,
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
    ...(present(pool.padding)    ? { padding: pool.padding }       : {}),
    ...(present(pool.rangeStart) ? { rangeStart: pool.rangeStart } : {}),
    ...(present(pool.rangeEnd)   ? { rangeEnd: pool.rangeEnd }     : {}),
    ...(present(pool.templateId) ? { templateId: pool.templateId } : {}),
    ...(present(pool.passIds)    ? { passIds: pool.passIds }       : {}),
    ...(present(pool.ranges)
      ? { ranges: pool.ranges.map(r => ({ start: r.start, end: r.end })) }
      : {}),
    ...(present(pool.matchRule)
      ? { matchRule: { by: pool.matchRule.by, values: pool.matchRule.values } }
      : {}),
  }
}

/**
 * The LAST line before Firestore: proves the document carries no `undefined`
 * anywhere, at any depth.
 *
 * Deliberately throws rather than stripping. Stripping would silently discard a
 * field a future change forgot to normalize; throwing surfaces it in the test
 * suite and, in production, turns an unreadable Firestore stack trace into a 400
 * with a sentence. It is an assertion about our own object, not user input —
 * `validateConfig` has already run by the time it is called.
 */
export function assertNoUndefined(value: unknown, path = 'config'): void {
  if (value === undefined) {
    throw new IdentifierConfigError(
      `Internal: "${path}" was undefined and cannot be stored. This is a bug in the identifier configuration normalizer.`,
    )
  }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`))
    return
  }
  // A Firestore sentinel (serverTimestamp) is an opaque class instance; its own
  // enumerable properties are none of our business.
  if (value.constructor && value.constructor !== Object) return
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertNoUndefined(v, `${path}.${k}`)
  }
}

/**
 * The whole configuration, in exactly the shape Firestore may store.
 *
 * Only the parts that can carry optional fields are rebuilt; the scalars come
 * from a validated `IdentifierConfig` and are copied through.
 */
export function normalizeConfigForPersistence(config: IdentifierConfig): IdentifierConfig {
  const out: IdentifierConfig = {
    ...config,
    pools:     config.pools.map(normalizePool),
    templates: config.templates ?? [],
  }
  // `tagMapping` is absent on every event that predates timing tags; an absent
  // capability must stay absent rather than becoming an undefined field.
  if (!present(config.tagMapping)) delete (out as { tagMapping?: unknown }).tagMapping
  if (!present(config.updatedAt)) delete (out as { updatedAt?: unknown }).updatedAt
  if (!present(config.createdAt)) delete (out as { createdAt?: unknown }).createdAt
  for (const [k, v] of Object.entries(out as unknown as Record<string, unknown>)) {
    if (v === undefined) delete (out as unknown as Record<string, unknown>)[k]
  }
  return out
}

function validatePoolShape(p: IdentifierPool): void {
  if (!p.poolId || typeof p.poolId !== 'string') throw new IdentifierConfigError('Each pool needs a poolId.')
  if (!p.label  || typeof p.label  !== 'string') throw new IdentifierConfigError(`Number range "${p.poolId}" needs a label.`)
  if (p.padding != null && (!Number.isInteger(p.padding) || p.padding < 0 || p.padding > MAX_PADDING)) {
    throw new IdentifierConfigError(`Number range "${p.poolId}" padding must be an integer between 0 and ${MAX_PADDING}.`)
  }
  const hasStart = p.rangeStart != null
  const hasEnd   = p.rangeEnd != null
  if (hasStart && !isNonNegInt(p.rangeStart)) throw new IdentifierConfigError(`Number range "${p.poolId}" rangeStart must be a non-negative integer.`)
  if (hasEnd   && !isNonNegInt(p.rangeEnd))   throw new IdentifierConfigError(`Number range "${p.poolId}" rangeEnd must be a non-negative integer.`)
  if (hasStart && hasEnd && (p.rangeStart as number) > (p.rangeEnd as number)) {
    throw new IdentifierConfigError(`Number range "${p.poolId}" rangeStart cannot exceed rangeEnd.`)
  }

  // RD-EVENT-19A · multi-range list. Validated by the pure range module so the
  // allocator, this validator and a future range editor cannot disagree.
  if (p.ranges != null) validateRanges(p.ranges, p.poolId)

  // RD-EVENT-19A · pass association. `[]` is rejected rather than stored,
  // because an empty list reads like "all passes" and means the opposite.
  if (p.passIds != null) {
    if (!Array.isArray(p.passIds)) throw new IdentifierConfigError(`Number range "${p.poolId}" passIds must be a list.`)
    if (p.passIds.length === 0) {
      throw new IdentifierConfigError(
        `Number range "${p.poolId}" passIds cannot be an empty list — remove the field to leave the range unrestricted.`,
      )
    }
    if (p.passIds.some(id => typeof id !== 'string' || !id.trim())) {
      throw new IdentifierConfigError(`Number range "${p.poolId}" passIds must all be non-empty strings.`)
    }
    if (new Set(p.passIds).size !== p.passIds.length) {
      throw new IdentifierConfigError(`Number range "${p.poolId}" lists the same pass twice.`)
    }
  }
}

/** Validates the full pool set: unique ids, no overlapping bounded ranges, valid default. */
function validatePools(pools: IdentifierPool[], defaultPoolId: string): void {
  if (!Array.isArray(pools) || pools.length === 0) throw new IdentifierConfigError('At least one pool is required.')

  const seen = new Set<string>()
  for (const p of pools) {
    validatePoolShape(p)
    if (seen.has(p.poolId)) throw new IdentifierConfigError(`Duplicate poolId "${p.poolId}".`)
    seen.add(p.poolId)
  }
  if (!seen.has(defaultPoolId)) {
    throw new IdentifierConfigError(`defaultPoolId "${defaultPoolId}" does not match any pool.`)
  }

  // RD-EVENT-19A · the SAME pass may not be claimed by two pools, or allocation
  // would depend on array order rather than on what the organizer configured.
  const passOwner = new Map<string, string>()
  for (const p of pools) {
    for (const passId of p.passIds ?? []) {
      const owner = passOwner.get(passId)
      if (owner) {
        throw new IdentifierConfigError(
          `Number ranges "${owner}" and "${p.poolId}" are both assigned to the same pass.`,
        )
      }
      passOwner.set(passId, p.poolId)
    }
  }

  // Overlap check between pools that BOTH declare explicit numeric ranges.
  // `effectiveRanges` reads `ranges[]` when present and the legacy
  // rangeStart/rangeEnd pair otherwise, so a multi-range pool and a legacy pool
  // are compared on the same footing. Adjacent ranges (5999 / 6000) do not clash.
  const boundedPools = pools
    .map(p => ({ poolId: p.poolId, ranges: effectiveRanges(p) }))
    .filter(p => p.ranges.length > 0)
  for (let i = 0; i < boundedPools.length; i++) {
    for (let j = i + 1; j < boundedPools.length; j++) {
      const a = boundedPools[i], b = boundedPools[j]
      for (const ra of a.ranges) {
        for (const rb of b.ranges) {
          if (rangesOverlap(ra, rb)) {
            throw new IdentifierConfigError(
              `Number ranges "${a.poolId}" (${ra.start}–${ra.end}) and "${b.poolId}" (${rb.start}–${rb.end}) have overlapping ranges.`,
            )
          }
        }
      }
    }
  }
}

/** Validates the merged identifier config before it is persisted. */
function validateConfig(c: IdentifierConfig): void {
  if (!TYPES.has(c.type))             throw new IdentifierConfigError(`Invalid identifier type "${c.type}".`)
  if (!REUSE.has(c.reusePolicy))      throw new IdentifierConfigError(`Invalid reuse policy "${c.reusePolicy}".`)
  if (!STRATEGIES.has(c.assignmentStrategy)) throw new IdentifierConfigError(`Invalid assignment strategy "${c.assignmentStrategy}".`)
  if (c.assignmentOrder != null && !ORDERS.has(c.assignmentOrder)) throw new IdentifierConfigError(`Invalid assignment order "${c.assignmentOrder}".`)
  if (c.autoTrigger != null && !TRIGGERS.has(c.autoTrigger)) throw new IdentifierConfigError(`Invalid auto trigger "${c.autoTrigger}".`)
  if (!Number.isInteger(c.format.padding) || c.format.padding < 0 || c.format.padding > MAX_PADDING) {
    throw new IdentifierConfigError(`format.padding must be an integer between 0 and ${MAX_PADDING}.`)
  }
  if (!isNonNegInt(c.format.startNumber)) throw new IdentifierConfigError('format.startNumber must be a non-negative integer.')
  if (c.format.caseMode != null && !CASE_MODES.has(c.format.caseMode)) {
    throw new IdentifierConfigError(`Invalid case mode "${c.format.caseMode}".`)
  }
  if (c.tagMapping != null) {
    if (typeof c.tagMapping !== 'object') throw new IdentifierConfigError('tagMapping must be an object.')
    const m = c.tagMapping as { mode?: unknown; label?: unknown }
    if (m.mode != null && m.mode !== 'mapped' && m.mode !== 'identifier') {
      throw new IdentifierConfigError('Timing tag mode must be either mapped or identifier.')
    }
    if (m.label != null && (typeof m.label !== 'string' || !m.label.trim())) {
      throw new IdentifierConfigError('The timing tag name cannot be blank.')
    }
  }
  validatePools(c.pools, c.defaultPoolId)
}

// ─── Default config (mirrors legacy bib behaviour) ──────────────────────────

export function defaultIdentifierConfig(eventSlug: string): IdentifierConfig {
  return {
    eventSlug,
    enabled:             true,
    // RD-BIB-01 · event-type NEUTRAL.
    //
    // This is the label an event that has never been configured gets, and it used to
    // be "Bib Number" — so a conference nobody had set up headed its identifier
    // column with a running-race word, on a platform that serves ten event
    // categories. "Identifier" says what it is without claiming what the event is;
    // the organizer replaces it the moment they configure anything.
    //
    // Nothing keys off this string: it is a label, and every surface reads it from
    // the config rather than hardcoding one.
    // RD-BIB-TIMING-04 · REVERTED from the brief 'Number' experiment of
    // RD-BIB-TIMING-03. The label an organizer reads must come from the event's
    // own configuration, and swapping one generic default for another only moved
    // the problem. This value exists solely so an unconfigured event has something
    // to render; the moment a label is configured, every surface reads that.
    label:               'Identifier',
    preset:              'bib',
    type:                'numeric',
    format:              { prefix: '', suffix: '', padding: 4, startNumber: 1 },
    reusePolicy:         'never',
    assignmentStrategy:  'manual',
    allowManualOverride: true,
    allowDuplicate:      false,
    pools:               [{ poolId: DEFAULT_POOL_ID, label: 'Default' }],
    templates:           [],
    defaultPoolId:       DEFAULT_POOL_ID,
    visibility:          { attendee: true, ticket: true, certificate: true, badge: false, checkin: true },
    version:             0,
  }
}

// ─── Read ───────────────────────────────────────────────────────────────────

export interface ResolvedConfig {
  config:   IdentifierConfig
  isStored: boolean      // false ⇒ default fallback (no organizer setup yet)
}

/** Returns the stored config or a behaviour-compatible default. */
export async function resolveIdentifierConfig(eventSlug: string): Promise<ResolvedConfig> {
  const snap = await adminDb.collection('identifierConfigs').doc(eventSlug).get()
  if (!snap.exists) return { config: defaultIdentifierConfig(eventSlug), isStored: false }

  const stored = snap.data() as Partial<IdentifierConfig>
  // Merge over the default so partial/older docs stay valid (forward-compatible).
  const base = defaultIdentifierConfig(eventSlug)
  return {
    config: {
      ...base,
      ...stored,
      eventSlug,
      format:     { ...base.format, ...(stored.format ?? {}) },
      visibility: { ...base.visibility, ...(stored.visibility ?? {}) },
      pools:      stored.pools && stored.pools.length ? stored.pools : base.pools,
      templates:  stored.templates ?? base.templates,
      defaultPoolId: stored.defaultPoolId ?? base.defaultPoolId,
    },
    isStored: true,
  }
}

// ─── Pool resolution ────────────────────────────────────────────────────────

export interface PoolMatchContext {
  passId?:           string | null
  category?:         string | null
  registrationType?: string | null
}

/**
 * Resolves which pool a registration belongs to.
 *
 * ─── PRECEDENCE (RD-EVENT-19A) ────────────────────────────────────────────
 *   0. An explicit `poolId` — an operator naming a pool always wins.
 *   1. `pool.passIds` contains ctx.passId          ← first-class pass association
 *   2. `pool.matchRule.by === 'pass'` matches      ← legacy pass rule, still honoured
 *   3. any other `matchRule` (category / registration_type / custom)
 *   4. the default pool
 *
 * Tiers 1 and 2 both mean "this pass", so they are tried before any
 * category rule; within a tier, the FIRST pool in configuration order wins, which
 * is deterministic and matches the pre-19A behaviour for tiers 3 and 4.
 *
 * BACKWARD COMPATIBILITY: tiers 1 and 2 can only fire when a caller supplies a
 * `passId`. No caller did before 19A, so for every existing configuration this
 * function returns exactly what it returned before — a category rule that used to
 * win still wins, and a config with no rules still lands on the default pool.
 *
 * An UNKNOWN passId matches no pool's `passIds` and no pass `matchRule`, so it
 * falls through to the category rules and finally the default pool. It can never
 * land in another pass's pool: matching is by explicit membership only, never by
 * position or by "the nearest configured pass".
 */
export function resolvePool(
  config:     IdentifierConfig,
  explicit:   string | undefined,
  ctx:        PoolMatchContext,
): IdentifierPool {
  if (explicit) {
    const found = config.pools.find(p => p.poolId === explicit)
    if (found) return found
  }

  // 1 — first-class pass association.
  const byPassIds = config.pools.find(p => poolAcceptsPass(p, ctx.passId))
  if (byPassIds) return byPassIds

  // 2 — legacy pass matchRule.
  const byPassRule = config.pools.find(p =>
    p.matchRule?.by === 'pass' && !!ctx.passId && p.matchRule.values.includes(ctx.passId),
  )
  if (byPassRule) return byPassRule


  // 3 — every other matchRule, in configuration order (unchanged behaviour).
  for (const pool of config.pools) {
    const rule = pool.matchRule
    if (!rule || rule.by === 'pass') continue
    const candidate =
      rule.by === 'category'          ? ctx.category
      : rule.by === 'registration_type' ? ctx.registrationType
      : null
    if (candidate && rule.values.includes(candidate)) return pool
  }

  // ── RD-BIB-01 · 3b — STOP before the default fallback on a pass-scoped event ──
  //
  // Step 4 below ends in the default pool, and that is what allowed a pass with no
  // range of its own to be served from somebody else's numbers, silently. Observed
  // in the audit: a 10 KM entrant whose pool was missing received a number from
  // `default`, and on a freshly-defaulted config the default pool is unbounded, so
  // the number would have been 1.
  //
  // Placed AFTER the category and registration_type rules deliberately — a config
  // that mixes pass pools with a category pool must keep resolving the category one,
  // which is existing behaviour a test rightly pins. Only the blind fallback goes.
  //
  // A legacy event (no pool names any pass) never reaches this line, so its
  // behaviour is byte-identical to before.
  if (eventUsesPassScopedPools(config.pools)) {
    throw new IdentifierError(
      'POOL_NOT_FOUND',
      ctx.passId
        ? 'This pass has no participant-number range configured. Add one before assigning.'
        : 'This registration has no pass, and this event issues participant numbers per pass.',
    )
  }

  // 4 — default.
  return (
    config.pools.find(p => p.poolId === config.defaultPoolId) ??
    config.pools[0] ??
    { poolId: DEFAULT_POOL_ID, label: 'Default' }
  )
}

// ─── Reuse eligibility (computed live — never a static free list) ────────────
//
// RD-EVENT-19D moved the rule itself to ./reusePolicy, which is PURE, so the
// browser-side decision model can consult it without importing the Admin SDK.
// Re-exported here so every existing `from '@/lib/identifiers/config'` import is
// unchanged. The rule is identical — this was a move, not a rewrite.
export { canReuse } from './reusePolicy'
export type { LifecyclePhase } from './reusePolicy'

// ─── Legacy counter seed (continuity for existing events) ───────────────────

/**
 * Reads the legacy bibCounters/{slug}.nextBib so a freshly-initialised default
 * pool counter continues from where sequential bib assignment left off — never
 * re-issuing a number that was already handed out. Returns null when absent.
 */
export async function legacyCounterSeed(eventSlug: string): Promise<number | null> {
  const snap = await adminDb.collection('bibCounters').doc(eventSlug).get()
  if (!snap.exists) return null
  const n = snap.data()?.nextBib
  return typeof n === 'number' ? n : null
}

// ─── Configuration writer (H.3 — persists identifierConfigs/{slug}) ─────────
//
// These do NOT touch allocation or transaction logic. They persist the per-event
// config document the allocator already reads, and append a config_changed entry
// to the existing identifierHistory audit timeline. No new collection.

const configRef = (slug: string) => adminDb.collection('identifierConfigs').doc(slug)

async function auditConfigChange(eventSlug: string, actor: string, reason: string): Promise<void> {
  await adminDb.collection('identifierHistory').add({
    eventSlug, value: '__config__', action: 'config_changed', actor,
    registrationId: null, previousOwner: null, newOwner: null, reason,
    timestamp: FieldValue.serverTimestamp(),
  })
}

// ─── RD-BIB-01 · range-edit safety ──────────────────────────────────────────

/**
 * The highest number any band query needs to reach. Identifier values are bounded by
 * `MAX_VALUE_LENGTH` characters, so no legitimate numeric identifier approaches this;
 * it exists so the "everything above the last range" band is a closed query rather
 * than an open one.
 */
const NUMERIC_CEILING = 1_000_000_000

/** One pool's proposed range change, and what it would do to numbers already issued. */
export interface StrandingReport {
  poolId:   string
  poolLabel: string
  /** Identifiers that would fall outside the new ranges. Null ⇒ could not be counted. */
  stranded: number | null
  /** The bands they were found in, for the message. */
  bands:    IdentifierRange[]
  /** True when the change cannot strand anything and no query was needed. */
  safeByContainment: boolean
}

/**
 * RD-BIB-01 · would this range change orphan numbers somebody is already carrying?
 *
 * ═══ WHY THE SERVER OWNS THIS ════════════════════════════════════════════════
 * `strandedByRanges()` has existed since RD-EVENT-19A, fully tested, documented as
 * "the contract the range editor is required to consult" — and nothing consulted it.
 * An organizer could move a pool from 5001–5600 to 6000–7000 while 500 participants
 * were carrying 5001–5500, and the save succeeded silently. The workspace would then
 * report "this pool holds more identifiers than its ranges allow", which is a
 * diagnosis delivered after the bibs are printed.
 *
 * ═══ WHY IT IS BOUNDED ═══════════════════════════════════════════════════════
 * It never loads locks. Two cheap steps:
 *
 *   1. CONTAINMENT — if the new ranges cover every old range, nothing can possibly be
 *      stranded. Widening, and merging adjacent ranges, cost zero reads.
 *   2. BANDS — otherwise, one `count()` per gap the new ranges leave. Two ranges make
 *      three bands. The cost is fixed by the CONFIGURATION, never by the event size.
 *
 * ═══ WHY IT FAILS CLOSED ═════════════════════════════════════════════════════
 * A count that throws returns `stranded: null`, and the caller REFUSES the write.
 * "I could not check whether this would invalidate issued numbers" is not permission
 * to proceed.
 */
export async function reportStranding(
  eventSlug: string,
  previous:  IdentifierPool[],
  next:      IdentifierPool[],
): Promise<StrandingReport[]> {
  const before = new Map(previous.map(p => [p.poolId, p]))
  const out: StrandingReport[] = []

  for (const pool of next) {
    const old = before.get(pool.poolId)
    if (!old) continue                                   // a brand-new pool holds nothing
    const oldRanges = effectiveRanges(old)
    const newRanges = effectiveRanges(pool)
    if (newRanges.length === 0) continue                 // unbounded ⇒ nothing can fall outside
    if (rangesContain(newRanges, oldRanges)) {
      out.push({ poolId: pool.poolId, poolLabel: pool.label, stranded: 0, bands: [], safeByContainment: true })
      continue
    }

    const bands = bandsOutside(newRanges, NUMERIC_CEILING)
    const base = adminDb.collection('identifierLocks')
      .where('eventSlug', '==', eventSlug)
      .where('poolId', '==', pool.poolId)
    try {
      const counts = await Promise.all(bands.map(async b => {
        const snap = await base
          .where('numeric', '>=', b.start)
          .where('numeric', '<=', b.end)
          .count().get()
        return snap.data().count as number
      }))
      out.push({
        poolId: pool.poolId, poolLabel: pool.label,
        stranded: counts.reduce((a, b) => a + b, 0),
        bands, safeByContainment: false,
      })
    } catch {
      // Could not verify — reported as unknown, and the caller refuses.
      out.push({ poolId: pool.poolId, poolLabel: pool.label, stranded: null, bands, safeByContainment: false })
    }
  }
  return out
}

/** Merge-writes the event's identifier config and bumps its version. */
export async function saveIdentifierConfig(
  eventSlug: string, patch: Partial<IdentifierConfig>, actor: string, reason = 'config updated',
  options: {
    /**
     * RD-BIB-01 · proceed even though issued numbers would be stranded.
     *
     * Deliberate, explicit and audited: the reason recorded in `identifierHistory`
     * names the count, so "who broke bib 5500" has an answer. Never a default.
     */
    acknowledgeStranding?: boolean
  } = {},
): Promise<IdentifierConfig> {
  const { config, isStored } = await resolveIdentifierConfig(eventSlug)
  const next: IdentifierConfig = {
    ...config,
    ...patch,
    eventSlug,
    format:     { ...config.format,     ...(patch.format     ?? {}) },
    visibility: { ...config.visibility, ...(patch.visibility ?? {}) },
    pools:      patch.pools     ?? config.pools,
    templates:  patch.templates ?? config.templates,
    version:    (config.version ?? 0) + 1,
  }
  // Reject invalid values before they reach the allocator (P5.1).
  validateConfig(next)

  // RD-BIB-01 · and reject a range change that would orphan issued numbers.
  // Runs only when the pools actually changed, so an unrelated config edit (a label,
  // the reuse policy, tag mapping) costs nothing.
  let strandingNote = ''
  if (patch.pools) {
    const reports = await reportStranding(eventSlug, config.pools, next.pools)
    const unverifiable = reports.filter(r => r.stranded === null)
    const damaging     = reports.filter(r => (r.stranded ?? 0) > 0)

    if (unverifiable.length > 0) {
      throw new IdentifierConfigError(
        `The number range for "${unverifiable[0].poolLabel}" could not be checked against the identifiers already issued, so the change was not saved. Try again in a moment.`,
      )
    }
    if (damaging.length > 0 && !options.acknowledgeStranding) {
      const worst = damaging.sort((a, b) => (b.stranded ?? 0) - (a.stranded ?? 0))[0]
      const total = damaging.reduce((n, r) => n + (r.stranded ?? 0), 0)
      throw new IdentifierConfigError(
        `${total} issued identifier${total === 1 ? '' : 's'} would fall outside the new number range` +
        `${damaging.length > 1 ? 's' : ''} — ${worst.stranded} in "${worst.poolLabel}" (${describeRanges(worst.bands)}). ` +
        `Those participants are already carrying those numbers. Widen the range to include them, or confirm the change explicitly.`,
      )
    }
    if (damaging.length > 0) {
      const total = damaging.reduce((n, r) => n + (r.stranded ?? 0), 0)
      strandingNote = ` · acknowledged: ${total} issued identifier(s) now outside their range`
    }
  }

  // RD-BIB-UX-02 · normalize, then PROVE, then write — in that order, in the one
  // function every config write goes through. Both routes and every internal
  // caller (upsertPool, deletePool, the tag-mapping patch) land here, so there is
  // no second path that could reach Firestore with an unnormalized object.
  const persisted = normalizeConfigForPersistence(next)
  const document = {
    ...persisted,
    updatedAt: FieldValue.serverTimestamp(),
    ...(isStored ? {} : { createdAt: FieldValue.serverTimestamp() }),
  }
  assertNoUndefined(document, 'identifierConfig')

  await configRef(eventSlug).set(document, { merge: true })
  await auditConfigChange(eventSlug, actor, reason + strandingNote)
  // RD-BIB-UX-02 · return what was STORED, not the pre-normalization object. The
  // pools route echoes this straight back to the editor, and an echo that still
  // carried `prefix: undefined` would show the caller a shape the database does
  // not hold.
  return persisted
}

/** Adds or replaces a pool (matched by poolId) in the event config. */
export async function upsertPool(eventSlug: string, pool: IdentifierPool, actor: string, options: { acknowledgeStranding?: boolean } = {}): Promise<IdentifierConfig> {
  const { config } = await resolveIdentifierConfig(eventSlug)
  const pools = config.pools.some(p => p.poolId === pool.poolId)
    ? config.pools.map(p => (p.poolId === pool.poolId ? pool : p))
    : [...config.pools, pool]
  return saveIdentifierConfig(eventSlug, { pools }, actor, `pool ${pool.poolId} upserted`, options)
}

/**
 * Removes a pool. The default pool cannot be deleted, and a pool that still
 * contains in-use identifiers (assigned/consumed/reserved/blocked/retired) cannot
 * be deleted — that would orphan live allocations (P5.1).
 */
export async function deletePool(eventSlug: string, poolId: string, actor: string): Promise<IdentifierConfig> {
  const { config } = await resolveIdentifierConfig(eventSlug)
  if (poolId === config.defaultPoolId) {
    throw new IdentifierConfigError('The default pool cannot be deleted.')
  }
  if (!config.pools.some(p => p.poolId === poolId)) {
    throw new IdentifierConfigError(`Number range "${poolId}" does not exist.`)
  }

  // Guard: refuse to delete a pool that still holds active identifiers.
  const lockSnap = await adminDb.collection('identifierLocks')
    .where('eventSlug', '==', eventSlug)
    .where('poolId', '==', poolId)
    .select('state')
    .get()
  const inUse = lockSnap.docs.reduce(
    (n, d) => n + (OCCUPIED_STATES.has((d.data() as { state?: IdentifierState }).state ?? 'available') ? 1 : 0),
    0,
  )
  if (inUse > 0) {
    throw new IdentifierConfigError(
      `Number range "${poolId}" still has ${inUse} in-use identifier(s). Release or swap them before deleting it.`,
    )
  }

  const pools = config.pools.filter(p => p.poolId !== poolId)
  return saveIdentifierConfig(eventSlug, { pools }, actor, `pool ${poolId} deleted`)
}

// ─── Pool / state statistics (H.3 — read-only aggregation) ──────────────────

/**
 * RD-EVENT-19B · every metric is now `number | null`.
 *
 * These were plain `number` and were produced by counting an UNBOUNDED read of
 * every lock document. A failed read therefore surfaced as `0` — "nobody has an
 * identifier" — which is the one thing this screen must never say by accident.
 * `null` means "could not be established"; `0` now means a real zero.
 */
export interface PoolStat {
  poolId:     string
  label:      string
  prefix:     string
  padding:    number
  rangeStart: number | null
  rangeEnd:   number | null
  /** RD-EVENT-19A · every range the pool occupies; `[]` when unbounded. Additive. */
  ranges:     IdentifierRange[]
  /** RD-EVENT-19A · the passes this pool serves; null when unrestricted. Additive. */
  passIds:    string[] | null
  capacity:   number | null
  nextNumber: number | null
  assigned:   number | null
  consumed:   number | null
  reserved:   number | null
  blocked:    number | null
  retired:    number | null
  released:   number | null
  available:  number | null
}

export interface IdentifierStatistics {
  pools: PoolStat[]
  totals: {
    assigned: number | null; consumed: number | null; reserved: number | null
    blocked: number | null; retired: number | null; released: number | null
    reusable: number | null; available: number | null
  }
}

// ─── Bounded usage reads (RD-EVENT-19B) ─────────────────────────────────────

/** The lock states counted per pool. Order is fixed so results are deterministic. */
const COUNTED_STATES = ['assigned', 'consumed', 'reserved', 'blocked', 'retired', 'released'] as const

/**
 * Above this many pools the per-pool aggregates are skipped and usage is reported
 * as UNAVAILABLE rather than fired as hundreds of parallel queries.
 *
 * Pools are CONFIGURATION, not data: a real event has one to a handful. The cap
 * exists so a pathological configuration cannot turn one page load into a storm,
 * and it fails honestly (`state: 'unavailable'`) instead of silently.
 */
export const MAX_STAT_POOLS = 20

/**
 * RD-BIB-01 · the same idea for passes. Three aggregates each, so a pathological
 * event cannot turn one page load into a hundred round trips. Passes beyond the cap
 * are simply absent from the map, which the pure layer reads as UNKNOWN — never zero.
 */
export const MAX_STAT_PASSES = 12

const countOf = (q: FirebaseFirestore.Query): Promise<number | null> =>
  q.count().get().then(s => s.data().count as number)
    // One failed aggregate must not take the others with it, and must never
    // become a zero. This is the same guard the attendance dashboard uses.
    .catch(() => null)

/**
 * Reads identifier usage with BOUNDED aggregates — zero documents transferred,
 * zero PII, and a cost that does not grow with the number of identifiers.
 *
 * BEFORE: `identifierLocks.where(eventSlug).get()` — every lock document. An event
 * with 10,000 assigned identifiers cost 10,000 reads to render seven numbers.
 *
 * AFTER: `count()` aggregates. Six per pool (one per counted state), one counter
 * document per pool, one event-wide reusable count, one eligible-registration
 * count. For the common single-pool event that is ten reads instead of ten
 * thousand, and it does not change as the event fills.
 *
 * Every query is an equality-only conjunction, which Firestore serves by merging
 * single-field indexes — the same shape `deletePool` above already relies on. No
 * composite index is introduced, so nothing has to be deployed for this to work.
 */
export async function fetchIdentifierUsage(
  eventSlug: string,
  config:    IdentifierConfig,
  organizerUid?: string,
  passIds:   readonly string[] = [],
): Promise<IdentifierUsage> {
  const locks = adminDb.collection('identifierLocks').where('eventSlug', '==', eventSlug)

  const pools = config.pools.slice(0, MAX_STAT_POOLS)
  const skipped = config.pools.length > MAX_STAT_POOLS

  const [poolCounts, nextNumbers, reusable, eligible, rosterWithId, rosterWithoutId, legacyLocks] = await Promise.all([
    // Per pool × per state. Bounded by the CONFIGURATION, not by the data.
    Promise.all(pools.map(p => Promise.all(
      COUNTED_STATES.map(state => countOf(locks.where('poolId', '==', p.poolId).where('state', '==', state))),
    ))),
    Promise.all(pools.map(p =>
      adminDb.collection('identifierCounters').doc(`${eventSlug}__${p.poolId}`).get()
        .then(s => (s.exists ? ((s.data()?.nextNumber as number | undefined) ?? null) : null))
        .catch(() => null),
    )),
    // Released and never checked in — the values policy may re-issue. A lock that
    // predates `everCheckedIn` is not indexed on it and so is not counted here;
    // every lock the engine writes sets the field explicitly.
    countOf(locks.where('state', '==', 'released').where('everCheckedIn', '==', false)),
    // The ROSTER eligibility rule, as one aggregate. Same query shape /bibs already
    // runs, minus the documents.
    organizerUid
      ? countOf(adminDb.collection('registrations')
          .where('organizerUid', '==', organizerUid)
          .where('eventSlug', '==', eventSlug)
          .where('status', '==', 'confirmed'))
      : Promise.resolve(null),
    // ── RD-REPORT-03 · the EVENT-WIDE half of the same three-way split ────────
    //
    // RD-BIB-01 made the per-pass figures exact with `hasIdentifier`, but the
    // event-level "how many are still without a number" stayed UNKNOWN, because it
    // was only ever derivable from the LOCK collection — and a lock carries no
    // registration status, so a lock held by a cancelled entrant would have been
    // subtracted from a roster that never contained them.
    //
    // Counting on the REGISTRATION side removes that objection entirely: both
    // figures are drawn from the identical population (this organizer, this event,
    // status confirmed), so the subtraction never crosses collections.
    //
    // Two aggregates, equality-only like the three per-pass ones above, so Firestore
    // serves them by merging single-field indexes — no composite to deploy. ABSENT
    // remains a third state: `true + false < total` means some registrations predate
    // the field, and the read model reports UNKNOWN rather than a number that is too
    // small. Summing the per-pass rows instead would silently omit any registration
    // whose pass is not in the configured list.
    organizerUid
      ? countOf(adminDb.collection('registrations')
          .where('organizerUid', '==', organizerUid)
          .where('eventSlug', '==', eventSlug)
          .where('status', '==', 'confirmed')
          .where('hasIdentifier', '==', true))
      : Promise.resolve(null),
    organizerUid
      ? countOf(adminDb.collection('registrations')
          .where('organizerUid', '==', organizerUid)
          .where('eventSlug', '==', eventSlug)
          .where('status', '==', 'confirmed')
          .where('hasIdentifier', '==', false))
      : Promise.resolve(null),
    // Pre-platform locks, reported separately and NEVER summed into `assigned`:
    // a value can exist in both collections, so adding them would double-count.
    countOf(adminDb.collection('bibLocks').where('eventSlug', '==', eventSlug)),
  ])

  // ── RD-BIB-01 · per-pass participant counts, EXACT and self-verifying ──────
  //
  // Three aggregates per pass: how many are on the roster, how many of them hold an
  // identifier, and how many are known NOT to. All three are equality-only, so
  // Firestore serves them by merging single-field indexes — no composite to deploy.
  //
  // The third is what makes "will assign" exact, and the reason it is a separate
  // count rather than `total − assigned` is the failure that shortcut hides: a
  // registration written before `hasIdentifier` existed matches NEITHER `true` nor
  // `false`. When the two do not add up to the total, the difference is registrations
  // this event cannot yet answer for, and the read model says UNKNOWN instead of
  // quietly reporting a number that is too small.
  const passScope = passIds.slice(0, MAX_STAT_PASSES)
  const byPass = new Map<string, PassParticipantCounts>()
  if (organizerUid && passScope.length > 0) {
    const roster = adminDb.collection('registrations')
      .where('organizerUid', '==', organizerUid)
      .where('eventSlug', '==', eventSlug)
      .where('status', '==', 'confirmed')
    const rows = await Promise.all(passScope.map(async passId => {
      const q = roster.where('passId', '==', passId)
      const [total, withId, withoutId] = await Promise.all([
        countOf(q),
        countOf(q.where('hasIdentifier', '==', true)),
        countOf(q.where('hasIdentifier', '==', false)),
      ])
      return { passId, total, withId, withoutId }
    }))
    for (const r of rows) {
      byPass.set(r.passId, { total: r.total, withIdentifier: r.withId, withoutIdentifier: r.withoutId })
    }
  }

  const byPool = new Map<string, PoolStateCounts>()
  pools.forEach((p, i) => {
    const row = poolCounts[i]
    byPool.set(p.poolId, {
      assigned: row[0], consumed: row[1], reserved: row[2],
      blocked:  row[3], retired:  row[4], released: row[5],
    })
  })

  const nextByPool = new Map<string, number | null>()
  pools.forEach((p, i) => nextByPool.set(p.poolId, nextNumbers[i]))

  // Pools past the cap are left OUT of the map, which the pure layer reads as
  // unknown usage — never as zero.
  void skipped

  return {
    byPool, nextNumbers: nextByPool, reusable, eligible, legacyLocks, byPass,
    // RD-REPORT-03 · event-wide roster coverage, same shape as a per-pass row.
    roster: { total: eligible, withIdentifier: rosterWithId, withoutIdentifier: rosterWithoutId },
  }
}

/**
 * Per-pool state counts + next numbers, in the pre-19B response shape.
 *
 * Kept so existing consumers are untouched; it is now assembled from the same
 * bounded aggregates and the same pure read model as everything else, so the two
 * shapes can never disagree.
 */
export async function getPoolStatistics(eventSlug: string): Promise<IdentifierStatistics> {
  const { config } = await resolveIdentifierConfig(eventSlug)
  const usage = await fetchIdentifierUsage(eventSlug, config)
  const model = buildIdentifierReadModel({
    eventSlug, config, configured: true, usage,
    ctx: { passes: [], passesKnown: false },
  })
  return toLegacyStatistics(model, usage)
}

/**
 * RD-EVENT-19B · the ONE entry point for the identifier overview.
 *
 * Resolves the config, reads usage ONCE with bounded aggregates, and returns both
 * the rich read model and the legacy statistics shape built from the same numbers.
 * Callers must not fetch usage twice by also calling `getPoolStatistics`.
 *
 * `ctx.passes` comes from the event draft the scope resolver has already read, so
 * orphaned-pass detection costs nothing. When the passes are unknown, no pool is
 * reported as orphaned — a guess in that direction would condemn every pool.
 */
export async function getIdentifierOverview(
  eventSlug: string,
  ctx:       ReadModelContext,
  organizerUid?: string,
): Promise<{ model: IdentifierReadModel; legacy: IdentifierStatistics; config: IdentifierConfig; isStored: boolean }> {
  const { config, isStored } = await resolveIdentifierConfig(eventSlug)
  // RD-BIB-01 · the event's passes come from the draft the scope resolver already read,
  // so the per-pass counts cost aggregates only — no extra document read.
  const usage = await fetchIdentifierUsage(eventSlug, config, organizerUid, ctx.passes.map(p => p.id))
  const model = buildIdentifierReadModel({ eventSlug, config, configured: isStored, usage, ctx })
  return { model, legacy: toLegacyStatistics(model, usage), config, isStored }
}

/** Projects the read model onto the pre-19B `IdentifierStatistics` shape. */
export function toLegacyStatistics(
  model: IdentifierReadModel, usage: IdentifierUsage,
): IdentifierStatistics {
  return {
    pools: model.pools.map(p => ({
      poolId: p.poolId, label: p.label, prefix: p.prefix, padding: p.padding,
      rangeStart: p.rangeStart, rangeEnd: p.rangeEnd, ranges: p.ranges, passIds: p.passIds,
      capacity: p.capacity, nextNumber: p.nextNumber,
      assigned: p.assigned, consumed: p.consumed, reserved: p.reserved,
      blocked: p.blocked, retired: p.retired, released: p.released,
      available: p.available,
    })),
    totals: {
      assigned: model.summary.assigned, consumed: model.summary.consumed,
      reserved: model.summary.reserved, blocked:  model.summary.blocked,
      retired:  model.summary.retired,  released: model.summary.released,
      reusable: usage.reusable,         available: model.summary.available,
    },
  }
}
