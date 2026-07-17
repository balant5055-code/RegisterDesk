// Public shapes for the WhatsApp provider's template-send API.
//
// These are intentionally a thin, typed abstraction over the Cloud API template
// component model — enough to express header/body/button parameters without
// leaking Graph request/response internals to callers. Business code never
// constructs these directly in this phase (no notification is routed to WhatsApp).

// A single template parameter (used in header and body components).
export type WhatsAppParameter =
  | { type: 'text';      text: string }
  | { type: 'currency';  currency: { fallbackValue: string; code: string; amount1000: number } }
  | { type: 'date_time'; dateTime: { fallbackValue: string } }
  | { type: 'image';     image: { link: string } }
  | { type: 'document';  document: { link: string; filename?: string } }
  | { type: 'video';     video: { link: string } }

// A button component parameter (URL suffix or quick-reply payload).
export interface WhatsAppButtonParameter {
  subType:    'url' | 'quick_reply'
  index:      number
  parameter:  { type: 'text'; text: string } | { type: 'payload'; payload: string }
}

// The caller-facing template message. `to` is an E.164 phone number (with or
// without a leading '+').
export interface WhatsAppTemplateMessage {
  to:                string
  templateName:      string
  languageCode:      string   // e.g. "en_US"
  headerParameters?: WhatsAppParameter[]
  bodyParameters?:   WhatsAppParameter[]
  buttonParameters?: WhatsAppButtonParameter[]
}

// Normalized send result — never contains a raw Meta payload.
export interface WhatsAppSendResult {
  success:         boolean
  messageId?:      string    // Meta wamid
  status?:         string    // e.g. "accepted"
  error?:          string    // normalized message
  code?:           number    // Graph error code (internal telemetry)
  httpStatus?:     number    // HTTP status of the Graph response (LS2.1 diagnostics)
  providerMessage?: string   // raw Meta error message — server logs/diagnostics only
  retriable?:      boolean
}
