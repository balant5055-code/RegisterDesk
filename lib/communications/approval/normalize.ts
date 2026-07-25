// RD-PLATFORM-COMMS-02 Phase 5D — pure approval normalizer + resolver + history projection.
//
// The ONE place a raw approval record becomes a ResolvedApproval: derives current state,
// ALLOWED actions (via the single state machine), a history projection, and validation. PURE —
// no I/O, no transition performed, no execution. Server-free so it is testable.

import { allowedTransitions, isTerminalState } from './stateMachine'
import { CAMPAIGN_LIFECYCLE } from './types'
import type {
  CampaignApproval, ResolvedApproval, ApprovalHistoryEntry, ApprovalValidation, CampaignLifecycleState,
} from './types'

function titleize(s: string): string { return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }
function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function strOrNull(v: unknown): string | null { return typeof v === 'string' && v ? v : null }

function coerceState(v: unknown): CampaignLifecycleState {
  return typeof v === 'string' && (CAMPAIGN_LIFECYCLE as string[]).includes(v) ? (v as CampaignLifecycleState) : 'draft'
}

/** Normalize a raw approval record. PURE. Returns null without an id + campaignId. */
export function normalizeApproval(raw: Record<string, unknown>): CampaignApproval | null {
  const approvalId = str(raw.approvalId) || str(raw.id)
  const campaignId = str(raw.campaignId)
  if (!approvalId || !campaignId) return null
  return {
    approvalId, campaignId,
    status:      coerceState(raw.status),
    submittedBy: strOrNull(raw.submittedBy), submittedAt: strOrNull(raw.submittedAt),
    reviewedBy:  strOrNull(raw.reviewedBy),  reviewedAt:  strOrNull(raw.reviewedAt),
    approvedBy:  strOrNull(raw.approvedBy),  approvedAt:  strOrNull(raw.approvedAt),
    rejectedBy:  strOrNull(raw.rejectedBy),  rejectedAt:  strOrNull(raw.rejectedAt),
    cancelledBy: strOrNull(raw.cancelledBy), cancelledAt: strOrNull(raw.cancelledAt),
    archivedAt:  strOrNull(raw.archivedAt),
    reason:      strOrNull(raw.reason),
    metadata:    (raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}) as CampaignApproval['metadata'],
  }
}

/** Project the approval record's timestamped events into an ordered history. PURE. */
export function projectHistory(a: CampaignApproval): ApprovalHistoryEntry[] {
  const rows: ApprovalHistoryEntry[] = []
  const push = (ts: string | null, actor: string | null, action: string, status: CampaignLifecycleState, reason: string | null = null) => {
    if (ts) rows.push({ timestamp: ts, actor: actor ?? 'system', action, reason, status })
  }
  push(a.submittedAt, a.submittedBy, 'Submitted for review', 'review')
  push(a.reviewedAt,  a.reviewedBy,  'Reviewed',             'review')
  push(a.approvedAt,  a.approvedBy,  'Approved',             'approved')
  push(a.rejectedAt,  a.rejectedBy,  'Rejected',             'rejected', a.reason)
  push(a.cancelledAt, a.cancelledBy, 'Cancelled',            'cancelled', a.reason)
  push(a.archivedAt,  null,          'Archived',             'archived')
  return rows.sort((x, y) => x.timestamp.localeCompare(y.timestamp))
}

/** Resolve the approval view: current state, allowed actions, history, validation. PURE. */
export function resolveApproval(
  campaign: { campaignId: string; name: string } | null,
  approval: CampaignApproval | null,
): ResolvedApproval {
  const currentState: CampaignLifecycleState = approval?.status ?? 'draft'
  const validation: ApprovalValidation[] = [
    { check: 'campaign', ok: !!campaign, detail: campaign ? `Campaign "${campaign.name}".` : 'Campaign not found.' },
    { check: 'approval', ok: !!approval, detail: approval ? 'Approval record found.' : 'No approval record — defaults to Draft.' },
    { check: 'state',    ok: (CAMPAIGN_LIFECYCLE as string[]).includes(currentState), detail: `Current state: ${titleize(currentState)}.` },
  ]

  return {
    campaignId:        campaign?.campaignId ?? approval?.campaignId ?? '',
    campaignName:      campaign?.name ?? null,
    currentState,
    currentStateLabel: titleize(currentState),
    isTerminal:        isTerminalState(currentState),
    allowedActions:    campaign ? allowedTransitions(currentState) : [],
    history:           approval ? projectHistory(approval) : [],
    validation,
  }
}
