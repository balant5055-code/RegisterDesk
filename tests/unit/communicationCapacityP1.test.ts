// RD-COMMS-P1 — Communication billing architecture / entitlement cleanup (unit level).
//
// License & Services is the ONLY place communication capacity is bought; the organizer
// communication balance is LEGACY (controlled drain, no new funds). Pinned here:
//   • the one drain rule (pure);
//   • certificates REQUIRE certificate capacity — no wallet, no free issue (real generateCertificate,
//     storage/render stubbed);
//   • the top-up route is retired (real route, auth stubbed);
//   • the Usage figures add up with no double count (pure);
//   • no Add Funds / top-up in the active organizer communication UI; Usage is event-scoped;
//   • the low-balance ("add funds") reminder is retired.
// Money paths on real Firestore: tests/emulator/communicationCapacityP1.emu.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8')
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('{/*')).join('\n')

// ─── harness: certificate issuance with a controllable capacity ledger ─────────
const h = vi.hoisted(() => ({
  reserve: { mode: 'allowance', already: false } as { mode: string; already?: boolean; policy?: string },
  draftId: 'draft-1' as string | null,
  released: 0, charged: 0, created: 0,
}))
vi.mock('@/lib/licensing/serviceAllowanceLedger', () => ({
  draftIdForEventSlug: async () => h.draftId,
  reserveServiceUnits: async () => h.reserve,
  releaseServiceUnits: async () => { h.released++; return true },
}))
vi.mock('@/lib/certificates/billing', () => ({ chargeCertificate: async () => { h.charged++; return { charged: true, costPaise: 200 } } }))
vi.mock('@/lib/firebase/storage/admin', () => ({ uploadServerFile: async () => ({ url: 'https://storage.test/x' }) }))
vi.mock('@/features/platform-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/platform-storage')>()),
  storage: {
    upload: async (i: { id: string; eventSlug: string; body: Uint8Array }) => ({ metadata: { path: `events/${i.eventSlug}/certificates/${i.id}`, size: i.body.byteLength } }),
    delete: async () => {}, download: async () => ({ body: new Uint8Array([1]), mimeType: 'application/pdf', size: 1 }),
    generateSignedUrl: async () => 'https://r2.test/signed',
  },
}))
vi.mock('@/lib/certificates/render', () => ({ renderCertificatePdf: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]) }))
vi.mock('@/lib/certificates/urlGuard', () => ({
  safeFetchBytes: async () => new Uint8Array([1, 2, 3]), validateEventTemplateUrl: () => ({ ok: true }),
  validateGlobalTemplateUrl: () => ({ ok: true }), validateGeneratedCertificateUrl: () => ({ ok: true }),
}))
vi.mock('@/lib/certificates/firestore', () => ({
  assertRegistrationEligibleForCertificate: async () => {},
  findCertificate: async () => null,
  reserveCertificateId: async () => ({ certificateId: 'RDC-2026-CAP001', owned: true }),
  createCertificate: async (input: Record<string, unknown>) => { h.created++; return { ...input, status: 'generated' } },
  getCertificate: async () => null, getActiveTemplate: async () => null, getTemplateById: async () => null,
  recordCertificateRegeneration: async () => {}, releaseCertificateClaim: async () => {}, setCertificateArtifact: async () => {},
  getSettings: async () => null, recordTemplateUsage: async () => {},
}))
vi.mock('@/lib/certificates/email', () => ({ emailCertificate: async () => ({ success: true, skipped: true }) }))
vi.mock('@/lib/certificates/whatsapp', () => ({ sendCertificateWhatsApp: async () => {} }))
vi.mock('@/lib/integrations/webhooks', () => ({ enqueueWebhook: async () => {} }))
vi.mock('@/lib/crm/service', () => ({ crmRecordCertificate: async () => {} }))
vi.mock('@/lib/email/appUrl', () => ({ getEmailAppUrl: () => 'https://registerdesk.in' }))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {}, captureFinancialError: () => {} }))
// No Firestore at unit level (the usage reader is imported only for its pure helper).
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
// The retired top-up route only authenticates; nothing else may be touched.
vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({ ok: true, status: 200, error: '', workspaceUid: 'org-1', callerUid: 'org-1', permissions: ['wallet'] }),
}))

