// Phase H.1.5A — Migration Safety Layer: the dry-run analyzer.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ABSOLUTELY READ-ONLY.                                                      ║
// ║  This module performs ONLY Firestore reads (.get / query .get).            ║
// ║  It MUST NOT write, update, delete, batch, run a transaction, backfill,    ║
// ║  create locks, or mutate any identifier / registration. Every "repair" it  ║
// ║  produces is a PLAN (description only) — never executed here.               ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Server-only — uses the Firebase Admin SDK.

import { FieldPath } from 'firebase-admin/firestore'
import { adminDb }   from '@/lib/firebase/admin'
import type {
  MigrationAuditReport,
  EventMigrationReport,
  GlobalMigrationSummary,
  IdentifierIssue,
  RepairAction,
  CategoryVariantGroup,
  MigrationComplexity,
} from './types'

// ─── Internal row shapes (read projections) ─────────────────────────────────

interface RegRow {
  id:            string
  bibNumber:     string | null
  bibCategory:   string | null
  status:        string
  paymentStatus: string
  checkedIn:     boolean
}

interface LockRow {
  lockId:         string   // bibLocks doc id: `${eventSlug}__${bibNumber}`
  eventSlug:      string
  bibNumber:      string
  registrationId: string | null
}

interface EventMeta {
  eventName:    string
  eventType:    string | null
  organizerUid: string | null
}

// ─── Constants ──────────────────────────────────────────────────────────────

const REG_BATCH       = 500
const NUMERIC_RE      = /^\d+$/
const TERMINAL_STATUS = new Set(['cancelled', 'rejected'])

// Readiness penalty weights (per occurrence). Tuned so a small number of issues
// maps intuitively to a high score (e.g. 2 duplicates + 1 orphan ⇒ ~97%).
const W = {
  blockingDuplicate: 1.5,
  lockConflict:      2,
  brokenReference:   2,
  nonNumeric:        1,
  dirtyCategory:     1,
  orphanAssignment:  0.5,
  staleLock:         0.5,
  outOfRange:        0.25,
} as const

// ─── Small helpers ──────────────────────────────────────────────────────────

function bibOf(r: RegRow): string | null {
  const v = (r.bibNumber ?? '').trim()
  return v.length > 0 ? v : null
}

function isTerminal(r: RegRow): boolean {
  return TERMINAL_STATUS.has(r.status) || r.paymentStatus === 'refunded'
}

