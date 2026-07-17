// Publish Governance — shared types (EA-4 S1). Client-safe: NO Firebase/SDK import.
//
// The governance layer binds a purchased license to ONE immutable event identity.
// It is intentionally decoupled from commercial license metadata (eventLicenses):
// the baseline is event-owned governance data keyed by the immutable Event ID
// (= draftId; the slug is mutable and must NOT be used as the binding key).

export type IdentityChangeLevel = 'none' | 'minor' | 'moderate' | 'major'

/** The identity-defining fields captured at first publish and compared thereafter. */
export interface EventIdentity {
  eventType:    string
  eventSubtype: string   // category
  city:         string
  startDate:    string
  name:         string
  venue:        string
}

/** Admin governance overrides — stored on the baseline (governance domain), set by
 *  the admin console with a reason + audit. All optional-by-absence. */
export interface GovernanceOverrides {
  publish?:            boolean   // force-publish: bypass ALL governance
  identity?:           boolean   // bypass identity validation
  registrationSafety?: boolean   // bypass the registration-safety escalation
  setBy?:              string
  setAt?:              unknown    // Firestore Timestamp
  reason?:             string
}

/**
 * publishBaselines/{eventId}  (eventId = draftId — the permanent Event ID)
 *
 * Immutable per-event governance baseline. Future-proof: new governance fields can
 * be added without redesign, gated by `governanceVersion`.
 */
export interface PublishBaseline {
  eventId:           string
  governanceVersion: number
  identity:          EventIdentity                 // immutable snapshot (captured at first governed publish)
  firstPublishedAt:  unknown                        // Firestore Timestamp
  publishCount:      number
  licenseRef:        { orderId: string | null; tier: string; slug: string }  // loose ref to the commercial license
  overrides?:        GovernanceOverrides
  createdAt:         unknown
  updatedAt:         unknown
}

export interface IdentityClassification {
  level:          IdentityChangeLevel
  changedFields:  string[]
  majorFields:    string[]
  moderateFields: string[]
}

export type GovernanceDecision = 'allow' | 'warn' | 'block'

export interface GovernanceResult {
  ok:                   boolean            // publish may proceed (allow, or warn+confirmed)
  decision:             GovernanceDecision
  firstPublish:         boolean            // no baseline existed → caller lazily captures it
  level:                IdentityChangeLevel
  changedFields:        string[]
  requiresConfirmation: boolean            // moderate change on an activity-free event
  suggestDuplicate:     boolean            // block → offer Duplicate as New Event
  hasActivity:          boolean            // event already has registrations/check-ins
  reason:               string
}

/** Governance thresholds — resolved from Business Configuration (platformSettings/
 *  publishGovernance) with safe built-in defaults. NEVER hardcoded at call sites. */
export interface GovernanceConfig {
  enabled:                 boolean
  majorFields:             (keyof EventIdentity)[]
  moderateFields:          (keyof EventIdentity)[]
  nameSimilarityThreshold: number   // 0..1; a name below this similarity is a significant change
}
