// Phase H.3.5 — Visibility engine (Deliverable 6). Pure + SDK-free.
//
// Decides whether a field/section is visible given a context (role, plan, event
// type, registration/payment status). Expression rules are delegated to an
// injected evaluator so this module stays pure and dependency-free — the future
// rule engine plugs in without changing callers.

import type { VisibilityRule } from './types'

export interface VisibilityContext {
  role?:               string
  plan?:               string
  eventType?:          string
  registrationStatus?: string
  paymentStatus?:      string
  /** Optional safe evaluator for 'expression' rules (no eval here). */
  evalExpression?:     (expression: string) => boolean
}

function matchesRule(rule: VisibilityRule, ctx: VisibilityContext): boolean {
  switch (rule.type) {
    case 'always':              return true
    case 'role':                return !rule.roles      || (!!ctx.role      && rule.roles.includes(ctx.role))
    case 'plan':                return !rule.plans      || (!!ctx.plan      && rule.plans.includes(ctx.plan))
    case 'event_type':          return !rule.eventTypes || (!!ctx.eventType && rule.eventTypes.includes(ctx.eventType))
    case 'registration_status': return !rule.statuses   || (!!ctx.registrationStatus && rule.statuses.includes(ctx.registrationStatus))
    case 'payment_status':      return !rule.statuses   || (!!ctx.paymentStatus      && rule.statuses.includes(ctx.paymentStatus))
    case 'expression':          return rule.expression && ctx.evalExpression ? ctx.evalExpression(rule.expression) : true
    default:                    return true
  }
}

/**
 * A field with no rules is always visible. With rules, ALL rules must pass
 * (AND semantics) — the common "role X AND plan Y" case. OR-groups can be modeled
 * as a single expression rule when the rule engine ships.
 */
export function isVisible(rules: VisibilityRule[] | undefined, ctx: VisibilityContext): boolean {
  if (!rules || rules.length === 0) return true
  return rules.every(r => matchesRule(r, ctx))
}
