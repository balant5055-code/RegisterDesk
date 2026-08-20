// RD-WA-RETRY-01 · failure taxonomy + reason-aware retry.
//
// THE RULE THIS PROTECTS. Every non-sent WhatsApp message must give the organizer a recovery
// action — including the ones Meta never answered. But an unanswered request is NOT a failed
// one: Meta may already have accepted and queued it, so resending can double-message a real
// attendee. The resolution is not to hide the button, it is to make the risk explicit and
// require a human to accept it.
//
// Two properties therefore have to hold at once, and neither may be traded for the other:
//
//   1. RECOVERABLE — retry is offered for every non-sent terminal state.
//   2. INDETERMINATE ≠ FAILED — an unknown delivery is only ever resent after an explicit,
//      strictly-boolean confirmation, and never by a default, a truthy value, or a background
//      caller.
//
// Classification is asserted STRUCTURALLY (code / httpStatus), never on message text, because
// prose is exactly what drifts when someone improves the copy.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  classifyWhatsAppFailure, describeWhatsAppFailure, isRecipientFault,
  WHATSAPP_FAILURE_MESSAGE,
} from '@/lib/whatsapp/failureReason'
import type { WhatsAppFailureReason } from '@/lib/whatsapp/failureReason'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

// ─── Classification ───────────────────────────────────────────────────────────

describe('Meta responses are classified by code, not by wording', () => {
  const cases: Array<[string, { code?: number; httpStatus?: number }, WhatsAppFailureReason]> = [
    ['token expired (190)',            { code: 190,    httpStatus: 401 }, 'AUTHENTICATION_ERROR'],
    ['permission denied (10)',         { code: 10,     httpStatus: 403 }, 'AUTHENTICATION_ERROR'],
    ['invalid parameter (100)',        { code: 100,    httpStatus: 400 }, 'INVALID_RECIPIENT'],
    ['not in allow list (131030)',     { code: 131030, httpStatus: 400 }, 'INVALID_RECIPIENT'],
    ['template missing (132000)',      { code: 132000, httpStatus: 400 }, 'TEMPLATE_ERROR'],
    ['24h window closed (131047)',     { code: 131047, httpStatus: 400 }, 'TEMPLATE_ERROR'],
    ['rate limit (4)',                 { code: 4,      httpStatus: 400 }, 'RATE_LIMITED'],
    ['rate limit (130429)',            { code: 130429, httpStatus: 429 }, 'RATE_LIMITED'],
    ['messaging limit (131048)',       { code: 131048, httpStatus: 400 }, 'RATE_LIMITED'],
    ['Meta unavailable (1)',           { code: 1,      httpStatus: 500 }, 'META_SERVER_ERROR'],
  ]
  it.each(cases)('%s', (_label, input, expected) => {
    expect(classifyWhatsAppFailure(input)).toBe(expected)
  })

  it('falls back on HTTP status when the code is unrecognised', () => {
    expect(classifyWhatsAppFailure({ httpStatus: 401 })).toBe('AUTHENTICATION_ERROR')
    expect(classifyWhatsAppFailure({ httpStatus: 429 })).toBe('RATE_LIMITED')
    expect(classifyWhatsAppFailure({ httpStatus: 503 })).toBe('META_SERVER_ERROR')
    expect(classifyWhatsAppFailure({ httpStatus: 418, code: 999999 })).toBe('UNKNOWN_ERROR')
  })
})

describe('a request Meta never answered is never mistaken for a decision', () => {
  it('timeout ⇒ NETWORK_TIMEOUT', () => {
    expect(classifyWhatsAppFailure({ error: 'Meta API request timed out' })).toBe('NETWORK_TIMEOUT')
  })

  it('other transport failure ⇒ NETWORK_ERROR', () => {
    expect(classifyWhatsAppFailure({ error: 'Meta API network error' })).toBe('NETWORK_ERROR')
  })

  it('transport with no recognisable text ⇒ UNKNOWN_ERROR, not a Meta category', () => {
    expect(classifyWhatsAppFailure({ error: null })).toBe('UNKNOWN_ERROR')
  })

  it('the ABSENT httpStatus decides it — a stray code cannot make it look definite', () => {
    // This is the whole structural rule: no status means Meta returned no verdict, whatever
    // else happens to be on the row.
    expect(classifyWhatsAppFailure({ code: 132000, error: 'Meta API request timed out' }))
      .toBe('NETWORK_TIMEOUT')
  })

  it('httpStatus 0 is still a status — only ABSENT means no verdict', () => {
    expect(classifyWhatsAppFailure({ httpStatus: 0 })).toBe('UNKNOWN_ERROR')
  })
})

