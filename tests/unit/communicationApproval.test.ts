// RD-PLATFORM-COMMS-02 Phase 5D — the ONE state machine + pure approval resolver: only legal
// transitions, correct allowed-actions, honest history projection, and validation.

import { describe, it, expect } from 'vitest'
import { CAMPAIGN_TRANSITIONS, allowedTransitions, canTransition, isTerminalState } from '@/lib/communications/approval/stateMachine'
import { normalizeApproval, projectHistory, resolveApproval } from '@/lib/communications/approval/normalize'
import type { CampaignApproval } from '@/lib/communications/approval/types'

describe('campaign lifecycle state machine', () => {
  it('allows exactly the certified transitions', () => {
    expect(allowedTransitions('draft').map(t => t.to)).toEqual(['review'])
    expect(allowedTransitions('review').map(t => t.to).sort()).toEqual(['approved', 'rejected'])
    expect(allowedTransitions('approved').map(t => t.to).sort()).toEqual(['cancelled', 'scheduled'])
    expect(allowedTransitions('rejected').map(t => t.to)).toEqual(['draft'])
    expect(allowedTransitions('scheduled').map(t => t.to)).toEqual(['running'])
    expect(allowedTransitions('running').map(t => t.to)).toEqual(['completed'])
    expect(allowedTransitions('completed').map(t => t.to)).toEqual(['archived'])
    expect(allowedTransitions('cancelled').map(t => t.to)).toEqual(['archived'])
    expect(allowedTransitions('archived')).toEqual([])
  })

  it('rejects illegal transitions', () => {
    expect(canTransition('draft', 'approved')).toBe(false)   // must go through review
    expect(canTransition('draft', 'running')).toBe(false)
    expect(canTransition('archived', 'draft')).toBe(false)
    expect(canTransition('completed', 'running')).toBe(false)
    expect(canTransition('review', 'approved')).toBe(true)   // legal
  })

  it('archived is the only terminal state', () => {
    expect(isTerminalState('archived')).toBe(true)
    expect(Object.keys(CAMPAIGN_TRANSITIONS).filter(s => isTerminalState(s as never))).toEqual(['archived'])
  })
})

describe('resolveApproval', () => {
  const approval = (over: Partial<CampaignApproval> = {}): CampaignApproval =>
    normalizeApproval({ approvalId: 'ap1', campaignId: 'c1', status: 'review', submittedBy: 'u1', submittedAt: '2026-01-01T00:00:00.000Z', ...over })!

  it('defaults to draft with no approval record, and lists submit action', () => {
    const r = resolveApproval({ campaignId: 'c1', name: 'Launch' }, null)
    expect(r.currentState).toBe('draft')
    expect(r.allowedActions.map(a => a.to)).toEqual(['review'])
    expect(r.validation.find(v => v.check === 'approval')!.ok).toBe(false)
  })

  it('surfaces current state + allowed actions from the record', () => {
    const r = resolveApproval({ campaignId: 'c1', name: 'Launch' }, approval({ status: 'review' }))
    expect(r.currentState).toBe('review')
    expect(r.allowedActions.map(a => a.to).sort()).toEqual(['approved', 'rejected'])
  })

  it('flags a missing campaign and offers no actions', () => {
    const r = resolveApproval(null, approval())
    expect(r.validation.find(v => v.check === 'campaign')!.ok).toBe(false)
    expect(r.allowedActions).toEqual([])
  })

  it('projects an ordered history from timestamps', () => {
    const h = projectHistory(approval({ approvedAt: '2026-01-02T00:00:00.000Z', approvedBy: 'admin' }))
    expect(h.map(e => e.action)).toEqual(['Submitted for review', 'Approved'])
    expect(h[1].actor).toBe('admin')
  })
})
