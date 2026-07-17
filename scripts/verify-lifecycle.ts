// Exhaustive unit verification for the event lifecycle state machine (PART 2).
// Run: npx tsx scripts/verify-lifecycle.ts   (exits non-zero on any failure)

import {
  isValidTransition,
  targetStatus,
  deriveLifecycleStatus,
} from '../lib/events/lifecycleStateMachine'
import type { EventLifecycleStatus, LifecycleAction } from '../types/events'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

console.log('── Required VALID transitions ──')
const VALID: Array<[EventLifecycleStatus, EventLifecycleStatus]> = [
  ['draft', 'pending_review'],
  ['pending_review', 'published'],       // approve
  ['pending_review', 'draft'],           // reject (rejected state = draft + reviewStatus)
  ['pending_review', 'changes_requested'],
  ['changes_requested', 'pending_review'], // resubmit
  ['published', 'cancelled'],
  ['published', 'archived'],
  ['published', 'unpublished'],            // unpublish
  ['unpublished', 'pending_review'],       // republish (reuses existing license)
  ['archived', 'unpublished'],             // restore (→ private, reuses existing license)
  ['cancelled', 'archived'],
  ['completed', 'archived'],
  ['registration_closed', 'published'],
]
for (const [from, to] of VALID) check(`${from} → ${to} is VALID`, isValidTransition(from, to) === true)

console.log('── Illegal transitions must be REJECTED ──')
const ILLEGAL: Array<[EventLifecycleStatus, EventLifecycleStatus]> = [
  ['published', 'published'],       // ← THE reported bug: must be rejected
  ['draft', 'published'],           // first publish is handled by /publish, not the machine
  ['published', 'pending_review'],  // published can only go to unpublished, not straight to review
  ['published', 'draft'],           // unpublish now targets 'unpublished', never 'draft'
  ['unpublished', 'published'],     // republish must go through review, never straight to published
  ['draft', 'archived'],
  ['pending_review', 'archived'],
  ['changes_requested', 'published'],
  ['archived', 'published'],
  ['cancelled', 'published'],
]
for (const [from, to] of ILLEGAL) check(`${from} → ${to} is REJECTED`, isValidTransition(from, to) === false)

console.log('── targetStatus() per action ──')
const ACTIONS: Array<[LifecycleAction, EventLifecycleStatus]> = [
  ['approve', 'published'],
  ['reject', 'draft'],
  ['request_changes', 'changes_requested'],
  ['resubmit', 'pending_review'],
  ['republish', 'pending_review'],
  ['restore', 'unpublished'],
  ['cancel', 'cancelled'],
  ['archive', 'archived'],
  ['complete', 'completed'],
  ['unpublish', 'unpublished'],
  ['close_registrations', 'registration_closed'],
  ['reopen_registrations', 'published'],
]
for (const [action, target] of ACTIONS) check(`action '${action}' → '${target}'`, targetStatus(action) === target)

console.log('── deriveLifecycleStatus() — the approve-bug root cause ──')
// A pending_review draft with NO lifecycleStatus must NOT derive as 'published'.
check("legacy {status:'pending_review'} → 'pending_review'", deriveLifecycleStatus({ status: 'pending_review' }) === 'pending_review')
check("legacy {status:'draft'} → 'draft'",                   deriveLifecycleStatus({ status: 'draft' }) === 'draft')
check("legacy {status:'published'} → 'published'",           deriveLifecycleStatus({ status: 'published' }) === 'published')
check("explicit lifecycleStatus wins",                       deriveLifecycleStatus({ lifecycleStatus: 'changes_requested', status: 'draft' }) === 'changes_requested')
check("unknown/old doc → 'published' fallback",              deriveLifecycleStatus({}) === 'published')

console.log('── The exact failing scenario: approve a pending_review event ──')
// currentStatus derived from a pending_review draft, target from 'approve'.
const cur = deriveLifecycleStatus({ status: 'pending_review' })
const tgt = targetStatus('approve')
check(`derive+approve: '${cur}' → '${tgt}' is VALID (bug fixed)`, isValidTransition(cur, tgt) === true)

console.log('')
if (failures > 0) { console.error(`❌ ${failures} assertion(s) FAILED`); process.exit(1) }
console.log('✅ All lifecycle state-machine assertions passed')
