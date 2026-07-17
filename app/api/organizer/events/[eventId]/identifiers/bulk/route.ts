// Organizer Identifier Bulk API.
//
//   POST { action: 'assign' | 'release', mode?: 'preview' | 'commit',
//          rows?: [{ registrationId, value?, category? }], csv?: string }
//
//   • mode 'preview' (default) = dry-run: validates each row, performs NO writes.
//   • mode 'commit'            = executes each row through the engine
//     (allocateIdentifier / releaseIdentifier) — one engine call per row, so all
//     uniqueness, transaction safety and audit logging are inherited unchanged.
//
// CSV is accepted as a raw string (header: registrationId,value,category) or as
// structured `rows`. Capped at 500 rows. Ownership-guarded per row.

import { NextRequest, NextResponse } from 'next/server'
import { allocateIdentifier, releaseIdentifier, lookupIdentifier } from '@/lib/identifiers/engine'
import { IdentifierError } from '@/lib/identifiers/types'
import { resolveIdentifierScope, assertRegistrationInScope } from '@/lib/identifiers/organizerScope'

export const dynamic = 'force-dynamic'

interface Row { registrationId: string; value?: string; category?: string | null }
interface RowResult { registrationId: string; ok: boolean; value?: string; error?: string; note?: string }

const MAX_ROWS = 500

function parseCsv(csv: string): Row[] {
  const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return []
  const header = lines[0].split(',').map(h => h.trim().toLowerCase())
  const idIdx  = header.indexOf('registrationid')
  const valIdx = header.indexOf('value')
  const catIdx = header.indexOf('category')
  const start  = idIdx >= 0 ? 1 : 0          // tolerate header-less single-column files
  const out: Row[] = []
  for (let i = start; i < lines.length; i++) {
    const cells = lines[i].split(',').map(c => c.trim())
    const registrationId = idIdx >= 0 ? (cells[idIdx] ?? '') : (cells[0] ?? '')
    if (!registrationId) continue
    out.push({
      registrationId,
      value:    valIdx >= 0 ? (cells[valIdx] || undefined) : undefined,
      category: catIdx >= 0 ? (cells[catIdx] || null) : null,
    })
  }
  return out
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  let body: { action?: string; mode?: string; rows?: Row[]; csv?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const action = body.action
  if (action !== 'assign' && action !== 'release') {
    return NextResponse.json({ error: "action must be 'assign' or 'release'" }, { status: 400 })
  }
  const mode = body.mode === 'commit' ? 'commit' : 'preview'

  let rows: Row[] = Array.isArray(body.rows)
    ? body.rows.filter(r => r && typeof r.registrationId === 'string' && r.registrationId)
    : typeof body.csv === 'string' ? parseCsv(body.csv) : []
  if (rows.length === 0) return NextResponse.json({ error: 'No rows supplied' }, { status: 400 })
  rows = rows.slice(0, MAX_ROWS)

  const results: RowResult[] = []

  for (const row of rows) {
    // Ownership + event scope for every row — no cross-event/org access.
    const guard = await assertRegistrationInScope(row.registrationId, scope.workspaceUid, scope.slug)
    if (!guard.ok) { results.push({ registrationId: row.registrationId, ok: false, error: guard.error }); continue }

    try {
      if (mode === 'preview') {
        // Dry-run: validate only. For explicit values, check availability.
        if (action === 'assign' && row.value?.trim()) {
          const lk = await lookupIdentifier(scope.slug, row.value.trim())
          const taken = lk.exists && lk.lock != null
            && lk.registrationId !== row.registrationId
            && ['assigned', 'consumed', 'reserved', 'blocked', 'retired'].includes(lk.lock.state)
          results.push({ registrationId: row.registrationId, ok: !taken, value: row.value.trim(),
            note: taken ? 'value already in use' : 'would assign' })
        } else {
          results.push({ registrationId: row.registrationId, ok: true,
            note: action === 'assign' ? 'would auto-assign' : 'would release' })
        }
        continue
      }

      // Commit
      if (action === 'assign') {
        const r = await allocateIdentifier({
          eventSlug: scope.slug, registrationId: row.registrationId, actor: scope.callerUid,
          source: 'bulk', explicitValue: row.value, category: row.category ?? null,
        })
        results.push({ registrationId: row.registrationId, ok: true, value: r.value })
      } else {
        await releaseIdentifier(row.registrationId, scope.callerUid, 'bulk release')
        results.push({ registrationId: row.registrationId, ok: true })
      }
    } catch (err) {
      const message = err instanceof IdentifierError ? err.message
        : err instanceof Error ? err.message : 'Failed'
      results.push({ registrationId: row.registrationId, ok: false, error: message })
    }
  }

  const succeeded = results.filter(r => r.ok).length
  return NextResponse.json({
    action, mode, processed: rows.length, succeeded, failed: rows.length - succeeded, results,
  })
}
