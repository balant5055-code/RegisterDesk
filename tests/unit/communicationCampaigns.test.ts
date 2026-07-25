// RD-PLATFORM-COMMS-02 Phase 5A — the pure campaign normalizer/resolver: validates enums,
// fills safe defaults, derives lifecycle flags, and never fabricates a campaign.

import { describe, it, expect } from 'vitest'
import { normalizeCampaign, resolveCampaign } from '@/lib/communications/campaigns/normalize'
import { CAMPAIGN_STATUSES, CAMPAIGN_TYPES, CAMPAIGN_CATEGORIES } from '@/lib/communications/campaigns/types'

describe('normalizeCampaign', () => {
  it('returns null without a usable id + name (never fabricated)', () => {
    expect(normalizeCampaign({})).toBeNull()
    expect(normalizeCampaign({ campaignId: 'c1' })).toBeNull()
    expect(normalizeCampaign({ name: 'x' })).toBeNull()
  })

  it('normalizes a valid record and preserves bindings', () => {
    const c = normalizeCampaign({ campaignId: 'c1', name: 'July maintenance', type: 'maintenance', category: 'operations', status: 'scheduled', priority: 'high', notificationId: 'ACCOUNT_WELCOME', templateId: 'welcome.email', policyId: 'ACCOUNT_WELCOME' })!
    expect(c.campaignId).toBe('c1')
    expect(c.type).toBe('maintenance')
    expect(c.category).toBe('operations')
    expect(c.status).toBe('scheduled')
    expect(c.notificationId).toBe('ACCOUNT_WELCOME')
  })

  it('falls back to safe defaults for unknown enum values (no throw)', () => {
    const c = normalizeCampaign({ id: 'c2', name: 'x', type: 'bogus', category: 'bogus', status: 'bogus', priority: 'bogus' })!
    expect(CAMPAIGN_TYPES).toContain(c.type)
    expect(CAMPAIGN_CATEGORIES).toContain(c.category)
    expect(CAMPAIGN_STATUSES).toContain(c.status)
    expect(c.status).toBe('draft')       // default
    expect(c.priority).toBe('medium')
  })
})

describe('resolveCampaign', () => {
  const make = (status: string) => resolveCampaign(normalizeCampaign({ campaignId: 'c', name: 'n', status })!)

  it('derives display labels', () => {
    const r = resolveCampaign(normalizeCampaign({ campaignId: 'c', name: 'n', type: 'feature_release' })!)
    expect(r.typeLabel).toBe('Feature Release')
  })

  it('flags terminal vs active lifecycle', () => {
    expect(make('completed').isTerminal).toBe(true)
    expect(make('archived').isTerminal).toBe(true)
    expect(make('running').isActive).toBe(true)
    expect(make('scheduled').isActive).toBe(true)
    expect(make('draft').isTerminal).toBe(false)
    expect(make('draft').isActive).toBe(false)
  })
})