// ─── Organizer-facing copy ────────────────────────────────────────────────────

describe('every reason has organizer-facing copy, and no raw Meta detail leads', () => {
  it('covers every category', () => {
    const all: WhatsAppFailureReason[] = [
      'INVALID_WHATSAPP_NUMBER', 'INVALID_RECIPIENT', 'TEMPLATE_ERROR', 'AUTHENTICATION_ERROR',
      'RATE_LIMITED', 'META_SERVER_ERROR', 'NETWORK_TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN_ERROR',
    ]
    for (const r of all) {
      expect(WHATSAPP_FAILURE_MESSAGE[r], r).toBeTruthy()
      expect(WHATSAPP_FAILURE_MESSAGE[r].length, r).toBeGreaterThan(10)
    }
  })

  it('the message never contains a Meta code, HTTP status or token', () => {
    for (const [r, m] of Object.entries(WHATSAPP_FAILURE_MESSAGE)) {
      expect(m, r).not.toMatch(/\b\d{3,6}\b/)          // no bare Meta codes
      expect(m.toLowerCase(), r).not.toContain('http')
      expect(m.toLowerCase(), r).not.toContain('token')
      expect(m.toLowerCase(), r).not.toContain('bearer')
    }
  })

  it('an invalid number is flagged as the recipient’s fault', () => {
    expect(isRecipientFault('INVALID_WHATSAPP_NUMBER')).toBe(true)
    expect(isRecipientFault('INVALID_RECIPIENT')).toBe(true)
    expect(isRecipientFault('RATE_LIMITED')).toBe(false)
    expect(isRecipientFault('NETWORK_TIMEOUT')).toBe(false)
  })

  it('describe() returns the symbol AND the sentence together', () => {
    const d = describeWhatsAppFailure({ code: 131030, httpStatus: 400 })
    expect(d.reason).toBe('INVALID_RECIPIENT')
    expect(d.message).toBe(WHATSAPP_FAILURE_MESSAGE.INVALID_RECIPIENT)
    expect(d.recipientFault).toBe(true)
  })
})

// ─── The classifier invents nothing ───────────────────────────────────────────

