// RD-PLATFORM-COMMS-02 Phase 5D — canonical Campaign Approval types (isomorphic).
//
// Models the campaign LIFECYCLE + approval record only. READ-ONLY — this phase computes the
// current state, the ALLOWED next actions (from the one state machine), and a history
// projection; it never performs a transition, executes, schedules, or persists anything.

export type CampaignLifecycleState =
  | 'draft' | 'review' | 'approved' | 'rejected'
  | 'scheduled' | 'running' | 'completed' | 'cancelled' | 'archived'

export const CAMPAIGN_LIFECYCLE: CampaignLifecycleState[] = ['draft', 'review', 'approved', 'rejected', 'scheduled', 'running', 'completed', 'cancelled', 'archived']

/** The persisted approval record (a future workflow phase writes these). */
export interface CampaignApproval {
  approvalId:   string
  campaignId:   string
  status:       CampaignLifecycleState
  submittedBy:  string | null
  submittedAt:  string | null
  reviewedBy:   string | null
  reviewedAt:   string | null
  approvedBy:   string | null
  approvedAt:   string | null
  rejectedBy:   string | null
  rejectedAt:   string | null
  cancelledBy:  string | null
  cancelledAt:  string | null
  archivedAt:   string | null
  reason:       string | null
  metadata:     Record<string, string | number | boolean | undefined>
}

/** A single allowed transition (the state machine's edge). */
export interface ApprovalTransition {
  to:     CampaignLifecycleState
  action: string   // human label, e.g. "Submit for review"
}

/** One projected history entry (read model — pure projection over the approval record). */
export interface ApprovalHistoryEntry {
  timestamp: string
  actor:     string
  action:    string
  reason:    string | null
  status:    CampaignLifecycleState
}

export interface ApprovalValidation {
  check:  'campaign' | 'approval' | 'state' | 'transition'
  ok:     boolean
  detail: string
}

export interface ResolvedApproval {
  campaignId:        string
  campaignName:      string | null
  currentState:      CampaignLifecycleState
  currentStateLabel: string
  isTerminal:        boolean
  allowedActions:    ApprovalTransition[]
  history:           ApprovalHistoryEntry[]
  validation:        ApprovalValidation[]
}

// ─── Future extension points (Phase 5E+) — RESERVED, NOT IMPLEMENTED ──────────
export interface ApprovalExtensionPoints {
  executionPlanner?: never
  scheduler?:        never
  replay?:           never
  analytics?:        never
  insights?:         never
  notifications?:    never
  ai?:               never
}
