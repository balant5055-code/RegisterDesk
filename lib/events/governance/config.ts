// Publish Governance config resolver (EA-4 S1). Server-only.
//
// Reuses the established platformSettings/* config-doc pattern (see
// lib/platform/publishing.ts). Thresholds live in Business Configuration, never
// hardcoded at call sites — this module supplies safe defaults and merges any
// stored overrides. Fail-safe: any read error → defaults.

import { adminDb } from '@/lib/firebase/admin'
import type { GovernanceConfig } from './types'

export const GOVERNANCE_VERSION = 1

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = {
  enabled:                 true,
  majorFields:             ['eventType', 'eventSubtype', 'city', 'startDate'],
  moderateFields:          ['name', 'venue'],
  nameSimilarityThreshold: 0.6,
}

export async function getGovernanceConfig(): Promise<GovernanceConfig> {
  try {
    const snap = await adminDb.collection('platformSettings').doc('publishGovernance').get()
    if (!snap.exists) return DEFAULT_GOVERNANCE_CONFIG
    const d = (snap.data() ?? {}) as Partial<GovernanceConfig>
    return {
      enabled:                 typeof d.enabled === 'boolean' ? d.enabled : DEFAULT_GOVERNANCE_CONFIG.enabled,
      majorFields:             Array.isArray(d.majorFields) && d.majorFields.length ? d.majorFields : DEFAULT_GOVERNANCE_CONFIG.majorFields,
      moderateFields:          Array.isArray(d.moderateFields) && d.moderateFields.length ? d.moderateFields : DEFAULT_GOVERNANCE_CONFIG.moderateFields,
      nameSimilarityThreshold: typeof d.nameSimilarityThreshold === 'number' ? d.nameSimilarityThreshold : DEFAULT_GOVERNANCE_CONFIG.nameSimilarityThreshold,
    }
  } catch {
    return DEFAULT_GOVERNANCE_CONFIG
  }
}
