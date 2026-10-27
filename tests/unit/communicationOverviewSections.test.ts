// RD-COMMS-OVERVIEW-02 (unit) — the reorganized Communication Center Overview: every figure keeps its
// existing definition and period, provider acceptance is never presented as delivery, missing data
// is "—" (never 0), capped sources are marked "at least", attention items link without side
// effects, and each section renders its loading / empty / unavailable states.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/firebase/auth', () => ({ auth: { currentUser: null } }))
vi.mock('@/components/dashboard/EventContextProvider', () => ({ useEventContext: () => ({ selectedEvent: { name: 'City Run' }, isAllEvents: false }) }))
vi.mock('next/link', () => ({ default: ({ href, children, className }: { href: string; children: unknown; className?: string }) => createElement('a', { href, className }, children as never) }))

const { buildOverviewModel, BROADCAST_LIST_CAP, REMINDER_LIST_CAP } = await import('@/lib/communications/overviewModel')
const { OverviewSections, CommunicationOverview } = await import('@/components/communications/overview/CommunicationOverview')

const counts = { pending: 2, sent: 900, delivered: 600, failed: 100, unknown: 7, today: 41 }
const wallet = { emailsSent: 1200, whatsappSent: 340, smsSent: 0, thisMonthSpendPaise: 0, messageCounts: counts }
const inputs = (over: Partial<Parameters<typeof buildOverviewModel>[0]> = {}) => ({ wallet, walletError: null, broadcasts: { count: 12 }, reminders: { scheduled: 3, listed: 9 }, smsAvailable: false, ...over })
const html = (m: ReturnType<typeof buildOverviewModel>, walletError: string | null = null) => renderToStaticMarkup(createElement(OverviewSections, { model: m, walletError }))
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

describe('model — figures keep their existing definitions', () => {
  const m = buildOverviewModel(inputs())
  it('activity: monthly usage, capped broadcast list, current reminders', () => {
    expect(m.activity.map(f => [f.key, f.value, f.period])).toEqual([
      ['emails', 1200, 'This month'], ['whatsapp', 340, 'This month'], ['broadcasts', 12, 'All time'], ['reminders', 3, 'Current'],
    ])
    expect(m.activity.every(f => !f.atLeast)).toBe(true)
  })
  it('delivery: sent includes delivered; failed excludes unknown; all time', () => {
    expect(m.delivery.map(f => [f.key, f.value, f.period])).toEqual([['sent', 900, 'All time'], ['delivered', 600, 'All time'], ['failed', 100, 'All time'], ['pending', 2, 'All time']])
    expect(m.delivery.find(f => f.key === 'sent')!.help).toMatch(/Includes messages later confirmed as delivered/)
    expect(m.unknownCount).toBe(7)
  })
  it('today counts every outcome (India time) — exactly the existing aggregate', () => {
    expect(m.today).toMatchObject({ value: 41, period: 'Today (India time)' })
    expect(m.today.help).toMatch(/whatever its outcome/)
  })
  it('acceptance rate = accepted ÷ (accepted + failed) — the existing formula, never called delivery', () => {
    expect(m.acceptance).toEqual({ rate: 90, accepted: 900, failed: 100, reason: null })
    expect(buildOverviewModel(inputs({ wallet: { ...wallet, messageCounts: { ...counts, sent: 0, failed: 0 } } })).acceptance).toMatchObject({ rate: null, reason: 'No messages have been sent yet.' })
    expect(buildOverviewModel(inputs({ wallet: { ...wallet, messageCounts: { ...counts, failed: null } } })).acceptance).toMatchObject({ rate: null, reason: 'Some message figures could not be read.' })
  })
  it('capped sources are marked "at least", never presented as exact', () => {
    const c = buildOverviewModel(inputs({ broadcasts: { count: BROADCAST_LIST_CAP }, reminders: { scheduled: 50, listed: REMINDER_LIST_CAP } }))
    expect(c.activity.find(f => f.key === 'broadcasts')!.atLeast).toBe(true)
    expect(c.activity.find(f => f.key === 'reminders')!.atLeast).toBe(true)
  })
  it('missing data stays null — never 0', () => {
    const n = buildOverviewModel(inputs({ wallet: null, walletError: 'Missing required permission: wallet.', broadcasts: null, reminders: null }))
    expect(n.activity.every(f => f.value === null)).toBe(true)
    expect(n.delivery.every(f => f.value === null)).toBe(true)
    expect(n.today.value).toBeNull()
    expect(n.deliveryUnavailable).toBe(true)
    expect(n.attention).toEqual([])
    expect(n.acceptance.reason).toBe('Message figures are unavailable.')
  })
  it('SMS appears only when the channel exists; legacy spend only when > 0', () => {
    expect(buildOverviewModel(inputs({ smsAvailable: true })).activity.map(f => f.key)).toContain('sms')
    expect(m.legacySpendPaise).toBeNull()
    expect(buildOverviewModel(inputs({ wallet: { ...wallet, thisMonthSpendPaise: 12_300 } })).legacySpendPaise).toBe(12_300)
  })
  it('attention: failed and unknown are actions, queued is a note; links only — no side effects', () => {
    expect(m.attention.map(a => [a.key, a.tone, a.href])).toEqual([
      ['failed', 'action', '/dashboard/communications?tab=messages&msgStatus=failed'],
      ['unknown', 'action', '/dashboard/communications?tab=messages&msgStatus=unknown'],
      ['pending', 'info', '/dashboard/communications?tab=messages&msgStatus=queued'],
    ])
    expect(buildOverviewModel(inputs({ wallet: { ...wallet, messageCounts: { ...counts, failed: 0, unknown: 0, pending: 0 } } })).attention).toEqual([])
  })
})