function canonicalCategory(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// ─── Readers (READ-ONLY) ────────────────────────────────────────────────────

/** Distinct event slugs that show any bib activity (counters ∪ locks). */
async function discoverBibEventSlugs(scopeSlug?: string): Promise<Set<string>> {
  if (scopeSlug) return new Set([scopeSlug])

  const slugs = new Set<string>()

  const counterSnap = await adminDb.collection('bibCounters').get()
  for (const doc of counterSnap.docs) slugs.add(doc.id)

  const lockSnap = await adminDb.collection('bibLocks').get()
  for (const doc of lockSnap.docs) {
    const slug = (doc.data().eventSlug as string | undefined) ?? doc.id.split('__')[0]
    if (slug) slugs.add(slug)
  }

  return slugs
}

/** All bib locks for one event (read-only). */
async function loadLocks(slug: string): Promise<LockRow[]> {
  const snap = await adminDb.collection('bibLocks').where('eventSlug', '==', slug).get()
  return snap.docs.map(doc => {
    const d = doc.data() as Record<string, unknown>
    return {
      lockId:         doc.id,
      eventSlug:      slug,
      bibNumber:      String(d.bibNumber ?? doc.id.split('__').slice(1).join('__')),
      registrationId: typeof d.registrationId === 'string' ? d.registrationId : null,
    }
  })
}

/** nextBib for one event, or null when no counter exists (read-only). */
async function loadCounter(slug: string): Promise<number | null> {
  const snap = await adminDb.collection('bibCounters').doc(slug).get()
  if (!snap.exists) return null
  const n = snap.data()?.nextBib
  return typeof n === 'number' ? n : null
}

/** Event display metadata (read-only). Tolerates a missing events doc. */
async function loadEventMeta(slug: string): Promise<EventMeta> {
  const snap = await adminDb.collection('events').doc(slug).get()
  if (!snap.exists) return { eventName: slug, eventType: null, organizerUid: null }
  const d    = snap.data() as Record<string, unknown>
  const ed   = d.eventDetails as Record<string, unknown> | undefined
  const info = ed?.info as Record<string, unknown> | undefined
  const name = typeof info?.name === 'string' && info.name.trim() ? info.name.trim() : slug
  return {
    eventName:    name,
    eventType:    typeof d.eventType === 'string' ? d.eventType : null,
    organizerUid: typeof d.uid === 'string' ? d.uid : null,
  }
}

/** All registrations for one event, projected to the fields we need (read-only). */
async function loadRegs(slug: string): Promise<RegRow[]> {
  const base = adminDb
    .collection('registrations')
    .where('eventSlug', '==', slug)
    .select('bibNumber', 'bibCategory', 'status', 'paymentStatus', 'checkedIn')
    .orderBy(FieldPath.documentId())

  const rows: RegRow[] = []
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined

  for (;;) {
    let q = base.limit(REG_BATCH)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    if (snap.empty) break

    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>
      rows.push({
        id:            doc.id,
        bibNumber:     typeof d.bibNumber === 'string' ? d.bibNumber : null,
        bibCategory:   typeof d.bibCategory === 'string' ? d.bibCategory : null,
        status:        typeof d.status === 'string' ? d.status : 'unknown',
        paymentStatus: typeof d.paymentStatus === 'string' ? d.paymentStatus : 'unknown',
        checkedIn:     d.checkedIn === true,
      })
    }

    if (snap.size < REG_BATCH) break
    cursor = snap.docs[snap.docs.length - 1]
  }

  return rows
}

// ─── Per-event analysis (pure; no I/O) ──────────────────────────────────────

