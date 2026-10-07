// Phase D1.1 — the organizer-facing Easy Split notice must stay NON-FUNCTIONAL.
//
// ═══ THE RISK ══════════════════════════════════════════════════════════════
// This notice sits inside the event builder, a form whose whole purpose is to collect
// values and persist them into a draft. A "coming soon" block in that context is one
// careless edit away from becoming a real field: add an onChange, and a feature nobody
// built starts writing to the event payload.
//
// So it is static copy with no control, reads no draft state, and has no counterpart in
// the event schema. These cases pin all three, and separately pin that the existing admin
// notice was left alone.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const WIZARD = 'app/(dashboard)/dashboard/events/new/page.tsx'
const src = readFileSync(WIZARD, 'utf8')

/**
 * The Easy Split block only. The fee-model cards above it legitimately have controls, so
 * the window is anchored on the block's own comment banner and the close of its container.
 */
const block = (() => {
  const marker = src.indexOf('CASHFREE EASY SPLIT')
  expect(marker, 'Easy Split block not found in the wizard').toBeGreaterThan(-1)
  // Anchor on the comment's OPENING brace, not the banner text inside it — otherwise the
  // slice starts mid-comment and the comment-stripping regex below has nothing to match.
  const start = src.lastIndexOf('{/*', marker)
  const rest  = src.slice(start)
  // Up to the end of the section that contains it.
  return rest.slice(0, rest.indexOf('</div>\n    </div>') + 18)
})()

/**
 * The same block with its JSX comment stripped.
 *
 * The comment explains WHY there is no disabled control, so it necessarily contains the
 * word "disabled" — asserting against the raw text would fail on the explanation rather
 * than on the markup. Assertions about what the UI *renders* use this.
 */
const markup = block.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

describe('Phase D1.1 · the organizer notice', () => {
  it('carries the exact required copy', () => {
    expect(block).toContain('Cashfree Easy Split')
    expect(block).toContain('Coming Soon')
    expect(block).toContain(
      'Automatically split registration payments between RegisterDesk and eligible event',
    )
    expect(block).toMatch(/Subject to Cashfree activation, account eligibility and completion of the/)
  })

  it('reassures that payouts are unchanged', () => {
    // An organizer reading a payment notice mid-form must not conclude their settlements
    // have already moved.
    expect(block).toMatch(/existing settlement process/i)
  })

  it('has NO interactive control — not even a disabled one', () => {
    for (const control of ['<button', '<input', '<select', 'onClick', 'onChange', 'role="switch"', 'disabled']) {
      expect(markup, `the notice must not contain ${control}`).not.toContain(control)
    }
  })

  it('reads no state and writes no draft field', () => {
    // The two ways a builder block becomes real: reading a value, or emitting one.
    for (const wiring of ['useState', 'onDraftChange', 'emit(', 'setValues', 'autosave', 'draft.']) {
      expect(markup, `the notice must not use ${wiring}`).not.toContain(wiring)
    }
  })

  it('makes no Cashfree API call', () => {
    expect(markup).not.toContain('fetch(')
    expect(markup).not.toContain('cashfree.com')
    expect(markup).not.toContain('cashfreeAdapter')
  })
})

describe('Phase D1.1 · there is nothing to enable', () => {
  it('no easySplit field exists in the event payload or publish route', () => {
    // Even bypassing the form, there is no key to set.
    for (const f of ['app/api/events/publish/route.ts', 'lib/events/builder/stepRegistry.ts']) {
      const s = readFileSync(f, 'utf8')
      expect(s, `${f} must not carry an easySplit field`).not.toMatch(/easySplit|easy_split/i)
    }
  })

  it('the wizard introduces no split or commission machinery', () => {
    for (const forbidden of ['order_splits', 'createVendor', 'splitRule', 'commissionPercent']) {
      expect(src, `the wizard must not contain ${forbidden}`).not.toContain(forbidden)
    }
  })
})

describe('Phase D1.1 · the admin notice is untouched', () => {
  it('the Business Configuration notice still exists, unchanged in substance', () => {
    const admin = readFileSync('app/(admin)/admin/business-configuration/PaymentGatewayEditor.tsx', 'utf8')
    expect(admin).toContain('Easy Split')
    expect(admin).toContain('Coming soon')
    expect(admin).toContain(
      'Automatically split registration payments between RegisterDesk and eligible event',
    )
  })
})
