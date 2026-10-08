// RD-COMMS-P2-F — Communication UI & usage cleanup: the display rules and the page contracts.
//
//   • message outcome: Sent / Failed / Delivery unknown are distinct, and Retry is offered for a
//     DEFINITE failure only; WhatsApp is never labelled "Free";
//   • Usage figures: definitions + the pure arithmetic; email is "included" without implying
//     anything about WhatsApp; the legacy balance is read-only;
//   • reminders: plain-language reasons, never an internal code or error text;
//   • every communication page follows the event selector and carries the event into links;
//   • no Add Funds / Top up / Recharge / Media Credits purchase / SMS action survives.
// The server read models are exercised on the emulator (tests/emulator/communicationUiP2F.emu.test.ts).

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const read = (f: string) => readFileSync(f, 'utf8')
/** The source without comment lines — what can actually render. */
const code = (f: string) => read(f).split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')
const { commStatusOf, canOfferRetry, chargeLabel, COMM_STATUS_LABELS, DELIVERY_UNKNOWN_HELP } = await import('@/lib/communications/messageStatus')
const labels = await import('@/lib/communications/usageLabels')
const { serviceUsageOf } = await import('@/lib/communications/usage')
const { reminderReasonLabel, REMINDER_STATUS_LABELS } = await import('@/lib/reminders/types')
const { increaseLimitHref } = await import('@/lib/wallet/purchaseIntent')
const { withEventParam } = await import('@/lib/events/eventContext')
const { COMMUNICATION_USAGE_HREF } = await import('@/lib/wallet/communicationBalance')

const inr = (p: number) => `₹${p / 100}`

const PAGES = {
  hub:        'app/(dashboard)/dashboard/communications/page.tsx',
  usage:      'components/communications/CommUsage.tsx',
  tabs:       'components/communications/CommTabs.tsx',
  messages:   'app/(dashboard)/dashboard/communications/notifications/page.tsx',
  reminders:  'app/(dashboard)/dashboard/communications/reminders/page.tsx',
  emailLogs:  'app/(dashboard)/dashboard/communications/email-logs/EmailLogsClient.tsx',
  broadcasts: 'app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx',
  eventTab:   'app/(dashboard)/dashboard/events/[eventId]/tabs/CommunicationsTab.tsx',
  whatsapp:   'app/(dashboard)/dashboard/communications/whatsapp-logs/WhatsAppLogsClient.tsx',
}

describe('message outcome — Sent, Failed and Delivery unknown are distinct', () => {
  it('a failed row flagged deliveryUnknown is "Delivery unknown", not Failed and not Sent', () => {
    expect(commStatusOf({ status: 'failed', deliveryUnknown: true })).toBe('unknown')
    expect(commStatusOf({ status: 'failed' })).toBe('failed')
    expect(commStatusOf({ status: 'sent' })).toBe('sent')
    expect(commStatusOf({ status: 'sent', deliveryUnknown: true })).toBe('sent')      // a later confirmation wins
    expect(COMM_STATUS_LABELS.unknown).toBe('Delivery unknown')
    expect(DELIVERY_UNKNOWN_HELP).toMatch(/may or may not have been delivered/)
  })
  it('Retry is offered for a DEFINITE failure only — never for an unknown outcome', () => {
    expect(canOfferRetry({ status: 'failed' })).toBe(true)
    expect(canOfferRetry({ status: 'failed', deliveryUnknown: true })).toBe(false)
    expect(canOfferRetry({ status: 'sent' })).toBe(false)
    const src = read(PAGES.emailLogs)
    expect(src).toContain('{canOfferRetry(log) && (')
    expect(src).not.toContain("{log.status === 'failed' && (")
  })
  it('the Messages page shows the unknown state and offers no resend at all', () => {
    const src = code(PAGES.messages)
    expect(src).toContain('<option value="unknown">Delivery unknown</option>')
    expect(src).toContain('label="Delivery unknown"')
    expect(src).not.toMatch(/retry|resend/i)
  })
  it('WhatsApp is never "Free": email is "Included", WhatsApp shows only a legacy-balance charge', () => {
    expect(chargeLabel({ channel: 'email', costPaise: 0 }, inr)).toBe('Included')
    expect(chargeLabel({ channel: 'whatsapp', costPaise: 0 }, inr)).toBe('—')
    expect(chargeLabel({ channel: 'whatsapp', costPaise: 150 }, inr)).toBe('₹1.5 · legacy balance')
    expect(read(PAGES.messages)).not.toMatch(/>Free<|'Free'/)
    const bc = read(PAGES.broadcasts)
    expect(bc).toContain("c.channel === 'email' ? 'Included (email)' : '—'")
    expect(bc).not.toMatch(/: 'Free'\}/)
  })
})

