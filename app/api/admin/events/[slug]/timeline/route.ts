// GET /api/admin/events/[slug]/timeline — Event 360 merged chronological trail.
//
// Admin-gated read. Merges — from EXISTING sources, no new logic — the event's:
//   • lifecycle timestamps (event doc)            → source: 'lifecycle'
//   • admin audit trail (adminAuditLogs)          → source: 'audit' / 'moderation'
//   • immutable license history (getLicenseDetail) → source: 'license'
//   • publish governance baseline (getBaseline)   → source: 'governance'
//   • review history (events/{slug}/reviewHistory) → source: 'review' (RD-REVIEW-01)
// into ONE list sorted newest-first. Reads are bounded (audit ≤200, history ≤200);
// no scan. Sorting is in-memory so no composite index is required.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid, resolveSuperAdminUid } from '@/lib/admin/auth'
import { getLicenseDetail }          from '@/lib/admin/licenseAdminService'
import { getBaseline }               from '@/lib/events/governance/baseline'
import { isFinancialAuditEntry }     from '@/lib/admin/auditConstants'
import { readReviewHistory, type ReviewHistoryItem } from '@/lib/events/reviewHistory'
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

// RD-REVIEW-01 — the rows the review history supersedes for the period it covers.
const REVIEW_LIFECYCLE_KEYS = new Set(['approved', 'rejected', 'changes_requested', 'resubmitted'])
const REVIEW_AUDIT_ACTIONS  = new Set(['event.approved', 'event.rejected', 'event.changes_requested'])

const REVIEW_LABEL: Record<ReviewHistoryItem['action'], string> = {
  approve:         'Approved',
  reject:          'Rejected',
  request_changes: 'Changes requested',
  resubmit:        'Resubmitted by organizer',
  republish:       'Republished by organizer',
}
function reviewDetail(r: ReviewHistoryItem): string {
  const text = r.comment ?? r.reason
  const revised = r.revisedSections.length ? r.revisedSections.map(s => s.replace(/^eventDetails\./, '')) : []
  const fields = revised.length ? ` · revised: ${revised.join(', ')}` : ''
  return `${REVIEW_LABEL[r.action] ?? r.action}${text ? ` — ${text}` : ''}${fields}`
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { slug } = await ctx.params

  const eventSnap = await adminDb.collection('events').doc(slug).get()
  if (!eventSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const ev      = eventSnap.data() as Record<string, unknown>
  const draftId = str(ev.draftId) ?? slug

  // RD-PHASE4-S4 · D7 — financial audit rows (and the licence history) only for a Super Admin.
  const includeFinancial = (await resolveSuperAdminUid(req.headers.get('authorization'))) !== null
  const [auditSnap, license, baseline, review] = await Promise.all([
    adminDb.collection('adminAuditLogs').where('entityId', '==', slug).limit(200).get().catch(() => null),
    getLicenseDetail(slug).catch(() => null),
    getBaseline(draftId).catch(() => null),
    readReviewHistory(slug),
  ])

  const entries: Event360TimelineEntry[] = []

  // ── Review history (RD-REVIEW-01) ──
  // Every decision and resubmission, each with its own time, actor and comment. The single
  // "latest" lifecycle stamps and the admin audit rows below repeat the same occurrences, so for
  // the period the history covers they are left out rather than listed twice.
  const historyStart = review.length ? Date.parse(review[review.length - 1].at ?? '') : NaN
  const coveredByHistory = (at: string | null) =>
    Number.isFinite(historyStart) && at !== null && Date.parse(at) >= historyStart
  for (const r of review) {
    entries.push({
      id: `review:${r.id}`, source: 'review', action: r.action,
      detail: reviewDetail(r),
      actor: r.actorUid, at: r.at,
    })
  }

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
    if (!at) continue
    if (REVIEW_LIFECYCLE_KEYS.has(action) && coveredByHistory(at)) continue
    entries.push({ id: `lifecycle:${action}`, source: 'lifecycle', action, detail, actor: null, at })
  }

  // ── Admin audit trail (moderation + generic admin actions on this event) ──
  if (auditSnap) {
    for (const d of auditSnap.docs) {
      const x = d.data() as Record<string, unknown>
      if (!includeFinancial && isFinancialAuditEntry(x)) continue
      const action = str(x.action) ?? 'admin.action'
      const source: TimelineSource = MODERATION_ACTIONS.has(action) ? 'moderation' : 'audit'
      const meta = x.metadata && typeof x.metadata === 'object' ? (x.metadata as Record<string, unknown>) : {}
      const at   = tsToISO(x.createdAt)
      if (REVIEW_AUDIT_ACTIONS.has(action) && coveredByHistory(at)) continue
      // `comment` is where the review route records a change request; it was never shown.
      const detail = str(meta.reason) ?? str(meta.comment) ?? str(meta.note) ?? action.replace(/[._]/g, ' ')
      entries.push({
        id:     `audit:${d.id}`,
        source, action,
        detail,
        actor:  str(x.adminUid),
        at,
      })
    }
  }

  // ── License history (immutable, already mapped by the service) ──
  if (license && includeFinancial) {
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
