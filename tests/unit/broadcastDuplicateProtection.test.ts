// RD-BCAST-DUP-01 (unit) — broadcast duplicate protection: default ON, confirmation before turning it
// off (cancel keeps it on), independent channels, the project's own normalization, preview = dispatch,
// stored campaigns keep their stored flags, and the eligibility order (refunds → consent / opt-outs →
// dedupe) is untouched. The server is unchanged by this work; these tests pin that it stays correct.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_DUPLICATE_PROTECTION, DUPLICATE_PROTECTION_COPY, resolveDuplicateToggle, disableProtectionRequest,
  KEEP_PROTECTION_LABEL, DISABLE_PROTECTION_LABEL,
} from '@/lib/broadcasts/duplicateProtection'
import { dedupeRecipientsByEmail, dedupeRecipientsByPhone, countUniqueRecipients, countUniquePhones } from '@/lib/broadcasts/dedupeRecipients'

const read = (p: string) => readFileSync(p, 'utf8')
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
const COMPOSER = 'app/(dashboard)/dashboard/communications/broadcasts/BroadcastsClient.tsx'
const reg = (email: string, phone: string) => ({ data: { attendee: { email, phone } } })

describe('defaults and copy', () => {
  it('a new broadcast starts protected on BOTH channels', () => {
    expect(DEFAULT_DUPLICATE_PROTECTION).toEqual({ email: true, whatsapp: true })
    const src = code(COMPOSER)
    expect(src).toContain('useState(DEFAULT_DUPLICATE_PROTECTION.email)')
    expect(src).toContain('useState(DEFAULT_DUPLICATE_PROTECTION.whatsapp)')
    // …and the form resets to protected after a send, never to unprotected.
    expect(src).toContain('setDedupeEmails(DEFAULT_DUPLICATE_PROTECTION.email)')
    expect(src).toContain('setDedupePhones(DEFAULT_DUPLICATE_PROTECTION.whatsapp)')
    expect(src).not.toMatch(/setDedupe(Emails|Phones)\(false\)/)
  })
  it('uses the exact approved wording', () => {
    expect(DUPLICATE_PROTECTION_COPY.whatsapp).toEqual({
      label: 'Prevent duplicate WhatsApp messages',
      description: 'Send at most one WhatsApp message per phone number, even if it appears on several registrations.',
      confirmTitle: 'Disable duplicate WhatsApp protection?',
      confirmMessage: 'Multiple registrations may share the same phone number. Disabling this protection can send multiple WhatsApp messages to the same number and consume more of your purchased WhatsApp message allowance.',
    })
    expect(DUPLICATE_PROTECTION_COPY.email).toEqual({
      label: 'Prevent duplicate emails',
      description: 'Send at most one email per email address, even if it appears on several registrations.',
      confirmTitle: 'Disable duplicate email protection?',
      confirmMessage: 'Multiple registrations may share the same email address. Disabling this protection can send duplicate emails and increase your email usage.',
    })
    expect([KEEP_PROTECTION_LABEL, DISABLE_PROTECTION_LABEL]).toEqual(['Keep protection enabled', 'Disable protection'])
    expect(code(COMPOSER)).toContain('Recommended')
    for (const c of ['email', 'whatsapp'] as const) expect(JSON.stringify(DUPLICATE_PROTECTION_COPY[c])).not.toMatch(/₹|\d+\s*paise|rupee/i)   // no invented costs
  })
})