describe('Usage — definitions, arithmetic and wording', () => {
  const line = { purchased: 100, consumed: 60, carriedIn: 20, carriedOut: 10, refunded: 5, remaining: 45 }
  // RD-COMMS-L2 — the ONE organizer definition (lib/communications/capacityFigures).
  const act = (inProgress: number) => ({ inProgress, returned: 7 })
  it('Purchased = bought for this event; Carried in is its own figure', () => {
    expect(serviceUsageOf(line, act(19), '#')).toMatchObject({ purchased: 100, carriedIn: 20 })
  })
  it('In progress = units currently held (never more than consumed)', () => {
    expect(serviceUsageOf(line, act(19), '#').inProgress).toBe(19)
    expect(serviceUsageOf(line, act(999), '#').inProgress).toBe(60)
  })
  it('Used = consumed − in progress', () => expect(serviceUsageOf(line, act(19), '#').used).toBe(41))
  it('Returned = units broadcasts gave back; Refunded and Carried out are their own figures', () => {
    expect(serviceUsageOf(line, act(19), '#')).toMatchObject({ returned: 7, refunded: 5, carriedOut: 10 })
  })
  it('Available = the ledger’s available figure, and the figures reconcile (Returned is already inside it)', () => {
    const u = serviceUsageOf(line, act(19), '#')
    expect(u.available).toBe(45)
    expect(u.purchased + u.carriedIn - u.inProgress! - u.used! - u.refunded - u.carriedOut).toBe(u.available)
  })
  it('every figure has a plain definition, with no storage/ledger/hold jargon', () => {
    for (const k of labels.USAGE_FIGURE_ORDER) {
      expect(labels.USAGE_FIGURE_HELP[k].length, k).toBeGreaterThan(20)
      expect(labels.USAGE_FIGURE_HELP[k], k).not.toMatch(/firestore|ledger|hold id|unitKey|eventServiceAllowances|doc/i)
    }
    expect(labels.USAGE_FIGURE_HELP.available).toMatch(/Purchased plus Carried in, minus Used, In progress, Refunded and Carried out/)
    const src = read(PAGES.usage)
    expect(src).toContain('What these figures mean')
    expect(src).toContain('help={USAGE_FIGURE_HELP[k]}')
    expect(src).toContain('help={USAGE_FIGURE_HELP[key]}')
  })
  it('email is included — and says it never uses WhatsApp capacity or any balance (no bare "Free")', () => {
    expect(labels.EMAIL_INCLUDED_NOTE).toMatch(/never uses this event’s WhatsApp capacity or any communication balance/)
    expect(labels.USAGE_FUNDED_LABELS.free).toBe('Included (email)')
    expect(read(PAGES.usage)).not.toMatch(/>Free<|'Free'/)
  })
  it('the legacy balance, when shown, is badged read-only and cannot be topped up', () => {
    expect(read(PAGES.usage)).toContain('Legacy · read-only')
    expect(labels.LEGACY_BALANCE_NOTE).toMatch(/cannot be topped up/)
  })
})

describe('event scoping and event-preserving links', () => {
  it('Usage, Messages and Reminders follow the event selector and drop a stale answer', () => {
    const usage = read(PAGES.usage)
    expect(usage).toContain('usage?eventId=${encodeURIComponent(eventId)}')
    expect(usage).toContain('state.eventId === selectedEventId')
    const msg = read(PAGES.messages)
    expect(msg).toContain('useEventContext()')
    expect(msg).toContain("if (scope !== '*') qs.set('event', scope)")
    expect(msg).toContain('}, [scope, dateFrom, dateTo, reloadKey])')
    expect(msg).not.toContain('All events</option>')           // no second, competing event picker
    const rem = read(PAGES.reminders)
    expect(rem).toContain("`?event=${encodeURIComponent(scope)}`")
    expect(rem).toContain('list.scope === scope')
    expect(rem).toContain('}, [scope, reloadKey])')
  })
  it('License & Services opens THIS event on the right service', () => {
    for (const s of ['whatsapp', 'certificates', 'media', 'registrations'] as const) {
      const href = increaseLimitHref('draft-xyz', s)
      expect(href).toContain('draftId=draft-xyz')
      expect(href).toContain(`service=${s}`)
      expect(href).toContain('step=license')
    }
    expect(read(PAGES.eventTab)).toContain('withEventParam(COMMUNICATION_USAGE_HREF, event.draftId)')
    expect(withEventParam(COMMUNICATION_USAGE_HREF, 'draft-xyz')).toBe('/dashboard/communications?tab=usage&eventId=draft-xyz')
  })
})

