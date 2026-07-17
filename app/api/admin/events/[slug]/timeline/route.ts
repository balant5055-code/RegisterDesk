// GET /api/admin/events/[slug]/timeline — Event 360 merged chronological trail.
//
// Admin-gated read. Merges — from EXISTING sources, no new logic — the event's:
//   • lifecycle timestamps (event doc)            → source: 'lifecycle'
//   • admin audit trail (adminAuditLogs)          → source: 'audit' / 'moderation'
//   • immutable license history (getLicenseDetail) → source: 'license'
//   • publish governance baseline (getBaseline)   → source: 'governance'
// into ONE list sorted newest-first. Reads are bounded (audit ≤200, history ≤200);
// no scan. Sorting is in-memory so no composite index is required.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { getLicenseDetail }          from '@/lib/admin/licenseAdminService'
import { getBaseline }               from '@/lib/events/governance/baseline'
import type {
  Event360Timeline, Event360TimelineEntry, TimelineSource,
} from '@/lib/admin/event360Types'

interface RouteContext { params: Promise<{ slug: string }> }

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    try { return (ts as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  if (typeof ts === 'string' && ts) return ts
  return null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

// Admin audit actions that are moderation (vs generic admin) — for source tagging.
const MODERATION_ACTIONS = new Set(['event.taken_down', 'event.restored', 'event.under_review'])

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { slug } = await ctx.params

  const eventSnap = await adminDb.collection('events').doc(slug).get()
  if (!eventSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const ev      = eventSnap.data() as Record<string, unknown>
  const draftId = str(ev.draftId) ?? slug

  const [auditSnap, license, baseline] = await Promise.all([
    adminDb.collection('adminAuditLogs').where('entityId', '==', slug).limit(200).get().catch(() => null),
    getLicenseDetail(slug).catch(() => null),
    getBaseline(draftId).catch(() => null),
  ])

  const entries: Event360TimelineEntry[] = []

  // ── Lifecycle (event doc timestamps) ──
  const lifecycle: [string, unknown, string][] = [
    ['created',            ev.createdAt,           'Event created'],
    ['submitted',          ev.publishedAt,         'Submitted / published'],
    ['approved',           ev.approvedAt,          'Approved'],
    ['rejected',           ev.rejectedAt,          'Rejected'],
    ['changes_requested',  ev.changesRequestedAt,  'Changes requested'],
    ['resubmitted',        ev.resubmittedAt,       'Resubmitted'],
  ]
  for (const [action, ts, detail] of lifecycle) {
    const at = tsToISO(ts)
    if (at) entries.push({ id: `lifecycle:${action}`, source: 'lifecycle', action, detail, actor: null, at })
  }

  // ── Admin audit trail (moderation + generic admin actions on this event) ──
  if (auditSnap) {
    for (const d of auditSnap.docs) {
      const x = d.data() as Record<string, unknown>
      const action = str(x.action) ?? 'admin.action'
      const source: TimelineSource = MODERATION_ACTIONS.has(action) ? 'moderation' : 'audit'
      const meta = x.metadata && typeof x.metadata === 'object' ? (x.metadata as Record<string, unknown>) : {}
      const detail = str(meta.reason) ?? str(meta.note) ?? action.replace(/[._]/g, ' ')
      entries.push({
        id:     `audit:${d.id}`,
        source, action,
        detail,
        actor:  str(x.adminUid),
        at:     tsToISO(x.createdAt),
      })
    }
  }

  // ── License history (immutable, already mapped by the service) ──
  if (license) {
    for (const t of license.timeline) {
      entries.push({
        id:     `license:${t.id}`,
        source: 'license',
        action: t.action,
        detail: t.note || t.reason || `${t.fromTier ? `${t.fromTier} → ` : ''}${t.toTier}`,
        actor:  t.actorUid,
        at:     t.createdAt,
      })
    }
  }

  // ── Governance baseline (first publish) ──
  if (baseline) {
    const at = tsToISO(baseline.firstPublishedAt)
    if (at) {
      entries.push({
        id: 'governance:first_publish', source: 'governance', action: 'first_published',
        detail: `Identity baseline captured · ${baseline.publishCount ?? 1} publish(es)`,
        actor: null, at,
      })
    }
  }

  // Newest first; entries without a timestamp sink to the bottom.
  entries.sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : -Infinity
    const tb = b.at ? Date.parse(b.at) : -Infinity
    return tb - ta
  })

  return NextResponse.json({ entries } satisfies Event360Timeline, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