function analyzeEvent(
  slug:    string,
  meta:    EventMeta,
  regs:    RegRow[],
  locks:   LockRow[],
  nextBib: number | null,
): EventMigrationReport {
  const issues:     IdentifierIssue[] = []
  const regById = new Map<string, RegRow>(regs.map(r => [r.id, r]))

  const assigned = regs.filter(r => bibOf(r) !== null)
  const active   = assigned.filter(r => !isTerminal(r))

  // ── Duplicates among ACTIVE registrations (blocking) ──
  const byValueActive = new Map<string, RegRow[]>()
  for (const r of active) {
    const v   = bibOf(r)!
    const arr = byValueActive.get(v)
    if (arr) arr.push(r)
    else byValueActive.set(v, [r])
  }
  let duplicateCount = 0
  for (const [value, group] of byValueActive) {
    if (group.length > 1) {
      duplicateCount++
      issues.push({
        type: 'duplicate_identifier', severity: 'blocking',
        message: `Identifier "${value}" is assigned to ${group.length} active registrations.`,
        value, registrationIds: group.map(g => g.id), lockIds: [], autoRepairable: false,
      })
    }
  }

  // ── Numeric collisions ("0042" vs "42") among ACTIVE regs ──
  const byNumericActive = new Map<number, Set<string>>()
  for (const r of active) {
    const v = bibOf(r)!
    if (!NUMERIC_RE.test(v)) continue
    const n   = parseInt(v, 10)
    const set = byNumericActive.get(n)
    if (set) set.add(v)
    else byNumericActive.set(n, new Set([v]))
  }
  let numericCollisions = 0
  for (const [n, variants] of byNumericActive) {
    if (variants.size > 1) {
      numericCollisions++
      const variantList = [...variants]
      const affected = active.filter(r => variantList.includes(bibOf(r)!)).map(r => r.id)
      issues.push({
        type: 'numeric_collision', severity: 'blocking',
        message: `Values ${variantList.map(v => `"${v}"`).join(' / ')} all resolve to number ${n}.`,
        value: String(n), registrationIds: affected, lockIds: [], autoRepairable: false,
      })
    }
  }

  // ── Non-numeric / custom values (manual review) ──
  let nonNumericCount = 0
  for (const r of assigned) {
    const v = bibOf(r)!
    if (!NUMERIC_RE.test(v)) {
      nonNumericCount++
      issues.push({
        type: 'non_numeric_value', severity: 'manual_review',
        message: `Non-numeric identifier "${v}" — must be classified (custom type) before migration.`,
        value: v, registrationIds: [r.id], lockIds: [], autoRepairable: false,
      })
    }
  }

  // ── Allocations on terminal registrations (auto-repairable orphans) ──
  let cancelledAllocations = 0
  const lockByValue = new Map<string, LockRow>()
  for (const l of locks) lockByValue.set(l.bibNumber, l)

  for (const r of assigned) {
    if (!isTerminal(r)) continue
    cancelledAllocations++
    const v       = bibOf(r)!
    const lock    = lockByValue.get(v)
    const refunded = r.paymentStatus === 'refunded'
    issues.push({
      type: refunded ? 'refunded_allocation' : 'cancelled_allocation', severity: 'auto_repairable',
      message: `Identifier "${v}" is still held by a ${refunded ? 'refunded' : r.status} registration and should be released.`,
      value: v, registrationIds: [r.id],
      lockIds: lock && lock.registrationId === r.id ? [lock.lockId] : [],
      autoRepairable: true,
    })
  }

  // ── Lock integrity ──
  let brokenReferences = 0
  let staleLocks       = 0
  let lockConflicts    = 0

  for (const l of locks) {
    const reg = l.registrationId ? regById.get(l.registrationId) : undefined

    // broken reference: lock points at a non-existent registration
    if (l.registrationId && !reg) {
      brokenReferences++
      issues.push({
        type: 'broken_reference', severity: 'auto_repairable',
        message: `Lock for "${l.bibNumber}" references missing registration ${l.registrationId}.`,
        value: l.bibNumber, registrationIds: [l.registrationId], lockIds: [l.lockId], autoRepairable: true,
      })
      continue
    }

    if (reg) {
      const regBib = bibOf(reg)
      // stale lock: the owning registration no longer holds this value
      if (regBib !== l.bibNumber) {
        staleLocks++
        issues.push({
          type: 'stale_lock', severity: 'auto_repairable',
          message: `Lock "${l.bibNumber}" disagrees with registration ${reg.id} (now holds ${regBib ?? 'no bib'}).`,
          value: l.bibNumber, registrationIds: [reg.id], lockIds: [l.lockId], autoRepairable: true,
        })
      }
    }

    // conflict: an ACTIVE registration holds this value but the lock names a different owner
    const activeHolders = active.filter(r => bibOf(r) === l.bibNumber)
    const otherOwner    = activeHolders.find(r => r.id !== l.registrationId)
    if (otherOwner && l.registrationId) {
      lockConflicts++
      issues.push({
        type: 'lock_conflict', severity: 'blocking',
        message: `Value "${l.bibNumber}" is locked to ${l.registrationId} but also held by ${otherOwner.id}.`,
        value: l.bibNumber,
        registrationIds: [l.registrationId, otherOwner.id], lockIds: [l.lockId], autoRepairable: false,
      })
    }
  }

  // ── Categories: detect dirty / inconsistent labels ──
  const canonicalToVariants = new Map<string, Set<string>>()
  for (const r of assigned) {
    const raw = (r.bibCategory ?? '').trim()
    if (!raw) continue
    const key = canonicalCategory(raw)
    const set = canonicalToVariants.get(key)
    if (set) set.add(raw)
    else canonicalToVariants.set(key, new Set([raw]))
  }
  const categoryVariants: CategoryVariantGroup[] = []
  let dirtyCategoryGroups = 0
  for (const [canonical, variants] of canonicalToVariants) {
    if (variants.size > 1) {
      dirtyCategoryGroups++
      categoryVariants.push({ canonical, variants: [...variants] })
      issues.push({
        type: 'invalid_category', severity: 'manual_review',
        message: `Category "${canonical}" has inconsistent labels: ${[...variants].map(v => `"${v}"`).join(', ')}.`,
        value: null, registrationIds: [], lockIds: [], autoRepairable: false,
      })
    }
  }
  const distinctCategories = [...canonicalToVariants.keys()].sort()

  // ── Sequential range: out-of-range + missing (gaps) ──
  let outOfRange = 0
  const numericInRange = new Set<number>()
  let rangeMin: number | null = null
  let rangeMax: number | null = null

  for (const r of active) {
    const v = bibOf(r)!
    if (!NUMERIC_RE.test(v)) continue
    const n = parseInt(v, 10)
    rangeMin = rangeMin === null ? n : Math.min(rangeMin, n)
    rangeMax = rangeMax === null ? n : Math.max(rangeMax, n)
    if (nextBib !== null) {
      if (n < 1 || n > nextBib - 1) {
        outOfRange++
        issues.push({
          type: 'out_of_range', severity: 'info',
          message: `Identifier ${n} is outside the issued counter range [1, ${nextBib - 1}].`,
          value: v, registrationIds: [r.id], lockIds: [], autoRepairable: false,
        })
      } else {
        numericInRange.add(n)
      }
    }
  }

  let missingInRange = 0
  if (nextBib !== null && nextBib > 1) {
    missingInRange = (nextBib - 1) - numericInRange.size
    if (missingInRange < 0) missingInRange = 0
  }

  // ── Aggregate counts ──
  const orphanCount  = cancelledAllocations + staleLocks + brokenReferences
  const invalidCount = nonNumericCount + dirtyCategoryGroups + outOfRange
  const conflictCount = lockConflicts
  const checkedInAllocations = assigned.filter(r => r.checkedIn).length

  // ── Repair plan (PLAN ONLY) ──
  const repairPlan = buildRepairPlan(slug, issues)

  // ── Readiness score ──
  const penalty =
    duplicateCount       * W.blockingDuplicate +
    numericCollisions    * W.blockingDuplicate +
    lockConflicts        * W.lockConflict +
    brokenReferences     * W.brokenReference +
    nonNumericCount      * W.nonNumeric +
    dirtyCategoryGroups  * W.dirtyCategory +
    cancelledAllocations * W.orphanAssignment +
    staleLocks           * W.staleLock +
    outOfRange           * W.outOfRange

  const readinessScore = Math.max(0, Math.round(100 - penalty))

  const readinessReasons: string[] = []
  if (duplicateCount)       readinessReasons.push(`${duplicateCount} duplicate identifier${duplicateCount > 1 ? 's' : ''}`)
  if (numericCollisions)    readinessReasons.push(`${numericCollisions} numeric collision${numericCollisions > 1 ? 's' : ''}`)
  if (lockConflicts)        readinessReasons.push(`${lockConflicts} lock conflict${lockConflicts > 1 ? 's' : ''}`)
  if (brokenReferences)     readinessReasons.push(`${brokenReferences} broken reference${brokenReferences > 1 ? 's' : ''}`)
  if (cancelledAllocations) readinessReasons.push(`${cancelledAllocations} orphaned allocation${cancelledAllocations > 1 ? 's' : ''}`)
  if (staleLocks)           readinessReasons.push(`${staleLocks} stale lock${staleLocks > 1 ? 's' : ''}`)
  if (nonNumericCount)      readinessReasons.push(`${nonNumericCount} non-numeric value${nonNumericCount > 1 ? 's' : ''}`)
  if (dirtyCategoryGroups)  readinessReasons.push(`${dirtyCategoryGroups} inconsistent categor${dirtyCategoryGroups > 1 ? 'ies' : 'y'}`)
  if (outOfRange)           readinessReasons.push(`${outOfRange} out-of-range identifier${outOfRange > 1 ? 's' : ''}`)

  // ── Verdicts ──
  const hasBlocking = duplicateCount > 0 || numericCollisions > 0 || lockConflicts > 0
  const hasManual   = nonNumericCount > 0 || dirtyCategoryGroups > 0
  const hasAuto     = cancelledAllocations > 0 || staleLocks > 0 || brokenReferences > 0
  const safeToMigrate = !hasBlocking

  let complexity: MigrationComplexity = 'trivial'
  if (hasBlocking)      complexity = 'high'
  else if (hasManual)   complexity = 'medium'
  else if (hasAuto)     complexity = 'low'

  return {
    eventSlug: slug,
    eventName: meta.eventName,
    eventType: meta.eventType,
    organizerUid: meta.organizerUid,

    totalRegistrations:   regs.length,
    assignedIdentifiers:  assigned.length,
    freeIdentifiers:      missingInRange,
    duplicateCount,
    orphanCount,
    invalidCount,
    cancelledAllocations,
    checkedInAllocations,
    conflictCount,

    distinctCategories,
    categoryVariants,

    counterNextBib: nextBib,
    rangeMin,
    rangeMax,
    missingInRange,

    complexity,
    safeToMigrate,
    readinessScore,
    readinessReasons: readinessReasons.length ? readinessReasons : ['No issues detected'],

    issues,
    repairPlan,
  }
}

