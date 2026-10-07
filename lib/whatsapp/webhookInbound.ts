// Pure parser for Meta WhatsApp INBOUND message webhook payloads (WhatsApp Inbox, Phase 1a).
// The sibling of webhookStatus.ts: no I/O, no Firestore — Meta's JSON → a flat list of
// inbound messages. Kept separate from persistence so it is unit-testable, and separate from
// the status parser so the delivery-status path stays byte-identical.
//
// Meta shape (the `messages` webhook field carries BOTH statuses and messages):
//   { entry: [ { changes: [ { field: 'messages', value: {
//       metadata: { phone_number_id },
//       messages: [ { from, id, timestamp, type, context?: { id }, text?: { body }, … } ]
//   } } ] } ] }
//
// Never throws. Anything malformed is dropped rather than guessed at. The sender's WhatsApp
// profile name (`value.contacts[].profile.name`) is deliberately NOT extracted: the attendee's
// name comes from their registration, and a self-chosen display name is personal data the
// inbox does not need.

import {
  MAX_TEXT_LENGTH,
  type InboundLocation,
  type InboundMedia,
  type InboundMessageType,
} from '@/lib/whatsapp-inbox/types'

export interface WhatsAppInboundMessage {
  wamid:           string
  /** The business phone number the message was delivered to ('' when Meta omitted it). */
  phoneNumberId:   string
  /** Sender as Meta reports it (wa_id, digits). Normalized later by the shared phone util. */
  from:            string
  type:            InboundMessageType
  /** Unix ms from Meta's `timestamp`; 0 when absent/invalid. */
  metaTimestampMs: number
  text:            string | null
  media:           InboundMedia | null
  location:        InboundLocation | null
  /**
   * The outbound message this one explicitly refers to: `context.id` for a reply or a
   * quick-reply button, `reaction.message_id` for a reaction. Null when there is none.
   */
  contextWamid:    string | null
}

const MEDIA_TYPES = new Set(['image', 'document', 'audio', 'video', 'sticker'])

type Obj = Record<string, unknown>

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function asObj(v: unknown): Obj | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}
function cap(v: string | null): string | null {
  return v === null ? null : v.slice(0, MAX_TEXT_LENGTH)
}
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

function parseMedia(node: Obj | null): InboundMedia | null {
  const id = str(node?.id)
  if (!node || !id) return null
  const media: InboundMedia = { id }
  const mimeType = str(node.mime_type)
  const caption  = cap(str(node.caption))
  const filename = str(node.filename)
  if (mimeType) media.mimeType = mimeType
  if (caption)  media.caption  = caption
  if (filename) media.filename = filename.slice(0, 255)
  return media
}

function parseLocation(node: Obj | null): InboundLocation | null {
  const latitude  = num(node?.latitude)
  const longitude = num(node?.longitude)
  if (!node || latitude === null || longitude === null) return null
  const loc: InboundLocation = { latitude, longitude }
  const name    = str(node.name)
  const address = str(node.address)
  if (name)    loc.name    = name.slice(0, 255)
  if (address) loc.address = address.slice(0, 500)
  return loc
}

function parseOne(raw: unknown, phoneNumberId: string): WhatsAppInboundMessage | null {
  const m = asObj(raw)
  if (!m) return null
  const wamid = str(m.id)
  const from  = str(m.from)
  if (!wamid || !from) return null

  const tsSec = num(m.timestamp)
  const metaTimestampMs = tsSec !== null && tsSec > 0 ? Math.round(tsSec * 1000) : 0

  const rawType = str(m.type) ?? ''
  let type: InboundMessageType = 'unsupported'
  let text: string | null = null
  let media: InboundMedia | null = null
  let location: InboundLocation | null = null
  let contextWamid = str(asObj(m.context)?.id)

  if (rawType === 'text') {
    type = 'text'
    text = cap(str(asObj(m.text)?.body))
  } else if (MEDIA_TYPES.has(rawType)) {
    media = parseMedia(asObj(m[rawType]))
    type  = media ? (rawType as InboundMessageType) : 'unsupported'
  } else if (rawType === 'location') {
    location = parseLocation(asObj(m.location))
    type = location ? 'location' : 'unsupported'
    if (location) text = cap([location.name, location.address].filter(Boolean).join(' — ') || null)
  } else if (rawType === 'reaction') {
    const r = asObj(m.reaction)
    type = 'reaction'
    text = str(r?.emoji)   // an empty emoji is Meta's "reaction removed"
    contextWamid = contextWamid ?? str(r?.message_id)
  } else if (rawType === 'button') {
    type = 'button'
    text = cap(str(asObj(m.button)?.text))
  } else if (rawType === 'interactive') {
    const it = asObj(m.interactive)
    const reply = asObj(it?.button_reply) ?? asObj(it?.list_reply)
    type = 'interactive'
    text = cap(str(reply?.title))
  }
  // Anything else (Meta's own 'unsupported', 'system', 'order', unknown future types) stays
  // 'unsupported' with no content — recorded, never interpreted.

  return { wamid, phoneNumberId, from, type, metaTimestampMs, text, media, location, contextWamid }
}

/** Extract every inbound message from a Meta webhook body. Never throws. */
export function parseWhatsAppInboundMessages(payload: unknown): WhatsAppInboundMessage[] {
  const out: WhatsAppInboundMessage[] = []
  const seen = new Set<string>()
  const root = asObj(payload)

  for (const entry of asArray(root?.entry)) {
    for (const change of asArray(asObj(entry)?.changes)) {
      const c = asObj(change)
      // Only the `messages` field carries messages; an absent field is tolerated (older
      // payload shapes), any other named field is not ours.
      if (c?.field !== undefined && c.field !== 'messages') continue
      const value = asObj(c?.value)
      const phoneNumberId = str(asObj(value?.metadata)?.phone_number_id) ?? ''
      for (const raw of asArray(value?.messages)) {
        const msg = parseOne(raw, phoneNumberId)
        // The same wamid twice in ONE payload is collapsed here; across payloads the
        // persistence layer's create() is the guard.
        if (msg && !seen.has(msg.wamid)) {
          seen.add(msg.wamid)
          out.push(msg)
        }
      }
    }
  }
  return out
}
