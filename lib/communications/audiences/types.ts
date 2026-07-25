// RD-PLATFORM-COMMS-02 Phase 5B — canonical Audience domain types (isomorphic).
//
// An Audience is a first-class PLATFORM object — a saved segment of organizers/users defined by
// a boolean rule tree. This phase builds the BUILDER (model + rules + resolver) only: no campaign
// execution, no sending, no evaluation against live data (that is a future phase). Read-only.

export type AudienceType   = 'static' | 'dynamic' | 'saved' | 'preview'
export const AUDIENCE_TYPES: AudienceType[] = ['static', 'dynamic', 'saved', 'preview']

export type AudienceScope  = 'platform' | 'organizer' | 'operations' | 'compliance' | 'marketing' | 'finance' | 'security'
export const AUDIENCE_SCOPES: AudienceScope[] = ['platform', 'organizer', 'operations', 'compliance', 'marketing', 'finance', 'security']

export type AudienceStatus = 'draft' | 'active' | 'archived'
export const AUDIENCE_STATUSES: AudienceStatus[] = ['draft', 'active', 'archived']

// ─── Rule model ────────────────────────────────────────────────────────────────

export type RuleOperator  = 'and' | 'or' | 'not'
export const RULE_OPERATORS: RuleOperator[] = ['and', 'or', 'not']

export type RuleCondition =
  | 'equals' | 'not_equals' | 'greater_than' | 'less_than'
  | 'contains' | 'starts_with' | 'ends_with'
  | 'exists' | 'not_exists' | 'in' | 'not_in'
export const RULE_CONDITIONS: RuleCondition[] = ['equals', 'not_equals', 'greater_than', 'less_than', 'contains', 'starts_with', 'ends_with', 'exists', 'not_exists', 'in', 'not_in']

/** Conditions that operate without a value. */
export const VALUELESS_CONDITIONS: RuleCondition[] = ['exists', 'not_exists']

/** A single leaf condition on a supported field. */
export interface AudienceRule {
  field:     string
  condition: RuleCondition
  value?:    string | number | boolean | Array<string | number>
}

/** A boolean group combining leaf rules and/or nested groups. */
export interface AudienceRuleGroup {
  operator: RuleOperator
  rules:    Array<AudienceRule | AudienceRuleGroup>
}

export function isRuleGroup(r: AudienceRule | AudienceRuleGroup): r is AudienceRuleGroup {
  return (r as AudienceRuleGroup).operator !== undefined
}

// ─── Audience record ─────────────────────────────────────────────────────────

export interface Audience {
  audienceId:    string
  name:          string
  description:   string
  type:          AudienceType
  status:        AudienceStatus
  scope:         AudienceScope
  rules:         AudienceRuleGroup
  estimatedSize: number        // last stored estimate (a future evaluation phase populates this)
  createdBy:     string
  createdAt:     string
  updatedAt:     string
  lastEvaluatedAt: string | null
  metadata:      Record<string, string | number | boolean | undefined>
}

export interface AudienceWarning { code: string; detail: string }

/** An audience validated + enriched with rule count, health, and warnings. */
export interface ResolvedAudience extends Audience {
  ruleCount:     number
  valid:         boolean
  warnings:      AudienceWarning[]
  health:        'valid' | 'warning' | 'invalid'
  typeLabel:     string
  scopeLabel:    string
  statusLabel:   string
}

// ─── Future extension points (Phase 5C+) — RESERVED, NOT IMPLEMENTED ──────────
export interface AudienceExtensionPoints {
  campaignComposer?: never
  approval?:         never
  execution?:        never   // evaluate rules against live organizer data
  analytics?:        never
  insights?:         never
  rulesEngine?:      never
  ai?:               never
}