import { legacyBalanceCanFund, legacyBalanceCanFundNewWhatsApp, LEGACY_BALANCE_FUNDS_NEW_WHATSAPP, WHATSAPP_CAPACITY_REQUIRED, CERTIFICATE_CAPACITY_REQUIRED, LICENSE_SERVICES_CTA } from '@/lib/communications/capacity'

const TEMPLATE = {
  templateId: 'TPL-1', organizerUid: 'org-1', eventId: 'draft-1', templateType: 'png',
  dimensions: { width: 1492, height: 1054, unit: 'px' }, fileUrl: 'https://storage.test/templates/TPL-1.png', isActive: true,
  layout: { version: 1, canvas: { width: 1492, height: 1054, unit: 'px' }, elements: [{ id: 'e1', type: 'text', content: '{{participantName}}',
    zIndex: 1, x: 0.1, y: 0.4, width: 0.8, fontFamily: 'helvetica', fontSizeFrac: 0.05, weight: 'normal', color: '#111111', align: 'center' }] },
} as never
const INPUT = {
  eventId: 'draft-1', eventSlug: 'cap-event-2026', organizerUid: 'org-1', eventName: 'Cap Event', eventDate: '1 Jan 2027',
  eventLocation: 'Chennai', organizerName: 'RD', registrationId: 'reg-1', attendeeName: 'A', attendeeEmail: 'a@example.test',
  ticketCode: 'T1', passName: '10K', bibNumber: '1', distance: '10K', finishTime: '', position: '', category: '',
} as never

beforeEach(() => {
  h.reserve = { mode: 'allowance', already: false }; h.draftId = 'draft-1'
  h.released = 0; h.charged = 0; h.created = 0
})

// ═══ the drain rule ════════════════════════════════════════════════════════════
describe('RD-WA-BLOCK-01 · a NEW WhatsApp message is never funded by the legacy balance', () => {
  it('the policy is off, so even a balance that covers the whole cost funds nothing new', () => {
    expect(LEGACY_BALANCE_FUNDS_NEW_WHATSAPP).toBe(false)
    expect(legacyBalanceCanFundNewWhatsApp(5_000, 50)).toBe(false)
    expect(legacyBalanceCanFundNewWhatsApp(50, 50)).toBe(false)
    expect(legacyBalanceCanFundNewWhatsApp(Number.MAX_SAFE_INTEGER, 1)).toBe(false)
  })
})

describe('legacyBalanceCanFund — the settlement rule for what the legacy balance ALREADY funded', () => {
  it('funds only when there is a real price and the balance covers ALL of it', () => {
    expect(legacyBalanceCanFund(5_000, 50)).toBe(true)
    expect(legacyBalanceCanFund(50, 50)).toBe(true)
    expect(legacyBalanceCanFund(49, 50)).toBe(false)     // partial cover ⇒ blocked
    expect(legacyBalanceCanFund(0, 50)).toBe(false)      // ₹0 legacy balance ⇒ blocked
    expect(legacyBalanceCanFund(5_000, 0)).toBe(false)   // no price ⇒ never a free send without capacity
    expect(legacyBalanceCanFund(-10, 50)).toBe(false)
    expect(legacyBalanceCanFund(Number.NaN, 50)).toBe(false)
  })
  it('organizer-facing capacity messages name License & Services and no wallet / pay-as-you-go wording', () => {
    for (const m of [WHATSAPP_CAPACITY_REQUIRED, CERTIFICATE_CAPACITY_REQUIRED]) {
      expect(m).toContain('License & Services')
      expect(m).not.toMatch(/wallet|balance|add funds|pay-as-you-go|increase limit/i)
    }
    expect(LICENSE_SERVICES_CTA).toBe('Manage in License & Services')
  })
})

