// RD-EMAIL-PRODUCTION-URL — the canonical absolute-URL source for outgoing email.
//
// A certificate email went out containing http://localhost:3000/verify/certificate/…
// because NEXT_PUBLIC_APP_URL was a development origin and nothing in the send path could
// tell. These tests pin the guard that now makes that impossible in production, and the
// URL shapes the templates depend on.

import { describe, it, expect, vi, afterEach } from 'vitest'

/** Load the module fresh with a given APP_URL + NODE_ENV. */
async function load(appUrl: string, nodeEnv: string) {
  vi.resetModules()
  vi.doMock('@/lib/env', () => ({ APP_URL: appUrl.replace(/\/+$/, '') }))
  vi.stubEnv('NODE_ENV', nodeEnv)
  return import('@/lib/email/appUrl')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock('@/lib/env')
  vi.resetModules()
})

describe('A/B · resolves the configured origin', () => {
  it('production → the public site URL', async () => {
    const m = await load('https://registerdesk.in', 'production')
    expect(m.getEmailAppUrl()).toBe('https://registerdesk.in')
  })

  it('development → localhost stays usable', async () => {
    const m = await load('http://localhost:3000', 'development')
    expect(m.getEmailAppUrl()).toBe('http://localhost:3000')
  })
})

describe('C · normalization', () => {
  it('strips a trailing slash', async () => {
    const m = await load('https://registerdesk.in/', 'production')
    expect(m.getEmailAppUrl()).toBe('https://registerdesk.in')
  })

  it('strips several trailing slashes', async () => {
    const m = await load('https://registerdesk.in///', 'production')
    expect(m.getEmailAppUrl()).toBe('https://registerdesk.in')
  })

  it('never produces a double slash, with or without a leading slash on the path', async () => {
    const m = await load('https://registerdesk.in/', 'production')
    expect(m.emailUrl('/verify/x')).toBe('https://registerdesk.in/verify/x')
    expect(m.emailUrl('verify/x')).toBe('https://registerdesk.in/verify/x')
  })
})

describe('D/E/F · the URL shapes templates embed', () => {
  it('certificate verification', async () => {
    const m = await load('https://registerdesk.in', 'production')
    expect(m.emailUrl(`/verify/certificate/RDC-2026-5OHOUL`))
      .toBe('https://registerdesk.in/verify/certificate/RDC-2026-5OHOUL')
  })

  it('certificate file download', async () => {
    const m = await load('https://registerdesk.in', 'production')
    expect(m.emailUrl('/api/certificates/RDC-1/file')).toBe('https://registerdesk.in/api/certificates/RDC-1/file')
  })

  it('ticket page', async () => {
    const m = await load('https://registerdesk.in', 'production')
    expect(m.emailUrl('/tickets/reg-1')).toBe('https://registerdesk.in/tickets/reg-1')
  })

  it('public event page', async () => {
    const m = await load('https://registerdesk.in', 'production')
    expect(m.emailUrl('/events/noyyal-marathon-2026')).toBe('https://registerdesk.in/events/noyyal-marathon-2026')
  })

  it('unsubscribe', async () => {
    const m = await load('https://registerdesk.in', 'production')
    expect(m.emailUrl('/unsubscribe')).toBe('https://registerdesk.in/unsubscribe')
  })
})

describe('G · the production guard', () => {
  it.each([
    ['localhost',      'http://localhost:3000'],
    ['127.0.0.1',      'http://127.0.0.1:3000'],
    ['0.0.0.0',        'http://0.0.0.0:8080'],
    ['ipv6 loopback',  'http://[::1]:3000'],
    ['https localhost','https://localhost'],
  ])('refuses to build an email URL on %s in production', async (_label, origin) => {
    const m = await load(origin, 'production')
    // Failing loudly is the point: the previous behaviour shipped a real email whose
    // every button was dead. This surfaces instead as a recorded send failure.
    expect(() => m.getEmailAppUrl()).toThrow(/local development origin/i)
    expect(() => m.emailUrl('/verify/certificate/X')).toThrow()
  })

  it('the error names the variable an operator must change, and leaks no secret', async () => {
    const m = await load('http://localhost:3000', 'production')
    let msg = ''
    try { m.getEmailAppUrl() } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('NEXT_PUBLIC_APP_URL')
    expect(msg).toContain('localhost')
    expect(msg).not.toMatch(/key|secret|token|password/i)
  })

  it('does NOT throw for a local origin outside production', async () => {
    const m = await load('http://localhost:3000', 'development')
    expect(() => m.getEmailAppUrl()).not.toThrow()
  })

  it('a real production host passes untouched', async () => {
    const m = await load('https://registerdesk.in', 'production')
    expect(() => m.getEmailAppUrl()).not.toThrow()
  })

  it('does not false-positive on a hostname that merely contains "localhost"', async () => {
    const m = await load('https://localhost.registerdesk.in', 'production')
    expect(() => m.getEmailAppUrl()).not.toThrow()
  })
})

describe('isLocalOrigin', () => {
  it.each([
    ['http://localhost:3000', true],
    ['http://127.0.0.1', true],
    ['https://registerdesk.in', false],
    ['https://staging.registerdesk.in', false],
  ])('%s → %s', async (url, expected) => {
    const m = await load('https://registerdesk.in', 'test')
    expect(m.isLocalOrigin(url)).toBe(expected)
  })
})
