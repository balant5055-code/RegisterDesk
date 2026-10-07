// RD-EVENT-19F-B — The start list a timing provider needs. GET → CSV.
//
// ═══ WHAT IT CONTAINS, AND WHAT IT DELIBERATELY DOES NOT ═════════════════════
// Identifier · Timing Tag · Participant · Pass · Category — and nothing else.
//
// NO email, NO phone, NO address, NO form answers. A timing system matches a read
// to a person by the tag and prints a name on a result; it has never needed a way
// to contact them. A future provider adapter that genuinely requires a field can
// add it deliberately — the default must not leak it.
//
// The column NAMES are provider-neutral, and the identifier column is titled with
// this event's own configured label, so a road race exports "Bib Number" and a
// conference exports "Delegate ID" from the same code.
//
// Streamed with a cursor: memory stays flat and a 20,000-participant event is the
// same shape of work as a 20-participant one.

import { NextRequest } from 'next/server'
import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { resolveIdentifierScope } from '@/lib/identifiers/organizerScope'
import { resolveIdentifierConfig } from '@/lib/identifiers/config'
import { resolveTagMapping } from '@/lib/identifiers/timingTags'
import { ROSTER_STATUSES } from '@/lib/identifiers/eligibility'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PAGE = 500

/** Neutralises spreadsheet formula injection, then quotes/escapes. */
function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}
const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',') + '\r\n'

export async function GET(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<Response> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId, { forDownload: true })
  if (!scope.ok) {
    return new Response(JSON.stringify({ error: scope.error }), {
      status: scope.status, headers: { 'Content-Type': 'application/json' },
    })
  }

  const { config } = await resolveIdentifierConfig(scope.slug)
  const mapping = resolveTagMapping(config.tagMapping)

  const base = adminDb.collection('registrations')
    .where('organizerUid', '==', scope.workspaceUid)
    .where('eventSlug', '==', scope.slug)
    .where('status', '==', ROSTER_STATUSES[0])
    .orderBy(FieldPath.documentId())

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // RD-BIB-TIMING-01 · a STATUS column, because a blank identifier cell is not
      // self-explanatory to whoever opens this file. A participant with no
      // identifier cannot be timed, and the row says which of the two credentials
      // is missing rather than being silently dropped (which would hide people) or
      // given an invented value (which would map a chip to nobody).
      controller.enqueue(encoder.encode(csvRow([
        config.label, mapping.label, 'Participant', 'Pass', 'Category', 'Status',
      ])))

      let cursor: string | null = null
      try {
        for (;;) {
          let q = base.limit(PAGE)
          if (cursor) q = q.startAfter(cursor)
          const snap = await q.select('attendee', 'passName', 'identifier', 'timingTag', 'bibCategory').get()
          if (snap.empty) break

          for (const d of snap.docs) {
            const r = d.data() as Record<string, unknown>
            const a = r.attendee as { name?: unknown } | undefined
            const identifier = (r.identifier as { value?: unknown } | undefined)?.value
            const tg = r.timingTag as { tag?: unknown; state?: unknown } | null | undefined
            // In `identifier` mode the device IS the printed value, so the tag
            // column repeats it rather than being blank — which is exactly what a
            // provider expects from an event configured that way.
            const tagCell = mapping.mode === 'identifier'
              ? (typeof identifier === 'string' ? identifier : '')
              : (tg?.state === 'assigned' && typeof tg.tag === 'string' ? tg.tag : '')

            // The dependency, restated for the reader of the file: no identifier
            // means no timing is possible, whatever the tag column happens to say.
            const hasIdentifier = typeof identifier === 'string' && identifier.length > 0
            const status = !hasIdentifier ? `Needs ${config.label}`
                         : !tagCell       ? `Needs ${mapping.label}`
                         : 'Ready'

            controller.enqueue(encoder.encode(csvRow([
              hasIdentifier ? identifier : '',
              tagCell,
              typeof a?.name === 'string' ? a.name : '',
              typeof r.passName === 'string' ? r.passName : '',
              typeof r.bibCategory === 'string' ? r.bibCategory : '',
              status,
            ])))
          }

          if (snap.size < PAGE) break
          cursor = snap.docs[snap.docs.length - 1].id
        }
      } catch {
        // A truncated file is worse than a visible failure: say so IN the file.
        controller.enqueue(encoder.encode(csvRow(['# export interrupted — this file is incomplete'])))
      }
      controller.close()
    },
  })

  const filename = `${scope.slug}-start-list.csv`
  return new Response(stream, {
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-store',
    },
  })
}
