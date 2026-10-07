// RD-WALLET-CFG-01 — wallet financial controls are Super Admin only, proved through the REAL
// business-config and public-config routes on REAL Firestore (private emulator). Identity is stubbed
// at the token boundary only (lib/admin/auth), as in the Phase 4 suite: SUPER is in ADMIN_UIDS,
// PLAIN holds only the legacy `admin: true` claim, ORG is a signed-in organizer, '' is anonymous.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

// RD-SEC-01 · two roles only. A legacy-claim caller is no longer a "plain admin": routes refuse it
// at the admin door like any non-admin (bare 403/401) or, behind requireSuperAdmin, with
// SUPER_ADMIN_REQUIRED. Either way it must be an AUTHORIZATION refusal — never a validation code
// (REASON_REQUIRED etc.), which would mean it got past the door.
const PLAIN_REFUSED: ReadonlyArray<string | undefined> = ['SUPER_ADMIN_REQUIRED', undefined]


const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = process.pid
const SUPER = `wcfg-super-${P}`, PLAIN = `wcfg-plain-${P}`, ORG = `wcfg-org-${P}`

const h = vi.hoisted(() => ({ who: '' as string, superUid: '', plainUid: '' }))
// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async () => (h.who === h.superUid ? h.who : null),
  legacyAdminClaimOnly: async () => h.who === h.plainUid,
  resolveSuperAdminUid: async () => (h.who === h.superUid ? h.superUid : null),
}))

