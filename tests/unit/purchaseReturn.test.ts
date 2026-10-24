// RD-PURCHASE-RETURN-01 — after buying certificate or WhatsApp capacity in License & Services, the
// organizer returns to the screen they started from (the event's Certificates tab / the Broadcasts
// composer with the event preselected). Wallet-started purchases keep returning to the Wallet. The
// allow-list stays EXACT and is checked when built, recorded and consumed; the return target is
// navigation only, never authorization.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  safeReturnTo, returnLabelFor, increaseLimitHref, intentFromParams, readIntent, saveIntent,
  walletHrefFor, certificatesTabHrefFor, broadcastsHrefFor,
} from '@/lib/wallet/purchaseIntent'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const paramsOf = (href: string) => new URL(href, 'http://x').searchParams

describe('RD-PURCHASE-RETURN-01 · allow-list', () => {
  it('accepts exactly the three destinations', () => {
    for (const ok of [
      '/dashboard/wallet', '/dashboard/wallet?eventId=d_1',
      '/dashboard/events/draft_1?tab=certificates',
      '/dashboard/communications/broadcasts', '/dashboard/communications/broadcasts?event=city-run-2026',
    ]) expect(safeReturnTo(ok), ok).toBe(ok)
  })
  it('rejects external, protocol-relative, look-alike and decorated URLs', () => {
    for (const bad of [
      'https://evil.example', '//evil.example', 'javascript:alert(1)', '/dashboard/settings',
      '/dashboard/events/draft_1', '/dashboard/events/draft_1?tab=registrations',
      '/dashboard/events/draft_1?tab=certificates&x=1', '/dashboard/events/../admin?tab=certificates',
      '/dashboard/events/draft_1?tab=certificates#frag', '/dashboard/communications/broadcasts?event=a&x=1',
      '/dashboard/communications/broadcasts?event=%2F%2Fevil', '/dashboard/communications/broadcastsX',
      '/dashboard/wallet?eventId=a&x=1', ' /dashboard/wallet', null, 42,
    ]) expect(safeReturnTo(bad), String(bad)).toBeNull()
  })
  it('labels name the actual destination', () => {
    expect(returnLabelFor(walletHrefFor('d'))).toBe('Return to Wallet')
    expect(returnLabelFor(certificatesTabHrefFor('d'))).toBe('Return to Certificates')
    expect(returnLabelFor(broadcastsHrefFor('slug-1'))).toBe('Return to Broadcasts')
  })
})

describe('RD-PURCHASE-RETURN-01 · hand-off', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    ;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
    }
  })
  it('defaults to the Wallet (existing behaviour)', () => {
    expect(paramsOf(increaseLimitHref('d1', 'whatsapp')).get('returnTo')).toBe('/dashboard/wallet?eventId=d1')
  })
  it('certificate and WhatsApp purchases carry their own screen back, end to end', () => {
    for (const [service, target] of [['certificates', certificatesTabHrefFor('d1')], ['whatsapp', broadcastsHrefFor('run-2026')]] as const) {
      const href = increaseLimitHref('d1', service, target)
      const intent = intentFromParams(paramsOf(href), 1000)
      expect(intent).toMatchObject({ draftId: 'd1', service, returnTo: target })
      saveIntent(intent)
      expect(readIntent('d1', 2000)?.returnTo).toBe(target)
    }
  })
  it('an unapproved target is replaced by the Wallet when BUILT, refused when RECORDED, ignored when CONSUMED', () => {
    expect(paramsOf(increaseLimitHref('d1', 'certificates', 'https://evil.example')).get('returnTo')).toBe('/dashboard/wallet?eventId=d1')
    expect(intentFromParams(new URLSearchParams({ draftId: 'd1', step: 'license', returnTo: '//evil.example' }))).toBeNull()
    sessionStorage.setItem('rd_wallet_purchase_intent', JSON.stringify({ draftId: 'd1', service: null, returnTo: 'https://evil.example', at: 1000 }))
    expect(readIntent('d1', 2000)).toBeNull()
  })
})

describe('RD-PURCHASE-RETURN-01 · wiring', () => {
  it('certificate capacity links return to the Certificates tab', () => {
    expect(read('lib/certificates/capacity.ts')).toContain("increaseLimitHref(draftId, 'certificates', certificatesTabHrefFor(draftId))")
  })
  it('every Broadcasts capacity link returns to Broadcasts with the event preselected', () => {
    const src = read('app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx')
    expect(src.match(/increaseLimitHref\([^)]*'whatsapp'\)/g) ?? []).toEqual([])            // none left on the Wallet default
    expect(src.match(/increaseLimitHref\([^\n]*'whatsapp', broadcastsHrefFor\(/g)?.length).toBe(3)
  })
  it('the return links are labelled from their destination, not hard-coded "Wallet"', () => {
    for (const p of ['app/(dashboard)/dashboard/events/new/page.tsx', 'components/wizard/LicenseServicesStep.tsx']) {
      const s = read(p)
      expect(s, p).toContain('{returnLabelFor(walletIntent.returnTo)}')
      expect(s, p).not.toMatch(/aria-hidden \/>(Back|Return) to Wallet/)
    }
  })
})
