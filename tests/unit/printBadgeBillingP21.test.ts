// RD-PRINT-BILL-P2.1 — UI hardening: administrator-facing errors, GST hint accuracy, reason guidance,
// and the corrupt event-override recovery contract. Pure + source contracts. Real routes / Firestore /
// Auth (refused unconfirmed replace, confirmed replace, confirmed clear, audit with the raw value):
// tests/emulator/printBadgeCommercial.emu.test.ts (A5).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { DEFAULT_SERVICE_ALLOWANCES, validateServiceAllowances } from '@/lib/licensing/serviceAllowances'
import {
  describeBadgeSettingsIssue, describeBadgeSettingsProblems, badgePriceHint, badgeReasonProblem,
  badgeSettingsOf, BADGE_REASON_GUIDANCE, BADGE_REASON_MAX,
} from '@/lib/licensing/printBadgeSettings'
import { validatePrintBadgeBilling } from '@/lib/licensing/printBadgeCommercial'

const read = (f: string) => readFileSync(f, 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const PB = DEFAULT_SERVICE_ALLOWANCES.print_badges
/** The real validator's messages for one bad print_badges value. */
const raw = (bad: Record<string, unknown> | string) =>
  validateServiceAllowances({ ...DEFAULT_SERVICE_ALLOWANCES, print_badges: typeof bad === 'string' ? bad : { ...PB, ...bad } })
    .filter(e => e.startsWith('licensing.serviceAllowances.print_badges'))

describe('1 · administrator-facing validation errors (no raw configuration paths; field kept)', () => {
  const cases: [Record<string, unknown> | string, string, string][] = [
    [{ unitPricePaise: -1 },               'unitPricePaise', 'Unit price must be an amount above ₹0 (for example ₹0.20), including GST.'],
    [{ gstRatePercent: 150 },              'gstRatePercent', 'GST rate must be between 0% and 100%, or left blank until the accountant confirms it.'],
    [{ gstRatePercent: 'x' },              'gstRatePercent', 'GST rate must be between 0% and 100%, or left blank until the accountant confirms it.'],
    [{ minQuantity: 0 },                   'minQuantity',    'Minimum purchase must be a whole number of at least 1 badge.'],
    [{ maxQuantity: 0 },                   'maxQuantity',    'Maximum must be a whole number of at least 1 badge, or blank for no maximum.'],
    [{ minQuantity: 100, maxQuantity: 50 }, 'maxQuantity',   'Maximum cannot be lower than the minimum purchase.'],
  ]
  it.each(cases)('%o → %s', (bad, field, message) => {
    const msgs = raw(bad)
    expect(msgs.length).toBeGreaterThan(0)
    const described = msgs.map(describeBadgeSettingsIssue)
    expect(described).toContainEqual({ field, message })
    for (const d of described) expect(d.message).not.toMatch(/licensing\.|serviceAllowances|print_badges/)
  })
  it('unreadable blocks point to Reset to defaults', () => {
    expect(describeBadgeSettingsIssue(raw('corrupt')[0])).toEqual({ field: null, message: 'The stored ID badge settings are unreadable. Use “Reset to defaults” to restore them.' })
    expect(describeBadgeSettingsIssue(raw({ enabled: 'yes' })[0]).message).toMatch(/Reset to defaults/)
    expect(describeBadgeSettingsIssue(raw({ onExhausted: 'x' })[0]).message).toMatch(/Reset to defaults/)
    for (const m of validatePrintBadgeBilling({ paidGenerationEnabled: 'on', extra: 1 }).map(e => e.replace('licensing.printBadgeBilling', 'licensing.printBadgeBilling'))) {
      expect(describeBadgeSettingsIssue(m)).toMatchObject({ field: 'paidGenerationEnabled' })
      expect(describeBadgeSettingsIssue(m).message).not.toMatch(/licensing\./)
    }
  })
  it('lock messages pass through, tied to their switch', () => {
    const issues = describeBadgeSettingsProblems(badgeSettingsOf({ serviceAllowances: { print_badges: { ...PB, enabled: true, gstRatePercent: 18 } }, printBadgeBilling: { paidGenerationEnabled: true } }))
    expect(issues.map(i => i.field).sort()).toEqual(['enabled', 'paidGenerationEnabled'])
    for (const i of issues) expect(i.message).toMatch(/locked/)
  })
  it('the save route and the editor use the administrator wording', () => {
    const route = code(read('app/api/admin/business-config/route.ts'))
    expect(route).toContain('const words = (list: string[]) => list.map(m => describeBadgeSettingsIssue(m).message)')
    expect(route).toContain('`Not published — ID badges: ${words(problems.errors).join(\' \')}`')
    const editor = code(read('app/(admin)/admin/business-configuration/LicensingEditor.tsx'))
    expect(editor).toContain('const issues = describeBadgeSettingsProblems(after)')
    expect(editor).toContain("describeBadgeSettingsProblems(badgeSettingsOf(draft)).map(i => `ID badges: ${i.message}`)")
    // Field-level association: each input is described by its own error.
    for (const f of ['gstRatePercent', 'minQuantity', 'maxQuantity']) expect(editor).toContain(`{...inv('${f}')}`)
    expect(editor).toContain("'aria-describedby': `pb-${f}-err`")
  })
})

describe('2 · GST hint accuracy — unset vs invalid vs complete', () => {
  it('unset (null) says "not set"', () => {
    expect(badgePriceHint({ ...PB, gstRatePercent: null })).toEqual({ kind: 'gst_unset', text: 'GST rate not set — no price is shown or charged until it is.' })
  })
  it.each([150, -1, NaN, '18', Infinity])('an INVALID rate (%s) is never described as missing', rate => {
    const h = badgePriceHint({ ...PB, gstRatePercent: rate })
    expect(h.kind).toBe('gst_invalid')
    expect('text' in h && h.text).toMatch(/invalid/)
    expect('text' in h && h.text).not.toMatch(/not set/)
  })
  it('other gaps are named; a complete set gives the GST-inclusive example', () => {
    expect(badgePriceHint({ ...PB, gstRatePercent: 18, unitPricePaise: null }).kind).toBe('price_unset')
    expect(badgePriceHint({ ...PB, gstRatePercent: 18, unitPricePaise: -5 }).kind).toBe('price_invalid')
    expect(badgePriceHint({ ...PB, gstRatePercent: 18, minQuantity: NaN }).kind).toBe('quantity_invalid')
    expect(badgePriceHint({ ...PB, gstRatePercent: 18 })).toEqual({ kind: 'example', quantity: 100, unitPricePaise: 20, totalPaise: 2000, gstPaise: 305, basePaise: 1695 })
  })
})

describe('3 · reason guidance before submission (server rule unchanged)', () => {
  it('the rule, stated and checked the same way as the server', () => {
    expect(BADGE_REASON_GUIDANCE).toBe('Changing ID badge settings needs a reason of 3–500 characters. It is recorded in the audit log.')
    expect(BADGE_REASON_MAX).toBe(500)
    expect(badgeReasonProblem('')).toBe('Enter a reason.')
    expect(badgeReasonProblem('  ab ')).toBe('The reason must be at least 3 characters.')
    expect(badgeReasonProblem('abc')).toBeNull()
    expect(badgeReasonProblem('x'.repeat(500))).toBeNull()
    expect(badgeReasonProblem('x'.repeat(501))).toBe('The reason must be at most 500 characters.')
  })
  it('the publish dialog states it for a badge change, counts characters and disables Publish until valid', () => {
    const page = code(read('app/(admin)/admin/business-configuration/PageClient.tsx'))
    expect(page).toContain("const badgeChangeInDialog = reasonFor === 'licensing' && !!data && !!drafts")
    expect(page).toContain('{BADGE_REASON_GUIDANCE}')
    expect(page).toContain('disabled={publishing || !reasonText.trim() || !!badgeReasonIssue}')
    // The server rule is still enforced (unchanged).
    expect(code(read('app/api/admin/business-config/route.ts'))).toContain('const reason = parseFinancialReason(rawReason)')
  })
  it('the editor block and the event panel state it up front', () => {
    expect(code(read('app/(admin)/admin/business-configuration/LicensingEditor.tsx'))).toContain('{BADGE_REASON_GUIDANCE}')
    expect(code(read('components/admin/AdminPrintBadgePanel.tsx'))).toContain('const REASON_HINT = `Reason — required, 3–${BADGE_REASON_MAX} characters, recorded in the audit log`')
  })
})

describe('4 · corrupt event-override recovery (contracts; emulator A5 proves the behaviour)', () => {
  const panel = code(read('components/admin/AdminPrintBadgePanel.tsx'))
  const route = code(read('app/api/admin/events/[slug]/print-badges/route.ts'))
  it('server: an unconfirmed save never replaces an unreadable override; clear is explicit; preview is bounded text', () => {
    expect(route).toContain('if (!stored.ok && !clearAll && body.replaceUnreadable !== true) return { kind: \'unreadable\', errors: stored.errors }')
    expect(route).toContain("code: 'OVERRIDE_UNREADABLE'")
    expect(route).toContain('overrideStatus: stored.ok ? { ok: true } : { ok: false, errors: stored.errors, ...rawPreview(storedRaw) },')
    expect(route).toContain('const RAW_PREVIEW_MAX = 2000')
    expect(route).not.toMatch(/raw: storedRaw/)
  })
  it('panel: "Unreadable override" status, read-only escaped preview, explicit clear with a confirmation step', () => {
    expect(panel).toContain('Unreadable override')
    expect(panel).toContain('data-testid="unreadable-override-raw">{overrideStatus.rawPreview}</pre>')   // text, never HTML
    expect(panel).not.toMatch(/dangerouslySetInnerHTML/)
    expect(panel).toContain('data-testid="clear-corrupt-override"')
    expect(panel).toContain("const startClear = () => { setReason(''); setError(null); setNotice(null); setMode('confirmClear') }")
    expect(panel).toContain("void send({ clear: true }, 'The unreadable override was cleared — the event follows the global settings.')")
    // Cancel returns to view without sending anything.
    expect(panel).toContain("const cancel = () => { setMode('view'); setError(null); setReason(''); setAckReplace(false) }")
  })
  it('panel: replacing needs an explicit acknowledgement; only then is replaceUnreadable sent', () => {
    expect(panel).toContain("if (unreadable && !ackReplace) { setError('Confirm that this save replaces the unreadable override.'); return }")
    expect(panel).toContain('...(unreadable ? { replaceUnreadable: true } : {}),')
    expect(panel).toContain('disabled={saving || (unreadable && !ackReplace)}')
  })
  it('panel: readable at 390px — stacked layers below sm, table from sm up', () => {
    expect(panel).toContain('<table className="hidden w-full text-[12px] sm:table">')
    expect(panel).toContain('<dl className="space-y-2 sm:hidden" data-testid="print-badge-stacked">')
  })
})
