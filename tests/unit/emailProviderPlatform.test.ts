// RD-EMAIL-PROVIDER-04 / RD-BCAST-AUDIT (unit) — the platform email provider reaches every send
// path, never falls back silently, cannot be set to an unconfigured provider, and never exposes a
// secret; Svix replay protection; broadcast event variables. Firestore and providers are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({
  configured: { ses: true, resend: true } as Record<'ses' | 'resend', boolean>,
  stored: 'ses' as unknown, configFails: false, used: [] as string[], eventOverride: undefined as unknown,
}))
vi.mock('@/lib/config/businessConfigService', () => ({
  businessConfig: { getSection: async () => { if (h.configFails) throw new Error('down'); return { emailProvider: h.stored } } },
}))
vi.mock('@/lib/email', async orig => {
  const real = await orig<typeof import('@/lib/email')>()
  return {
    ...real,
    getEmailProvider: (name: 'ses' | 'resend' = 'ses') => h.configured[name]
      ? { sendCustomEmail: async () => { h.used.push(name); return { success: true } } }
      : null,
  }
})
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { collection: () => ({ doc: () => ({ get: async () => ({ data: () => ({ emailProvider: h.eventOverride }) }) }) }) },
  adminAuth: {},
}))
vi.mock('@/lib/communications/resolveCommunicationConfig', () => ({ getCommunicationConfig: async () => ({ email: { enabled: true } }) }))

const platform = await import('@/lib/email/platformProvider')
const { resolveEventEmailProvider, __clearEventProviderCache } = await import('@/lib/email/resolveEventProvider')
const { notificationEngine, NotificationType, NotificationChannel } = await import('@/lib/notifications')
const { emailProviderSelectionRefusal, emailProviderStatuses } = await import('@/lib/email/providerSelection')
const { verifySvix, SVIX_TOLERANCE_SECONDS } = await import('@/lib/email/svix')
const { broadcastEventVars, unknownBroadcastVariables } = await import('@/lib/broadcasts/eventVars')

