// WhatsApp Inbox (Phase 1a) — the inbound webhook parser.
//
// parseWhatsAppInboundMessages is the only code that reads Meta's `messages[]`. It must
// extract every supported type, carry the explicit reference (context.id / reaction target)
// that routing treats as authoritative, cap what it stores, and never throw on anything.

import { describe, it, expect } from 'vitest'
import { parseWhatsAppInboundMessages } from '@/lib/whatsapp/webhookInbound'
import { parseWhatsAppStatusEvents } from '@/lib/whatsapp/webhookStatus'
import { MAX_TEXT_LENGTH } from '@/lib/whatsapp-inbox/types'

const PNID = '1098765'

function payload(messages: unknown[], extra: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '15550000000', phone_number_id: PNID },
      contacts: [{ profile: { name: 'Self Chosen Name' }, wa_id: '919876543210' }],
      messages,
      ...extra,
    } }] }],
  }
}
const base = { from: '919876543210', timestamp: '1759140000' }

describe('parseWhatsAppInboundMessages — supported types', () => {
  it('text with reply context', () => {
    const [m] = parseWhatsAppInboundMessages(payload([{
      ...base, id: 'wamid.A', type: 'text', text: { body: 'Is parking available?' },
      context: { from: '15550000000', id: 'wamid.OUT1' },
    }]))
    expect(m).toEqual({
      wamid: 'wamid.A', phoneNumberId: PNID, from: '919876543210', type: 'text',
      metaTimestampMs: 1759140000000, text: 'Is parking available?', media: null,
      location: null, contextWamid: 'wamid.OUT1',
    })
  })

  it('text without context has contextWamid null', () => {
    const [m] = parseWhatsAppInboundMessages(payload([{ ...base, id: 'wamid.B', type: 'text', text: { body: 'hi' } }]))
    expect(m.contextWamid).toBeNull()
  })

  it.each(['image', 'document', 'audio', 'video', 'sticker'] as const)('%s keeps metadata only', type => {
    const [m] = parseWhatsAppInboundMessages(payload([{
      ...base, id: `wamid.${type}`, type,
      [type]: { id: 'MEDIA1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'bib photo', filename: 'x.pdf' },
    }]))
    expect(m.type).toBe(type)
    expect(m.media?.id).toBe('MEDIA1')
    expect(m.media?.mimeType).toBe('image/jpeg')
    expect(m.media).not.toHaveProperty('sha256')
    expect(m.text).toBeNull()
  })

  it('media without an id is unsupported, not a broken media row', () => {
    const [m] = parseWhatsAppInboundMessages(payload([{ ...base, id: 'wamid.C', type: 'image', image: {} }]))
    expect(m.type).toBe('unsupported')
    expect(m.media).toBeNull()
  })

  it('reaction references its target as the context', () => {
    const [m] = parseWhatsAppInboundMessages(payload([{
      ...base, id: 'wamid.R', type: 'reaction', reaction: { message_id: 'wamid.OUT2', emoji: '👍' },
    }]))
    expect(m).toMatchObject({ type: 'reaction', text: '👍', contextWamid: 'wamid.OUT2' })
  })

  it('quick-reply button carries text and context', () => {
    const [m] = parseWhatsAppInboundMessages(payload([{
      ...base, id: 'wamid.BTN', type: 'button', button: { text: 'Yes', payload: 'YES' },
      context: { id: 'wamid.OUT3' },
    }]))
    expect(m).toMatchObject({ type: 'button', text: 'Yes', contextWamid: 'wamid.OUT3' })
  })

  it('interactive button_reply and list_reply use the title', () => {
    const out = parseWhatsAppInboundMessages(payload([
      { ...base, id: 'wamid.I1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b', title: 'Confirm' } } },
      { ...base, id: 'wamid.I2', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'l', title: 'Event A' } } },
    ]))
    expect(out.map(m => m.text)).toEqual(['Confirm', 'Event A'])
  })

  it('location keeps coordinates and a readable label', () => {
    const [m] = parseWhatsAppInboundMessages(payload([{
      ...base, id: 'wamid.L', type: 'location',
      location: { latitude: 12.97, longitude: 77.59, name: 'Gate 2', address: 'MG Road' },
    }]))
    expect(m.location).toEqual({ latitude: 12.97, longitude: 77.59, name: 'Gate 2', address: 'MG Road' })
    expect(m.text).toBe('Gate 2 — MG Road')
  })

  it("Meta's own 'unsupported' and unknown future types are recorded with no content", () => {
    const out = parseWhatsAppInboundMessages(payload([
      { ...base, id: 'wamid.U1', type: 'unsupported', errors: [{ code: 131051 }] },
      { ...base, id: 'wamid.U2', type: 'order', order: { catalog_id: 'x' } },
    ]))
    expect(out.map(m => [m.type, m.text, m.media])).toEqual([['unsupported', null, null], ['unsupported', null, null]])
  })
})