describe('turning protection off needs confirmation', () => {
  it('cancel keeps it ON; confirm turns it OFF exactly once; enabling never asks', async () => {
    const cancel = vi.fn(async () => false)
    expect(await resolveDuplicateToggle('whatsapp', true, false, cancel)).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel.mock.calls[0][0]).toMatchObject({ title: 'Disable duplicate WhatsApp protection?', confirmLabel: 'Disable protection', cancelLabel: 'Keep protection enabled', confirmOnEnter: false })

    const ok = vi.fn(async () => true)
    expect(await resolveDuplicateToggle('email', true, false, ok)).toBe(false)
    expect(ok).toHaveBeenCalledTimes(1)

    const never = vi.fn(async () => true)
    expect(await resolveDuplicateToggle('email', false, true, never)).toBe(true)
    expect(await resolveDuplicateToggle('email', true, true, never)).toBe(true)          // no change, no dialog
    expect(never).not.toHaveBeenCalled()
  })
  it('a dialog that fails or resolves oddly keeps protection ON', async () => {
    expect(await resolveDuplicateToggle('email', true, false, async () => { throw new Error('closed') })).toBe(true)
    expect(await resolveDuplicateToggle('email', true, false, async () => undefined as unknown as boolean)).toBe(true)
  })
  it('the two settings are independent', async () => {
    const state = { ...DEFAULT_DUPLICATE_PROTECTION }
    state.email = await resolveDuplicateToggle('email', state.email, false, async () => true)
    expect(state).toEqual({ email: false, whatsapp: true })
    state.whatsapp = await resolveDuplicateToggle('whatsapp', state.whatsapp, false, async () => false)
    expect(state).toEqual({ email: false, whatsapp: true })
  })
  it('the dialog is protective: Enter never takes the risky action; it cannot send a campaign', () => {
    expect(disableProtectionRequest('email')).toMatchObject({ tone: 'danger', confirmOnEnter: false })
    const dialog = code('components/ui/ConfirmDialog.tsx')
    expect(dialog).toContain("e.key === 'Enter' && !multiline && pending.opts.confirmOnEnter !== false")
    expect(dialog).toContain("if (e.key === 'Escape')                 { e.preventDefault(); cancel() }")
    const src = code(COMPOSER)
    // The checkbox calls ONLY the toggle; the toggle sets ONLY its own flag — never handleSend.
    expect(src).toContain('onChange={e => void toggleDuplicateProtection(c, e.target.checked)}')
    const toggle = src.slice(src.indexOf('const toggleDuplicateProtection'), src.indexOf('}, [dedupeEmails, dedupePhones, confirm])'))
    expect(toggle).not.toMatch(/handleSend|fetch\(|setShowConfirm/)
    expect(toggle).toContain('duplicateToggleBusy.current')                                // one dialog at a time
    // No dialog on load: confirm is only ever called from the toggle.
    expect(src.match(/\bconfirm\(/g) ?? []).toHaveLength(0)
    expect(src.match(/resolveDuplicateToggle\(/g)).toHaveLength(1)
  })
})

describe('normalization — the project’s own rules, shared by preview and dispatch', () => {
  it('email: case and surrounding whitespace are one address; first registration wins', () => {
    const rows = [reg('Asha@Example.com', ''), reg(' asha@example.com ', ''), reg('ravi@example.com', ''), reg('', '')]
    expect(dedupeRecipientsByEmail(rows).map(r => r.data.attendee.email)).toEqual(['Asha@Example.com', 'ravi@example.com', ''])
    // A blank address is never an identity, so it is never merged — and the preview counts it
    // exactly as dispatch sends it: preview = dispatch.
    expect(countUniqueRecipients(rows.map(r => r.data.attendee.email))).toBe(dedupeRecipientsByEmail(rows).length)
  })
  it('WhatsApp: the canonical number (+91 98765 43210 = 09876543210 = 9876543210) is one recipient', () => {
    const rows = [reg('', '+91 98765 43210'), reg('', '09876543210'), reg('', '9876543210'), reg('', '+91 99999 00000')]
    expect(dedupeRecipientsByPhone(rows)).toHaveLength(2)
    expect(countUniquePhones(rows.map(r => r.data.attendee.phone))).toBe(2)
  })
  it('protection OFF keeps every eligible registration (no merge, no mutation)', () => {
    const rows = [reg('a@x.io', '9876543210'), reg('A@X.IO', '9876543210')]
    const snapshot = JSON.stringify(rows)
    dedupeRecipientsByEmail(rows); dedupeRecipientsByPhone(rows)
    expect(JSON.stringify(rows)).toBe(snapshot)                                          // registrations untouched
    expect(rows).toHaveLength(2)
  })
})

describe('server consistency (unchanged, pinned)', () => {
  it('preview, creation and dispatch all read the same flag; absent ⇒ no dedupe (stored campaigns keep theirs)', () => {
    const count = code('app/api/organizer/broadcasts/count/route.ts')
    expect(count).toContain('const dedupeEmails = dedupeRaw === true')
    expect(count).toContain('const dedupePhones = dedupePhonesRaw === true')
    expect(count).toContain('dedupePhones ? countUniquePhones(phones) : phones.length')
    expect(count).toContain('dedupeEmails ? countUniqueRecipients(emails) : emails.length')
    const create = code('app/api/organizer/broadcasts/route.ts')
    expect(create).toContain('dedupePhones ? dedupeRecipientsByPhone(consent.eligible) : consent.eligible')
    expect(create).toContain('dedupeEmails ? dedupeRecipientsByEmail(suppressed) : suppressed')
    expect(create).toContain("...(dedupeEmails && chosenChannel !== 'whatsapp' ? { dedupeEmails: true } : {})")
    expect(create).toContain("...(dedupePhones && chosenChannel === 'whatsapp' ? { dedupePhones: true } : {})")
    const send = code('lib/broadcasts/send.ts')
    expect(send).toContain('c.dedupeEmails')                                              // re-read from the STORED campaign
    expect(send).toContain('c.dedupePhones')
    // The composer never loads a stored campaign into the form, so it cannot rewrite one.
    expect(code(COMPOSER)).not.toMatch(/setDedupe(Emails|Phones)\((c|campaign|data|stored)\./)
  })
  it('eligibility order is unchanged: refunds → consent / opt-outs → dedupe; the count is re-fetched when a flag changes', () => {
    const create = code('app/api/organizer/broadcasts/route.ts')
    expect(create.indexOf('filterWhatsAppBroadcastRecipients(withPhone)')).toBeLessThan(create.indexOf('dedupeRecipientsByPhone(consent.eligible)'))
    expect(create.indexOf('getOrganiserSuppressionSet(uid)')).toBeLessThan(create.indexOf('dedupeRecipientsByEmail(suppressed)'))
    const count = code('app/api/organizer/broadcasts/count/route.ts')
    expect(count.indexOf('filterWhatsAppBroadcastRecipients(withPhone)')).toBeLessThan(count.indexOf('countUniquePhones(phones)'))
    expect(code(COMPOSER)).toMatch(/\[eventSlug, audience, channel, dedupeEmails, dedupePhones,/)
  })
})