// ═══ certificates require certificate capacity ═════════════════════════════════
describe('certificate issuance requires certificate capacity (no wallet, no free issue)', () => {
  const run = async () => (await import('@/lib/certificates/generate')).generateCertificate({
    input: INPUT, certificateType: 'participation', source: 'manual', template: TEMPLATE,
  } as never)

  it('capacity available ⇒ issued, one unit reserved, the communication balance is never charged', async () => {
    const r = await run()
    expect(r.created).toBe(true)
    expect((r as { charged?: boolean }).charged).toBe(false)
    expect(h.created).toBe(1)
    expect(h.charged).toBe(0)
  })
  for (const [label, reserve, draftId] of [
    ['no certificate capacity purchased', { mode: 'none' }, 'draft-1'],
    ['capacity used up (stored policy block)', { mode: 'exhausted', policy: 'block' }, 'draft-1'],
    ['capacity used up (stored policy wallet_payg — retired)', { mode: 'exhausted', policy: 'wallet_payg' }, 'draft-1'],
    ['no resolvable allowance ledger', { mode: 'none' }, null],
  ] as const) {
    it(`${label} ⇒ refused with the License & Services message; nothing issued, nothing charged`, async () => {
      h.reserve = reserve; h.draftId = draftId
      await expect(run()).rejects.toThrow(CERTIFICATE_CAPACITY_REQUIRED)
      expect(h.created).toBe(0)
      expect(h.charged).toBe(0)
    })
  }
  it('the issue API answers 402 with that message; a bulk job reports it per item without alerting', () => {
    const route = code('app/api/organizer/events/[eventId]/certificates/issue/route.ts')
    // RD-CERT-CAPACITY-UX-01 — the same 402 and message, plus an additive machine-readable code.
    expect(route).toMatch(/err instanceof CertificateAllowanceExhaustedError\) \{[\s\S]{0,200}?return NextResponse\.json\(\{ error: err\.message, code: 'CERTIFICATE_CAPACITY_REQUIRED' \}, \{ status: 402 \}\)/)
    const jobs = code('lib/certificates/jobs.ts')
    expect(jobs).toMatch(/err instanceof CertificateAllowanceExhaustedError\) \{\s*return \{ ok: false, error: err\.message \}/)
  })
})

// ═══ top-ups are retired ═══════════════════════════════════════════════════════
describe('new communication-balance top-ups are retired', () => {
  it('POST /api/organizer/wallet/topup answers 410 COMMUNICATION_TOPUP_RETIRED (no order, no write)', async () => {
    const { POST } = await import('@/app/api/organizer/wallet/topup/route')
    const res = await POST(new Request('http://localhost/api/organizer/wallet/topup', {
      method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ amountPaise: 50_000 }),
    }) as never)
    expect(res.status).toBe(410)
    const body = await res.json() as { code?: string; error?: string }
    expect(body.code).toBe('COMMUNICATION_TOPUP_RETIRED')
    expect(body.error).toContain('License & Services')
  })
  it('existing top-ups still settle: verify, status, the webhook credit and reconciliation are untouched', () => {
    expect(code('app/api/organizer/wallet/topup/verify/route.ts')).toContain('atomicTopupCredit(')
    expect(code('app/api/webhooks/razorpay/route.ts')).toContain('atomicTopupCredit(')
    expect(code('app/api/cron/wallet-reconciliation/route.ts')).toMatch(/retryPendingWalletTopups|sweepStaleWalletTopups/)
  })
})

