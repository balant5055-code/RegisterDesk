// Business Configuration Service — server-only. The single runtime entry point for
// reading and updating editable business settings. FOUNDATION ONLY (RD-CONF-01):
// nothing consumes it yet, so it changes no behaviour. It provides load + cache +
// layered resolution + validation + audit/versioning hooks, ready for future
// phases to migrate individual values onto it WITHOUT a code deploy.
//
// Server-only: imports firebase-admin (adminDb). Do NOT import from client code.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  resolveBusinessConfig,
  validateBusinessConfig,
  CONFIG_SECTION_REGISTRY,
  deepMerge,
  type BusinessConfigSections,
  type BusinessConfigSectionKey,
  type DeepPartialSections,
  type StoredBusinessConfig,
} from './businessConfig'

// ─── Firestore layout — ONE document ────────────────────────────────────────────
//
// The whole business configuration lives in a single doc; history snapshots and
// the audit trail hang off it. No per-section collections.
export const SYSTEM_COLLECTION        = 'system'
export const BUSINESS_CONFIG_DOC_ID   = 'businessConfiguration'   // system/businessConfiguration
export const CONFIG_HISTORY_SUBCOLLECTION = 'history'
export const CONFIG_AUDIT_COLLECTION  = 'configurationAudit'

const CACHE_TTL_MS = 60_000   // never read Firestore more than once per minute

// ─── Types ──────────────────────────────────────────────────────────────────────

/** Context supplied with every update — powers the audit trail (Step 7). */
export interface ConfigUpdateContext {
  updatedBy: string   // actor uid
  reason:    string   // why the change was made
}

export interface ConfigAuditEntry {
  section:   BusinessConfigSectionKey
  before:    unknown
  after:     unknown
  updatedBy: string
  reason:    string
  version:   number
}

interface ConfigCache {
  stored:     DeepPartialSections
  version:    number
  loadedAtMs: number
}

// ─── Service ────────────────────────────────────────────────────────────────────

export class BusinessConfigurationService {
  private cache: ConfigCache | null = null
  // Runtime overrides — highest-priority layer. In-memory only (per server
  // instance); use for emergency kill-switches / tests. Never persisted.
  private runtimeOverrides: DeepPartialSections = {}

  private docRef() {
    return adminDb.collection(SYSTEM_COLLECTION).doc(BUSINESS_CONFIG_DOC_ID)
  }

  private now(): number {
    return Date.now()
  }

  private isFresh(): boolean {
    return this.cache !== null && this.now() - this.cache.loadedAtMs < CACHE_TTL_MS
  }

  /** Read the stored config doc (sections + version) into the cache. Fail-safe:
   *  on any error the cache is left empty so resolution falls back to code defaults. */
  private async loadStored(force = false): Promise<ConfigCache> {
    if (!force && this.isFresh()) return this.cache!
    try {
      const snap = await this.docRef().get()
      const data = (snap.exists ? snap.data() : {}) as Partial<StoredBusinessConfig>
      const { _meta, ...sections } = data ?? {}
      this.cache = {
        stored:     sections as DeepPartialSections,
        version:    typeof _meta?.version === 'number' ? _meta.version : 0,
        loadedAtMs: this.now(),
      }
      return this.cache
    } catch {
      // Do not cache the failure — retry on the next call. Resolve from defaults.
      return { stored: {}, version: this.cache?.version ?? 0, loadedAtMs: 0 }
    }
  }

  /** Full resolved configuration (runtime override → firestore → code default). */
  async getConfig(): Promise<BusinessConfigSections> {
    const { stored } = await this.loadStored()
    return resolveBusinessConfig(stored, this.runtimeOverrides)
  }

  /** One resolved section. Never returns undefined. */
  async getSection<K extends BusinessConfigSectionKey>(key: K): Promise<BusinessConfigSections[K]> {
    return (await this.getConfig())[key]
  }

  /** One resolved value within a section. Never returns undefined. */
  async getValue<K extends BusinessConfigSectionKey, F extends keyof BusinessConfigSections[K]>(
    key: K, field: F,
  ): Promise<BusinessConfigSections[K][F]> {
    return (await this.getSection(key))[field]
  }

  /** Current committed config version (0 when never written). */
  async getVersion(): Promise<number> {
    return (await this.loadStored()).version
  }

  // ─── Cache control (Step 5) ─────────────────────────────────────────────────────

  /** Drop the cache so the next read re-fetches Firestore. */
  invalidateCache(): void {
    this.cache = null
  }

  // ─── Runtime overrides (highest-priority layer) ─────────────────────────────────

