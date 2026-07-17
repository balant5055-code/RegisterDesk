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
import type {
  IdentifierConfig,
  IdentifierPool,
  IdentifierLockDoc,
  IdentifierState,
  ReusePolicy,
  IdentifierType,
  AssignmentStrategy,
  AutoTrigger,
} from './types'

export const DEFAULT_POOL_ID = 'default'

// ─── Validation (P5.1 launch blocker) ───────────────────────────────────────
//
// Rejects invalid pool / config values BEFORE they are persisted, so the
// allocator never reads a corrupt config. Thrown as IdentifierConfigError so the
// API layer can map it to HTTP 400 (vs. a 500 from an uncaught throw).

export class IdentifierConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentifierConfigError'
  }
}

const TYPES:        ReadonlySet<IdentifierType>     = new Set(['numeric', 'alphanumeric', 'random', 'pattern'])
const REUSE:        ReadonlySet<ReusePolicy>        = new Set(['never', 'before_event_start', 'after_cancel_before_checkin', 'after_event_completed', 'manual_only'])
const STRATEGIES:   ReadonlySet<AssignmentStrategy> = new Set(['manual', 'auto'])
const TRIGGERS:     ReadonlySet<AutoTrigger>        = new Set(['on_confirmation', 'on_payment', 'on_checkin'])
const MAX_PADDING = 12

// Lock states that mean a value in the pool is in active use (has a live owner
// or is intentionally held) and therefore blocks deletion of its pool.
const OCCUPIED_STATES: ReadonlySet<IdentifierState> =
  new Set<IdentifierState>(['assigned', 'consumed', 'reserved', 'blocked', 'retired'])

function isNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

