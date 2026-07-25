// RD-PLATFORM-COMMS-01 Phase 4G — the pure Communication Analytics aggregator (isomorphic).
//
// The ONE place analytics are computed. Input: resolved TIMELINE entries (never providers) +
// a notification-metadata lookup (from the registry). Output: the canonical analytics model.
// PURE — no I/O, no mutation of inputs. This is what makes "analytics reads the timeline" true.

import type { TimelineEntry } from '@/lib/communications/timeline/types'
import { CHANNEL_CAPABILITIES } from '@/lib/communications/health/channels'
import type {
  CommMetrics, RateMetrics, ProviderAnalytics, NamedMetrics,
  NotificationAnalytics, TemplateAnalytics, CommunicationAnalytics,
} from './types'

/** Per-notification metadata the aggregator joins in (supplied by the server from the registry). */
export interface NotificationMeta { displayName: string; category: string }

interface Acc extends CommMetrics { _latSum: number; _latN: number }

function blank(): Acc {
  return { volume: 0, accepted: 0, delivered: 0, opened: 0, clicked: 0, failed: 0, cancelled: 0, retrying: 0, queued: 0, avgLatencyMs: null, lastAt: null, _latSum: 0, _latN: 0 }
}

function add(a: Acc, e: TimelineEntry): void {
  a.volume++
  switch (e.status) {
    case 'clicked':   a.clicked++;   a.opened++; a.delivered++; a.accepted++; break
    case 'opened':    a.opened++;    a.delivered++; a.accepted++; break
    case 'delivered': a.delivered++; a.accepted++; break
    case 'sent':
    case 'accepted':  a.accepted++;  break
    case 'failed':    a.failed++;    break
    case 'cancelled':
    case 'expired':   a.cancelled++; break
    case 'retrying':  a.retrying++;  break
    case 'queued':    a.queued++;    break
    default: break
  }
  if (e.latencyMs != null) { a._latSum += e.latencyMs; a._latN++ }
  const at = e.completedAt ?? e.sentAt ?? e.queuedAt ?? null
  if (at && (!a.lastAt || at > a.lastAt)) a.lastAt = at
}

function finalize(a: Acc): CommMetrics {
  const { _latSum, _latN, ...rest } = a
  return { ...rest, avgLatencyMs: _latN > 0 ? Math.round(_latSum / _latN) : null }
}

function bucketMap(): Map<string, Acc> { return new Map() }
function into(m: Map<string, Acc>, key: string, e: TimelineEntry): void {
  let a = m.get(key); if (!a) { a = blank(); m.set(key, a) }
  add(a, e)
}

/** Aggregate timeline entries into the canonical analytics model. PURE. */
export function aggregateAnalytics(
  entries: TimelineEntry[],
  meta:    Record<string, NotificationMeta>,
): CommunicationAnalytics {
  const overall = blank()
  const providers = bucketMap()
  const channels  = bucketMap()
  const categories = bucketMap()
  const notifications = bucketMap()
  const templates = bucketMap()
  const providerErrors = new Map<string, Map<string, number>>()

  for (const e of entries) {
    add(overall, e)
    into(providers, e.provider || 'unknown', e)
    into(channels, e.channel, e)
    into(templates, e.templateId, e)
    const nid = e.notificationId ?? '(unmapped)'
    into(notifications, nid, e)
    const cat = e.notificationId ? (meta[e.notificationId]?.category ?? 'uncategorized') : 'uncategorized'
    into(categories, cat, e)
    if (e.status === 'failed') {
      const code = e.errorCode ?? 'unknown'
      const pm = providerErrors.get(e.provider) ?? new Map<string, number>()
      pm.set(code, (pm.get(code) ?? 0) + 1)
      providerErrors.set(e.provider, pm)
    }
  }

  const overallM = finalize(overall)
  const rate = (n: number) => overall.volume > 0 ? n / overall.volume : 0
  const overallR: RateMetrics = { ...overallM, successRate: rate(overallM.accepted), failureRate: rate(overallM.failed) }

  const byProvider: ProviderAnalytics[] = [...providers.entries()].map(([provider, a]) => {
    const m = finalize(a)
    const errs = providerErrors.get(provider)
    return {
      provider,
      implemented: provider === 'ses' || provider === 'meta',
      metrics:     m,
      availability: (m.accepted + m.failed) > 0 ? m.accepted / (m.accepted + m.failed) : 1,
      errorDistribution: errs ? [...errs.entries()].map(([code, count]) => ({ code, count })).sort((x, y) => y.count - x.count) : [],
    }
  }).sort((x, y) => y.metrics.volume - x.metrics.volume)

  const byChannel: NamedMetrics[] = [...channels.entries()].map(([key, a]) => ({
    key, label: CHANNEL_CAPABILITIES[key as keyof typeof CHANNEL_CAPABILITIES]?.label ?? key, metrics: finalize(a),
  })).sort((x, y) => y.metrics.volume - x.metrics.volume)

  const byCategory: NamedMetrics[] = [...categories.entries()].map(([key, a]) => ({ key, label: key, metrics: finalize(a) }))
    .sort((x, y) => y.metrics.volume - x.metrics.volume)

  const byNotification: NotificationAnalytics[] = [...notifications.entries()].map(([notificationId, a]) => ({
    notificationId,
    displayName: meta[notificationId]?.displayName ?? notificationId,
    category:    meta[notificationId]?.category ?? 'uncategorized',
    metrics:     finalize(a),
  })).sort((x, y) => y.metrics.volume - x.metrics.volume)

  const byTemplate: TemplateAnalytics[] = [...templates.entries()].map(([templateId, a]) => ({
    templateId,
    boundNotification: entries.find(e => e.templateId === templateId)?.notificationId ?? null,
    metrics: finalize(a),
  })).sort((x, y) => y.metrics.volume - x.metrics.volume)

  return { scanned: entries.length, overall: overallR, byProvider, byChannel, byCategory, byNotification, byTemplate }
}
