// RD-PLATFORM-COMMS-01 Phase 4H — the pure insight rules engine: fires only on real conditions,
// never fabricates, and is deterministic.

import { describe, it, expect } from 'vitest'
import { generateInsights, type InsightInput } from '@/lib/communications/insights/generate'
import type { CommunicationAnalytics } from '@/lib/communications/analytics/types'
import type { CommunicationHealth } from '@/lib/communications/health/types'

const NOW = '2026-01-01T00:00:00.000Z'

function analytics(over: Partial<CommunicationAnalytics> = {}): CommunicationAnalytics {
  return {
    scanned: 100,
    overall: { volume: 100, accepted: 90, delivered: 40, opened: 0, clicked: 0, failed: 10, cancelled: 0, retrying: 0, queued: 0, avgLatencyMs: 200, lastAt: NOW, successRate: 0.9, failureRate: 0.1 },
    byProvider: [], byChannel: [], byCategory: [], byNotification: [], byTemplate: [], ...over,
  }
}
function health(overall: 'green' | 'amber' | 'red', channels: CommunicationHealth['channels'] = []): CommunicationHealth {
  return { scope: {}, channels, overall }
}
const emptyInput = (over: Partial<InsightInput> = {}): InsightInput => ({ analytics: analytics(), health: health('green'), registry: [], templates: [], ...over })

describe('generateInsights', () => {
  it('produces no insights when everything is healthy and quiet', () => {
    expect(generateInsights(emptyInput(), NOW)).toEqual([])
  })

  it('is deterministic (same input + now → same output)', () => {
    const inp = emptyInput({ health: health('amber') })
    expect(generateInsights(inp, NOW)).toEqual(generateInsights(inp, NOW))
  })

  it('flags a provider that is configured but degraded', () => {
    const ins = generateInsights(emptyInput({ health: health('amber', [
      { channel: 'whatsapp', implemented: true, state: 'degraded', status: 'amber', summary: 'WhatsApp enabled with a caveat', dimensions: [] },
    ]) }), NOW)
    expect(ins.some(i => i.insightId === 'provider.degraded.whatsapp' && i.severity === 'medium')).toBe(true)
    expect(ins.some(i => i.insightId === 'health.degraded')).toBe(true)
  })

  it('flags high provider failure rate only above threshold + volume', () => {
    const withFail = generateInsights(emptyInput({ analytics: analytics({ byProvider: [
      { provider: 'ses', implemented: true, availability: 0.5, errorDistribution: [{ code: '400', count: 6 }], metrics: { volume: 12, accepted: 6, delivered: 0, opened: 0, clicked: 0, failed: 6, cancelled: 0, retrying: 0, queued: 0, avgLatencyMs: 100, lastAt: NOW } },
    ] }) }), NOW)
    expect(withFail.some(i => i.insightId === 'performance.high_failure.ses' && i.severity === 'high')).toBe(true)

    const lowVol = generateInsights(emptyInput({ analytics: analytics({ byProvider: [
      { provider: 'ses', implemented: true, availability: 0.5, errorDistribution: [], metrics: { volume: 2, accepted: 1, delivered: 0, opened: 0, clicked: 0, failed: 1, cancelled: 0, retrying: 0, queued: 0, avgLatencyMs: 100, lastAt: NOW } },
    ] }) }), NOW)
    expect(lowVol.some(i => i.insightId.startsWith('performance.high_failure'))).toBe(false)  // below min volume
  })

  it('flags unknown template variables (real condition) but not when clean', () => {
    const bad = generateInsights(emptyInput({ templates: [{ templateId: 'x.email', notificationId: 'X', status: 'published', unknownVariables: ['Bogus'], bound: true }] }), NOW)
    expect(bad.some(i => i.insightId === 'templates.unknown_vars.x.email' && i.severity === 'high')).toBe(true)

    const clean = generateInsights(emptyInput({ templates: [{ templateId: 'x.email', notificationId: 'X', status: 'published', unknownVariables: [], bound: true }] }), NOW)
    expect(clean.some(i => i.insightId.startsWith('templates.unknown_vars'))).toBe(false)
  })

  it('surfaces "no activity" when the window is empty', () => {
    const ins = generateInsights(emptyInput({ analytics: analytics({ scanned: 0, overall: { ...analytics().overall, volume: 0, accepted: 0, delivered: 0, failed: 0, successRate: 0, failureRate: 0 } }) }), NOW)
    expect(ins.some(i => i.insightId === 'analytics.no_activity')).toBe(true)
  })
})
