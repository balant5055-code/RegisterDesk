// WhatsApp webhook subscription health (2026-10-26: production's app was never subscribed to the
// WABA, so Meta delivered no webhook at all). UNIT layer: the Graph call is a fetch double — no
// network, and the check is a READ: nothing is ever POSTed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ configured: true }))

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {}, adminApp: {} }))
vi.mock('@/lib/whatsapp/config', () => ({
  getMetaConfig: async () => h.configured
    ? { appId: 'APP1', appSecret: 's', accessToken: 'TOKEN-SECRET', phoneNumberId: 'P1', businessAccountId: 'WABA1', webhookVerifyToken: 'v', apiVersion: 'v21.0', apiTimeoutMs: 5_000 }
    : null,
}))

import { classifyWabaSubscription, checkWabaSubscription } from '@/lib/whatsapp/subscriptionHealth'
import { whatsappWebhooksService } from '@/lib/admin/platformMonitorService'

const app = (id: string) => ({ whatsapp_business_api_data: { id, name: 'x' } })
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => { h.configured = true })
afterEach(() => { vi.unstubAllGlobals() })

function stubFetch(status: number, body: unknown) {
  fetchSpy = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchSpy)
}

describe('classifyWabaSubscription', () => {
  it('subscribed — the configured app is listed', () => {
    expect(classifyWabaSubscription('APP1', { ok: true, data: { data: [app('OTHER'), app('APP1')] } })).toEqual({ state: 'subscribed' })
  })
  it('missing — an empty list (the production incident) or only other apps', () => {
    expect(classifyWabaSubscription('APP1', { ok: true, data: { data: [] } })).toEqual({ state: 'missing' })
    expect(classifyWabaSubscription('APP1', { ok: true, data: {} })).toEqual({ state: 'missing' })
    expect(classifyWabaSubscription('APP1', { ok: true, data: { data: [app('OTHER')] } })).toEqual({ state: 'missing' })
  })
  it('unavailable — a Graph error is never read as missing or subscribed', () => {
    const r = classifyWabaSubscription('APP1', { ok: false, error: { code: 190, message: 'x', httpStatus: 401, retriable: false } as never })
    expect(r).toEqual({ state: 'unavailable', reason: 'api_error' })
  })
})

describe('checkWabaSubscription (one Graph READ)', () => {
  it('GETs /{WABA}/subscribed_apps with the bearer token in a header, never the URL', async () => {
    stubFetch(200, { data: [app('APP1')] })
    expect(await checkWabaSubscription()).toEqual({ state: 'subscribed' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://graph.facebook.com/v21.0/WABA1/subscribed_apps')
    expect(init.method).toBe('GET')
    expect(url).not.toContain('TOKEN-SECRET')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN-SECRET')
  })
  it('missing when Meta returns an empty list', async () => {
    stubFetch(200, { data: [] })
    expect(await checkWabaSubscription()).toEqual({ state: 'missing' })
  })
  it('unavailable on a Graph error status, and on a transport failure — never throws', async () => {
    stubFetch(500, { error: { message: 'boom', code: 1 } })
    expect(await checkWabaSubscription()).toEqual({ state: 'unavailable', reason: 'api_error' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }))
    expect(await checkWabaSubscription()).toEqual({ state: 'unavailable', reason: 'api_error' })
  })
  it('unavailable (not configured) without any network call when WhatsApp is not configured', async () => {
    h.configured = false
    stubFetch(200, { data: [app('APP1')] })
    expect(await checkWabaSubscription()).toEqual({ state: 'unavailable', reason: 'not_configured' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('Platform Monitor tile', () => {
  it('subscribed → healthy', () => {
    expect(whatsappWebhooksService({ state: 'subscribed' })).toMatchObject({ key: 'whatsapp_webhooks', level: 'healthy', metric: 'Subscribed' })
  })
  it('missing → warning that says nothing is delivered', () => {
    const t = whatsappWebhooksService({ state: 'missing' })
    expect(t).toMatchObject({ level: 'warning', metric: 'Not subscribed' })
    expect(t.detail).toMatch(/not subscribed/i)
  })
  it('unavailable → unavailable (never healthy by default), naming why', () => {
    expect(whatsappWebhooksService({ state: 'unavailable', reason: 'api_error' })).toMatchObject({ level: 'unavailable', metric: null, detail: expect.stringMatching(/unavailable/i) })
    expect(whatsappWebhooksService({ state: 'unavailable', reason: 'not_configured' })).toMatchObject({ level: 'unavailable', detail: expect.stringMatching(/not configured/i) })
  })
})
