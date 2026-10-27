// RD-WA-TEMPLATES-01 — pure parser for Meta's template webhooks. No I/O.
//
//   field 'message_template_status_update' — value { event, message_template_id, message_template_name,
//     message_template_language, reason, message_template_category?, rejection_info?{reason,
//     recommendation}, other_info?{title, description}, disable_info?{disable_date} }
//   field 'template_category_update' — value { message_template_id, message_template_name,
//     message_template_language, previous_category, new_category, correct_category? }
//
// Delivered on the existing signed /api/webhooks/whatsapp endpoint (X-Hub-Signature-256 is verified
// there, before this parser runs). Unknown fields and malformed entries are skipped, never thrown.
// `entryTimeMs` is Meta's entry.time — used to ignore an event older than the state already stored.

export interface TemplateStatusEvent {
  kind:            'status'
  metaTemplateId:  string
  name:            string
  /** Normalized to Meta's send-side form (en_US, not en-US). */
  language:        string
  event:           string
  reason:          string | null
  category:        string | null
  rejectionInfo:   { reason: string | null; recommendation: string | null } | null
  otherInfo:       { title: string | null; description: string | null } | null
  disableDateMs:   number | null
  entryTimeMs:     number
}

export interface TemplateCategoryEvent {
  kind:             'category'
  metaTemplateId:   string
  name:             string
  language:         string
  previousCategory: string | null
  newCategory:      string | null
  entryTimeMs:      number
}

export type TemplateWebhookEvent = TemplateStatusEvent | TemplateCategoryEvent

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)

export function normalizeWebhookLanguage(v: unknown): string {
  return (str(v) ?? '').replace('-', '_')
}

export function parseTemplateWebhookEvents(payload: unknown): TemplateWebhookEvent[] {
  const out: TemplateWebhookEvent[] = []
  for (const entry of arr(rec(payload).entry)) {
    const t = Number(rec(entry).time)
    const entryTimeMs = Number.isFinite(t) && t > 0 ? (t > 1e12 ? t : t * 1000) : 0
    for (const change of arr(rec(entry).changes)) {
      const field = rec(change).field
      const v = rec(rec(change).value)
      const metaTemplateId = str(v.message_template_id)
      const name = str(v.message_template_name)
      if (!metaTemplateId || !name) continue
      const language = normalizeWebhookLanguage(v.message_template_language)
      if (field === 'message_template_status_update') {
        const event = str(v.event)
        if (!event) continue
        const ri = v.rejection_info ? rec(v.rejection_info) : null
        const oi = v.other_info ? rec(v.other_info) : null
        const dd = Number(rec(v.disable_info).disable_date)
        out.push({
          kind: 'status', metaTemplateId, name, language, event: event.toUpperCase(),
          reason: str(v.reason), category: str(v.message_template_category),
          rejectionInfo: ri ? { reason: str(ri.reason), recommendation: str(ri.recommendation) } : null,
          otherInfo: oi ? { title: str(oi.title), description: str(oi.description) } : null,
          disableDateMs: Number.isFinite(dd) && dd > 0 ? dd * 1000 : null,
          entryTimeMs,
        })
      } else if (field === 'template_category_update') {
        out.push({ kind: 'category', metaTemplateId, name, language, previousCategory: str(v.previous_category), newCategory: str(v.new_category), entryTimeMs })
      }
    }
  }
  return out
}
