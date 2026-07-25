// RD-PLATFORM-COMMS-02 Phase 5D — the ONE canonical campaign lifecycle state machine (pure).
//
// THE single source of truth for legal campaign transitions. Every allowed-action and
// transition-validity check goes through here — no transition logic is duplicated anywhere.
// PURE — describes the graph; it never performs a transition, executes, or schedules.

import type { CampaignLifecycleState, ApprovalTransition } from './types'

/** The complete, canonical transition graph. Any edge not listed is illegal. */
export const CAMPAIGN_TRANSITIONS: Record<CampaignLifecycleState, ApprovalTransition[]> = {
  draft:     [{ to: 'review',    action: 'Submit for review' }],
  review:    [{ to: 'approved',  action: 'Approve' }, { to: 'rejected', action: 'Reject' }],
  approved:  [{ to: 'scheduled', action: 'Schedule' }, { to: 'cancelled', action: 'Cancel' }],
  rejected:  [{ to: 'draft',     action: 'Return to draft' }],
  scheduled: [{ to: 'running',   action: 'Start' }],
  running:   [{ to: 'completed', action: 'Complete' }],
  completed: [{ to: 'archived',  action: 'Archive' }],
  cancelled: [{ to: 'archived',  action: 'Archive' }],
  archived:  [],
}

/** States from which no transition is possible. */
export const TERMINAL_STATES: CampaignLifecycleState[] = ['archived']

/** The allowed transitions out of a state. PURE. */
export function allowedTransitions(state: CampaignLifecycleState): ApprovalTransition[] {
  return CAMPAIGN_TRANSITIONS[state] ?? []
}

/** Whether a from→to transition is legal. PURE. */
export function canTransition(from: CampaignLifecycleState, to: CampaignLifecycleState): boolean {
  return (CAMPAIGN_TRANSITIONS[from] ?? []).some(t => t.to === to)
}

/** Whether a state is terminal (no outgoing transitions). PURE. */
export function isTerminalState(state: CampaignLifecycleState): boolean {
  return allowedTransitions(state).length === 0
}
