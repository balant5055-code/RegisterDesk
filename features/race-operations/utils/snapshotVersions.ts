// RD-RACEOPS-02G · Snapshot version allocation — PURE.
//
// ═══ WHY THIS EXISTS ═══════════════════════════════════════════════════════════
// The next snapshot version used to be `doc.version + 1`, computed from the LIVE pointer.
// Rollback moves that pointer backwards, so after `live v6 → rollback → v4` the next build
// was allocated v5 — a version that already had entries (an abandoned lane, or a version
// that was actually published). New rows were written into the old namespace, the public
// leaderboard served the union, and `versions[]` grew a duplicate record that made a later
// rollback ambiguous (02F, P1).
//
// A version number is an ALLOCATION, not a pointer. Once handed out it is never handed out
// again, whatever the live pointer does afterwards. `maxVersion` on the snapshot document
// is that allocator; these helpers derive it safely for documents written before it
// existed, and detect the one corruption this module must never make worse.

export interface VersionAllocationSource {
  /** The live pointer. */
  version?:        number | null
  /** RD-RACEOPS-02G · highest version ever allocated. Absent on documents written before it. */
  maxVersion?:     number | null
  /** A lane in flight (or abandoned) also holds an allocated number. */
  pendingVersion?: number | null
  /** Every version that ever went live. */
  versions?:       readonly { version: number }[] | null
}

const asVersion = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0

/**
 * The highest version this race has ever allocated, from every field that can hold one.
 *
 * On a document that already carries `maxVersion` this is `maxVersion` (the other fields
 * can never exceed it). On a legacy document it is derived from the live pointer, the
 * pending lane and the published history — bounded by `versions[]`, which is a handful of
 * records on the document itself, never a subcollection scan.
 */
export function highestAllocatedVersion(doc: VersionAllocationSource): number {
  let highest = Math.max(asVersion(doc.maxVersion), asVersion(doc.version), asVersion(doc.pendingVersion))
  for (const record of doc.versions ?? []) highest = Math.max(highest, asVersion(record?.version))
  return highest
}

/** The version a NEW build must receive. Strictly greater than anything ever allocated. */
export function nextAllocatableVersion(doc: VersionAllocationSource): number {
  return highestAllocatedVersion(doc) + 1
}

/**
 * The first version number that appears more than once in a history, or null when the
 * history is unique. A duplicate means two publishes wrote the same namespace — the exact
 * corruption 02F reproduced — and every write that could deepen it must fail closed.
 */
export function findDuplicateVersion(versions: readonly { version: number }[] | null | undefined): number | null {
  const seen = new Set<number>()
  for (const record of versions ?? []) {
    const v = asVersion(record?.version)
    if (seen.has(v)) return v
    seen.add(v)
  }
  return null
}

/** The one message every fail-closed path on a corrupt history shares. */
export function inconsistentHistoryMessage(duplicate: number): string {
  return `This race's version history is inconsistent (version ${duplicate} is recorded more than once). Results cannot be published or restored until it is repaired.`
}

/** True when `version` already has a record in `versions[]`. */
export function versionAlreadyPublished(
  versions: readonly { version: number }[] | null | undefined, version: number,
): boolean {
  return (versions ?? []).some(r => asVersion(r?.version) === version)
}
