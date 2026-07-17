// GET /api/organizer/events/[eventId]/identifiers/export
//
// Streams every identifier lock for the event as a CSV download. Workspace +
// `participants` permission enforced via resolveIdentifierScope (same as the rest
// of the identifier API). Reads from Firestore with .stream() and writes rows as
// they arrive — memory stays flat regardless of pool size.

import { NextRequest } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { resolveIdentifierScope } from '@/lib/identifiers/organizerScope'
import type { IdentifierLockDoc } from '@/lib/identifiers/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// CSV cell: neutralize spreadsheet formula injection, then quote/escape.
function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',') + '\r\n'
}

function tsIso(v: unknown): string {
  if (v && typeof v === 'object' && typeof (v as { toDate?: () => Date }).toDate === 'function') {
    try { return (v as { toDate: () => Date }).toDate().toISOString() } catch { return '' }
  }
  return ''
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<Response> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) {
    return new Response(JSON.stringify({ error: scope.error }), {
      status: scope.status, headers: { 'Content-Type': 'application/json' },
    })
  }

  const encoder = new TextEncoder()
  const nodeStream = adminDb.collection('identifierLocks')
    .where('eventSlug', '==', scope.slug)
    .stream() as NodeJS.ReadableStream

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(csvRow([
        'Value', 'Numeric', 'Pool', 'Template', 'State',
        'Registration ID', 'Ever Checked In', 'Reason', 'Assigned At', 'Released At',
      ])))

      nodeStream.on('data', (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
        const d = doc.data() as IdentifierLockDoc
        controller.enqueue(encoder.encode(csvRow([
          d.value ?? '',
          d.numeric ?? '',
          d.poolId ?? '',
          d.templateId ?? '',
          d.state ?? '',
          d.registrationId ?? '',
          d.everCheckedIn ? 'yes' : 'no',
          d.reason ?? '',
          tsIso(d.assignedAt),
          tsIso(d.releasedAt),
        ])))
        // Backpressure: pause Firestore reads when the consumer is behind.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) nodeStream.pause()
      })
      nodeStream.on('end', () => controller.close())
      nodeStream.on('error', (err: Error) => controller.error(err))
    },
    pull() {
      nodeStream.resume()
    },
    cancel() {
      (nodeStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="identifiers-${scope.slug}.csv"`,
      'Cache-Control':       'no-store',
    },
  })
}