// ═══ server send paths follow the rule ═════════════════════════════════════════
describe('every WhatsApp send path: event capacity, or blocked (RD-WA-BLOCK-01 — the legacy balance funds nothing new)', () => {
  for (const f of ['lib/registrations/sendWhatsAppConfirmation.ts', 'lib/certificates/whatsapp.ts', 'lib/email-logs/whatsappRetry.ts']) {
    it(`${f}`, () => {
      const s = code(f)
      // RD-COMMS-P2-A — funding is decided ATOMICALLY by the hold (lib/whatsapp/funding.ts), never by
      // a balance read outside a transaction.
      expect(s).toContain('reserveWhatsAppFunding(')
      expect(s).not.toContain('getWalletBalance(')
      expect(s).toContain('WHATSAPP_CAPACITY_REQUIRED')
      expect(s).not.toMatch(/policy === 'block'|walletChargeAttendeeNotifications|getWalletConfig/)
    })
  }
  it('acceptance settles against the send funding hold (no toggle can make a drained send free)', () => {
    for (const f of ['lib/registrations/whatsappConfirmationAcceptance.ts', 'lib/certificates/whatsapp.ts']) {
      expect(code(f), f).toContain('legacyPricePaise: comm.whatsapp.pricePaise')
      expect(code(f), f).not.toMatch(/walletChargeAttendeeNotifications|fromAllowance/)
    }
    // The legacy drain never goes below zero, whatever allowNegativeBalance says.
    const acc = code('lib/whatsapp/acceptance.ts')
    expect(acc).not.toMatch(/allowNegativeBalance|getWalletConfig/)
    // RD-WA-BLOCK-01 — funding a message with no usable hold is a NEW funding decision: capacity only.
    expect(acc).toContain('legacyBalanceCanFundNewWhatsApp(balance, f.legacyPricePaise)')
    expect(acc).not.toContain('legacyBalanceCanFund(balance, f.legacyPricePaise)')
  })
  it('broadcasts: email is never charged; WhatsApp not covered by capacity fails (RD-WA-BLOCK-01)', () => {
    const s = code('lib/communications/billing.ts')
    expect(s).toContain("if (args.channel === 'whatsapp' && units > 0 && !legacyBalanceCanFundNewWhatsApp(balance, cost)) {")
    expect(s).toMatch(/: args\.channel === 'sms'\s+\? comm\.sms\.pricePaise\s+: 0/)   // email ⇒ price 0
    const route = code('app/api/organizer/broadcasts/route.ts')
    expect(route).toContain("error: 'WHATSAPP_CAPACITY_REQUIRED', message: WHATSAPP_BROADCAST_CAPACITY_REQUIRED")
    expect(route).not.toMatch(/Increase limit on the event Wallet|Insufficient wallet balance/)
  })
})

// ═══ Usage figures ═════════════════════════════════════════════════════════════
describe('Usage — canonical ledger figures, no double count', async () => {
  const { serviceUsageOf } = await import('@/lib/communications/usage')
  it('purchased + carried in − used − in progress − refunded − carried out = available (the ledger formula)', () => {
    // RD-COMMS-L2 — purchased 1,000 + carried in 200; consumed 650 of which 150 are held by a running
    // broadcast; 50 refunded + 100 carried out ⇒ available = 1,200 − 650 − 150 = 400.
    const u = serviceUsageOf({ purchased: 1_000, carriedIn: 200, consumed: 650, carriedOut: 100, refunded: 50, remaining: 400 }, { inProgress: 150, returned: 30 }, '/x')
    expect(u).toEqual({ purchased: 1_000, carriedIn: 200, inProgress: 150, used: 500, returned: 30, refunded: 50, carriedOut: 100, available: 400, manageHref: '/x' })
    expect(u.purchased + u.carriedIn - u.used! - u.inProgress! - u.refunded - u.carriedOut).toBe(u.available)
  })
  it('in progress can never exceed what was consumed (a stale campaign never makes "used" negative)', () => {
    const u = serviceUsageOf({ purchased: 10, carriedIn: 0, consumed: 3, carriedOut: 0, refunded: 0, remaining: 7 }, { inProgress: 99, returned: 0 }, '/x')
    expect(u.inProgress).toBe(3)
    expect(u.used).toBe(0)
  })
})

