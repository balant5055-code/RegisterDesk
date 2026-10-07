// RD-EVENT-COMMERCE-05F — the wizard ALWAYS sends the organizer's ticked Publish Agreement to the
// draft purchase route and the publish route, and both now refuse a request without it. Suites
// that exercise OTHER behaviour of those routes wrap the handler with this, so their requests
// look like the real client's. A request that already carries an `agreement` (including a
// deliberately bad one) is passed through untouched — missing / forged consent is tested
// explicitly in tests/emulator/eventCommerce05f.emu.test.ts.

import { NextRequest } from 'next/server'
import type { PublishAgreementInput } from '@/lib/legal/organizerAgreement'

export const FULL_PUBLISH_AGREEMENT: PublishAgreementInput = {
  accurateInformation: true, settlementFeePolicy: true, termsOfService: true, privacyPolicy: true,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withPublishAgreement<H extends (r: NextRequest, ...rest: any[]) => Promise<Response>>(handler: H): H {
  return (async (r: NextRequest, ...rest: unknown[]) => {
    const text = await r.text()
    let body: unknown = null
    try { body = JSON.parse(text) } catch { /* not JSON — pass through */ }
    const next = body && typeof body === 'object' && !Array.isArray(body) && !('agreement' in body)
      ? JSON.stringify({ ...(body as Record<string, unknown>), agreement: FULL_PUBLISH_AGREEMENT })
      : text
    return handler(new NextRequest(r.url, { method: r.method, headers: r.headers, body: next }), ...rest)
  }) as H
}