/** Validates a single pool's static configuration (not cross-pool concerns). */
function validatePoolShape(p: IdentifierPool): void {
  if (!p.poolId || typeof p.poolId !== 'string') throw new IdentifierConfigError('Each pool needs a poolId.')
  if (!p.label  || typeof p.label  !== 'string') throw new IdentifierConfigError(`Pool "${p.poolId}" needs a label.`)
  if (p.padding != null && (!Number.isInteger(p.padding) || p.padding < 0 || p.padding > MAX_PADDING)) {
    throw new IdentifierConfigError(`Pool "${p.poolId}" padding must be an integer between 0 and ${MAX_PADDING}.`)
  }
  const hasStart = p.rangeStart != null
  const hasEnd   = p.rangeEnd != null
  if (hasStart && !isNonNegInt(p.rangeStart)) throw new IdentifierConfigError(`Pool "${p.poolId}" rangeStart must be a non-negative integer.`)
  if (hasEnd   && !isNonNegInt(p.rangeEnd))   throw new IdentifierConfigError(`Pool "${p.poolId}" rangeEnd must be a non-negative integer.`)
  if (hasStart && hasEnd && (p.rangeStart as number) > (p.rangeEnd as number)) {
    throw new IdentifierConfigError(`Pool "${p.poolId}" rangeStart cannot exceed rangeEnd.`)
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

  // Overlap check between pools that BOTH declare explicit numeric ranges.
  const bounded = pools.filter(p => p.rangeStart != null && p.rangeEnd != null)
  for (let i = 0; i < bounded.length; i++) {
    for (let j = i + 1; j < bounded.length; j++) {
      const a = bounded[i], b = bounded[j]
      if ((a.rangeStart as number) <= (b.rangeEnd as number) && (b.rangeStart as number) <= (a.rangeEnd as number)) {
        throw new IdentifierConfigError(
          `Pools "${a.poolId}" (${a.rangeStart}–${a.rangeEnd}) and "${b.poolId}" (${b.rangeStart}–${b.rangeEnd}) have overlapping ranges.`,
        )
      }
    }
  }
}

/** Validates the merged identifier config before it is persisted. */
function validateConfig(c: IdentifierConfig): void {
  if (!TYPES.has(c.type))             throw new IdentifierConfigError(`Invalid identifier type "${c.type}".`)
  if (!REUSE.has(c.reusePolicy))      throw new IdentifierConfigError(`Invalid reuse policy "${c.reusePolicy}".`)
  if (!STRATEGIES.has(c.assignmentStrategy)) throw new IdentifierConfigError(`Invalid assignment strategy "${c.assignmentStrategy}".`)
  if (c.autoTrigger != null && !TRIGGERS.has(c.autoTrigger)) throw new IdentifierConfigError(`Invalid auto trigger "${c.autoTrigger}".`)
  if (!Number.isInteger(c.format.padding) || c.format.padding < 0 || c.format.padding > MAX_PADDING) {
    throw new IdentifierConfigError(`format.padding must be an integer between 0 and ${MAX_PADDING}.`)
  }
  if (!isNonNegInt(c.format.startNumber)) throw new IdentifierConfigError('format.startNumber must be a non-negative integer.')
  validatePools(c.pools, c.defaultPoolId)
}

// ─── Default config (mirrors legacy bib behaviour) ──────────────────────────

export function defaultIdentifierConfig(eventSlug: string): IdentifierConfig {
  return {
    eventSlug,
    enabled:             true,
    label:               'Bib Number',     // only a label; never special-cased in code
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
 * Resolves which pool a registration belongs to. Explicit poolId wins; otherwise
 * the first pool whose matchRule matches; otherwise the default pool.
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

  for (const pool of config.pools) {
    const rule = pool.matchRule
    if (!rule) continue
    const candidate =
      rule.by === 'pass'              ? ctx.passId
      : rule.by === 'category'        ? ctx.category
      : rule.by === 'registration_type' ? ctx.registrationType
      : null
    if (candidate && rule.values.includes(candidate)) return pool
  }

  return (
    config.pools.find(p => p.poolId === config.defaultPoolId) ??
    config.pools[0] ??
    { poolId: DEFAULT_POOL_ID, label: 'Default' }
  )
}

// ─── Reuse eligibility (computed live — never a static free list) ────────────

export type LifecyclePhase = 'pre_event' | 'in_event' | 'completed' | 'unknown'

/**
 * Whether a RELEASED lock may be re-issued right now. Pure + deterministic given
 * the current event phase. A consumed/everCheckedIn identifier is NEVER reusable.
 */
export function canReuse(
  lock:   Pick<IdentifierLockDoc, 'state' | 'everCheckedIn'>,
  policy: ReusePolicy,
  phase:  LifecyclePhase,
): boolean {
  if (lock.everCheckedIn) return false          // permanent rule
  if (lock.state !== 'released') return false    // only released values can be reused

  switch (policy) {
    case 'never':                       return false
    case 'manual_only':                 return false   // explicit manual reassignment only
    case 'after_cancel_before_checkin': return true    // released && !everCheckedIn
    case 'before_event_start':          return phase === 'pre_event'
    case 'after_event_completed':       return phase === 'completed'
    default:                            return false
  }
}

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

/** Merge-writes the event's identifier config and bumps its version. */
export async function saveIdentifierConfig(
  eventSlug: string, patch: Partial<IdentifierConfig>, actor: string, reason = 'config updated',
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
  await configRef(eventSlug).set({
    ...next,
    updatedAt: FieldValue.serverTimestamp(),
    ...(isStored ? {} : { createdAt: FieldValue.serverTimestamp() }),
  }, { merge: true })
  await auditConfigChange(eventSlug, actor, reason)
  return next
}

/** Adds or replaces a pool (matched by poolId) in the event config. */
export async function upsertPool(eventSlug: string, pool: IdentifierPool, actor: string): Promise<IdentifierConfig> {
  const { config } = await resolveIdentifierConfig(eventSlug)
  const pools = config.pools.some(p => p.poolId === pool.poolId)
    ? config.pools.map(p => (p.poolId === pool.poolId ? pool : p))
    : [...config.pools, pool]
  return saveIdentifierConfig(eventSlug, { pools }, actor, `pool ${pool.poolId} upserted`)
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
    throw new IdentifierConfigError(`Pool "${poolId}" does not exist.`)
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
      `Pool "${poolId}" still has ${inUse} in-use identifier(s). Release or swap them before deleting the pool.`,
    )
  }

  const pools = config.pools.filter(p => p.poolId !== poolId)
  return saveIdentifierConfig(eventSlug, { pools }, actor, `pool ${poolId} deleted`)
}

