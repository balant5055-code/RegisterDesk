// RD-EVENT-COMMERCE-04B — the centrally-controlled-pricing contract (pure).
// Route / token / Firestore behaviour: tests/emulator/eventCommerce04b.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CENTRAL_PRICING_FIELDS, changedCentralPricingFields, BUSINESS_CONFIG_DEFAULTS,
} from '@/lib/config/businessConfig'

const comm = BUSINESS_CONFIG_DEFAULTS.communication
const media = BUSINESS_CONFIG_DEFAULTS.mediaStudio

describe('which fields are centrally controlled pricing', () => {
  it('covers exactly the confirmed categories: licence/capacity, communication (incl. certificates), media — and (RD-PHASE4-S2) fees, the payment provider, settlement fee/tax', () => {
    // RD-WALLET-CFG-01 — plus the wallet's FINANCIAL controls (negative balance, freeze, refunds, limits).
    expect(Object.keys(CENTRAL_PRICING_FIELDS).sort()).toEqual(['communication', 'fees', 'licensing', 'mediaStudio', 'payments', 'settlements', 'wallet'])
    expect(CENTRAL_PRICING_FIELDS.licensing).toBe('*')
    expect(CENTRAL_PRICING_FIELDS.communication).toEqual(expect.arrayContaining([
      'email.pricePaise', 'whatsapp.pricePaise', 'sms.pricePaise', 'certificates.pricePaise',
    ]))
    expect(CENTRAL_PRICING_FIELDS.mediaStudio).toEqual(expect.arrayContaining(['creditUnitPricePaise', 'creditsPerPhoto']))
  })

  it('never includes an organizer’s own ticket / registration fees', () => {
    const all = Object.values(CENTRAL_PRICING_FIELDS).flatMap(v => (v === '*' ? [] : [...(v ?? [])]))
    expect(all.filter(f => /pass|ticket|registrationFee|earlyBird/i.test(f))).toEqual([])
    // Organizer ticket prices live on the event draft, which no business-config section holds.
    // RD-PHASE4-S2 — the PLATFORM fee (fees section) is now central pricing, Super Admin only.
    expect(changedCentralPricingFields('fees', BUSINESS_CONFIG_DEFAULTS.fees, { platformFeePercent: 9 })).toEqual(['fees'])
  })
})

describe('changedCentralPricingFields', () => {
  it('a changed rate is reported; an unchanged re-send is not', () => {
    expect(changedCentralPricingFields('communication', comm, { whatsapp: { pricePaise: comm.whatsapp.pricePaise + 1 } })).toEqual(['whatsapp.pricePaise'])
    expect(changedCentralPricingFields('communication', comm, { whatsapp: { pricePaise: comm.whatsapp.pricePaise } })).toEqual([])
    expect(changedCentralPricingFields('communication', comm, { certificates: { freeAllowance: comm.certificates.freeAllowance + 1 } })).toEqual(['certificates.freeAllowance'])
  })
  it('operational settings in the same section are not pricing', () => {
    expect(changedCentralPricingFields('communication', comm, { whatsapp: { dailyLimit: 5, defaultLanguage: 'hi' }, email: { fromName: 'X' } })).toEqual([])
    expect(changedCentralPricingFields('mediaStudio', media, { maxPhotosPerEvent: 10 })).toEqual([])
  })
  it('media pricing and the refund SERVICE CHARGE are pricing', () => {
    expect(changedCentralPricingFields('mediaStudio', media, { creditUnitPricePaise: media.creditUnitPricePaise + 1, refundServiceChargePercent: 50 }))
      .toEqual(['creditUnitPricePaise', 'refundServiceChargePercent'])
  })
  it('any change to the licensing section is pricing', () => {
    expect(changedCentralPricingFields('licensing', BUSINESS_CONFIG_DEFAULTS.licensing, { purchasesEnabled: !BUSINESS_CONFIG_DEFAULTS.licensing.purchasesEnabled })).toEqual(['licensing'])
    expect(changedCentralPricingFields('licensing', BUSINESS_CONFIG_DEFAULTS.licensing, {})).toEqual([])
  })
})

describe('the admin editors lock the SAME fields the server enforces', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  it('communication and media editors derive their locks from CENTRAL_PRICING_FIELDS', () => {
    expect(read('app/(admin)/admin/business-configuration/CommunicationEditor.tsx')).toContain('CENTRAL_PRICING_FIELDS.communication')
    expect(read('app/(admin)/admin/business-configuration/MediaStudioEditor.tsx')).toContain('CENTRAL_PRICING_FIELDS.mediaStudio')
    expect(read('app/(admin)/admin/business-configuration/PageClient.tsx').match(/canEditPricing=\{data\.permissions\?\.canEditPricing === true\}/g)).toHaveLength(6)   // RD-PHASE4-S2 — + fees, payment gateway, section editor
  })
})
