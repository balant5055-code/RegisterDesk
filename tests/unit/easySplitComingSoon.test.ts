// Phase D1 — the Easy Split "Coming soon" notice must stay NON-FUNCTIONAL.
//
// ═══ WHY THIS IS WORTH A TEST ═══════════════════════════════════════════════
// A "coming soon" block is the easiest thing in a codebase to accidentally make real. The
// usual route is a disabled control: someone sees `disabled` on a toggle, removes it in a
// later change, and a feature that was never built is suddenly switchable in production.
//
// So the notice is deliberately STATIC COPY with no control at all, and nothing in the
// payments configuration section corresponds to it — there is no field for a crafted
// request to set even if the UI were bypassed. These cases pin both halves of that.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const EDITOR = 'app/(admin)/admin/business-configuration/PaymentGatewayEditor.tsx'
const src = readFileSync(EDITOR, 'utf8')

/**
 * The Easy Split block only — the gateway selector above and the publish buttons below
 * legitimately have controls, so the window is anchored between two unambiguous markers:
 * the block's own comment banner, and the confirmation block that follows it.
 */
const block = (() => {
  const start = src.indexOf('EASY SPLIT')
  const end   = src.indexOf('{confirming && dirty', start)
  expect(start, 'Easy Split block marker not found').toBeGreaterThan(-1)
  expect(end, 'confirmation block marker not found').toBeGreaterThan(start)
  return src.slice(start, end)
})()

describe('Phase D1 · the Easy Split notice', () => {
  it('states the feature, its status and the exact description', () => {
    expect(src).toContain('Easy Split')
    expect(src).toContain('Coming soon')
    expect(src).toContain(
      'Automatically split registration payments between RegisterDesk and eligible event',
    )
  })

  it('says plainly that activation and eligibility are pending', () => {
    expect(block).toMatch(/Cashfree account activation/i)
    expect(block).toMatch(/eligibility/i)
    // And that the current payout route is unaffected — an admin reading this must not
    // conclude that settlements have changed.
    expect(block).toMatch(/existing settlement process/i)
  })

  it('contains NO interactive control — not even a disabled one', () => {
    // A disabled control is an invitation to remove `disabled`. Static text is not.
    for (const control of ['<button', '<input', '<select', '<Toggle', 'onClick', 'onChange', 'role="switch"']) {
      expect(block, `the Easy Split block must not contain ${control}`).not.toContain(control)
    }
  })

  it('writes nothing — it touches no draft and no config key', () => {
    expect(block).not.toContain('onDraftChange')
    expect(block).not.toContain('onPublish')
    expect(block).not.toMatch(/easySplit|easy_split/i)
  })
})

describe('Phase D1 · there is nothing to enable', () => {
  it('the payments config section has no Easy Split field', () => {
    // The server-side half. Even bypassing the UI entirely, no request can turn this on
    // because the section schema has no such key and the validator rejects unknown shapes.
    const cfg = readFileSync('lib/config/businessConfig.ts', 'utf8')
    const section = cfg.slice(cfg.indexOf('export interface PaymentsConfig'))
      .slice(0, cfg.slice(cfg.indexOf('export interface PaymentsConfig')).indexOf('}'))
    expect(section).toMatch(/activeProvider/)
    expect(section).not.toMatch(/split/i)
    expect(section).not.toMatch(/commission/i)
  })

  it('no split, vendor or commission machinery was introduced anywhere', () => {
    // Phase D1 is UI + audit only. If any of these appear in production code, the phase
    // has quietly started implementing Phase D.
    const cfg = readFileSync('lib/config/businessConfig.ts', 'utf8')
    for (const f of [EDITOR, 'lib/config/businessConfig.ts']) {
      const s = f === EDITOR ? src : cfg
      for (const forbidden of ['order_splits', 'createVendor', 'splitRule', 'commissionPercent']) {
        expect(s, `${f} must not contain ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('the notice makes no Cashfree API call', () => {
    expect(src).not.toContain('fetch(')
    expect(src).not.toContain('cashfree.com')
    expect(src).not.toContain('cashfreeAdapter')
  })
})
