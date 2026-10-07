// RD-FIN-12 · Source-level guards on the approved historical backfill.
//
// This script writes to production, so the properties that matter are structural: what it
// can reach, what it writes through, and the order in which it decides. All of that is
// readable from the source, and none of it should be provable only by running the migration
// against real money.
//
// The single most important assertion here is the first one. Creating a `registrationRefunds`
// document RECORDS a refund that already happened at the gateway; it must never become a
// script that CAUSES one. A Razorpay import is the only way that could change, so its absence
// is asserted rather than assumed.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SCRIPT = readFileSync('scripts/backfill-gateway-fees-and-refunds.ts', 'utf8')

describe('the backfill cannot reach Razorpay', () => {
  it('imports no Razorpay client, SDK or wrapper', () => {
    const imports = SCRIPT.match(/(?:import|require)\s*\(?[^\n]*/g) ?? []
    for (const line of imports) {
      expect(line.toLowerCase()).not.toContain('razorpay')
    }
  })

  it('constructs no HTTP client and names no gateway endpoint', () => {
    expect(SCRIPT).not.toMatch(/https?:\/\/api\.razorpay/i)
    expect(SCRIPT).not.toMatch(/\bfetch\s*\(/)
    expect(SCRIPT).not.toMatch(/\baxios\b/)
    expect(SCRIPT).not.toMatch(/\bnode:https?\b/)
  })

  it('reads no Razorpay credential', () => {
    expect(SCRIPT).not.toContain('RAZORPAY_KEY_ID')
    expect(SCRIPT).not.toContain('RAZORPAY_KEY_SECRET')
    expect(SCRIPT).not.toContain('RAZORPAY_WEBHOOK_SECRET')
  })

  it('never calls a refund-creating operation', () => {
    // Narrow on purpose: `approved.refunds.existing` is a reviewed expectation, not a call.
    // What must not exist is a gateway refund verb.
    expect(SCRIPT).not.toMatch(/refunds\s*\.\s*(create|edit|cancel|fetch)/i)
    expect(SCRIPT).not.toMatch(/payments\s*\.\s*refund/i)
    expect(SCRIPT).not.toMatch(/\bcreateRefund\b/)
    expect(SCRIPT).not.toMatch(/\bissueRefund\b/)
  })
})

describe('it writes only through the established primitives', () => {
  it('uses the shared write-once gateway-fee writer', () => {
    expect(SCRIPT).toContain('recordActualGatewayFee')
    expect(SCRIPT).toContain('extractActualGatewayFee')
  })

  it('uses the shared idempotent refund-record primitive', () => {
    expect(SCRIPT).toContain('ensureRegistrationRefundRecord')
  })

  it('performs no raw Firestore mutation of its own', () => {
    // Every write must go through a primitive that carries its own transaction and guards.
    // Targeted at document/collection references — a plain `Map.set` is not a Firestore write.
    expect(SCRIPT).not.toMatch(/\.doc\([^)]*\)\s*\.\s*(set|update|delete)\(/)
    expect(SCRIPT).not.toMatch(/collection\([^)]*\)\s*\.\s*(add|set)\(/)
    expect(SCRIPT).not.toMatch(/\b(adminDb|db)\s*\.\s*(batch|bulkWriter|runTransaction)\s*\(/)
    expect(SCRIPT).not.toMatch(/\bFieldValue\b/)
    expect(SCRIPT).not.toMatch(/\bWriteBatch\b/)
  })

  it('never creates a platformTransaction — it only annotates existing rows', () => {
    expect(SCRIPT).not.toMatch(/collection\('platformTransactions'\)\s*\.doc\([^)]*\)\s*\.set/)
  })
})

describe('protected state is never written', () => {
  const PROTECTED = [
    'registrationCounters', 'organizerRevenueWallets', 'registrations', 'paymentIntents',
  ]

  it('touches protected collections with reads only', () => {
    for (const col of PROTECTED) {
      const uses = SCRIPT.split(`collection('${col}')`).slice(1)
      for (const tail of uses) {
        const head = tail.slice(0, 160)
        expect(head).toMatch(/\.(get|doc|where|count)\b/)
        expect(head).not.toMatch(/\.(set|update|add|delete)\(/)
      }
    }
  })

  it('never names a protected money field as a write target', () => {
    // These may be READ for validation and fingerprinting. What must not appear is an
    // assignment of any of them into a write payload.
    for (const field of ['grossAmountPaise', 'netSettlementPaise', 'platformFeeBasePaise', 'platformFeeGstPaise', 'revenuePaise']) {
      expect(SCRIPT).not.toMatch(new RegExp(field + '\\s*:\\s*(?!\\s*\\{)[a-zA-Z0-9_.()\\[\\] ]+,\\s*//\\s*write'))
    }
    // The only two fields the migration writes.
    expect(SCRIPT).toContain('gatewayFeeActualPaise: w.feePaise')
    expect(SCRIPT).toContain('gatewayTaxPaise: w.taxPaise')
  })

  it('fingerprints protected state before and compares after', () => {
    expect(SCRIPT).toContain('const before = fingerprint()')
    expect(SCRIPT).toContain('registrationCounters unchanged')
    expect(SCRIPT).toContain('organizerRevenueWallets unchanged')
    expect(SCRIPT).toContain('registrations unchanged')
    expect(SCRIPT).toContain('ledger MONEY fields unchanged')
  })
})

describe('all-or-nothing ordering', () => {
  it('the abort gate precedes every write', () => {
    const gate  = SCRIPT.indexOf('ABORTED — ')
    const write = SCRIPT.indexOf('await recordActualGatewayFee')
    const refund = SCRIPT.indexOf('await ensureRegistrationRefundRecord')
    expect(gate).toBeGreaterThan(0)
    expect(write).toBeGreaterThan(gate)
    expect(refund).toBeGreaterThan(gate)
  })

  it('the dry-run exit precedes every write', () => {
    const dryExit = SCRIPT.indexOf('DRY RUN COMPLETE')
    expect(dryExit).toBeGreaterThan(0)
    expect(SCRIPT.indexOf('await recordActualGatewayFee')).toBeGreaterThan(dryExit)
    expect(SCRIPT.indexOf('await ensureRegistrationRefundRecord')).toBeGreaterThan(dryExit)
  })

  it('writing requires an explicit --commit; dry run is the default', () => {
    expect(SCRIPT).toContain("const COMMIT  = argv.includes('--commit')")
    expect(SCRIPT).toContain('if (!COMMIT) {')
  })

  it('a validation failure is recorded, never silently skipped', () => {
    expect(SCRIPT).toContain('const fail = (msg: string)')
    expect(SCRIPT).toContain('if (failures.length > 0)')
    expect(SCRIPT).toContain('NOTHING WAS WRITTEN')
  })
})

describe('scope and environment guards', () => {
  it('refuses to run against an emulator', () => {
    expect(SCRIPT).toContain('FIRESTORE_EMULATOR_HOST')
    expect(SCRIPT).toContain('Refusing to run')
  })

  it('requires both an event and an authoritative CSV', () => {
    expect(SCRIPT).toContain('--event <slug> and --csv <file> are both required')
  })

  it('refuses any event with no reviewed expectation set', () => {
    expect(SCRIPT).toContain('no approved expectation set for')
  })

  it('binds itself to the authoritative export by CONTENT, not filename', () => {
    // A different CSV with the right name must not pass. The totals are checked first.
    expect(SCRIPT).toContain("check('payment rows'")
    expect(SCRIPT).toContain("check('gateway fee'")
    expect(SCRIPT).toContain("check('refund amount'")
  })
})

describe('the two historical refund records', () => {
  it('are the only refunds the script knows about, by id', () => {
    const ids = SCRIPT.match(/rfnd_[A-Za-z0-9]+/g) ?? []
    expect([...new Set(ids)].sort()).toEqual(['rfnd_TOyDtn0C2i1lFM', 'rfnd_TSRjyzFifPuPWo'])
  })

  it('carry the reviewed amounts', () => {
    expect(SCRIPT).toContain("razorpayRefundId: 'rfnd_TOyDtn0C2i1lFM', gatewayPaymentId: 'pay_TOakYuP57oRqyn', amountPaise: 104")
    expect(SCRIPT).toContain("razorpayRefundId: 'rfnd_TSRjyzFifPuPWo', gatewayPaymentId: 'pay_TSQRcaUXeztDa8', amountPaise: 25920")
  })

  it('are recorded unlinked and already complete', () => {
    // registrationId null: neither payment produced a registration, and inventing one to
    // link would fabricate an attendee. status processed: the money already moved, so the
    // record must not be left claimable by a side-effect path.
    expect(SCRIPT).toContain('registrationId:   null')
    expect(SCRIPT).toContain("status:           'processed'")
  })

  it('refuse to overwrite an existing record that differs', () => {
    expect(SCRIPT).toContain('EXISTS WITH DIFFERENT DATA')
    expect(SCRIPT).toContain('refusing to overwrite')
  })

  it('say in the record itself that the refund was recorded, not issued', () => {
    expect(SCRIPT).toContain('Recorded, not issued.')
  })
})

describe('the 9 gateway-only payments stay out of the ledger', () => {
  it('no registration is created for them', () => {
    expect(SCRIPT).not.toMatch(/collection\('registrations'\)[\s\S]{0,80}\.(set|add)\(/)
  })

  it('they are reported as deliberately untouched', () => {
    expect(SCRIPT).toContain('CSV rows with no ledger row')
    expect(SCRIPT).toContain('Deliberately untouched')
  })
})
