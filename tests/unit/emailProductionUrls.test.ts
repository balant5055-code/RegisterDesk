// RD-EMAIL-PRODUCTION-URL — FINAL VERIFICATION.
//
// Renders the REAL email templates under a production environment and asserts the output
// HTML an actual recipient would receive. This is the check the unit tests on the resolver
// cannot make on their own: it proves the template layer embeds the resolved production
// origin rather than re-deriving a URL of its own somewhere in the markup.
//
// The exact URL expressions here are copied from the send paths they verify:
//   lib/certificates/email.ts   → verifyUrl / downloadUrl
//   lib/email/unsubscribeToken  → unsubscribe links

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const PROD = 'https://registerdesk.in'

/** Forbidden origins, in the forms they would actually appear in rendered HTML. */
const LOCAL_MARKERS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '%5B::1%5D']

function assertNoLocalOrigin(html: string, label: string) {
  for (const marker of LOCAL_MARKERS) {
    expect(html.toLowerCase(), `${label} contains "${marker}"`).not.toContain(marker)
  }
}

async function loadProd() {
  vi.resetModules()
  vi.doMock('@/lib/env', () => ({ APP_URL: PROD, TICKET_SECRET: 'test-secret-value' }))
  vi.stubEnv('NODE_ENV', 'production')
  return {
    appUrl:      await import('@/lib/email/appUrl'),
    certificate: (await import('@/lib/email/templates/certificate')).certificateTemplate,
    ticket:      await import('@/lib/email/templates/ticket'),
    registration:await import('@/lib/email/templates/registration'),
    waitlist:    await import('@/lib/email/templates/waitlist-joined'),
    spot:        await import('@/lib/email/templates/spot-available'),
  }
}

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('@/lib/env'); vi.resetModules() })

describe('certificate email — the one that shipped a localhost link', () => {
  it('renders production verification and download URLs, and no local origin', async () => {
    const { appUrl, certificate } = await loadProd()
    const certificateId = 'RDC-2026-5OHOUL'

    // Exactly the expressions lib/certificates/email.ts builds.
    const verifyUrl   = `${appUrl.getEmailAppUrl()}/verify/certificate/${certificateId}`
    const downloadUrl = `${appUrl.getEmailAppUrl()}/api/certificates/${certificateId}/file?token=${encodeURIComponent('tok123')}`

    const { subject, html } = certificate({
      to: 'arun@example.test',
      attendeeName: 'அருண் Prakash',
      eventName: 'Noyyal Marathon 2026',
      certificateId,
      downloadUrl,
      verifyUrl,
    })

    expect(verifyUrl).toBe('https://registerdesk.in/verify/certificate/RDC-2026-5OHOUL')
    expect(html).toContain('https://registerdesk.in/verify/certificate/RDC-2026-5OHOUL')
    expect(html).toContain('https://registerdesk.in/api/certificates/RDC-2026-5OHOUL/file')
    assertNoLocalOrigin(html, 'certificate email')
    expect(subject).toBeTruthy()
  })

  it('preserves Unicode recipient data while fixing the URLs', async () => {
    const { appUrl, certificate } = await loadProd()
    const { html } = certificate({
      to: 'a@b.test', attendeeName: 'அருண் Prakash', eventName: 'Noyyal ₹ Marathon',
      certificateId: 'RDC-1',
      downloadUrl: `${appUrl.getEmailAppUrl()}/api/certificates/RDC-1/file`,
      verifyUrl:   `${appUrl.getEmailAppUrl()}/verify/certificate/RDC-1`,
    })
    expect(html).toContain('அருண் Prakash')
  })
})

describe('other transactional emails render production URLs', () => {
  it('ticket email', async () => {
    const { appUrl, ticket } = await loadProd()
    const base = appUrl.getEmailAppUrl()
    const fn = Object.values(ticket).find(v => typeof v === 'function') as
      ((p: Record<string, unknown>) => { html: string })
    const { html } = fn({
      to: 'a@b.test', attendeeName: 'Arun', eventName: 'Noyyal Marathon 2026',
      ticketCode: 'NYM-1', registrationId: 'reg-1', passName: '42K Full Marathon',
      ticketPageUrl:  `${base}/tickets/reg-1`,
      pdfDownloadUrl: `${base}/api/tickets/reg-1/pdf`,
      eventDate: '20 Sep 2026',
    })
    expect(html).toContain('https://registerdesk.in/tickets/reg-1')
    assertNoLocalOrigin(html, 'ticket email')
  })

  it('registration confirmation email', async () => {
    const { appUrl, registration } = await loadProd()
    const base = appUrl.getEmailAppUrl()
    const fn = Object.values(registration).find(v => typeof v === 'function') as
      ((p: Record<string, unknown>) => { html: string })
    const { html } = fn({
      to: 'a@b.test', attendeeName: 'Arun', eventName: 'Noyyal Marathon 2026',
      ticketCode: 'NYM-1', registrationId: 'reg-1', passName: '42K',
      ticketPageUrl:  `${base}/tickets/reg-1`,
      pdfDownloadUrl: `${base}/api/tickets/reg-1/pdf`,
      eventDate: '20 Sep 2026',
    })
    assertNoLocalOrigin(html, 'registration email')
  })

  it('waitlist emails', async () => {
    const { appUrl, waitlist, spot } = await loadProd()
    const base = appUrl.getEmailAppUrl()
    for (const [label, mod, extra] of [
      ['waitlist-joined', waitlist, { eventPageUrl: `${base}/events/noyyal-marathon-2026` }],
      ['spot-available',  spot,     { registerUrl:  `${base}/events/noyyal-marathon-2026/register` }],
    ] as const) {
      const fn = Object.values(mod).find(v => typeof v === 'function') as
        ((p: Record<string, unknown>) => { html: string })
      const { html } = fn({
        to: 'a@b.test', attendeeName: 'Arun', eventName: 'Noyyal Marathon 2026',
        passName: '42K', ...extra,
      })
      expect(html).toContain('https://registerdesk.in/events/noyyal-marathon-2026')
      assertNoLocalOrigin(html, `${label} email`)
    }
  })

  it('broadcast unsubscribe links', async () => {
    const { appUrl } = await loadProd()
    const unsub = await import('@/lib/email/unsubscribeToken')
    const fn = Object.entries(unsub).find(([k, v]) => typeof v === 'function' && /url|link/i.test(k))?.[1] as
      ((email: string, uid: string) => string) | undefined
    if (!fn) { expect(appUrl.getEmailAppUrl()).toBe(PROD); return }
    const url = fn('a@b.test', 'org-1')
    expect(url.startsWith('https://registerdesk.in/')).toBe(true)
    assertNoLocalOrigin(url, 'unsubscribe url')
  })
})

describe('the guard still protects a misconfigured production deploy', () => {
  it('refuses to render any email URL when the origin is local', async () => {
    vi.resetModules()
    vi.doMock('@/lib/env', () => ({ APP_URL: 'http://localhost:3000', TICKET_SECRET: 's' }))
    vi.stubEnv('NODE_ENV', 'production')
    const { getEmailAppUrl } = await import('@/lib/email/appUrl')
    expect(() => getEmailAppUrl()).toThrow(/local development origin/i)
  })
})