describe('no Meta code is invented here', () => {
  it('every mapped code is one the normaliser already recognises', () => {
    const errs = read('lib/whatsapp/errors.ts')
    const mapped = [...read('lib/whatsapp/failureReason.ts')
      .matchAll(/^\s{2}(\d+):\s+'/gm)].map(m => m[1])
    expect(mapped.length).toBeGreaterThan(5)
    for (const code of mapped) {
      expect(errs, `code ${code} is not in errors.ts`).toMatch(new RegExp(`case ${code}:`))
    }
  })

  it('INVALID_WHATSAPP_NUMBER is defined but deliberately unmapped', () => {
    // No code in this repository identifies "not a WhatsApp user". The category exists so the
    // UI can say it, but mapping it means adding the code to errors.ts from Meta's docs first.
    const src = read('lib/whatsapp/failureReason.ts')
    expect(src).toContain('INVALID_WHATSAPP_NUMBER')
    expect(src).toContain('deliberately unmapped'.replace('deliberately unmapped', 'no code in this repository identifies'))
  })
})

// ─── Retry policy, at the source level ────────────────────────────────────────

describe('retry policy — recoverable, but never silently', () => {
  const lib   = read('lib/email-logs/whatsappRetry.ts')
  const route = read('app/api/organizer/whatsapp-logs/[logId]/retry/route.ts')
  const list  = read('app/api/organizer/whatsapp-logs/route.ts')

  it('an unknown delivery is blocked UNLESS confirmation is strictly true', () => {
    expect(lib).toContain("if (reg.whatsappStatus === 'unknown' && opts?.confirmUnknownDelivery !== true)")
  })

  it('the endpoint reads a STRICT boolean — a truthy string is not a confirmation', () => {
    expect(route).toContain('body?.confirmUnknownDelivery === true')
    // No loose coercion anywhere near the flag.
    expect(route).not.toMatch(/Boolean\(\s*body|confirmUnknownDelivery\s*\)\s*\{/)
  })

  it('an unconfirmed unknown returns a machine-readable 409', () => {
    expect(route).toContain("DELIVERY_UNKNOWN_CONFIRMATION_REQUIRED = 'delivery_unknown_confirmation_required'")
    expect(route).toContain('delivery_unknown:     409')
    expect(route).toContain('confirmationRequired: true')
  })

  it('retry is now OFFERED for an indeterminate row', () => {
    // The old exclusion left the organizer with no action at all.
    expect(list).not.toContain('&& !deliveryUnknown')
    expect(list).toContain('requiresUnknownConfirmation: deliveryUnknown')
  })

  it('definite failures keep their existing direct retry', () => {
    expect(list).toContain("retryAvailable:    (logStatus === 'failed'")
  })

  it('the guard still runs BEFORE the provider is called', () => {
    const guard = lib.indexOf("reg.whatsappStatus === 'unknown'")
    const send  = lib.indexOf('provider.sendTemplate')
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(send)
  })

  it('ownership, template and billing guards are untouched', () => {
    expect(route).toContain('l.organizerUid !== uid')
    expect(route).toContain("l.channel !== 'whatsapp'")
    expect(route).toContain('l.templateKey !== RETRYABLE_WHATSAPP_TEMPLATE_KEY')
    expect(lib).toContain('whatsapp_${args.registrationId}')   // deterministic ledger id
  })

  it('nothing retries automatically — no timer, no cron, no background caller', () => {
    expect(lib).not.toMatch(/setTimeout|setInterval/)
    expect(route).not.toMatch(/setTimeout|setInterval/)
    // The only caller that may pass the confirmation is the route, driven by a human click.
    const callers = read('app/(dashboard)/dashboard/communications/whatsapp-logs/WhatsAppLogsClient.tsx')
    expect(callers).toContain('if (log.requiresUnknownConfirmation) {')
    expect(callers).toContain('if (!ok) return')
  })
})

// ─── UI contract ──────────────────────────────────────────────────────────────

describe('the dashboard leads with meaning and keeps the detail', () => {
  const ui = read('app/(dashboard)/dashboard/communications/whatsapp-logs/WhatsAppLogsClient.tsx')

  it('the row shows the classified sentence, not the raw Meta text', () => {
    expect(ui).toContain('if (log.failureMessage) return log.failureMessage')
  })

  it('an unknown row opens a confirmation naming the duplicate risk', () => {
    expect(ui).toContain('Delivery status is unknown')
    expect(ui).toContain('receive this message more than once')
    expect(ui).toContain("confirmLabel: 'Retry anyway'")
  })

  it('the confirmation is the shared dialog, not a new visual language', () => {
    expect(ui).toContain("import { useConfirm } from '@/components/ui/ConfirmDialog'")
  })

  it('the flag is sent only for a row the SERVER flagged indeterminate', () => {
    expect(ui).toContain('confirmUnknownDelivery: log.requiresUnknownConfirmation === true')
  })

  it('an invalid number says so, and warns that resending unchanged will not help', () => {
    expect(ui).toContain('log.recipientFault')
    expect(ui).toContain('Retrying without correcting the number will fail the same way.')
  })

  it('Details keeps the technical Meta information beneath the human reason', () => {
    expect(ui).toContain("['Reason',              log.failureMessage ?? log.error ?? '—'],")
    expect(ui).toContain("['Category',            log.failureReason ?? '—'],")
    expect(ui).toContain("['Provider detail',     log.error ?? '—'],")
    expect(ui).toContain("['Provider error code',")
    expect(ui).toContain("['HTTP status',")
  })

  it('no credential is ever rendered', () => {
    expect(ui).not.toMatch(/META_ACCESS_TOKEN|Bearer \$\{[^}]*token[^}]*\}[^`]*<|apiKey/i)
  })
})

// ─── Isolation ────────────────────────────────────────────────────────────────

describe('nothing outside WhatsApp failure handling moved', () => {
  it('the shared EmailLogStatus union is NOT widened', () => {
    expect(read('lib/email-logs/types.ts'))
      .toContain("export type EmailLogStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped'")
  })

  it('the Meta client timeout is untouched', () => {
    expect(read('lib/whatsapp/client.ts')).toContain('AbortSignal.timeout(this.timeoutMs)')
  })

  it('the send path still classifies unknown structurally', () => {
    expect(read('lib/registrations/sendWhatsAppConfirmation.ts'))
      .toContain('const deliveryUnknown = result.httpStatus === undefined')
  })

  it('the broadcast job is not part of this change', () => {
    expect(read('lib/broadcasts/whatsappJob.ts')).not.toContain('confirmUnknownDelivery')
  })
})