describe('reminders — readable state, never an internal code', () => {
  it('known reasons are plain words; anything else is generic', () => {
    expect(reminderReasonLabel('skipped', 'organizer_suspended')).toMatch(/suspended/)
    expect(reminderReasonLabel('skipped', 'event_not_live')).toMatch(/archived/)
    expect(reminderReasonLabel('skipped', 'reminders_disabled')).toMatch(/switched off/)
    expect(reminderReasonLabel('skipped', 'email_disabled')).toMatch(/Email sending is switched off/)
    expect(reminderReasonLabel('skipped', 'event_rescheduled')).toMatch(/date or time changed/)
    expect(reminderReasonLabel('skipped', 'no_eligible_recipients')).toMatch(/no longer an attendee/)
    expect(reminderReasonLabel('failed', 'Error: ECONNRESET at socket.ts:42')).toBe('It could not be sent.')
    expect(reminderReasonLabel('skipped', 'something_new')).toBe('It was not sent.')
    expect(reminderReasonLabel('sent', null)).toBeNull()
    expect(REMINDER_STATUS_LABELS.skipped).toBe('Not sent')
  })
  it('the row carries the label, never the raw error; the page shows it with continuing/resumed state', () => {
    const svc = read('lib/reminders/service.ts')
    expect(svc).toContain('reasonLabel:  reminderReasonLabel(data.status, d.error)')
    const rowType = read('lib/reminders/types.ts').split('export interface ReminderRow {')[1].split('\n}')[0]
    expect(rowType).toContain('reasonLabel:')
    expect(rowType).not.toMatch(/^\s+error:/m)                                   // ReminderRow has no error field
    const page = read(PAGES.reminders)
    expect(page).toContain('{r.reasonLabel && <p')
    expect(page).toContain("if (r.continuing) return 'Continuing'")
    expect(page).toContain('Resumed after an interruption.')
    expect(page).not.toMatch(/label="Cost"/)
  })
  it('the retired low-balance reminder is neither previewed nor offered as a live switch', () => {
    expect(read(PAGES.tabs)).toContain("REMINDER_KINDS.filter(k => k !== 'low_wallet')")
    expect(read('app/(admin)/admin/reminders/PageClient.tsx')).toMatch(/k === 'low_wallet' \? \([\s\S]{0,900}>Retired</)
  })
})

describe('no wallet-era action, Media Credits purchase or SMS action in communication flows', () => {
  const flows = [...Object.values(PAGES), 'components/communications/CommUsage.tsx']
  it('no Add Funds / Top up / Recharge / Buy credits / wallet balance call to action', () => {
    for (const f of flows) {
      const visible = code(f)
      expect(visible, f).not.toMatch(/add funds|top ?up communication|recharge|buy (communication|credits)|low wallet|wallet deduction|wallet charge|wallet-charged/i)
      expect(visible, f).not.toMatch(/wallet\/topup|media-credits\/(buy|purchase)/i)
    }
  })
  it('no Media Credits purchase surface: the old page is a retired notice', () => {
    const page = read('app/(dashboard)/dashboard/media-studio/credits/page.tsx')
    expect(page).toContain('Media Credits are no longer used')
    // It only points to where photos ARE bought; it has no control of its own.
    expect(code('app/(dashboard)/dashboard/media-studio/credits/page.tsx')).not.toMatch(/checkout|razorpay|<button|onClick|\/buy|Buy |Purchase credits/i)
    expect(page).toContain('License &amp; Services')
  })
  it('SMS has no card, row or action while it has no transport', () => {
    expect(read(PAGES.tabs)).toContain('{SMS_AVAILABLE && <MetricCard label="SMS sent"')
    expect(read(PAGES.eventTab)).toMatch(/\{SMS_AVAILABLE && \(\s*<ChannelRow/)
    for (const f of flows) expect(read(f), f).not.toMatch(/Send SMS|sendSms/i)
  })
  it('the hub keeps Inbox-free, supported tabs: Overview, Messages, Broadcasts, Reminders, Templates, Analytics, Usage', () => {
    const hub = read(PAGES.hub)
    for (const t of ['overview', 'messages', 'broadcasts', 'reminders', 'templates', 'analytics', 'usage']) expect(hub).toContain(`key: '${t}'`)
    expect(hub).not.toMatch(/key: '(sms|billing|wallet|credits)'/)
  })
})
