// RD-FINANCE-CLOSURE-02 — masking + change detection for the payout audit trail.
//
// The whole security property of this feature is "the history can never be used to send
// money anywhere". That reduces to the pure functions below, so they are tested directly
// and exhaustively rather than only through the route.

import { describe, it, expect } from 'vitest'
import {
  maskAccountNumber, maskIfsc, maskPan, maskUpi, maskDestination,
} from '@/lib/payout/mask'
import {
  AUDITED_FIELDS, buildHistoryRecord, diffSnapshots, type PayoutSnapshot,
} from '@/lib/payout/historyRecord'

const BANK: PayoutSnapshot = {
  accountHolderName: 'Asha Menon',
  payoutMethod:      'bank',
  bankName:          'HDFC Bank',
  accountNumber:     '123456789012',
  ifscCode:          'HDFC0001234',
  upiId:             null,
  panNumber:         'ABCDE1234F',
  gstNumber:         null,
}

const UPI: PayoutSnapshot = {
  accountHolderName: 'Asha Menon',
  payoutMethod:      'upi',
  bankName:          null,
  accountNumber:     null,
  ifscCode:          null,
  upiId:             'asha.menon@okhdfc',
  panNumber:         'ABCDE1234F',
  gstNumber:         null,
}

describe('masking — never reveals enough to receive a payout', () => {
  it('keeps only the last 4 of an account number', () => {
    expect(maskAccountNumber('123456789012')).toBe('••••9012')
  })

  it('masks a SHORT account number entirely — last-4 of 4 is the whole value', () => {
    expect(maskAccountNumber('9012')).toBe('••••')
    expect(maskAccountNumber('12')).toBe('••••')
  })

  it('keeps only the last 4 of a PAN', () => {
    expect(maskPan('ABCDE1234F')).toBe('••••234F')
  })

  it('keeps only the BANK code of an IFSC, dropping the branch', () => {
    expect(maskIfsc('HDFC0001234')).toBe('HDFC••••')
    expect(maskIfsc('icic0004321')).toBe('ICIC••••')
  })

  it('keeps the UPI handle but masks the person', () => {
    expect(maskUpi('asha.menon@okhdfc')).toBe('as••••@okhdfc')
  })

  it('masks a short UPI local part entirely', () => {
    expect(maskUpi('ab@okaxis')).toBe('••••@okaxis')
  })

  it('reveals nothing for a UPI with no handle', () => {
    expect(maskUpi('notaupi')).toBe('••••')
  })

  it('returns null for empty input rather than a bullet string', () => {
    for (const f of [maskAccountNumber, maskPan, maskIfsc, maskUpi]) {
      expect(f('')).toBeNull()
      expect(f(null)).toBeNull()
      expect(f(undefined)).toBeNull()
    }
  })

  it('builds a bank destination label an auditor can read', () => {
    const d = maskDestination(BANK)
    expect(d.label).toBe('HDFC Bank ••••9012')
    expect(d.accountMasked).toBe('••••9012')
    expect(d.ifscBank).toBe('HDFC••••')
    expect(d.upiMasked).toBeNull()
  })

  it('builds a UPI destination label', () => {
    const d = maskDestination(UPI)
    expect(d.label).toBe('as••••@okhdfc')
    expect(d.accountMasked).toBeNull()
  })
})

describe('the record NEVER contains plaintext payout data', () => {
  const record = buildHistoryRecord({
    organizerUid: 'org1', actorUid: 'actor1',
    before: BANK, after: { ...BANK, accountNumber: '999988887777', ifscCode: 'ICIC0004321', bankName: 'ICICI Bank' },
    wasVerified: true, requestIp: '1.2.3.4', userAgent: 'jest',
  })
  const serialised = JSON.stringify(record)

  it.each([
    ['old account number', '123456789012'],
    ['new account number', '999988887777'],
    ['old IFSC',           'HDFC0001234'],
    ['new IFSC',           'ICIC0004321'],
    ['PAN',                'ABCDE1234F'],
  ])('does not contain the %s', (_label, secret) => {
    expect(serialised).not.toContain(secret)
  })

  it('does not contain a plaintext UPI id', () => {
    const upi = buildHistoryRecord({
      organizerUid: 'org1', actorUid: 'a', before: null, after: UPI,
      wasVerified: false, requestIp: null, userAgent: null,
    })
    expect(JSON.stringify(upi)).not.toContain('asha.menon@okhdfc')
  })

  it('keeps the account HOLDER name — a name is not a credential and identifies the change', () => {
    expect(record.nextHolderName).toBe('Asha Menon')
  })
})

describe('change detection', () => {
  it('reports every audited field on a first save', () => {
    expect(diffSnapshots(null, BANK)).toEqual([...AUDITED_FIELDS])
  })

  it('reports only what actually changed', () => {
    const after = { ...BANK, accountNumber: '999988887777', bankName: 'ICICI Bank' }
    expect(diffSnapshots(BANK, after).sort()).toEqual(['accountNumber', 'bankName'])
  })

  it('reports NOTHING when the same details are re-saved', () => {
    expect(diffSnapshots(BANK, { ...BANK })).toEqual([])
  })

  it('treats whitespace-only differences as no change', () => {
    expect(diffSnapshots(BANK, { ...BANK, accountHolderName: '  Asha Menon  ' })).toEqual([])
  })

  it('detects a switch from bank to UPI', () => {
    const fields = diffSnapshots(BANK, UPI)
    expect(fields).toContain('payoutMethod')
    expect(fields).toContain('upiId')
    expect(fields).toContain('accountNumber')
  })
})

describe('record shape', () => {
  it('marks a first save as created with no previous destination', () => {
    const r = buildHistoryRecord({
      organizerUid: 'org1', actorUid: 'actor1', before: null, after: BANK,
      wasVerified: false, requestIp: null, userAgent: null,
    })
    expect(r.action).toBe('created')
    expect(r.previous).toBeNull()
    expect(r.verificationReset).toBe(false)
  })

  it('marks a later save as updated and records the verification reset', () => {
    const r = buildHistoryRecord({
      organizerUid: 'org1', actorUid: 'actor2', before: BANK, after: UPI,
      wasVerified: true, requestIp: null, userAgent: null,
    })
    expect(r.action).toBe('updated')
    expect(r.previous?.label).toBe('HDFC Bank ••••9012')
    expect(r.next.label).toBe('as••••@okhdfc')
    expect(r.wasVerified).toBe(true)
    expect(r.verificationReset).toBe(true)
  })

  it('records the ACTOR, which may differ from the workspace owner', () => {
    const r = buildHistoryRecord({
      organizerUid: 'ownerUid', actorUid: 'teamMemberUid', before: BANK, after: BANK,
      wasVerified: false, requestIp: null, userAgent: null,
    })
    expect(r.organizerUid).toBe('ownerUid')
    expect(r.actorUid).toBe('teamMemberUid')
  })
})