describe('rendered sections', () => {
  it('renders the four sections with their headings and labels, in order', () => {
    const t = text(html(buildOverviewModel(inputs())))
    const order = ['Activity overview', 'Delivery performance', 'Today & acceptance rate', 'Attention required']
    for (const s of order) expect(t).toContain(s)
    expect(order.map(s => t.indexOf(s))).toEqual([...order.map(s => t.indexOf(s))].sort((a, b) => a - b))
    for (const l of ['Emails sent', 'WhatsApp messages sent', 'Broadcasts', 'Scheduled reminders', 'Sent / submitted', 'Delivered', 'Failed', 'Pending', 'Messages today', 'Provider acceptance rate']) expect(t).toContain(l)
    expect(t).toContain('Accepted ÷ (accepted + failed) = 900 ÷ 1,000')
    expect(t).toContain('Not confirmed delivery')
    expect(t).toContain('7 messages have an unknown outcome and are not counted as failed')
    expect(t).not.toMatch(/success rate/i)                                     // acceptance is not "success"
  })
  it('unavailable data renders "—" with a reason, and the attention section explains it cannot check', () => {
    const t = text(html(buildOverviewModel(inputs({ wallet: null, walletError: 'Missing required permission: wallet.' })), 'Missing required permission: wallet.'))
    expect(t).toContain('—')
    expect(t).toContain('could not be loaded (Missing required permission: wallet.)')
    expect(t).toContain('attention items cannot be checked right now')
    expect(t).not.toMatch(/Emails sent\s+0/)
  })
  it('an empty workspace shows zeros it actually read, and a restrained "nothing needs attention"', () => {
    const zero = { pending: 0, sent: 0, delivered: 0, failed: 0, unknown: 0, today: 0 }
    const t = text(html(buildOverviewModel(inputs({ wallet: { ...wallet, emailsSent: 0, whatsappSent: 0, messageCounts: zero } }))))
    expect(t).toContain('Nothing needs attention right now.')
    expect(t).toContain('No messages have been sent yet.')
  })
  it('capped counts render with a "+" and "at least"', () => {
    const t = text(html(buildOverviewModel(inputs({ broadcasts: { count: 100 } }))))
    expect(t).toMatch(/100\s*\+/)
    expect(t).toContain('Latest 100 · at least')
  })
  it('loading state and the scope banner (event selected → page states it is workspace-wide)', () => {
    const t = text(renderToStaticMarkup(createElement(CommunicationOverview)))
    expect(t).toContain('Loading overview…')
    expect(t).toContain('All events')
    expect(t).toContain('Workspace-wide activity across every event')
    expect(t).toContain('The event selector does not filter this page')
    expect(t).toContain('City Run')
  })
  it('the data still comes from the same three existing endpoints', () => {
    const src = readFileSync('components/communications/overview/CommunicationOverview.tsx', 'utf8')
    for (const ep of ["'/api/organizer/wallet/overview'", "'/api/organizer/broadcasts'", "'/api/organizer/reminders'"]) expect(src).toContain(ep)
    expect(src.match(/getJSON<[^>]*>\('\/api\//g)).toHaveLength(3)
    expect(src).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/)                // read-only
  })
})