// ─── Pool / state statistics (H.3 — read-only aggregation) ──────────────────

export interface PoolStat {
  poolId:     string
  label:      string
  prefix:     string
  padding:    number
  rangeStart: number | null
  rangeEnd:   number | null
  capacity:   number | null
  nextNumber: number | null
  assigned:   number
  consumed:   number
  reserved:   number
  blocked:    number
  retired:    number
  released:   number
  available:  number | null
}

export interface IdentifierStatistics {
  pools: PoolStat[]
  totals: {
    assigned: number; consumed: number; reserved: number; blocked: number
    retired: number; released: number; reusable: number; available: number | null
  }
}

type StateKey = 'assigned' | 'consumed' | 'reserved' | 'blocked' | 'retired' | 'released' | 'available'

/**
 * Real, read-only counts of identifier states per pool, plus next numbers.
 * Reuses the engine's own collections (identifierLocks + identifierCounters) —
 * no allocation logic, no writes, no invented data.
 */
export async function getPoolStatistics(eventSlug: string): Promise<IdentifierStatistics> {
  const { config } = await resolveIdentifierConfig(eventSlug)

  const [lockSnap, counterSnaps] = await Promise.all([
    adminDb.collection('identifierLocks').where('eventSlug', '==', eventSlug).get(),
    Promise.all(config.pools.map(p => adminDb.collection('identifierCounters').doc(`${eventSlug}__${p.poolId}`).get())),
  ])

  const counts = new Map<string, Record<StateKey, number>>()
  const zero = (): Record<StateKey, number> =>
    ({ assigned: 0, consumed: 0, reserved: 0, blocked: 0, retired: 0, released: 0, available: 0 })
  let reusable = 0

  for (const doc of lockSnap.docs) {
    const d = doc.data() as { poolId?: string; state?: string; everCheckedIn?: boolean }
    const poolId = d.poolId ?? config.defaultPoolId
    const state = (d.state ?? 'available') as StateKey
    const rec = counts.get(poolId) ?? counts.set(poolId, zero()).get(poolId)!
    if (state in rec) rec[state] += 1
    if (state === 'released' && d.everCheckedIn !== true) reusable += 1
  }

  const nextByPool = new Map<string, number | null>()
  counterSnaps.forEach((snap, i) => {
    const poolId = config.pools[i]!.poolId
    nextByPool.set(poolId, snap.exists ? ((snap.data()?.nextNumber as number | undefined) ?? null) : null)
  })

  const pools: PoolStat[] = config.pools.map(p => {
    const c = counts.get(p.poolId) ?? zero()
    const rangeStart = p.rangeStart ?? null
    const rangeEnd   = p.rangeEnd ?? null
    const capacity   = rangeStart !== null && rangeEnd !== null ? Math.max(0, rangeEnd - rangeStart + 1) : null
    const used       = c.assigned + c.consumed + c.reserved + c.blocked + c.retired
    return {
      poolId: p.poolId, label: p.label,
      prefix: p.prefix ?? config.format.prefix ?? '',
      padding: p.padding ?? config.format.padding ?? 0,
      rangeStart, rangeEnd, capacity,
      nextNumber: nextByPool.get(p.poolId) ?? null,
      assigned: c.assigned, consumed: c.consumed, reserved: c.reserved,
      blocked: c.blocked, retired: c.retired, released: c.released,
      available: capacity !== null ? Math.max(0, capacity - used) : null,
    }
  })

  const sum = (k: StateKey) => pools.reduce((s, p) => s + (p[k] ?? 0), 0)
  const anyBounded = pools.some(p => p.capacity !== null)
  return {
    pools,
    totals: {
      assigned: sum('assigned'), consumed: sum('consumed'), reserved: sum('reserved'),
      blocked: sum('blocked'), retired: sum('retired'), released: sum('released'), reusable,
      available: anyBounded ? pools.reduce((s, p) => s + (p.available ?? 0), 0) : null,
    },
  }
}