// ═══ organizer UI: no Add Funds, Usage is event-scoped ═════════════════════════
describe('active organizer communication UI has no purchase path except License & Services', () => {
  const SURFACES = [
    'app/(dashboard)/dashboard/communications/page.tsx', 'components/communications/CommTabs.tsx',
    'components/communications/CommUsage.tsx', 'components/wallet/CommunicationBalanceCard.tsx',
    'app/(dashboard)/dashboard/events/new/page.tsx', 'app/(dashboard)/dashboard/settings/billing/page.tsx',
    'app/(dashboard)/dashboard/page.tsx', 'app/(dashboard)/dashboard/events/[eventId]/tabs/CommunicationsTab.tsx',
    'app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx',
    'components/wizard/LicenseServicesStep.tsx', 'components/wizard/LicenseCostSummary.tsx',
    'app/(dashboard)/dashboard/wallet/EventWalletClient.tsx',
  ]
  it('no top-up call, no Add Funds / Top up control, no "keep pay-as-you-go messages running"', () => {
    for (const f of SURFACES) {
      const s = code(f)
      expect(s, f).not.toContain('/api/organizer/wallet/topup')
      expect(s, f).not.toMatch(/>\s*Add funds|>\s*Add Funds|Top up balance|Top up communication balance|keep pay-as-you-go messages running|billed from your communication balance|Increase limit on the event Wallet/)
    }
  })
  it('Billing became Usage (old ?tab=billing links still land there); Usage follows the header event selector', () => {
    const page = code('app/(dashboard)/dashboard/communications/page.tsx')
    expect(page).toContain("{ key: 'usage',      label: 'Usage' }")
    expect(page).not.toContain("label: 'Billing'")
    expect(page).toContain("const requested = rawTab === 'billing' ? 'usage' : rawTab")
    const usage = code('components/communications/CommUsage.tsx')
    expect(usage).toContain('useEventContext()')
    expect(usage).toContain("const current = state.kind !== 'idle' && state.eventId === selectedEventId ? state : null")
    expect(usage).toContain('/api/organizer/communications/usage?eventId=${encodeURIComponent(eventId)}')
    expect(usage).toContain('{LICENSE_SERVICES_CTA}')
  })
  it('the Usage API is event-scoped and ownership-checked; legacy money only for wallet holders', () => {
    const r = code('app/api/organizer/communications/usage/route.ts')
    expect(r).toContain("authorizeEvent(req, 'broadcasts', eventId)")
    expect(r).toContain("includeLegacyBalance: authz.permissions.includes('wallet')")
    const s = code('lib/communications/usage.ts')
    expect(s).toContain('adminDb.doc(`users/${uid}/eventDrafts/${draftId}`)')
    expect(s).toContain('raw && raw.organizerUid === uid ? raw : undefined')
    expect(s).toContain("where('organizerUid', '==', uid).where('eventSlug', '==', slug)")
    expect(s).not.toMatch(/\.(set|update|delete|create)\(|runTransaction|razorpay/i)
  })
  it('a legacy balance is shown read-only and only while above zero', () => {
    expect(code('components/wallet/CommunicationBalanceCard.tsx')).toContain('if (balancePaise === null || balancePaise <= 0) return null')
    expect(code('components/communications/CommUsage.tsx')).toContain('u.legacyBalancePaise !== null && u.legacyBalancePaise > 0')
    expect(code('app/(dashboard)/dashboard/page.tsx')).toContain('const showLegacyBalance = finance.allowed && (data.walletBalancePaise ?? 0) > 0')
  })
})

// ═══ low-balance reminder retired ══════════════════════════════════════════════
describe('the low-balance ("add funds") reminder is retired', () => {
  it('no new low_wallet reminder is scheduled, and one scheduled before is skipped, never sent', () => {
    const sched = code('lib/reminders/scheduler.ts')
    expect(sched).not.toContain('rem_lowwallet_')
    expect(sched).not.toContain('getWalletBalance')
    const disp = code('lib/reminders/dispatch.ts')
    const gate = disp.lastIndexOf("if (data.kind === 'low_wallet') {")   // the dispatch gate (the first match is the legacy content builder)
    expect(gate).toBeGreaterThan(-1)
    expect(disp.slice(gate, gate + 600)).toContain("'retired')")
    expect(gate).toBeLessThan(disp.indexOf('buildContent(data, gate.event)'))   // skipped before any content is built or sent
  })
})