// ─── Repair planner (descriptions only — NEVER executed) ────────────────────

function buildRepairPlan(slug: string, issues: IdentifierIssue[]): RepairAction[] {
  const plan: RepairAction[] = []

  for (const issue of issues) {
    const regPaths  = issue.registrationIds.map(id => `registrations/${id}`)
    const lockPaths = issue.lockIds.map(id => `bibLocks/${id}`)

    switch (issue.type) {
      case 'cancelled_allocation':
      case 'refunded_allocation':
      case 'orphaned_assignment':
        plan.push({
          repairType: 'release_orphan_bib', title: 'Release orphaned identifier',
          severity: 'auto_repairable', affectedDocuments: [...regPaths, ...lockPaths],
          exactAction: `WOULD clear bibNumber/bibCategory on ${regPaths.join(', ')}${lockPaths.length ? ` and delete ${lockPaths.join(', ')}` : ''}.`,
          estimatedImpact: `Frees identifier "${issue.value}". The registration is terminal, so no active participant is affected.`,
          automatic: true,
        })
        break
      case 'broken_reference':
      case 'stale_lock':
        plan.push({
          repairType: 'delete_stale_lock', title: 'Delete stale / dangling lock',
          severity: 'auto_repairable', affectedDocuments: lockPaths,
          exactAction: `WOULD delete ${lockPaths.join(', ')} (lock no longer reflects a live assignment).`,
          estimatedImpact: `Removes a dangling lock for "${issue.value}". No registration loses an active identifier.`,
          automatic: true,
        })
        break
      case 'lock_conflict':
        plan.push({
          repairType: 'reconcile_lock_conflict', title: 'Reconcile competing owners',
          severity: 'blocking', affectedDocuments: [...regPaths, ...lockPaths],
          exactAction: `MANUAL: decide which registration keeps "${issue.value}"; the other must be reassigned.`,
          estimatedImpact: `Two participants currently claim "${issue.value}". Requires an organizer decision before migration.`,
          automatic: false,
        })
        break
      case 'duplicate_identifier':
      case 'numeric_collision':
        plan.push({
          repairType: 'resolve_duplicate', title: 'Resolve duplicate identifier',
          severity: 'blocking', affectedDocuments: regPaths,
          exactAction: `MANUAL: reassign all but one of ${regPaths.join(', ')} so "${issue.value}" is unique.`,
          estimatedImpact: `Multiple active participants share "${issue.value}". One keeps it; the rest need new identifiers.`,
          automatic: false,
        })
        break
      case 'non_numeric_value':
      case 'invalid_custom_identifier':
        plan.push({
          repairType: 'classify_custom_identifier', title: 'Classify custom identifier',
          severity: 'manual_review', affectedDocuments: regPaths,
          exactAction: `MANUAL: confirm "${issue.value}" is an intended custom identifier (set engine type = custom).`,
          estimatedImpact: `Value is preserved as-is once classified. No data is destroyed.`,
          automatic: false,
        })
        break
      case 'invalid_category':
        plan.push({
          repairType: 'normalize_category', title: 'Map inconsistent categories',
          severity: 'manual_review', affectedDocuments: [`events/${slug}/identifierPools/*`],
          exactAction: `MANUAL: map the variant labels to one canonical pool category.`,
          estimatedImpact: `Cleans category data before pool creation. Historical labels are preserved on existing records.`,
          automatic: false,
        })
        break
      case 'out_of_range':
      case 'missing_identifier':
      case 'invalid_pool':
        // Informational — no repair action required.
        break
    }
  }

  return plan
}

