// RD-PLATFORM-COMMS-01 Phase 4I — the pure timeline-stage projection: honest per-channel
// reachability (email stops at sent; WhatsApp reaches delivered/read; clicked never today).

import { describe, it, expect } from 'vitest'
import { reachableStages } from '@/lib/communications/playground/project'

describe('reachableStages (playground timeline projection)', () => {
  it('email reaches queued/accepted/sent but NOT delivered/opened/clicked', () => {
    const s = Object.fromEntries(reachableStages('email').map(x => [x.stage, x.reachable]))
    expect(s.queued).toBe(true)
    expect(s.accepted).toBe(true)
    expect(s.sent).toBe(true)
    expect(s.delivered).toBe(false)   // email delivery not tracked
    expect(s.opened).toBe(false)
    expect(s.clicked).toBe(false)
  })

  it('whatsapp reaches delivered + opened (read), never clicked', () => {
    const s = Object.fromEntries(reachableStages('whatsapp').map(x => [x.stage, x.reachable]))
    expect(s.delivered).toBe(true)
    expect(s.opened).toBe(true)
    expect(s.clicked).toBe(false)
  })

  it('in-app reaches delivered (written to inbox)', () => {
    const s = Object.fromEntries(reachableStages('inapp').map(x => [x.stage, x.reachable]))
    expect(s.delivered).toBe(true)
    expect(s.opened).toBe(false)
  })

  it('always projects the full canonical stage set with notes', () => {
    const stages = reachableStages('email')
    expect(stages.map(s => s.stage)).toEqual(['queued', 'accepted', 'sent', 'delivered', 'opened', 'clicked', 'failed', 'cancelled'])
    expect(stages.find(s => s.stage === 'delivered')!.note).toContain('not tracked')
  })
})
