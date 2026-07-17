// Pure parser for Meta WhatsApp status webhook payloads (WA-2). No I/O, no
// Firestore — just Meta's JSON → a flat list of delivery-status events. Kept
// separate from persistence so it is unit-testable and the provider is untouched.
//
// Meta shape (statuses only; inbound `messages` are ignored):
//   { entry: [ { changes: [ { value: { statuses: [ {
//       id, status, timestamp, recipient_id, errors?: [ { code, title, message } ]
//   } ] } } ] } ] }

import type { WhatsAppDeliveryStatus } from '@/lib/email-logs/types'

export interface WhatsAppStatusEvent {
  wamid:             string
  status:            WhatsAppDeliveryStatus
  timestampMs:       number
  error?:            string   // human summary (failed events)
  providerResponse?: string   // compact diagnostics (failed events)
}

const VALID: Record<string, WhatsAppDeliveryStatus> = {
  sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed',
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Extract every delivery-status event from a Meta webhook body. Never throws. */
export function parseWhatsAppStatusEvents(payload: unknown): WhatsAppStatusEvent[] {
  const events: WhatsAppStatusEvent[] = []
  const root = (payload ?? {}) as { entry?: unknown }

  for (const entry of asArray(root.entry)) {
    for (const change of asArray((entry as { changes?: unknown }).changes)) {
      const value = (change as { value?: unknown }).value as { statuses?: unknown } | undefined
      for (const s of asArray(value?.statuses)) {
        const st = s as { id?: unknown; status?: unknown; timestamp?: unknown; errors?: unknown }
        const wamid = typeof st.id === 'string' ? st.id : ''
        const mapped = typeof st.status === 'string' ? VALID[st.status] : undefined
        if (!wamid || !mapped) continue

        const tsSec = Number(st.timestamp)
        const timestampMs = Number.isFinite(tsSec) && tsSec > 0 ? Math.round(tsSec * 1000) : 0

        let error: string | undefined
        let providerResponse: string | undefined
        if (mapped === 'failed') {
          const err = asArray(st.errors)[0] as { code?: unknown; title?: unknown; message?: unknown } | undefined
          if (err) {
            const code  = err.code != null ? String(err.code) : '?'
            const title = typeof err.title === 'string' ? err.title : ''
            const msg   = typeof err.message === 'string' ? err.message : ''
            error = `${title || 'WhatsApp delivery failed'}${msg ? `: ${msg}` : ''}`.slice(0, 300)
            providerResponse = `code ${code}${title ? ` · ${title}` : ''}`.slice(0, 300)
          } else {
            error = 'WhatsApp delivery failed'
          }
        }

        events.push({ wamid, status: mapped, timestampMs, error, providerResponse })
      }
    }
  }

  return events
}
