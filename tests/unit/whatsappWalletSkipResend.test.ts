// RD-WA-LOGS-02 · re-sending a WhatsApp confirmation that was SKIPPED for an empty wallet.
//
// THE INCIDENT THIS COMES FROM. During a live event the organizer's wallet reached zero and
// 40 registration confirmations were skipped at the balance check — before Meta was ever
// called, so those attendees simply never received the message. Only `failed` rows were
// re-sendable, so the one recovery path the operator needed did not exist.
//
// THE DISTINCTION EVERYTHING HERE TURNS ON:
//
//   HISTORICAL reason   — why this row was skipped. A fact about the past. It decides
//                         ELIGIBILITY, and it never changes.
//   CURRENT fee/balance — whether a NEW attempt may proceed. Decided later, at send time.
//
// Collapsing the two is the bug this file prevents in BOTH directions: dropping the fee to
// zero must not erase why old rows were skipped, and raising it must not strip the button
// off rows that were already skipped.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  WHATSAPP_WALLET_SKIP_REASON, isWalletSkippedWhatsAppLog,
} from '@/lib/email-logs/types'

type Doc = Record<string, unknown>
const UID = 'organizer-1'
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

// ─── The predicate, in isolation ──────────────────────────────────────────────

describe('isWalletSkippedWhatsAppLog — historical reason only', () => {
  it('matches a wallet skip', () => {
    expect(isWalletSkippedWhatsAppLog({ status: 'skipped', error: WHATSAPP_WALLET_SKIP_REASON })).toBe(true)
  })

  it('tolerates case and whitespace from older builds', () => {
    for (const e of ['insufficient wallet balance', '  Insufficient Wallet Balance  ', 'INSUFFICIENT WALLET BALANCE']) {
      expect(isWalletSkippedWhatsAppLog({ status: 'skipped', error: e }), e).toBe(true)
    }
  })

  it('does NOT match a skip for any other reason', () => {
    const others: Array<string | null | undefined> = [
      'No attendee phone number',
      'Invalid phone number: too short',
      'Organizer has no account mobile on file (Settings → Account → Account Mobile Number)',
      '', null, undefined,
    ]
    for (const e of others) {
      expect(isWalletSkippedWhatsAppLog({ status: 'skipped', error: e ?? null }), String(e)).toBe(false)
    }
  })

  it('does NOT match a non-skipped row carrying the same text', () => {
    for (const s of ['sent', 'delivered', 'queued', 'failed']) {
      expect(isWalletSkippedWhatsAppLog({ status: s, error: WHATSAPP_WALLET_SKIP_REASON }), s).toBe(false)
    }
  })

  it('takes NO fee or balance input — eligibility cannot depend on today price', () => {
    // A signature that accepted a fee would be the mutation this whole file guards against.
    expect(isWalletSkippedWhatsAppLog.length).toBe(1)
  })
})

// ─── The literal is still what the live sender writes ─────────────────────────

describe('the constant tracks its only writer', () => {
  it('sendWhatsAppConfirmation still stores exactly this string', () => {
    // emailLogs has no reason CODE, so this string IS the schema. If the sender's literal is
    // ever reworded, eligibility silently stops matching — this is what catches that.
    const src = read('lib/registrations/sendWhatsAppConfirmation.ts')
    expect(src).toContain(`'skipped', { error: '${WHATSAPP_WALLET_SKIP_REASON}' }`)
  })

  it('the live send path was NOT modified by this fix', () => {
    const src = read('lib/registrations/sendWhatsAppConfirmation.ts')
    expect(src).not.toContain('isWalletSkippedWhatsAppLog')
  })
})

// ─── List route: which rows offer the button ──────────────────────────────────

let rows: Doc[] = []
let authOk = true

vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => authOk
    ? { ok: true, workspaceUid: UID }
    : { ok: false, error: 'Forbidden', status: 403 },
}))
vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: () => {
      const q = {
        where: () => q, orderBy: () => q, limit: () => q,
        get: async () => ({ docs: rows.map(r => ({ id: r.id as string, data: () => r })) }),
      }
      return q
    },
  },
}))

const { GET } = await import('@/app/api/organizer/whatsapp-logs/route')