const read = (p: string) => readFileSync(p, 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

beforeEach(() => {
  h.configured = { ses: true, resend: true }; h.stored = 'ses'; h.configFails = false; h.used = []; h.eventOverride = undefined
  platform.__resetPlatformEmailProviderSnapshot(); __clearEventProviderCache()
})

describe('platform provider resolution', () => {
  it('reads integrations.emailProvider; legacy / invalid values and read failures mean SES', async () => {
    h.stored = 'resend'; expect(await platform.resolvePlatformEmailProvider()).toBe('resend')
    for (const v of ['RESEND', 'amazon_ses', '', null, 42]) { h.stored = v; expect(await platform.resolvePlatformEmailProvider(), String(v)).toBe('ses') }
    platform.__resetPlatformEmailProviderSnapshot(); h.configFails = true
    expect(await platform.resolvePlatformEmailProvider()).toBe('ses')
  })

  it('event mail: an explicit per-event override wins; otherwise the platform provider (not hard-wired SES)', async () => {
    h.stored = 'resend'
    expect(await resolveEventEmailProvider('ev-1')).toBe('resend')
    __clearEventProviderCache(); h.eventOverride = 'ses'
    expect(await resolveEventEmailProvider('ev-2')).toBe('ses')
    __clearEventProviderCache(); h.eventOverride = 'bogus'
    expect(await resolveEventEmailProvider('ev-3')).toBe('resend')
    expect(await resolveEventEmailProvider('')).toBe('resend')
  })
})

describe('the engine uses the platform provider for every un-routed send — never a silent fallback', () => {
  it('send() without a provider uses the selected one', async () => {
    h.stored = 'resend'
    await notificationEngine.send(NotificationType.CUSTOM_EMAIL, { to: 'a@rd.test', subject: 's', html: '<p>x</p>' })
    expect(h.used).toEqual(['resend'])
    h.used = []
    await notificationEngine.send(NotificationType.CUSTOM_EMAIL, { to: 'a@rd.test', subject: 's', html: '<p>x</p>' }, 'ses')
    expect(h.used).toEqual(['ses'])                                    // an explicit provider is honoured
  })

  it('selected provider unconfigured ⇒ provider_unavailable, NOT rerouted to the other one', async () => {
    h.stored = 'resend'; h.configured.resend = false
    const r = await notificationEngine.send(NotificationType.CUSTOM_EMAIL, { to: 'a@rd.test', subject: 's', html: '<p>x</p>' })
    expect(r).toMatchObject({ success: false, error: 'provider_unavailable' })
    expect(h.used).toEqual([])
  })

  it('isAvailable(): the selected provider once known; before that, "any configured" (never skips mail)', async () => {
    h.configured = { ses: false, resend: true }
    expect(notificationEngine.isAvailable(NotificationChannel.EMAIL)).toBe(true)        // cold: Resend exists
    h.stored = 'ses'; await platform.resolvePlatformEmailProvider()
    expect(notificationEngine.isAvailable(NotificationChannel.EMAIL)).toBe(false)       // SES selected, unconfigured
    h.stored = 'resend'; await platform.resolvePlatformEmailProvider()
    expect(notificationEngine.isAvailable(NotificationChannel.EMAIL)).toBe(true)
  })
})

describe('selection safety', () => {
  it('only a configured, valid provider can be selected', async () => {
    expect(await emailProviderSelectionRefusal('mailgun')).toMatch(/Choose Amazon SES or Resend/)
    h.configured.resend = false
    expect(await emailProviderSelectionRefusal('resend')).toMatch(/Resend is not configured/)
    h.configured.resend = true
    expect(await emailProviderSelectionRefusal('resend')).toBeNull()
  })

  it('status reports presence and identity only — never a key or secret', async () => {
    const s = await emailProviderStatuses()
    expect(s.map(p => p.name)).toEqual(['ses', 'resend'])
    for (const p of s) expect(Object.keys(p).sort()).toEqual(expect.arrayContaining(['configured', 'feedbackConfigured', 'fromEmail', 'fromName', 'label', 'missing', 'name']))
    expect(JSON.stringify(s)).not.toMatch(/apiKey|secret|AKIA|re_[A-Za-z0-9]{8,}/i)
  })

  it('both write paths refuse an unconfigured provider; only Super Admins; the editor field is read-only', () => {
    const generic = code(read('app/api/admin/business-config/route.ts'))
    expect(generic).toContain("body.section === 'integrations' && (body.patch as { emailProvider?: unknown }).emailProvider !== undefined")
    expect(generic).toContain('await emailProviderSelectionRefusal(')
    expect(generic).not.toContain("from '@/lib/email'")                          // no eager email-stack import
    const route = code(read('app/api/admin/communications/email-provider/route.ts'))
    expect((route.match(/await requireSuperAdmin\(req\)/g) ?? []).length).toBe(2)
    expect(route).toContain("action: 'platform.email_provider_changed'")
    expect(read('app/(admin)/admin/business-configuration/fields.ts')).toMatch(/key: 'emailProvider',\s+label: 'Platform email provider', kind: 'text', readOnly: true/)
    expect(read('app/(admin)/admin/business-configuration/CommunicationEditor.tsx')).toContain("label: 'Provider (not used — see Communication Center)', kind: 'text', readOnly: true")
  })

  it('no send path still hard-codes SES as the provider it logs', () => {
    for (const f of ['lib/admin/moderationService.ts', 'lib/events/reviewNotifications.ts', 'app/api/auth/send-otp/route.ts']) {
      expect(code(read(f)), f).not.toMatch(/provider:\s*('ses'|EMAIL_PROVIDER_NAME)/)
    }
    expect(code(read('app/api/contact/route.ts'))).toContain('getEmailProvider(await resolvePlatformEmailProvider())')
  })
})

describe('Svix (Resend webhook) verification', () => {
  const secret = Buffer.from('a-test-secret-for-svix-signing!!').toString('base64')
  const headersFor = (raw: string, ts: number, sigSecret = secret) => {
    const id = 'msg_1'
    const sig = crypto.createHmac('sha256', Buffer.from(sigSecret, 'base64')).update(`${id}.${ts}.${raw}`).digest('base64')
    return new Headers({ 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` })
  }
  it('accepts a fresh valid signature; refuses an old one (replay), a future one, and a wrong key', () => {
    const now = 1_800_000_000_000, raw = '{"type":"email.bounced"}', ts = Math.floor(now / 1000)
    expect(verifySvix(raw, headersFor(raw, ts), `whsec_${secret}`, now)).toBe(true)
    expect(verifySvix(raw, headersFor(raw, ts - SVIX_TOLERANCE_SECONDS - 1), `whsec_${secret}`, now)).toBe(false)
    expect(verifySvix(raw, headersFor(raw, ts + SVIX_TOLERANCE_SECONDS + 1), `whsec_${secret}`, now)).toBe(false)
    expect(verifySvix(raw, headersFor(raw, ts, Buffer.from('other-key-other-key-other-key-ok').toString('base64')), `whsec_${secret}`, now)).toBe(false)
    expect(verifySvix(raw + ' ', headersFor(raw, ts), `whsec_${secret}`, now)).toBe(false)
  })
})

describe('broadcast event variables', () => {
  it('date, venue (physical or online) and organizer name come from the event; missing values stay empty', () => {
    const physical = { eventDetails: { schedule: { startDate: '2026-12-20', startTime: '06:00' }, venue: { type: 'physical', physical: { name: 'Marina Beach', city: 'Chennai' } } } }
    expect(broadcastEventVars(physical, 'Dawn Runners')).toEqual({ eventDate: 'Sunday, 20 December 2026, 06:00', eventLocation: 'Marina Beach, Chennai', organizerName: 'Dawn Runners' })
    expect(broadcastEventVars({ eventDetails: { venue: { type: 'online', online: { platform: 'Zoom' } } } }, null)).toEqual({ eventDate: '', eventLocation: 'Zoom (Online)', organizerName: '' })
    expect(broadcastEventVars(undefined, undefined)).toEqual({ eventDate: '', eventLocation: '', organizerName: '' })
  })
  it('flags variables the composer does not offer', () => {
    expect(unknownBroadcastVariables('Hi {{attendeeName}}', '<p>{{eventDate}} {{firstName}} {{firstName}} {{venue}}</p>')).toEqual(['firstName', 'venue'])
    expect(unknownBroadcastVariables('{{attendeeName}} {{eventName}} {{eventDate}} {{ticketCode}} {{registrationId}} {{organizerName}} {{eventLocation}}')).toEqual([])
  })
})
