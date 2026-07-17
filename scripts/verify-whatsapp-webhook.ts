// Regression test for the WhatsApp status webhook parser (WA-2).
// Simulates Meta status payloads (sent / delivered / read / failed) and asserts the
// parsed events + status mapping. Run: npx tsx scripts/verify-whatsapp-webhook.ts

import { parseWhatsAppStatusEvents } from '../lib/whatsapp/webhookStatus'

let failures = 0
function assert(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

const statusPayload = (wamid: string, status: string, tsSec: number, errors?: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550000000', phone_number_id: 'PNID' },
        statuses: [{ id: wamid, status, timestamp: String(tsSec), recipient_id: '919000000000', ...(errors ? { errors } : {}) }],
      },
    }],
  }],
})

console.log('── Individual statuses ──')
for (const st of ['sent', 'delivered', 'read'] as const) {
  const ev = parseWhatsAppStatusEvents(statusPayload(`wamid.${st}`, st, 1_700_000_000))
  assert(`${st}: one event`, ev.length === 1)
  assert(`${st}: wamid + status`, ev[0]?.wamid === `wamid.${st}` && ev[0]?.status === st)
  assert(`${st}: timestampMs`, ev[0]?.timestampMs === 1_700_000_000_000)
}

console.log('── Failed status carries error + providerResponse ──')
const failed = parseWhatsAppStatusEvents(statusPayload('wamid.f', 'failed', 1_700_000_100, [
  { code: 131026, title: 'Message undeliverable', message: 'Recipient not on WhatsApp' },
]))
assert('failed: mapped', failed[0]?.status === 'failed')
assert('failed: error text', /Message undeliverable/.test(failed[0]?.error ?? ''))
assert('failed: providerResponse has code', /131026/.test(failed[0]?.providerResponse ?? ''))

console.log('── Multiple statuses in one payload ──')
const multi = parseWhatsAppStatusEvents({
  entry: [{ changes: [{ value: { statuses: [
    { id: 'w1', status: 'sent',      timestamp: '1700000000' },
    { id: 'w1', status: 'delivered', timestamp: '1700000005' },
    { id: 'w2', status: 'read',      timestamp: '1700000010' },
  ] } }] }],
})
assert('multi: 3 events', multi.length === 3)

console.log('── Robustness ──')
assert('inbound messages ignored (no statuses)', parseWhatsAppStatusEvents({ entry: [{ changes: [{ value: { messages: [{ id: 'in' }] } }] }] }).length === 0)
assert('unknown status ignored', parseWhatsAppStatusEvents(statusPayload('w', 'deleted', 1)).length === 0)
assert('missing wamid ignored', parseWhatsAppStatusEvents({ entry: [{ changes: [{ value: { statuses: [{ status: 'sent', timestamp: '1' }] } }] }] }).length === 0)
assert('garbage → []', parseWhatsAppStatusEvents(null).length === 0 && parseWhatsAppStatusEvents({}).length === 0 && parseWhatsAppStatusEvents('x').length === 0)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