describe('parseWhatsAppInboundMessages — safety', () => {
  it('caps text at MAX_TEXT_LENGTH', () => {
    const [m] = parseWhatsAppInboundMessages(payload([{ ...base, id: 'wamid.LONG', type: 'text', text: { body: 'x'.repeat(10_000) } }]))
    expect(m.text).toHaveLength(MAX_TEXT_LENGTH)
  })

  it('drops messages missing id or sender', () => {
    const out = parseWhatsAppInboundMessages(payload([
      { from: '919876543210', type: 'text', text: { body: 'no id' } },
      { id: 'wamid.NOFROM', type: 'text', text: { body: 'no from' } },
      null, 42, 'junk',
    ]))
    expect(out).toEqual([])
  })

  it('collapses the same wamid repeated inside one payload', () => {
    const msg = { ...base, id: 'wamid.DUP', type: 'text', text: { body: 'x' } }
    expect(parseWhatsAppInboundMessages(payload([msg, msg]))).toHaveLength(1)
  })

  it('invalid / missing timestamp → 0', () => {
    const out = parseWhatsAppInboundMessages(payload([
      { from: '1', id: 'wamid.T1', type: 'text', text: { body: 'a' } },
      { from: '1', id: 'wamid.T2', type: 'text', text: { body: 'a' }, timestamp: 'soon' },
    ]))
    expect(out.map(m => m.metaTimestampMs)).toEqual([0, 0])
  })

  it('never extracts the WhatsApp profile name', () => {
    const [m] = parseWhatsAppInboundMessages(payload([{ ...base, id: 'wamid.P', type: 'text', text: { body: 'x' } }]))
    expect(JSON.stringify(m)).not.toContain('Self Chosen Name')
  })

  it('missing metadata → empty phoneNumberId (routing then refuses it)', () => {
    const p = payload([{ ...base, id: 'wamid.M', type: 'text', text: { body: 'x' } }])
    delete (p.entry[0].changes[0].value as Record<string, unknown>).metadata
    expect(parseWhatsAppInboundMessages(p)[0].phoneNumberId).toBe('')
  })

  it('ignores changes for a different webhook field', () => {
    const p = payload([{ ...base, id: 'wamid.F', type: 'text', text: { body: 'x' } }])
    ;(p.entry[0].changes[0] as Record<string, unknown>).field = 'account_update'
    expect(parseWhatsAppInboundMessages(p)).toEqual([])
  })

  it.each([undefined, null, 'x', 42, [], {}, { entry: 'x' }, { entry: [{ changes: [null] }] }])(
    'never throws on malformed input %#', bad => {
      expect(() => parseWhatsAppInboundMessages(bad)).not.toThrow()
      expect(parseWhatsAppInboundMessages(bad)).toEqual([])
    },
  )
})

describe('statuses and messages in one payload are parsed independently', () => {
  it('each parser sees only its own events', () => {
    const p = payload(
      [{ ...base, id: 'wamid.IN', type: 'text', text: { body: 'hello' } }],
      { statuses: [{ id: 'wamid.OUT', status: 'delivered', timestamp: '1759140001', recipient_id: '919876543210' }] },
    )
    expect(parseWhatsAppInboundMessages(p).map(m => m.wamid)).toEqual(['wamid.IN'])
    expect(parseWhatsAppStatusEvents(p).map(e => e.wamid)).toEqual(['wamid.OUT'])
  })

  it('a status-only payload yields no inbound messages', () => {
    const p = { entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'w', status: 'sent', timestamp: '1' }] } }] }] }
    expect(parseWhatsAppInboundMessages(p)).toEqual([])
  })
})