const row = (over: Doc = {}): Doc => ({
  id: 'log-1', organizerUid: UID, channel: 'whatsapp',
  eventId: 'evt-1', eventSlug: 'evt-1', eventName: 'VANATHUKKUL NOYYAL MARATHON',
  templateKey: 'registration_confirmation',
  recipientPhone: '+919080452223', recipientName: 'Attendee',
  status: 'skipped', provider: 'meta', registrationId: 'reg-1', costPaise: 0,
  error: WHATSAPP_WALLET_SKIP_REASON,
  createdAt: { toDate: () => new Date('2026-08-19T09:54:36Z') },
  updatedAt: { toDate: () => new Date('2026-08-19T09:54:36Z') },
  ...over,
})

interface ListedLog { id: string; retryAvailable: boolean; error: string | null; status: string }

async function listOnce(over: Doc = {}): Promise<ListedLog> {
  rows = [row(over)]
  const res = await GET(new NextRequest('http://x/api/organizer/whatsapp-logs', {
    headers: { Authorization: 'Bearer t' },
  }))
  const body = await res.json() as { logs: ListedLog[] }
  return body.logs[0]
}

beforeEach(() => { rows = []; authOk = true })

describe('resend eligibility in the list', () => {
  it('1 · skipped + insufficient wallet → Resend offered', async () => {
    expect((await listOnce()).retryAvailable).toBe(true)
  })

  it('2 · offered no matter the current fee — this route never reads one', async () => {
    const src = read('app/api/organizer/whatsapp-logs/route.ts')
    expect(src).not.toMatch(/getWalletBalance|pricePaise|getCommunicationConfig|getWalletConfig/)
    expect((await listOnce()).retryAvailable).toBe(true)
  })

  it('3 · skipped for another reason → hidden', async () => {
    expect((await listOnce({ error: 'No attendee phone number' })).retryAvailable).toBe(false)
    expect((await listOnce({ error: 'Invalid phone number: too short' })).retryAvailable).toBe(false)
  })

  it('3b · a skipped ORGANIZER notification is hidden — wrong template, no registration', async () => {
    const log = await listOnce({
      templateKey: 'EVENT_APPROVED', registrationId: '',
      error: 'Organizer has no account mobile on file (Settings → Account → Account Mobile Number)',
    })
    expect(log.retryAvailable).toBe(false)
  })

  it('4 · sent → hidden', async () => {
    expect((await listOnce({ status: 'sent', error: undefined })).retryAvailable).toBe(false)
  })

  it('5 · delivered → hidden', async () => {
    expect((await listOnce({ status: 'delivered', error: undefined })).retryAvailable).toBe(false)
  })

  it('6 · failed → STILL offered (pre-existing behaviour, deliberately unchanged)', async () => {
    expect((await listOnce({ status: 'failed', error: 'Template not approved' })).retryAvailable).toBe(true)
  })

  it('queued (a claim already held) → hidden', async () => {
    expect((await listOnce({ status: 'queued' })).retryAvailable).toBe(false)
  })

  it('14 · a wallet skip with no registration to re-send for → hidden', async () => {
    expect((await listOnce({ registrationId: '' })).retryAvailable).toBe(false)
  })

  it('10 · a mixed page keeps every row independent', async () => {
    rows = [
      row({ id: 'a' }),
      row({ id: 'b', status: 'sent', error: undefined }),
      row({ id: 'c' }),
      row({ id: 'd', error: 'No attendee phone number' }),
    ]
    const res  = await GET(new NextRequest('http://x/api/organizer/whatsapp-logs', { headers: { Authorization: 'Bearer t' } }))
    const body = await res.json() as { logs: ListedLog[] }
    expect(body.logs.map(l => [l.id, l.retryAvailable])).toEqual([
      ['a', true], ['b', false], ['c', true], ['d', false],
    ])
  })

  it('15 · the stored reason is returned for the table to render', async () => {
    expect((await listOnce()).error).toBe(WHATSAPP_WALLET_SKIP_REASON)
  })

  it('12 · an unauthorized caller gets nothing', async () => {
    authOk = false
    rows = [row()]
    expect((await GET(new NextRequest('http://x/api/organizer/whatsapp-logs'))).status).toBe(403)
  })
})