  setRuntimeOverride<K extends BusinessConfigSectionKey>(key: K, patch: Partial<BusinessConfigSections[K]>): void {
    this.runtimeOverrides = deepMerge(this.runtimeOverrides, { [key]: patch } as DeepPartialSections)
  }

  clearRuntimeOverrides(): void {
    this.runtimeOverrides = {}
  }

  // ─── Updates + validation + audit + versioning (Steps 6–8) ──────────────────────

  /**
   * Validate and persist a partial update to one section. The patch is validated
   * (merged onto the current resolved section) BEFORE any write — invalid values
   * are rejected, never stored. On success the version is bumped, a full snapshot
   * is written to the history subcollection (for future rollback), and an audit
   * entry (before/after/who/when/reason) is recorded. The cache is invalidated.
   */
  async updateSection<K extends BusinessConfigSectionKey>(
    key: K,
    patch: Partial<BusinessConfigSections[K]>,
    ctx: ConfigUpdateContext,
  ): Promise<{ version: number; section: BusinessConfigSections[K] }> {
    if (!ctx?.updatedBy || !ctx?.reason) {
      throw new Error('updateSection requires ctx.updatedBy and ctx.reason (audit trail)')
    }

    // Validate the resulting section against its schema before persisting.
    const current   = await this.getSection(key)
    const candidate = deepMerge(current, patch)
    const validation = validateBusinessConfig({ [key]: candidate } as Partial<BusinessConfigSections>)
    if (!validation.valid) {
      throw new Error(`Invalid configuration for section '${key}': ${validation.errors.join('; ')}`)
    }
    // Defensive: candidate must satisfy the section's own validator too.
    const sectionCheck = CONFIG_SECTION_REGISTRY[key].validate(candidate)
    if (!sectionCheck.valid) {
      throw new Error(`Invalid configuration for section '${key}': ${sectionCheck.errors.join('; ')}`)
    }

    const nowIso = new Date().toISOString()
    const docRef = this.docRef()

    const { before, after, newVersion } = await adminDb.runTransaction(async (txn) => {
      const snap = await txn.get(docRef)
      const data = (snap.exists ? snap.data() : {}) as Partial<StoredBusinessConfig>
      const prevVersion = typeof data._meta?.version === 'number' ? data._meta.version : 0
      const beforeSection = (data as Record<string, unknown>)[key]
      const version = prevVersion + 1

      // Merge the patch into the stored section and stamp meta. set(merge:true)
      // deep-merges the section map, so only changed keys are written.
      txn.set(docRef, {
        [key]: patch,
        _meta: { version, updatedAt: nowIso, updatedBy: ctx.updatedBy },
      }, { merge: true })

      // Version snapshot for future rollback (full resolved-stored section value).
      const historyRef = docRef.collection(CONFIG_HISTORY_SUBCOLLECTION).doc(String(version))
      txn.set(historyRef, {
        version, section: key, value: candidate,
        updatedBy: ctx.updatedBy, reason: ctx.reason, createdAt: FieldValue.serverTimestamp(),
      })

      return { before: beforeSection ?? null, after: candidate, newVersion: version }
    })

    // Audit hook (before/after/who/when/reason) — fire-and-forget; never blocks.
    void this.writeAudit({ section: key, before, after, updatedBy: ctx.updatedBy, reason: ctx.reason, version: newVersion })

    this.invalidateCache()
    return { version: newVersion, section: candidate }
  }

  /** Audit hook. Records one immutable entry per committed change. */
  private async writeAudit(entry: ConfigAuditEntry): Promise<void> {
    try {
      await adminDb.collection(CONFIG_AUDIT_COLLECTION).add({
        ...entry,
        at: FieldValue.serverTimestamp(),
      })
    } catch {
      // Audit must never block or throw into the caller.
    }
  }

  /** Read the version-snapshot history, most recent first (for future rollback UI). */
  async listHistory(limit = 50): Promise<Array<Record<string, unknown>>> {
    const qs = await this.docRef()
      .collection(CONFIG_HISTORY_SUBCOLLECTION)
      .orderBy('version', 'desc')
      .limit(limit)
      .get()
    return qs.docs.map(d => d.data())
  }

  /** Read the audit trail, most recent first. */
  async listAudit(limit = 50): Promise<Array<Record<string, unknown>>> {
    const qs = await adminDb.collection(CONFIG_AUDIT_COLLECTION)
      .orderBy('at', 'desc')
      .limit(limit)
      .get()
    return qs.docs.map(d => d.data())
  }
}

/** Shared singleton — cache lives for the lifetime of the server instance. */
export const businessConfig = new BusinessConfigurationService()
