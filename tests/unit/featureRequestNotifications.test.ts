// RD-FEATURE-REQ-01 · notification audit (unit). Recipient resolution for the Super Admin alert,
// the outbox outcomes surfacing on the Platform Monitor, and the wiring that keeps internal notes
// out of every notification. Delivery on real Firestore is in
// tests/emulator/featureRequestNotifications.emu.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const h = vi.hoisted(() => ({
  users: [] as { uid: string; email?: string; disabled?: boolean }[],
  asked: [] as string[],
  supportEmail: 'support@rd.test' as string | undefined,
}))
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {},
  adminAuth: {
    getUsers: async (ids: { uid: string }[]) => {
      h.asked = ids.map(i => i.uid)
      return { users: h.users.filter(u => h.asked.includes(u.uid)), notFound: [] }
    },
  },
}))
vi.mock('@/lib/config/resolveBrandingConfig', () => ({ getBrandingConfig: async () => ({ supportEmail: h.supportEmail }) }))

const { superAdminRecipients, canonicalMailbox, uniqueMailboxes } = await import('@/lib/notifications/superAdminRecipients')
const { evaluateAlerts } = await import('@/lib/operations/healthMetrics')

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('Super Admin recipients', () => {
  beforeEach(() => {
    h.supportEmail = 'support@rd.test'
    h.users = [
      { uid: 'a1', email: 'Admin.One@rd.test' },
      { uid: 'a2', email: 'admin.one@RD.test' },          // same address, other case → one email
      { uid: 'a3', email: 'off@rd.test', disabled: true },
      { uid: 'a4' },                                       // no email on the account
      { uid: 'claim', email: 'claim@rd.test' },            // not in ADMIN_UIDS
    ]
  })

  it('support inbox + every active ADMIN_UIDS account email, deduplicated; disabled / email-less / unlisted never', async () => {
    vi.stubEnv('ADMIN_UIDS', ' a1, a2 ,a3,a4,a1,ghost')
    const list = await superAdminRecipients()
    expect(h.asked).toEqual(['a1', 'a2', 'a3', 'a4', 'ghost'])
    expect(list.map(e => e.toLowerCase())).toEqual(['support@rd.test', 'admin.one@rd.test'])
    expect(list.join()).not.toMatch(/off@|claim@/)
    vi.unstubAllEnvs()
  })

  it('one recipient per MAILBOX: Gmail dots / +tags / googlemail.com / case are the same inbox', async () => {
    expect(canonicalMailbox('Bala.NT5055+ops@GoogleMail.com')).toBe('balant5055@gmail.com')
    expect(canonicalMailbox('ops+alerts@registerdesk.in')).toBe('ops@registerdesk.in')
    expect(canonicalMailbox('first.last@registerdesk.in')).toBe('first.last@registerdesk.in')   // dots only ignored at Gmail
    expect(uniqueMailboxes(['B.Ala@gmail.com', 'bala@googlemail.com', 'bala+x@gmail.com', 'other@x.in', 'not-an-email'])).toEqual(['B.Ala@gmail.com', 'other@x.in'])
    h.supportEmail = 'Support.Desk@gmail.com'
    h.users = [{ uid: 'a1', email: 'supportdesk+admin@googlemail.com' }, { uid: 'a2', email: 'two@rd.test' }]
    vi.stubEnv('ADMIN_UIDS', 'a1,a2')
    expect(await superAdminRecipients()).toEqual(['Support.Desk@gmail.com', 'two@rd.test'])
    vi.unstubAllEnvs()
  })

  it('no ADMIN_UIDS and no support inbox → no recipients (nothing guessed, nothing hardcoded)', async () => {
    vi.stubEnv('ADMIN_UIDS', '')
    h.supportEmail = undefined
    expect(await superAdminRecipients()).toEqual([])
    vi.unstubAllEnvs()
  })

  it('the outbox resolves recipients at delivery time from these resolvers only — no address literal', () => {
    const src = code(read('lib/notifications/outbox.ts'))
    expect(src).toContain("if (a.kind === 'super_admins') return uniqueMailboxes(await superAdminRecipients())")
    expect(src).toContain('await resolveOrganizerEmailIdentity(a.organizerUid)')
    expect(src).not.toMatch(/['"`][^'"`\s]+@[^'"`\s]+\.[a-z]{2,}['"`]/i)
    expect(code(read('lib/featureRequests/service.ts'))).not.toMatch(/['"`][^'"`\s]+@[^'"`\s]+\.[a-z]{2,}['"`]/i)
  })
})

describe('email outcome is never inferred from the queue', () => {
  const health = (failed: number, unconfirmed: number) => ({
    financial: {}, webhook: { failedDeliveries: 0 }, dataIntegrity: {}, crons: [],
    broadcast: { scheduled: 0, sending: 0, failed: 0, stuckSending: 0, notificationEmailsFailed: failed, notificationEmailsUnconfirmed: unconfirmed },
  }) as never

  it('failed and unconfirmed notification emails raise Platform Monitor warnings', () => {
    const alerts = evaluateAlerts(health(2, 1))
    expect(alerts.find(a => a.id === 'notification_emails_failed')).toMatchObject({ severity: 'warning', message: expect.stringMatching(/^2 notification email/) })
    expect(alerts.find(a => a.id === 'notification_emails_unconfirmed')).toMatchObject({ severity: 'warning', message: expect.stringMatching(/^1 notification email/) })
    expect(evaluateAlerts(health(0, 0)).some(a => a.id.startsWith('notification_emails'))).toBe(false)
  })

  it("'sent' is written only when every recipient was accepted; suppressed / no-answer are recorded, not retried", () => {
    const src = code(read('lib/notifications/outbox.ts'))
    expect(src).toContain("const reason: SkipReason | null = res.suppressed ? 'suppressed' : res.deliveryUnknown ? 'unconfirmed' : null")
    expect(src).toContain("if (s.delivered?.[key] || s.skipped?.[key]) return 'settled' as const")
    expect(src).toContain("if (s.leaseId !== leaseId) return 'lost' as const")
    expect(src.indexOf("status: 'unconfirmed'")).toBeGreaterThan(-1)
    expect(src.indexOf("status: 'unconfirmed'")).toBeLessThan(src.indexOf("status: 'sent'"))
  })

  it('the Super Admin save reports "queued", not "emailed"', () => {
    expect(code(read('app/(admin)/admin/feature-requests/PageClient.tsx'))).not.toMatch(/email(ed)? sent|notification sent/i)
  })
})

describe('internal notes never reach a notification', () => {
  const svc = code(read('lib/featureRequests/service.ts'))
  const fn = (name: string) => svc.slice(svc.indexOf(`export async function ${name}`), svc.indexOf('\nexport ', svc.indexOf(`export async function ${name}`) + 10))

  it('adding a note stages no outbox message', () => {
    expect(fn('adminAddNote')).not.toContain('stageOutboxMessage')
  })

  it('the organizer notice is built from the status, response and release update only', () => {
    const upd = fn('adminUpdateRequest')
    const notice = upd.slice(upd.indexOf('outbox = {'), upd.indexOf('stageOutboxMessage(txn, outbox)'))
    expect(notice).not.toMatch(/notes?\b|adminPriority|rollout|duplicateOf|actorUid|adminUid/)
  })
})
