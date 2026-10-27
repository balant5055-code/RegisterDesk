// RD-SUPPORT-01 — Support tickets (unit): validation and whitelists, the sensitive-content check,
// the lifecycle, the organizer view, screenshot checks, and the wiring that keeps every endpoint
// authorized and internal notes out of every organizer surface. The real routes, transactions and
// notification delivery are in tests/emulator/supportTickets.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  validateTicket, validateReply, validateAdminTicketPatch, validateAdminReply, validateNote, findSensitive,
  organizerCanReply, organizerCanReopen, organizerCanConfirmClose, reopenNeedsReason, backToSupport, statusChangeNotifiesOrganizer, toOrganizerTicketView,
  displayFilename, TICKET_STATUSES, REOPEN_WINDOW_DAYS, LIMITS,
} from '@/lib/support/types'
import { checkFiles, attachmentHeaders } from '@/lib/support/attachments'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p] })

const good = { subject: 'Scanner says invalid ticket', description: 'At the gate every QR code scans as invalid since this morning.', category: 'checkin_qr', priority: 'high', eventId: null }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const DAY = 24 * 60 * 60 * 1000

describe('organizer ticket validation', () => {
  it('accepts a complete ticket, trims it, and defaults the priority to Normal', () => {
    expect(validateTicket({ ...good, subject: `  ${good.subject} ` })).toEqual({ ok: true, value: good })
    expect(validateTicket({ ...good, priority: undefined })).toMatchObject({ ok: true, value: { priority: 'normal' } })
  })
  it('stores ONLY whitelisted fields — status, assignee, workspace and notes are ignored', () => {
    const r = validateTicket({ ...good, status: 'resolved', assigneeUid: 'x', workspaceUid: 'other', notes: ['x'], number: 'RD-1' })
    expect(r.ok && Object.keys(r.value).sort()).toEqual(['category', 'description', 'eventId', 'priority', 'subject'])
  })
  it('names every problem', () => {
    const r = validateTicket({ subject: 'Hi', description: 'short', category: 'billing', priority: 'urgent', eventId: '../x' })
    expect(r.ok).toBe(false)
    expect(Object.keys(!r.ok ? r.errors : {}).sort()).toEqual(['category', 'description', 'eventId', 'priority', 'subject'])
  })
  it('refuses card numbers, secrets, tokens and passwords — but not ordinary references', () => {
    for (const bad of ['My card 4111 1111 1111 1111 was charged twice', 'key rzp_live_AbCdEf123456', 'password: hunter22', 'OTP is 482913', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', '-----BEGIN PRIVATE KEY-----']) {
      expect(findSensitive(bad), bad).not.toBeNull()
    }
    for (const ok of ['Order 1234567890123456 failed', 'Payment pay_Nx8Jk2mQ9 refunded? UTR 412345678901', 'Call me on 9876543210', 'The password reset email never arrived']) {
      expect(findSensitive(ok), ok).toBeNull()
    }
    expect(validateTicket({ ...good, description: 'Charged twice on card 4111-1111-1111-1111, please refund' })).toMatchObject({ ok: false, errors: { description: expect.stringContaining('card number') } })
    expect(validateReply({ body: 'pwd = abc12345' })).toMatchObject({ ok: false })
  })
})

describe('Super Admin input', () => {
  it('triage whitelist: status, expectedStatus, priority, assignee — nothing else', () => {
    expect(validateAdminTicketPatch({ status: 'resolved', priority: 'critical', assigneeUid: 'adm1', workspaceUid: 'x', notes: 'y', createdBy: 'z' }))
      .toEqual({ ok: true, value: { status: 'resolved', priority: 'critical', assigneeUid: 'adm1' } })
    expect(validateAdminTicketPatch({ assigneeUid: '' })).toEqual({ ok: true, value: { assigneeUid: null } })
    expect(validateAdminTicketPatch({ status: 'deleted' }).ok).toBe(false)
  })
  it('reply needs text; a note is bounded', () => {
    expect(validateAdminReply({ body: ' ' }).ok).toBe(false)
    expect(validateAdminReply({ body: 'Fixed — please retry.', status: 'resolved' })).toEqual({ ok: true, value: { body: 'Fixed — please retry.', status: 'resolved' } })
    expect(validateNote({ text: 'x' }).ok).toBe(false)
    expect(validateNote({ text: 'x'.repeat(LIMITS.note.max + 1) }).ok).toBe(false)
  })
})

describe('lifecycle', () => {
  it('the organizer replies while open / in progress / waiting; never on resolved or closed', () => {
    expect(TICKET_STATUSES.filter(organizerCanReply)).toEqual(['open', 'in_progress', 'waiting_for_organizer'])
  })
  it('a resolved ticket reopens within the window; a closed one never', () => {
    const now = Date.now()
    expect(organizerCanReopen('resolved', now - (REOPEN_WINDOW_DAYS - 1) * DAY, now)).toBe(true)
    expect(organizerCanReopen('resolved', now - (REOPEN_WINDOW_DAYS + 1) * DAY, now)).toBe(false)
    expect(organizerCanReopen('closed', now, now)).toBe(false)
    expect(organizerCanReopen('open', now, now)).toBe(false)
    expect(backToSupport(true)).toBe('in_progress')
    expect(backToSupport(false)).toBe('open')
  })
  it('Confirm & Close is offered only for a Resolved ticket; reopening a Closed one needs a reason', () => {
    expect(TICKET_STATUSES.filter(organizerCanConfirmClose)).toEqual(['resolved'])
    expect(TICKET_STATUSES.filter(s => reopenNeedsReason('closed', s))).toEqual(['open', 'in_progress', 'waiting_for_organizer', 'resolved'])
    expect(TICKET_STATUSES.some(s => reopenNeedsReason(s, 'closed'))).toBe(false)
    expect(TICKET_STATUSES.filter(s => s !== 'closed').some(s => reopenNeedsReason(s, 'open'))).toBe(false)
    expect(validateAdminTicketPatch({ status: 'open', reason: '  Organizer called back  ' })).toEqual({ ok: true, value: { status: 'open', reason: 'Organizer called back' } })
    expect(validateAdminTicketPatch({ status: 'open', reason: 'no' }).ok).toBe(false)
  })
  it('the organizer hears about meaningful status changes only', () => {
    expect(statusChangeNotifiesOrganizer('open', 'in_progress')).toBe(true)
    expect(statusChangeNotifiesOrganizer('waiting_for_organizer', 'in_progress')).toBe(false)
    expect(statusChangeNotifiesOrganizer('in_progress', 'open')).toBe(false)
    expect(statusChangeNotifiesOrganizer('resolved', 'open')).toBe(true)
    expect(statusChangeNotifiesOrganizer('closed', 'open')).toBe(true)
    for (const to of ['waiting_for_organizer', 'resolved', 'closed'] as const) expect(statusChangeNotifiesOrganizer('open', to)).toBe(true)
    expect(statusChangeNotifiesOrganizer('open', 'open')).toBe(false)
  })
})

describe('organizer view', () => {
  it('is a whitelist — assignee, creator, notes, workspace and admin fields never appear', () => {
    const v = toOrganizerTicketView('t1', {
      number: 'RD-000001', subject: 's', category: 'technical', priority: 'low', status: 'resolved', resolvedAt: new Date(),
      assigneeUid: 'adm', createdBy: 'u', workspaceUid: 'ws', notes: ['secret'], statusChangedBy: 'adm', organizationName: 'Org',
    })
    expect(Object.keys(v).sort()).toEqual(['canConfirmClose', 'canReopen', 'canReply', 'category', 'createdAt', 'eventId', 'eventName', 'id', 'lastActivityAt', 'messageCount', 'number', 'priority', 'reopenUntil', 'status', 'subject', 'updatedAt'])
    expect(v).toMatchObject({ canReply: false, canReopen: true, canConfirmClose: true })
    expect(JSON.stringify(v)).not.toMatch(/adm|secret|ws/)
  })
})

describe('screenshots', () => {
  const f = (bytes: Uint8Array, name = 'a.png', declaredType = 'image/png') => ({ name, declaredType, bytes })
  it('accepts PNG / JPEG by their bytes and stores a safe display name', () => {
    const r = checkFiles([f(PNG, '../../etc/passwd.png'), f(JPG, 'shot.jpeg', 'image/jpeg')])
    expect(r.ok && r.files.map(x => [x.contentType, x.name])).toEqual([['image/png', '.._.._etc_passwd.png'], ['image/jpeg', 'shot.jpg']])
    expect(displayFilename('a"b<c>.png', 'image/png')).toBe('a_b_c_.png')
  })
  it('refuses SVG, HTML labelled as an image, a type that disagrees with the bytes, too many and too large', () => {
    expect(checkFiles([f(SVG, 'x.svg', 'image/svg+xml')]).ok).toBe(false)
    expect(checkFiles([f(new TextEncoder().encode('<html><script>x</script>'), 'x.png')]).ok).toBe(false)
    expect(checkFiles([f(PNG, 'x.jpg', 'image/jpeg')]).ok).toBe(false)
    expect(checkFiles([f(PNG), f(PNG), f(PNG), f(PNG)]).ok).toBe(false)
    expect(checkFiles([f(new Uint8Array(LIMITS.totalUploadBytes + 1).fill(0).map((_, i) => (i < 8 ? PNG[i] : 0)))]).ok).toBe(false)
    expect(checkFiles([f(PNG)], LIMITS.filesPerTicket).ok).toBe(false)
    expect(checkFiles([f(new Uint8Array())]).ok).toBe(false)
  })
  it('served private, uncached, unsniffable and sandboxed', () => {
    const h = attachmentHeaders('image/png', 'a"b.png', 10)
    expect(h).toMatchObject({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="a_b.png"' })
    expect(h['Content-Security-Policy']).toContain('sandbox')
  })
})

describe('wiring', () => {
  const routes = walk('app/api').filter(p => /[\\/]support[\\/]tickets[\\/]/.test(p) && p.endsWith('route.ts'))
  const org = routes.filter(p => p.includes(`${'organizer'}`))
  const adm = routes.filter(p => /[\\/]admin[\\/]/.test(p))

  it('every organizer handler authorizes the workspace first; every admin handler requires a Super Admin', () => {
    expect(org).toHaveLength(5)
    expect(adm).toHaveLength(5)
    for (const p of org) {
      const s = code(read(p))
      const handlers = s.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? []
      expect((s.match(/await authorizeAnyWorkspace\(req\)/g) ?? []).length, p).toBe(handlers.length)
      expect(s, p).not.toMatch(/notes|adminGetTicket|readAdminAttachment/)
    }
    for (const p of adm) {
      const s = code(read(p))
      const handlers = s.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? []
      expect((s.match(/await requireSuperAdmin\(req\)/g) ?? []).length, p).toBe(handlers.length)
      expect(s, p).not.toMatch(/resolveAdminUid/)
    }
  })

  it('notes are never read on an organizer path, and notifications carry no message body or note', () => {
    const svc = code(read('lib/support/service.ts'))
    const fn = (name: string) => { const i = svc.indexOf(`function ${name}`); return svc.slice(i, svc.indexOf('\n}\n', i)) }
    for (const f of ['getOrganizerTicket', 'listOrganizerTickets', 'organizerReply', 'organizerConfirmClose', 'readAttachment', 'adminAlert', 'organizerNotice']) {
      expect(fn(f), f).not.toMatch(/collection\('notes'\)/)
    }
    for (const f of ['adminAlert', 'organizerNotice']) expect(fn(f), f).not.toMatch(/\bbody\b|description|\.text\b|note/i)
    expect(fn('adminAddNote')).not.toContain('stageOutboxMessage')
  })

  it('screenshots are saved without a download token and read only server-side', () => {
    const s = code(read('lib/firebase/storage/admin.ts'))
    const save = s.slice(s.indexOf('export async function savePrivateServerFile'), s.indexOf('export async function readServerFile'))
    expect(save).not.toContain('firebaseStorageDownloadTokens')
    expect(save).toContain('ifGenerationMatch: 0')
    expect(code(read('lib/support/service.ts'))).not.toMatch(/uploadServerFile|signedReadUrl|getSignedUrl/)
    expect(read('storage.rules')).not.toContain('support-tickets')
  })

  it('the sidebar sends signed-in organizers to the Support Center; /contact stays public', () => {
    expect(read('config/workspaceNav.ts')).toContain("{ key: 'support', label: 'Help & Support', icon: LifeBuoy, href: '/dashboard/support', scope: 'global' }")
    expect(read('app/contact/page.tsx')).toContain("path:        '/contact'")
    expect(read('config/navigation.ts')).toMatch(/label: 'Support Desk',\s+href: ROUTES\.ADMIN_SUPPORT_DESK/)
  })

  it('no support code touches the R2 storage layer or the upload pipeline', () => {
    for (const p of [...routes, ...walk('lib/support').filter(f => f.endsWith('.ts'))]) expect(read(p), p).not.toMatch(/platform-storage|lib\/uploads|@aws-sdk/)
  })
})