const req = (method: string, body?: unknown) => new NextRequest('http://localhost/api/admin/business-config', {
  method, headers: { 'Content-Type': 'application/json', ...(h.who ? { authorization: 'Bearer t' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })
const RESTRICTED = [
  'allowNegativeBalance', 'frozen', 'allowWalletRefunds', 'minimumTopupPaise', 'maximumTopupPaise', 'maximumBalancePaise',
  'minimumRequiredBalancePaise', 'lowBalanceThresholdPaise', 'autoTopupThresholdPaise', 'autoTopupAmountPaise',
]

describeEmu('RD-WALLET-CFG-01 · wallet financial controls are Super Admin only (real routes, real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService').businessConfig

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    h.superUid = SUPER; h.plainUid = PLAIN
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
  }, T)
  afterAll(async () => {
    await adminDb.recursiveDelete(adminDb.doc('system/businessConfiguration')).catch(() => null)
    for (const c of ['configurationAudit', 'adminAuditLogs']) {
      for (const who of [SUPER, PLAIN]) {
        for (const f of ['updatedBy', 'adminUid']) {
          const qs = await adminDb.collection(c).where(f, '==', who).get().catch(() => null)
          for (const d of qs?.docs ?? []) await d.ref.delete().catch(() => null)
        }
      }
    }
    businessConfig.invalidateCache()
  }, T)
  beforeEach(() => { h.who = ''; businessConfig.invalidateCache() })

  const get = async () => { const { GET } = await import('@/app/api/admin/business-config/route'); return json(await GET(req('GET'))) }
  const publish = async (section: string, patch: Record<string, unknown>, reason = 'wallet controls test') => {
    const { POST } = await import('@/app/api/admin/business-config/route')
    return json(await POST(req('POST', { section, patch, reason })))
  }
  const stored = async () => JSON.stringify((await adminDb.doc('system/businessConfiguration').get()).data() ?? {})
  const storedWallet = async () => ((await adminDb.doc('system/businessConfiguration').get()).data()?.wallet ?? {}) as Record<string, unknown>

  it('unauthenticated and organizer callers are refused on read and write — nothing written', async () => {
    const before = await stored()
    for (const who of ['', ORG]) {
      h.who = who
      expect((await get()).status, who || 'anon').toBe(403)
      expect((await publish('wallet', { frozen: true })).status, who || 'anon').toBe(403)
      expect((await publish('wallet', { displayName: 'x' })).status, who || 'anon').toBe(403)
    }
    expect(await stored()).toBe(before)
  }, T)

  // RD-SEC-01 · was "does not SEE the controls (other wallet settings still visible)": the claim-only
  // "plain admin" tier is gone (two roles), so it reads NO configuration at all.
  it('a legacy admin:true caller cannot read the configuration at all', async () => {
    h.who = PLAIN
    const r = await get()
    expect(r.status).toBe(403)
    expect(r.body).not.toHaveProperty('config')
    expect(r.body).not.toHaveProperty('configurationAudit')
  }, T)

  it('a legacy admin:true caller cannot CHANGE any control — directly, mixed with permitted fields, or by clearing one', async () => {
    h.who = PLAIN
    const before = await stored()
    const W = (await import('@/lib/config/businessConfig')).BUSINESS_CONFIG_DEFAULTS.wallet as unknown as Record<string, unknown>
    for (const f of RESTRICTED) {
      const changed = typeof W[f] === 'boolean' ? !W[f] : (W[f] as number) + 100
      const r = await publish('wallet', { [f]: changed })
      expect(r.status, f).toBe(403)
      expect(PLAIN_REFUSED, f).toContain(r.body.code)
    }
    const mixed = await publish('wallet', { displayName: 'Smuggled', description: 'ok', allowNegativeBalance: true })
    expect(mixed.status).toBe(403)
    expect(await stored()).toBe(before)                                              // nothing at all written
  }, T)

  // RD-SEC-01 · was "CAN still change the unrestricted wallet settings": no plain-admin tier any more —
  // even an unrestricted field is refused, nothing written. The Super Admin's ordinary save still works.
  it('a legacy admin:true caller cannot change even the unrestricted wallet settings; the Super Admin can', async () => {
    h.who = PLAIN
    const before = await stored()
    const r = await publish('wallet', { displayName: 'Organizer wallet', description: 'Edited by an admin' })
    expect(r.status).toBe(403)
    expect(PLAIN_REFUSED).toContain(r.body.code)
    expect(await stored()).toBe(before)
    h.who = SUPER
    expect((await publish('wallet', { displayName: 'Organizer wallet', description: 'Edited by an admin' })).status).toBe(200)
    expect(await storedWallet()).toMatchObject({ displayName: 'Organizer wallet', description: 'Edited by an admin' })
  }, T)

  it('a Super Admin sees and changes the controls; the change is validated, versioned and audited', async () => {
    h.who = SUPER
    const view = await get()
    for (const f of RESTRICTED) expect((view.body.config as Record<string, Record<string, unknown>>).wallet, f).toHaveProperty(f)
    expect(view.body.permissions).toEqual({ canEditPricing: true })
    expect((await publish('wallet', { minimumTopupPaise: -5 })).status).toBe(400)
    expect((await publish('wallet', { minimumTopupPaise: 900_000, maximumTopupPaise: 100 })).status).toBe(400)
    const ok = await publish('wallet', { frozen: true, minimumTopupPaise: 50_000, allowWalletRefunds: false }, 'Super Admin sets wallet controls')
    expect(ok.status).toBe(200)
    expect(await storedWallet()).toMatchObject({ frozen: true, minimumTopupPaise: 50_000, allowWalletRefunds: false })
    businessConfig.invalidateCache()
    const audit = ((await get()).body.configurationAudit as Array<{ section: string; reason: string; changedFields: string[] }>)
    expect(audit.find(a => a.section === 'wallet' && a.reason === 'Super Admin sets wallet controls')?.changedFields)
      .toEqual(expect.arrayContaining(['frozen', 'minimumTopupPaise', 'allowWalletRefunds']))
  }, T)

  it('the public config feed never carries the restricted controls (and still reflects the organizer-facing limits)', async () => {
    const { GET } = await import('@/app/api/config/public/route')
    businessConfig.invalidateCache()
    const r = await json(await GET())
    const wallet = (r.body.config as Record<string, Record<string, unknown>>).wallet
    for (const f of ['allowNegativeBalance', 'frozen', 'allowWalletRefunds', 'maximumBalancePaise', 'minimumRequiredBalancePaise', 'autoTopupThresholdPaise', 'autoTopupAmountPaise']) {
      expect(wallet, f).not.toHaveProperty(f)
    }
    expect(wallet.minimumTopupPaise).toBe(50_000)                                    // set by the Super Admin above
    expect(wallet).toMatchObject({ displayName: 'Organizer wallet' })
  }, T)

  it('a legacy admin:true caller cannot CLEAR a control the Super Admin set (null would reset it to the default)', async () => {
    h.who = PLAIN
    const before = await stored()
    const r = await publish('wallet', { minimumTopupPaise: null, displayName: 'still organizer wallet' })
    expect(r.status).toBe(403)
    expect(PLAIN_REFUSED).toContain(r.body.code)
    expect(await stored()).toBe(before)
  }, T)

  // RD-SEC-01 · was "a legacy admin can still publish branding": every section is Super Admin only now.
  it('other sections: a legacy admin can publish nothing (branding included); the Super Admin can', async () => {
    h.who = PLAIN
    const before = await stored()
    expect((await publish('branding', { platformTagline: 'Wallet controls test tagline' })).status).toBe(403)
    expect((await publish('fees', { gstPercent: 12 })).status).toBe(403)
    expect(await stored()).toBe(before)
    h.who = SUPER
    expect((await publish('branding', { platformTagline: 'Wallet controls test tagline' })).status).toBe(200)
    expect(((await adminDb.doc('system/businessConfiguration').get()).data()?.branding ?? {}).platformTagline).toBe('Wallet controls test tagline')
  }, T)
})
