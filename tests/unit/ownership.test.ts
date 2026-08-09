// RD-LAUNCH-03 — one canonical ownership statement.
//
// The point of these is drift: the moment ownership wording is retyped in a footer, a
// legal page or an email template, the phrasings diverge and the entity becomes
// ambiguous. Everything is derived from BrandingConfig.legalName, and these lock that.

import { describe, it, expect } from 'vitest'
import {
  PLATFORM_BRAND, LEGAL_ENTITY, OWNERSHIP_SENTENCE, OWNERSHIP_SHORT, BUSINESS_IDENTITY,
  PUBLIC_WEBSITE,
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
  it('lists exactly product, support and website, in that order', () => {
    expect(BUSINESS_IDENTITY.map(i => i.label)).toEqual(['Product', 'Support', 'Website'])
  })

  it('names the product brand and the support address', () => {
    const byLabel = Object.fromEntries(BUSINESS_IDENTITY.map(i => [i.label, i.value]))
    expect(byLabel['Product']).toBe('RegisterDesk')
    expect(byLabel['Support']).toBe('support@registerdesk.in')
    expect(byLabel['Website']).toBe('registerdesk.in')
  })

  // The legal entity is still DISCLOSED (about + legal pages + footer + email shell),
  // just not restated in this compact directory.
  it('does not restate the legal entity, which OWNERSHIP_SENTENCE already carries', () => {
    const labels = BUSINESS_IDENTITY.map(i => i.label.toLowerCase()).join(' ')
    expect(labels).not.toContain('legal entity')
    expect(BUSINESS_IDENTITY.some(i => i.value === LEGAL_ENTITY)).toBe(false)
    expect(OWNERSHIP_SENTENCE).toContain(LEGAL_ENTITY)   // still disclosed elsewhere
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

// The published website is a FACT, not the deployment origin: seo/robots/sitemap need
// whatever host is serving the request, identity needs one stable answer. These lock
// the separation so a dev machine can never publish "localhost:3000" as the website.
describe('published website is environment-independent', () => {
  it('is the canonical public domain, with no scheme or trailing slash', () => {
    expect(PUBLIC_WEBSITE).toBe('registerdesk.in')
    expect(PUBLIC_WEBSITE).not.toMatch(/^https?:\/\//)
    expect(PUBLIC_WEBSITE).not.toMatch(/\/$/)
  })

  it('never renders a localhost or preview host', () => {
    const website = BUSINESS_IDENTITY.find(i => i.label === 'Website')?.value ?? ''
    expect(website).toBe('registerdesk.in')
    expect(website).not.toMatch(/localhost|127\.0\.0\.1|vercel\.app|:\d+/)
  })
})
