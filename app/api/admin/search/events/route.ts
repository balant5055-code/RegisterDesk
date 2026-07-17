// GET /api/admin/search/events?q= — bounded event search for global search (GA-2 S6).
//
// Admin-gated. NO scan: an exact slug is a single doc get; free text is filtered
// IN MEMORY over a bounded recent page (the SAME pattern the organizers list uses).
// This is the only new query in this sprint — no event-search endpoint existed to
// reuse. Older unlicensed events that don't match the recent window are reachable by
// exact slug (here) or via their license (the licenses endpoint), never by scan.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
import type { EventSearchHit, EventSearchResponse } from '@/lib/admin/globalSearchTypes'

const RECENT_WINDOW = 60
const MAX_HITS      = 8

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

function toHit(id: string, ev: Record<string, unknown>): EventSearchHit {
  const info = rec(rec(ev.eventDetails).info)
  return {
    slug:            id,
    name:            str(info.name) ?? '(untitled event)',
    organizerUid:    str(ev.uid),
    lifecycleStatus: str(ev.lifecycleStatus),
    eventType:       str(ev.eventType),
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (q.length < 2) return NextResponse.json({ events: [] } satisfies EventSearchResponse)
  const ql = q.toLowerCase()

  const byId = new Map<string, EventSearchHit>()

  // Exact slug — O(1) doc get.
  try {
    const snap = await adminDb.collection('events').doc(q).get()
    if (snap.exists) byId.set(snap.id, toHit(snap.id, snap.data() as Record<string, unknown>))
  } catch { /* ignore */ }

  // Bounded recent page + in-memory filter (no scan). Prefer newest-first; fall
  // back to an unordered bounded page if the createdAt index is unavailable.
  const col = adminDb.collection('events')
  const page = await col.orderBy('createdAt', 'desc').limit(RECENT_WINDOW).get()
    .catch(() => col.limit(RECENT_WINDOW).get().catch(() => null))
  for (const d of page?.docs ?? []) {
    if (byId.has(d.id)) continue
    const hit = toHit(d.id, d.data() as Record<string, unknown>)
    if (hit.slug.toLowerCase().includes(ql) || hit.name.toLowerCase().includes(ql)) byId.set(d.id, hit)
    if (byId.size >= MAX_HITS) break
  }

  return NextResponse.json({ events: [...byId.values()].slice(0, MAX_HITS) } satisfies EventSearchResponse, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