// ─── The table cell + the button ──────────────────────────────────────────────

describe('the Failure Reason column no longer hides a skip reason', () => {
  const src = read('app/(dashboard)/dashboard/communications/whatsapp-logs/WhatsAppLogsClient.tsx')

  it('does not short-circuit every non-failed status to a dash', () => {
    expect(src).not.toContain("if (log.status !== 'failed') return '—'")
  })

  it('renders the stored reason whenever one exists', () => {
    // RD-WA-RETRY-01 moved the HEADLINE to the classified sentence, so the assertion follows
    // the same intent one layer up: the row still never swallows a reason it holds. The raw
    // stored text remains the fallback when no classification exists (skips are not Meta
    // failures, so they have no category — their  is the reason).
    expect(src).toContain("if (log.failureMessage) return log.failureMessage")
    expect(src).toContain("const reason = log.error ?? (log.status === 'failed' ? 'WhatsApp send failed' : null)")
    expect(src).toContain("return reason ?? '—'")
  })

  it('the action reads Resend, and Sending while in flight', () => {
    expect(src).toContain("{retrying ? 'Sending…' : 'Resend'}")
  })

  it('11 · the button is disabled while a send is in flight (double-click guard)', () => {
    expect(src).toContain('disabled={retrying}')
  })

  it('9 · the list is reloaded after an attempt, so a sent row loses its button', () => {
    expect(src).toContain('await load()')
  })
})

// ─── The server claim is the real boundary ────────────────────────────────────

describe('the retry route enforces the same rule independently of the UI', () => {
  const src = read('app/api/organizer/whatsapp-logs/[logId]/retry/route.ts')

  it('7/13 · accepts only failed OR a wallet skip, inside the claim transaction', () => {
    expect(src).toContain("if (l.status !== 'failed' && !isWalletSkippedWhatsAppLog(l)) {")
    // The guard must sit inside runTransaction — that is what makes it the concurrency control.
    const txn = src.slice(src.indexOf('runTransaction'), src.indexOf('if (!claim.ok)'))
    expect(txn).toContain('isWalletSkippedWhatsAppLog(l)')
    expect(txn).toContain("tx.update(logRef, { status: 'queued'")
  })

  it('12/13 · still verifies ownership, channel and template before anything else', () => {
    const txn = src.slice(src.indexOf('runTransaction'), src.indexOf('if (!claim.ok)'))
    expect(txn).toContain('l.organizerUid !== uid')
    expect(txn).toContain("l.channel !== 'whatsapp'")
    expect(txn).toContain('l.templateKey !== RETRYABLE_WHATSAPP_TEMPLATE_KEY')
    expect(txn).toContain('!l.registrationId')
  })

  it('16 · nothing is written until a real attempt is made', () => {
    // The ONLY pre-attempt write is the claim itself. No backfill of status/reason/sentAt to
    // make a button appear — eligibility is computed from what is already stored.
    const txn = src.slice(src.indexOf('runTransaction'), src.indexOf('if (!claim.ok)'))
    expect((txn.match(/tx\.update\(/g) ?? []).length).toBe(1)
    expect(txn).not.toMatch(/error:\s*FieldValue|status:\s*'skipped'/)
  })
})

// ─── Zero fee is a valid price ────────────────────────────────────────────────

describe('8 · a zero fee must not be mistaken for a broken one', () => {
  const src = read('lib/email-logs/whatsappRetry.ts')

  it('the balance gate only applies when there is something to charge', () => {
    expect(src).toContain("if (!walletCfg.allowNegativeBalance && costPaise > 0 && balance < costPaise) {")
  })

  it('no debit is attempted at zero cost', () => {
    expect(src).toContain('const debited = costPaise > 0 ? await deductWhatsAppCharge(args, costPaise) : 0')
  })

  it('no truthiness check treats a zero fee as unset', () => {
    expect(src).not.toMatch(/if\s*\(\s*!\s*costPaise\s*\)/)
    expect(src).not.toMatch(/costPaise\s*<=\s*0/)
  })
})