// ─── Global summary ─────────────────────────────────────────────────────────

function buildSummary(events: EventMigrationReport[]): GlobalMigrationSummary {
  let totalRegistrations = 0
  let totalIdentifiers   = 0
  let totalDuplicates    = 0
  let totalConflicts     = 0
  let totalOrphans       = 0
  let totalInvalid       = 0
  let automaticRepairs   = 0
  let manualRepairs      = 0
  let eventsSafe         = 0
  let weightedScore      = 0
  let weightTotal        = 0

  for (const e of events) {
    totalRegistrations += e.totalRegistrations
    totalIdentifiers   += e.assignedIdentifiers
    totalDuplicates    += e.duplicateCount
    totalConflicts     += e.conflictCount
    totalOrphans       += e.orphanCount
    totalInvalid       += e.invalidCount
    for (const r of e.repairPlan) {
      if (r.automatic) automaticRepairs++
      else manualRepairs++
    }
    if (e.safeToMigrate) eventsSafe++

    // Registration-weighted readiness (min weight 1 so empty events still count).
    const w = Math.max(1, e.totalRegistrations)
    weightedScore += e.readinessScore * w
    weightTotal   += w
  }

  const totalRepairActions = automaticRepairs + manualRepairs
  const globalReadinessScore = weightTotal > 0 ? round1(weightedScore / weightTotal) : 100

  return {
    totalEvents:          events.length,
    totalRegistrations,
    totalIdentifiers,
    totalDuplicates,
    totalConflicts,
    totalOrphans,
    totalInvalid,
    totalRepairActions,
    automaticRepairs,
    manualRepairs,
    eventsSafeToMigrate:  eventsSafe,
    eventsNeedingReview:  events.length - eventsSafe,
    globalReadinessScore,
  }
}

