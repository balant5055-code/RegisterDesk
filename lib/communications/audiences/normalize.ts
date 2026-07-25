// RD-PLATFORM-COMMS-02 Phase 5B — the pure Audience normalizer + resolver (isomorphic).
//
// The ONE place a raw audience record becomes a ResolvedAudience: validates the boolean rule
// tree against the canonical field registry, counts leaf rules, derives health + warnings.
// PURE — no I/O, no evaluation against live data (that is a future phase). Returns null for a
// record without a usable id/name (never fabricates an audience).

import {
  AUDIENCE_TYPES, AUDIENCE_SCOPES, AUDIENCE_STATUSES, RULE_OPERATORS, RULE_CONDITIONS, VALUELESS_CONDITIONS,
  isRuleGroup,
  type Audience, type ResolvedAudience, type AudienceRule, type AudienceRuleGroup, type AudienceWarning,
  type AudienceType, type AudienceScope, type AudienceStatus,
} from './types'
import { getAudienceField, CONDITIONS_FOR_TYPE } from './fields'

function titleize(s: string): string { return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }
function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fb: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fb
}

const EMPTY_GROUP: AudienceRuleGroup = { operator: 'and', rules: [] }

function coerceGroup(v: unknown): AudienceRuleGroup {
  if (!v || typeof v !== 'object') return EMPTY_GROUP
  const g = v as { operator?: unknown; rules?: unknown }
  return {
    operator: oneOf(g.operator, RULE_OPERATORS, 'and'),
    rules: Array.isArray(g.rules)
      ? g.rules.map(r => (r && typeof r === 'object' && 'operator' in (r as object)) ? coerceGroup(r) : coerceRule(r)).filter(Boolean) as Array<AudienceRule | AudienceRuleGroup>
      : [],
  }
}
function coerceRule(v: unknown): AudienceRule | null {
  if (!v || typeof v !== 'object') return null
  const r = v as { field?: unknown; condition?: unknown; value?: unknown }
  if (typeof r.field !== 'string') return null
  return { field: r.field, condition: oneOf(r.condition, RULE_CONDITIONS, 'equals'), value: r.value as AudienceRule['value'] }
}

/** Normalize a raw audience record into an Audience. PURE. */
export function normalizeAudience(raw: Record<string, unknown>): Audience | null {
  const audienceId = str(raw.audienceId) || str(raw.id)
  const name       = str(raw.name)
  if (!audienceId || !name) return null

  return {
    audienceId, name,
    description:     str(raw.description),
    type:           oneOf<AudienceType>(raw.type, AUDIENCE_TYPES, 'dynamic'),
    status:         oneOf<AudienceStatus>(raw.status, AUDIENCE_STATUSES, 'draft'),
    scope:          oneOf<AudienceScope>(raw.scope, AUDIENCE_SCOPES, 'platform'),
    rules:          coerceGroup(raw.rules),
    estimatedSize:  num(raw.estimatedSize),
    createdBy:      str(raw.createdBy),
    createdAt:      str(raw.createdAt),
    updatedAt:      str(raw.updatedAt),
    lastEvaluatedAt: typeof raw.lastEvaluatedAt === 'string' && raw.lastEvaluatedAt ? raw.lastEvaluatedAt : null,
    metadata:       (raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}) as Audience['metadata'],
  }
}

/** Flatten leaf rules from the tree. */
function leaves(group: AudienceRuleGroup): AudienceRule[] {
  const out: AudienceRule[] = []
  for (const r of group.rules) {
    if (isRuleGroup(r)) out.push(...leaves(r))
    else out.push(r)
  }
  return out
}

/** Validate the rule tree against the field registry + derive health. PURE. */
export function resolveAudience(a: Audience): ResolvedAudience {
  const rules = leaves(a.rules)
  const warnings: AudienceWarning[] = []
  let invalid = false

  for (const r of rules) {
    const f = getAudienceField(r.field)
    if (!f) { warnings.push({ code: 'unknown_field', detail: `Unknown field "${r.field}".` }); invalid = true; continue }
    if (!CONDITIONS_FOR_TYPE[f.type].includes(r.condition)) {
      warnings.push({ code: 'invalid_condition', detail: `"${r.condition}" is not valid for ${f.label} (${f.type}).` }); invalid = true
    }
    if (!VALUELESS_CONDITIONS.includes(r.condition) && (r.value === undefined || r.value === null || r.value === '')) {
      warnings.push({ code: 'missing_value', detail: `${f.label} "${r.condition}" needs a value.` }); invalid = true
    }
    if (f.reserved) warnings.push({ code: 'reserved_field', detail: `${f.label} is reserved and not yet evaluable.` })
  }

  if (a.type === 'dynamic' && rules.length === 0) {
    warnings.push({ code: 'no_rules', detail: 'A dynamic audience has no rules — it will match everyone or no one.' })
  }
  if (a.lastEvaluatedAt === null) warnings.push({ code: 'never_evaluated', detail: 'Estimated size has not been evaluated yet.' })

  const valid = !invalid && !(a.type === 'dynamic' && rules.length === 0)
  const health: ResolvedAudience['health'] = invalid ? 'invalid' : warnings.length > 0 ? 'warning' : 'valid'

  return {
    ...a,
    ruleCount:   rules.length,
    valid, warnings, health,
    typeLabel:   titleize(a.type),
    scopeLabel:  titleize(a.scope),
    statusLabel: titleize(a.status),
  }
}
