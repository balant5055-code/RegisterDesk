// Cloud API request-body construction for template messages — server-only.
//
// Converts the provider's typed WhatsAppTemplateMessage into the exact JSON the
// Cloud API expects at POST /{PHONE_NUMBER_ID}/messages. Keeping this here means
// the Graph payload shape lives in exactly one place and never leaks upward.

import type {
  WhatsAppParameter,
  WhatsAppButtonParameter,
  WhatsAppTemplateMessage,
} from './types'
import { normalizePhoneNumber } from '@/lib/communication/phone'

// ─── Graph component shapes (Cloud API) ────────────────────────────────────────

type GraphParameter =
  | { type: 'text';      text: string }
  | { type: 'currency';  currency: { fallback_value: string; code: string; amount_1000: number } }
  | { type: 'date_time'; date_time: { fallback_value: string } }
  | { type: 'image';     image: { link: string } }
  | { type: 'document';  document: { link: string; filename?: string } }
  | { type: 'video';     video: { link: string } }

interface GraphComponent {
  type:       'header' | 'body' | 'button'
  sub_type?:  'url' | 'quick_reply'
  index?:     string
  parameters: unknown[]
}

export interface GraphTemplateMessageBody {
  messaging_product: 'whatsapp'
  recipient_type:    'individual'
  to:                string
  type:              'template'
  template: {
    name:        string
    language:    { code: string }
    components?: GraphComponent[]
  }
}

// ─── Conversion ────────────────────────────────────────────────────────────────

// Cloud API wants the phone in international format, digits only (no '+').
// The single shared normalizer is the FINAL choke point — no raw phone reaches Meta.
// Idempotent, so calling it here again after upstream normalization is safe.
function normalizeRecipient(to: string): string {
  return normalizePhoneNumber(to)
}

function toGraphParameter(p: WhatsAppParameter): GraphParameter {
  switch (p.type) {
    case 'text':      return { type: 'text', text: p.text }
    case 'currency':  return { type: 'currency',  currency:  { fallback_value: p.currency.fallbackValue, code: p.currency.code, amount_1000: p.currency.amount1000 } }
    case 'date_time': return { type: 'date_time', date_time: { fallback_value: p.dateTime.fallbackValue } }
    case 'image':     return { type: 'image',    image:    { link: p.image.link } }
    case 'document':  return { type: 'document', document: { link: p.document.link, ...(p.document.filename ? { filename: p.document.filename } : {}) } }
    case 'video':     return { type: 'video',    video:    { link: p.video.link } }
  }
}

function toButtonComponent(b: WhatsAppButtonParameter): GraphComponent {
  const param = b.parameter.type === 'payload'
    ? { type: 'payload', payload: b.parameter.payload }
    : { type: 'text', text: b.parameter.text }
  return { type: 'button', sub_type: b.subType, index: String(b.index), parameters: [param] }
}

export function buildTemplatePayload(msg: WhatsAppTemplateMessage): GraphTemplateMessageBody {
  const components: GraphComponent[] = []

  if (msg.headerParameters?.length) {
    components.push({ type: 'header', parameters: msg.headerParameters.map(toGraphParameter) })
  }
  if (msg.bodyParameters?.length) {
    components.push({ type: 'body', parameters: msg.bodyParameters.map(toGraphParameter) })
  }
  for (const btn of msg.buttonParameters ?? []) {
    components.push(toButtonComponent(btn))
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                normalizeRecipient(msg.to),
    type:              'template',
    template: {
      name:     msg.templateName,
      language: { code: msg.languageCode },
      ...(components.length ? { components } : {}),
    },
  }
}