// ─── Public entry point ─────────────────────────────────────────────────────

export interface AuditOptions {
  /** Limit the audit to a single event slug. Omit for a platform-wide scan. */
  eventSlug?: string
  /** ISO timestamp for the report (passed in to keep this function deterministic). */
  generatedAt: string
}

/**
 * Runs the complete READ-ONLY migration audit and returns a structured report.
 * Performs no writes of any kind.
 */
export async function runMigrationAudit(opts: AuditOptions): Promise<MigrationAuditReport> {
  const scopeSlug = opts.eventSlug?.trim() || undefined
  const slugs     = [...(await discoverBibEventSlugs(scopeSlug))].sort()

  const events: EventMigrationReport[] = []
  for (const slug of slugs) {
    const [meta, regs, locks, nextBib] = await Promise.all([
      loadEventMeta(slug),
      loadRegs(slug),
      loadLocks(slug),
      loadCounter(slug),
    ])
    events.push(analyzeEvent(slug, meta, regs, locks, nextBib))
  }

  // Worst-first ordering surfaces the events that need attention.
  events.sort((a, b) => a.readinessScore - b.readinessScore || b.totalRegistrations - a.totalRegistrations)

  return {
    generatedAt: opts.generatedAt,
    readOnly:    true,
    scope:       scopeSlug ? 'event' : 'platform',
    summary:     buildSummary(events),
    events,
  }
}
