// RD-LAUNCH-03 — one canonical ownership statement.
//
// The point of these is drift: the moment ownership wording is retyped in a footer, a
// legal page or an email template, the phrasings diverge and the entity becomes
// ambiguous. Everything is derived from BrandingConfig.legalName, and these lock that.

import { describe, it, expect } from 'vitest'
import {
  PLATFORM_BRAND, LEGAL_ENTITY, OWNERSHIP_SENTENCE, OWNERSHIP_SHORT, BUSINESS_IDENTITY,
} from '@/lib/marketing/ownership'
import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

describe('ownership constants', () => {
  it('keeps RegisterDesk as the public product brand', () => {
    expect(PLATFORM_BRAND).toBe('RegisterDesk')
  })

  it('names the registered operating entity', () => {
    expect(LEGAL_ENTITY).toBe('VARDHINI PRIME ENTERPRISES')
  })

  it('derives from BrandingConfig, so there is one source of truth', () => {
    expect(LEGAL_ENTITY).toBe(BUSINESS_CONFIG_DEFAULTS.branding.legalName)
    expect(PLATFORM_BRAND).toBe(BUSINESS_CONFIG_DEFAULTS.branding.platformName)
  })

  it('states ownership without replacing the brand', () => {
    expect(OWNERSHIP_SENTENCE).toContain('RegisterDesk')
    expect(OWNERSHIP_SENTENCE).toContain('VARDHINI PRIME ENTERPRISES')
    expect(OWNERSHIP_SENTENCE).toMatch(/owned and operated by/i)
  })

  it('offers a compact form for tight spaces', () => {
    expect(OWNERSHIP_SHORT).toContain('VARDHINI PRIME ENTERPRISES')
    expect(OWNERSHIP_SHORT.length).toBeLessThan(OWNERSHIP_SENTENCE.length)
  })
})

describe('business identity — published facts only', () => {
  it('separates the product brand from the legal entity', () => {
    const byLabel = Object.fromEntries(BUSINESS_IDENTITY.map(i => [i.label, i.value]))
    expect(byLabel['Product']).toBe('RegisterDesk')
    expect(byLabel['Legal entity']).toBe('VARDHINI PRIME ENTERPRISES')
  })

  it('never publishes a registered address, CIN or GSTIN — none exist to publish', () => {
    const labels = BUSINESS_IDENTITY.map(i => i.label.toLowerCase()).join(' ')
    expect(labels).not.toMatch(/address|cin|gstin|tax|registration number/)
  })

  it('exposes no empty values', () => {
    for (const item of BUSINESS_IDENTITY) {
      expect(item.value.trim().length).toBeGreaterThan(0)
    }
  })
})
