// WhatsApp Inbox — the ONE switch, end to end on the server: Business Configuration →
// system/businessConfiguration.featureFlags.whatsappInbox → resolveSection (defaults merged) →
// getFeatureFlags → authorizeInbox. UNIT layer (no Firestore, no emulator).
//
// Root cause pinned here: the setting is ABSENT from stored configuration by default, so the code
// default (false) applies to every workspace — it is a platform-wide switch, not a per-workspace one.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  flags:  { whatsappInbox: false } as Record<string, unknown>,
  authz:  { ok: true, status: 200, error: '', workspaceUid: 'ws1' } as Record<string, unknown>,
  flagReads: 0,
}))

vi.mock('@/lib/config/resolveFeatureFlags', () => ({
  getFeatureFlags: async () => { h.flagReads++; return h.flags },
}))
vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => h.authz,
}))

import { resolveSection, BUSINESS_CONFIG_DEFAULTS, FEATURE_FLAG_KEYS } from '@/lib/config/businessConfig'
import { authorizeInbox, INBOX_NOT_ENABLED } from '@/lib/whatsapp-inbox/authz'

beforeEach(() => {
  h.flags = { whatsappInbox: false }
  h.authz = { ok: true, status: 200, error: '', workspaceUid: 'ws1' }
  h.flagReads = 0
})

describe('configuration path', () => {
  it('whatsappInbox is a registered platform flag whose code default is OFF', () => {
    expect(FEATURE_FLAG_KEYS).toContain('whatsappInbox')
    expect(BUSINESS_CONFIG_DEFAULTS.featureFlags.whatsappInbox).toBe(false)
  })

  it('a stored configuration that never set it resolves OFF (the observed state)', () => {
    expect(resolveSection('featureFlags', { featureFlags: { crm: true } } as never).whatsappInbox).toBe(false)
    expect(resolveSection('featureFlags', undefined).whatsappInbox).toBe(false)
  })

  it('the Super Admin toggle (stored true) resolves ON, and leaves every other flag as stored/defaulted', () => {
    const on = resolveSection('featureFlags', { featureFlags: { whatsappInbox: true } } as never)
    expect(on.whatsappInbox).toBe(true)
    for (const k of FEATURE_FLAG_KEYS) if (k !== 'whatsappInbox') expect(on[k]).toBe(BUSINESS_CONFIG_DEFAULTS.featureFlags[k])
  })

  it('a malformed stored value is rejected and falls back to OFF (never "on" by accident)', () => {
    expect(resolveSection('featureFlags', { featureFlags: { whatsappInbox: 'yes' } } as never).whatsappInbox).toBe(false)
  })
})

describe('authorizeInbox — permission first, then the platform switch', () => {
  const req = () => new Request('https://rd.test/api/organizer/whatsapp-inbox/conversations')

  it('switch OFF → 404 "not enabled" for an authorized owner/admin', async () => {
    const r = await authorizeInbox(req())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.response.status).toBe(404)
      expect(await r.response.json()).toEqual({ success: false, error: INBOX_NOT_ENABLED })
    }
  })

  it('switch ON → admitted, scoped to the caller\'s server-resolved workspace', async () => {
    h.flags = { whatsappInbox: true }
    const r = await authorizeInbox(req())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.authz.workspaceUid).toBe('ws1')
  })

  it('switching it ON never admits a caller without `broadcasts` — refused before the flag is read', async () => {
    h.flags = { whatsappInbox: true }
    h.authz = { ok: false, status: 403, error: 'Missing required permission: broadcasts.' }
    const r = await authorizeInbox(req())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(403)
    expect(h.flagReads).toBe(0)
  })
})
