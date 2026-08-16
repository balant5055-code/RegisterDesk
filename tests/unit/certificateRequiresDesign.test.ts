// RD-CERT-2E — a template with no design cannot produce a certificate.
//
// Removing the implicit default layout (certificateRenderNoImplicitFields.test.ts) fixes the
// wrong certificate, but on its own it converts one into a BLANK one: a background with no
// name, no id and no verification route. That is equally unusable and harder to notice, so
// issuance stops instead — early, with a message naming the next step.
//
// This file pins WHERE that guard sits, which matters as much as that it exists:
//
//   • AFTER the idempotent fast path — an already-issued certificate stays retrievable even
//     if its template is later stripped, so retries and re-downloads never start failing
//     retroactively for work that already succeeded.
//   • BEFORE the deterministic claim — a refusal must not burn a certificateId that then
//     needs releasing.
//
// The re-render paths are held to the same rule: a stripped template must not quietly replace
// a good artifact with a bare background.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Doc = Record<string, unknown>

let existingCertificate: Doc | null = null
let activeTemplate: Doc | null = null
let existingRecord: Doc | null = null

const reserved: string[] = []

const DESIGNED = {
  version: 1, canvas: { width: 800, height: 600 },
  elements: [{
    id: 't1', type: 'text', content: '{{participantName}}', zIndex: 1, x: 0.1, y: 0.4,
    fontFamily: 'helvetica', fontSizeFrac: 0.05, weight: 'normal', color: '#111', align: 'center',
  }],
}

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { doc: () => ({ get: async () => ({ exists: false }) }), collection: () => ({}) },
  adminAuth: {},
}))

vi.mock('@/lib/certificates/firestore', () => ({
  findCertificate:      async () => existingCertificate,
  getCertificate:       async () => existingRecord,
  getActiveTemplate:    async () => activeTemplate,
  getTemplateById:      async () => activeTemplate,
  reserveCertificateId: async (e: string, r: string) => {
    reserved.push(`${e}:${r}`)                       // must NOT happen for an undesigned template
    return { certificateId: 'RDC-2026-CLAIM', owned: true }
  },
  createCertificate:            async (c: Doc) => c,
  releaseCertificateClaim:      async () => {},
  recordCertificateRegeneration: async () => {},
  recordTemplateUsage:          async () => {},
  getSettings:                  async () => null,
  // Eligibility is a separate gate that runs first; it is exercised by its own suite.
  assertRegistrationEligibleForCertificate: async () => {},
}))

const {
  generateCertificate, renderCertificateOnDemand, regenerateCertificate,
  templateHasDesign, CertificateTemplateNotDesignedError,
} = await import('@/lib/certificates/generate')

const template = (layout: unknown): Doc => ({
  templateId: 'tpl-1', eventId: 'evt-1', organizerUid: 'uid-1', name: 'R2-TEST',
  templateType: 'png', fileName: 'R2-TEST.png', fileSize: 10,
  dimensions: { width: 800, height: 600 },
  ...(layout === undefined ? {} : { layout }),
})

const issue = (tpl: Doc) => generateCertificate({
  input: {
    eventId: 'evt-1', eventSlug: 'evt', organizerUid: 'uid-1', eventName: 'Marathon',
    eventDate: '', eventLocation: '', organizerName: '', registrationId: 'reg-1',
    attendeeName: 'Balaganapathy NT', attendeeEmail: 'a@b.c', ticketCode: '', passName: '',
    bibNumber: '', distance: '', finishTime: '', position: '', category: '',
  },
  certificateType: 'participation',
  source: 'manual',
  template: tpl,
} as never)

beforeEach(() => {
  existingCertificate = null
  existingRecord = null
  activeTemplate = null
  reserved.length = 0
})

describe('templateHasDesign', () => {
  it('is false for no layout, an empty layout, and an empty elements array', () => {
    expect(templateHasDesign({} as never)).toBe(false)
    expect(templateHasDesign({ layout: undefined } as never)).toBe(false)
    expect(templateHasDesign({ layout: { version: 1, canvas: { width: 1, height: 1 }, elements: [] } } as never)).toBe(false)
  })

  it('is true as soon as one element exists', () => {
    expect(templateHasDesign({ layout: DESIGNED } as never)).toBe(true)
  })
})

describe('issuance guard', () => {
  it('refuses a template that was never designed, with an actionable message', async () => {
    await expect(issue(template(undefined))).rejects.toBeInstanceOf(CertificateTemplateNotDesignedError)
    await expect(issue(template(undefined))).rejects.toThrow(
      'Certificate template must be designed before certificates can be issued.',
    )
  })

  it('refuses a template whose design was emptied', async () => {
    const emptied = { version: 1, canvas: { width: 800, height: 600 }, elements: [] }
    await expect(issue(template(emptied))).rejects.toBeInstanceOf(CertificateTemplateNotDesignedError)
  })

  it('does NOT reserve a certificateId when it refuses', async () => {
    await issue(template(undefined)).catch(() => {})

    expect(reserved).toEqual([])   // no claim to release, no id burned
  })

  it('still returns an ALREADY-ISSUED certificate whose template was later stripped', async () => {
    existingCertificate = { certificateId: 'RDC-2026-OLD' }

    // Retries and re-downloads of past work must not start failing retroactively.
    const res = await issue(template(undefined))
    expect(res.created).toBe(false)
    expect(res.certificate).toMatchObject({ certificateId: 'RDC-2026-OLD' })
  })

  it('proceeds past the guard for a designed template', async () => {
    // Reaching the claim proves the guard did not fire; generation itself is exercised
    // end-to-end by the existing generation suite.
    await issue(template(DESIGNED)).catch(() => {})

    expect(reserved).toEqual(['evt-1:reg-1'])
  })
})

describe('re-render guards', () => {
  beforeEach(() => {
    existingRecord = {
      certificateId: 'RDC-2026-OLD', eventId: 'evt-1', organizerUid: 'uid-1',
      status: 'issued', templateId: 'tpl-1', data: {},
    }
  })

  it('on-demand render refuses a stripped template instead of returning a bare background', async () => {
    activeTemplate = template(undefined)

    await expect(renderCertificateOnDemand('RDC-2026-OLD'))
      .resolves.toMatchObject({ ok: false, error: 'no_template' })
  })

  it('regeneration refuses a stripped template instead of overwriting a good artifact', async () => {
    activeTemplate = template({ version: 1, canvas: { width: 800, height: 600 }, elements: [] })

    await expect(regenerateCertificate('RDC-2026-OLD'))
      .resolves.toMatchObject({ ok: false, error: 'no_active_template' })
  })
})
