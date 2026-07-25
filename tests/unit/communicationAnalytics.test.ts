// RD-PLATFORM-COMMS-01 Phase 4G — the pure analytics aggregator over timeline entries:
// correct roll-ups, rates, latency averaging, provider availability, and error distribution.

import { describe, it, expect } from 'vitest'
import { aggregateAnalytics, type NotificationMeta } from '@/lib/communications/analytics/aggregate'
import type { TimelineEntry } from '@/lib/communications/timeline/types'

function entry(over: Partial<TimelineEntry>): TimelineEntry {
  return {
    timelineId: 't', notificationId: 'LICENSE_PURCHASED', templateId: 'organizer.email', templateVersion: 1,
    policyId: 'LICENSE_PURCHASED', recipient: 'a@b.com', recipientType: 'organizer', channel: 'email',
    provider: 'ses', trigger: 'x', status: 'sent', retryCount: 0, latencyMs: null,
    providerReference: null, errorCode: null, errorMessage: null, metadata: {}, ...over,
  }
}
const meta: Record<string, NotificationMeta> = { LICENSE_PURCHASED: { displayName: 'License Purchased', category: 'licensing' } }

describe('aggregateAnalytics', () => {
  it('rolls up volume, accepted/delivered/failed and rates', () => {
    const a = aggregateAnalytics([
      entry({ status: 'delivered', latencyMs: 100 }),
      entry({ status: 'sent', latencyMs: 300 }),
      entry({ status: 'failed', provider: 'ses', errorCode: '132000' }),
    ], meta)
    expect(a.scanned).toBe(3)
    expect(a.overall.volume).toBe(3)
    expect(a.overall.accepted).toBe(2)       // delivered + sent
    expect(a.overall.delivered).toBe(1)
    expect(a.overall.failed).toBe(1)
    expect(a.overall.avgLatencyMs).toBe(200) // (100 + 300) / 2
    expect(a.overall.successRate).toBeCloseTo(2 / 3)
    expect(a.overall.failureRate).toBeCloseTo(1 / 3)
  })

  it('counts opened/clicked as delivered + accepted (cumulative lifecycle)', () => {
    const a = aggregateAnalytics([entry({ status: 'clicked' })], meta)
    expect(a.overall.clicked).toBe(1)
    expect(a.overall.opened).toBe(1)
    expect(a.overall.delivered).toBe(1)
    expect(a.overall.accepted).toBe(1)
  })

  it('computes provider availability + error distribution', () => {
    const a = aggregateAnalytics([
      entry({ status: 'delivered' }), entry({ status: 'delivered' }),
      entry({ status: 'failed', errorCode: '132000' }),
    ], meta)
    const ses = a.byProvider.find(p => p.provider === 'ses')!
    expect(ses.availability).toBeCloseTo(2 / 3)   // accepted / (accepted + failed)
    expect(ses.errorDistribution).toEqual([{ code: '132000', count: 1 }])
    expect(ses.implemented).toBe(true)
  })

  it('breaks down by notification + category from registry meta', () => {
    const a = aggregateAnalytics([entry({ status: 'delivered' })], meta)
    expect(a.byNotification[0].displayName).toBe('License Purchased')
    expect(a.byCategory[0].key).toBe('licensing')
  })

  it('unmapped notifications fall into (unmapped)/uncategorized, not fabricated', () => {
    const a = aggregateAnalytics([entry({ notificationId: null })], meta)
    expect(a.byNotification[0].notificationId).toBe('(unmapped)')
    expect(a.byCategory[0].key).toBe('uncategorized')
  })
})
