// RD-COMMS-01 Phase 2 — unit tests for the PURE communication read-model logic.
// Covers the capability SSOT, the channel state machine, status mapping, and the health +
// readiness builders. No server imports (env-free), so these run in the pure vitest env.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  CHANNEL_CAPABILITIES,
  isChannelImplemented,
  computeChannelState,
  statusForState,
  rollupStatus,
  type ChannelSignals,
} from '@/lib/communications/health/channels'
import { buildChannelHealth, buildCommunicationReadiness } from '@/lib/communications/health/build'

const configured = (over: Partial<ChannelSignals> = {}): ChannelSignals => ({
  configured: true, platformEnabled: true, healthy: true, funded: null,
  templatesAvailable: true, ...over,
})

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Comments are intent, not behaviour — strip them before asserting on source. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('channel capability SSOT', () => {
  it('marks only email and whatsapp as implemented', () => {
    expect(isChannelImplemented('email')).toBe(true)
    expect(isChannelImplemented('whatsapp')).toBe(true)
    expect(isChannelImplemented('sms')).toBe(false)
    expect(isChannelImplemented('push')).toBe(false)
  })
  it('labels email free and sms/push unavailable', () => {
    expect(CHANNEL_CAPABILITIES.email.billingLabel).toBe('Free')
    expect(CHANNEL_CAPABILITIES.whatsapp.paid).toBe(true)
    expect(CHANNEL_CAPABILITIES.sms.billingLabel).toBe('Unavailable')
    expect(CHANNEL_CAPABILITIES.push.billingLabel).toBe('Unavailable')
  })

  // ═══ RD-COMM-03 · the capability caught up with the implementation ══════════
  //
  // Email was declared `deliveryReceipts: false` on the grounds that no SES/SNS
  // webhook was wired. Both `app/api/webhooks/ses/route.ts` and
  // `app/api/webhooks/resend/route.ts` advance a log to `delivered`, and to
  // `failed` on a permanent bounce or complaint — so the flag was under-reporting
  // a capability the platform has, and produced a standing "connect delivery
  // tracking" recommendation for a channel that already tracks delivery.
  it('email and whatsapp report delivery receipts; sms/push cannot', () => {
    expect(CHANNEL_CAPABILITIES.email.deliveryReceipts).toBe(true)
    expect(CHANNEL_CAPABILITIES.whatsapp.deliveryReceipts).toBe(true)
    // A channel with no transport can never report anything back.
    expect(CHANNEL_CAPABILITIES.sms.deliveryReceipts).toBe(false)
    expect(CHANNEL_CAPABILITIES.push.deliveryReceipts).toBe(false)
  })

  it('a channel cannot report receipts without a transport', () => {
    for (const cap of Object.values(CHANNEL_CAPABILITIES)) {
      if (cap.deliveryReceipts) expect(cap.implemented, cap.id).toBe(true)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// RD-COMM-03 — the recommendation the stale flag was producing
// ════════════════════════════════════════════════════════════════════════════
//
// `deriveRecommendations` is private behind an async server resolver, so its rule
// is pinned from SOURCE. That is enough to prove the correction: the branch is
// gated on `!p.deliveryReceipts`, and email is now `true`, so the "delivery
// tracking not connected" recommendation can no longer be produced for email —
// while every other rule is asserted to still be there.

describe('RD-COMM-03 · the delivery-tracking recommendation', () => {
  const OVERVIEW = code(read('lib/communications/health/adminOverview.ts'))

  it('is driven ONLY by the capability flag, which email now satisfies', () => {
    expect(OVERVIEW).toContain('if (!p.deliveryReceipts) {')
    expect(OVERVIEW).toContain('delivery tracking not connected')
    // The flag is read straight from the SSOT — no second source of truth.
    expect(OVERVIEW).toContain('deliveryReceipts: cap.deliveryReceipts')
    // …and email satisfies it, so the branch cannot fire for email.
    expect(CHANNEL_CAPABILITIES.email.deliveryReceipts).toBe(true)
  })

  it('leaves every unrelated health rule exactly as it was', () => {
    for (const rule of [
      'is not available yet',                       // no transport
      'provider not connected',                     // missing credentials
      'disabled in Business Configuration',         // switched off
    ]) {
      expect(OVERVIEW, rule).toContain(rule)
    }
  })

  it('no NEW recommendation was invented for this correction', () => {
    // Exactly four `out.push({` recommendation sites, the same four as before.
    expect((OVERVIEW.match(/out\.push\(\{/g) ?? []).length).toBe(4)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// RD-COMM-03 — delivery semantics are UNTOUCHED
// ════════════════════════════════════════════════════════════════════════════

describe('RD-COMM-03 · sent, delivered and failed still mean what they meant', () => {
  const SES    = code(read('app/api/webhooks/ses/route.ts'))
  const RESEND = code(read('app/api/webhooks/resend/route.ts'))

  it('delivered is written ONLY by a provider webhook, never by sending', () => {
    for (const [name, src] of [['ses', SES], ['resend', RESEND]] as const) {
      expect(src, name).toContain("updateEmailLog(logId, 'delivered')")
      // A bounce already recorded must never be overwritten by a late delivery.
      expect(src, name).toContain("d.status !== 'failed'")
    }
  })

  it('a permanent failure is recorded as failed, with its reason', () => {
    for (const [name, src] of [['ses', SES], ['resend', RESEND]] as const) {
      expect(src, name).toContain("updateEmailLog(logId, 'failed'")
    }
  })

  it('nothing equates sent with delivered', () => {
    for (const src of [SES, RESEND]) {
      expect(src).not.toMatch(/sent\s*===?\s*delivered/)
      expect(src).not.toMatch(/status:\s*'delivered'\s*\}\s*\)\s*\/\/\s*sent/)
    }
  })
})

describe('computeChannelState', () => {
  it('SMS/Push are always unavailable regardless of signals', () => {
    expect(computeChannelState('sms', configured({ platformEnabled: true }))).toBe('unavailable')
    expect(computeChannelState('push', configured())).toBe('unavailable')
  })
  it('implemented but unconfigured → available', () => {
    expect(computeChannelState('whatsapp', configured({ configured: false }))).toBe('available')
  })
  it('configured but platform-disabled → down', () => {
    expect(computeChannelState('email', configured({ platformEnabled: false }))).toBe('down')
  })
  it('paid channel with empty wallet → degraded', () => {
    expect(computeChannelState('whatsapp', configured({ funded: false }))).toBe('degraded')
  })
  it('free channel, configured + enabled → configured', () => {
    expect(computeChannelState('email', configured())).toBe('configured')
  })
  it('event-enabled with template → ready; event-off → configured', () => {
    expect(computeChannelState('whatsapp', configured({ funded: true, event: { enabled: true } }))).toBe('ready')
    expect(computeChannelState('whatsapp', configured({ funded: true, event: { enabled: false } }))).toBe('configured')
  })
  it('event-enabled without template → degraded (global fallback)', () => {
    expect(computeChannelState('whatsapp', configured({ funded: true, templatesAvailable: false, event: { enabled: true } }))).toBe('degraded')
  })
})

describe('statusForState', () => {
  it('maps states to traffic lights and flags enabled-but-unavailable as red', () => {
    expect(statusForState('ready', true)).toBe('green')
    expect(statusForState('configured', true)).toBe('green')
    expect(statusForState('degraded', true)).toBe('amber')
    expect(statusForState('down', true)).toBe('red')
    expect(statusForState('unavailable', true)).toBe('red')   // enabled an unavailable channel
    expect(statusForState('unavailable', false)).toBe('amber') // merely not offered
  })
})

describe('rollupStatus', () => {
  it('red beats amber beats green', () => {
    expect(rollupStatus(['green', 'amber', 'red'])).toBe('red')
    expect(rollupStatus(['green', 'amber'])).toBe('amber')
    expect(rollupStatus(['green', 'green'])).toBe('green')
  })
})

describe('buildChannelHealth', () => {
  it('SMS health is unavailable with red provider/templates dimensions (never green)', () => {
    const h = buildChannelHealth('sms', configured({ configured: false, templatesAvailable: false, event: { enabled: true } }))
    expect(h.implemented).toBe(false)
    expect(h.state).toBe('unavailable')
    expect(h.status).toBe('red')  // event-enabled + unavailable
    const provider = h.dimensions.find(d => d.dimension === 'provider')!
    expect(provider.status).toBe('red')
    // no dimension should claim green for an unavailable channel except (n/a) — verify none fake success
    expect(h.dimensions.some(d => d.status === 'green')).toBe(false)
  })
  it('email health is green when configured+enabled and free', () => {
    const h = buildChannelHealth('email', configured())
    expect(h.state).toBe('configured')
    expect(h.status).toBe('green')
    expect(h.dimensions.find(d => d.dimension === 'credits')!.status).toBe('green') // free
  })
  it('whatsapp with empty wallet is amber (degraded), credits flagged', () => {
    const h = buildChannelHealth('whatsapp', configured({ funded: false, event: { enabled: true } }))
    expect(h.state).toBe('degraded')
    expect(h.status).toBe('amber')
    expect(h.dimensions.find(d => d.dimension === 'credits')!.status).toBe('amber')
  })
})

describe('buildCommunicationReadiness', () => {
  it('SMS is never ready and reports a hard blocker', () => {
    const r = buildCommunicationReadiness({
      email: configured(), whatsapp: configured({ funded: true }), sms: configured({ configured: false }),
      certificateEnabled: true,
    })
    expect(r.sms.ready).toBe(false)
    expect(r.sms.blockers.length).toBeGreaterThan(0)
    expect(r.sms.state).toBe('unavailable')
  })
  it('email ready → overall ready; certificate inherits email + platform enable', () => {
    const r = buildCommunicationReadiness({
      email: configured({ event: { enabled: true } }),
      whatsapp: configured({ funded: true, event: { enabled: true } }),
      sms: configured({ configured: false }),
      certificateEnabled: true,
    })
    expect(r.email.ready).toBe(true)
    expect(r.overall.ready).toBe(true)
    expect(r.certificate.ready).toBe(true)
  })
  it('unconfigured email blocks overall readiness', () => {
    const r = buildCommunicationReadiness({
      email: configured({ configured: false }), whatsapp: configured(), sms: configured({ configured: false }),
      certificateEnabled: false,
    })
    expect(r.email.ready).toBe(false)
    expect(r.overall.ready).toBe(false)
    expect(r.certificate.ready).toBe(false) // certificates disabled
  })
  it('whatsapp low balance is a warning, not a hard blocker', () => {
    const r = buildCommunicationReadiness({
      email: configured(), whatsapp: configured({ funded: false, event: { enabled: true } }), sms: configured({ configured: false }),
      certificateEnabled: true,
    })
    expect(r.whatsapp.ready).toBe(false)
    expect(r.whatsapp.blockers.length).toBe(0)
    expect(r.whatsapp.warnings.length).toBeGreaterThan(0)
  })
})
